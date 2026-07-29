import { sql } from 'kysely';
import {
  Session as SessionSchema,
  SessionStep as SessionStepSchema,
  type ScopedQuery,
  type ResolutionResult,
  type Session,
  type SessionStep,
  type SessionStepIngestResult,
} from 'protocol';

import type { ScopedDatabase } from './pool.js';

/**
 * The reads and writes behind the session endpoints.
 *
 * As in the memory repository, no method writes a `where tenant_id = …`: row-level security
 * applies it, and a duplicated filter is one that can drift from the policy. A session belonging
 * to another tenant therefore reads as absent rather than forbidden, which is the honest answer —
 * the caller has no way to tell whether it exists, and should not.
 *
 * ## Immutability is enforced by the write, not by a prior read
 *
 * `closeSession` and `insertSteps` both make "the session is still open" part of the statement
 * itself — a conditional update and a subquery guard respectively. Checking first and writing
 * second would leave a window in which a concurrent close lands between them, and the whole point
 * of "sessions are immutable once closed" is that no step can arrive after the last one.
 */

/** The stored shape of a session row, as Kysely returns it. */
interface SessionRow {
  readonly id: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly memoryVersionId: string;
  readonly userId: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

function toSession(row: SessionRow): Session {
  return SessionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    applicationId: row.applicationId,
    memoryVersionId: row.memoryVersionId,
    userId: row.userId,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt === null ? null : row.endedAt.toISOString(),
  });
}

/**
 * Open a session.
 *
 * The tenant and user come from the authenticated principal, never from the request body. The
 * composite foreign keys do the rest: an application or memory version belonging to another
 * tenant fails the constraint rather than opening a session that straddles two.
 */
export async function openSession(
  db: ScopedDatabase,
  input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly applicationId: string;
    readonly memoryVersionId: string;
  },
): Promise<Session> {
  const row = await db
    .insertInto('sessions')
    .values({
      tenantId: input.tenantId,
      userId: input.userId,
      applicationId: input.applicationId,
      memoryVersionId: input.memoryVersionId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return toSession(row);
}

export async function findSession(db: ScopedDatabase, sessionId: string): Promise<Session | null> {
  const row = await db
    .selectFrom('sessions')
    .selectAll()
    .where('id', '=', sessionId)
    .executeTakeFirst();

  return row === undefined ? null : toSession(row);
}

/**
 * Close a session, or report that it was already closed.
 *
 * The `ended_at is null` predicate is what makes closing idempotent *and* single: two concurrent
 * closes produce one timestamp, and the loser is told the session was already closed rather than
 * silently moving the end of a timeline.
 */
export async function closeSession(
  db: ScopedDatabase,
  sessionId: string,
): Promise<
  | { readonly outcome: 'closed'; readonly session: Session }
  | { readonly outcome: 'already_closed' | 'missing'; readonly session: Session | null }
> {
  const updated = await db
    .updateTable('sessions')
    .set({ endedAt: sql<Date>`now()` })
    .where('id', '=', sessionId)
    .where('endedAt', 'is', null)
    .returningAll()
    .executeTakeFirst();

  if (updated !== undefined) {
    return { outcome: 'closed', session: toSession(updated) };
  }

  // Nothing updated: either it does not exist for this tenant, or it was already closed. The two
  // are different answers to the caller — a 404 and a 409 — so they are distinguished here.
  const existing = await findSession(db, sessionId);
  return existing === null
    ? { outcome: 'missing', session: null }
    : { outcome: 'already_closed', session: existing };
}

/** What an ingest attempt did, so the route can answer with the right status without a second read. */
export type IngestOutcome =
  | { readonly kind: 'ingested'; readonly result: SessionStepIngestResult }
  | { readonly kind: 'missing' }
  | { readonly kind: 'closed'; readonly session: Session };

/**
 * Append a batch of steps, ignoring any ordinal already recorded.
 *
 * Idempotent on `(session_id, ordinal)` — the unique index from Phase 3 — so a flush retried after
 * a failed response appends nothing the second time. That is what lets the extension's buffer
 * retry freely: at-least-once delivery over a store that makes duplicates harmless.
 *
 * ## The row lock is what closes the race
 *
 * `withTenant` already runs this inside a transaction, so selecting the session `FOR UPDATE` holds
 * it until the insert commits. A concurrent close blocks on the lock rather than slipping between
 * the check and the write — which is the difference between "immutable once closed" and "immutable
 * unless two requests arrive together".
 */
export async function insertSteps(
  db: ScopedDatabase,
  input: {
    readonly tenantId: string;
    readonly sessionId: string;
    readonly steps: readonly SessionStep[];
  },
): Promise<IngestOutcome> {
  const locked = await db
    .selectFrom('sessions')
    .selectAll()
    .where('id', '=', input.sessionId)
    .forUpdate()
    .executeTakeFirst();

  if (locked === undefined) return { kind: 'missing' };

  const session = toSession(locked);
  if (session.endedAt !== null) return { kind: 'closed', session };

  const rows = await db
    .insertInto('sessionSteps')
    .values(
      input.steps.map((step) => ({
        id: step.id,
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        ordinal: step.ordinal,
        utterance: step.utterance,
        // Stringified rather than passed as objects: node-postgres serialises a plain object to
        // JSON but renders a JS *array* as a Postgres array literal, which a jsonb column rejects.
        // `evidence` is an array, so being explicit here is what keeps it from failing at runtime.
        intent: JSON.stringify(step.intent),
        resolution: JSON.stringify(step.resolution),
        elementId: step.elementId,
        tier: step.tier,
        confidence: step.confidence,
        actionClass: step.actionClass,
        latencyMs: step.latencyMs,
        outcome: step.outcome,
        evidence: JSON.stringify(step.evidence),
        createdAt: new Date(step.createdAt),
      })),
    )
    // No conflict target: any unique violation means this step is already recorded. The
    // `(session_id, ordinal)` index is what the idempotency contract rests on, but a retried flush
    // also re-sends the step's own id, and naming only the one arbiter would let that hit the
    // primary key and raise instead of being recognised as the duplicate it is.
    .onConflict((conflict) => conflict.doNothing())
    .returning('id')
    .execute();

  const inserted = rows.length;
  return {
    kind: 'ingested',
    result: {
      accepted: input.steps.length,
      inserted,
      duplicates: input.steps.length - inserted,
    },
  };
}

/** Every step of a session, in the order they happened. */
export async function listSteps(
  db: ScopedDatabase,
  sessionId: string,
): Promise<readonly SessionStep[]> {
  const rows = await db
    .selectFrom('sessionSteps')
    .selectAll()
    .where('sessionId', '=', sessionId)
    .orderBy('ordinal', 'asc')
    .execute();

  return rows.map((row) =>
    SessionStepSchema.parse({
      id: row.id,
      sessionId: row.sessionId,
      ordinal: row.ordinal,
      utterance: row.utterance,
      intent: row.intent as ScopedQuery,
      resolution: row.resolution as ResolutionResult,
      elementId: row.elementId,
      tier: row.tier,
      confidence: row.confidence === null ? null : Number(row.confidence),
      actionClass: row.actionClass,
      latencyMs: Number(row.latencyMs),
      outcome: row.outcome,
      evidence: row.evidence,
      createdAt: row.createdAt.toISOString(),
    }),
  );
}
