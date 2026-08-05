import { randomUUID } from 'node:crypto';

import type { CompositionNode, InverseOperation, MaterializerDescriptor } from 'protocol';

import type { SeedJobDispatcher } from '../redis/seed-queue.js';
import type {
  MaterializationContext,
  MaterializationOutcome,
  MaterializationRefusal,
  Materializer,
  RevertContext,
} from './types.js';

/**
 * The API adapter: the observed create request, replayed with the composed record in it.
 *
 * docs/TEST-DATA-ENGINE.md § 4 puts this first in the chain and states its costs plainly — it
 * bypasses the client-side validation a tester may have meant to exercise, and it breaks when the
 * API changes. The chain records which adapter ran for exactly that reason.
 *
 * The request itself is issued by `apps/indexer/src/seed/http.ts`, from inside the browser context
 * that is already logged in. What is left here is the gateway's half: deciding whether the
 * observed request can carry this particular record, and turning the plan's fields into the
 * payload's slots.
 *
 * ## Filling the template is a two-way check, and both directions matter
 *
 * `inferApiMaterializers` accepts a payload that covers 60% of a form's fields, so an observed
 * create request routinely has no slot for some of the things a plan asks for. Both mismatches are
 * refusals rather than best-effort fills:
 *
 * - **A slot with no composed value** would be sent as the literal string `{{status}}`, which the
 *   application would store or reject, and either is worse than not trying.
 * - **A composed value with no slot** is the quiet one, and the reason `canHandle` checks it. The
 *   tester asked for a *pending* order; if the observed payload has no `status`, the replay
 *   creates an order that is not pending, reports success, and the precondition the whole seed
 *   existed for is silently absent.
 *
 * Refusing sends the chain to the UI adapter, which fills the real form and therefore carries
 * every field. That is the fallback working, not a failure.
 */

/**
 * How a record created without a browser will be undone.
 *
 * Two values rather than one because a UI-driven delete has to be *aimed*, and the path it is
 * aimed with is not part of an inverse operation — it is stored on the ledger payload, which is
 * where the revert reads it from. A UI create gets that path for free by being a browser that
 * ended up somewhere; this is the reconstruction that stands in for it, and `null` is a real
 * answer meaning the record's page could not be reconstructed at all.
 */
export interface HttpCreateReversal {
  readonly inverseOp: InverseOperation;
  readonly detailPath: string | null;
}

export interface ApiMaterializerOptions {
  readonly dispatcher: SeedJobDispatcher;
  /** Decided from indexed knowledge by the route — see `inverseForHttpCreate`. */
  readonly reversalFor: (entity: string, externalRef: string) => HttpCreateReversal;
}

export function createApiMaterializer(options: ApiMaterializerOptions): Materializer {
  return {
    kind: 'api',

    canHandle(
      node: CompositionNode,
      descriptor: MaterializerDescriptor,
    ): MaterializationRefusal | null {
      if (descriptor.spec.kind !== 'api') {
        return { reason: 'the descriptor is not an API materializer' };
      }

      if (descriptor.spec.auth === 'bearer') {
        // The observed request carried an `Authorization` header, and `network-observer.ts`
        // records only that it was there — never its value, which is correct and is why this
        // cannot run. A bearer token lives in the application's own JavaScript; the browser
        // context the replay is issued from shares a cookie jar, not a variable in somebody's
        // JS heap. Replaying without it would create nothing, or worse, create it as the wrong
        // principal.
        return {
          reason:
            'the observed create request authenticates with a bearer token, which was never ' +
            'captured and cannot be replayed — the UI form will run instead',
        };
      }

      const slots = slotsIn(descriptor.spec.payloadTemplate);
      const fields = new Map(
        Object.keys(node.fields).map((field) => [normalize(field), field] as const),
      );

      const unfillable = [...slots].filter((slot) => !fields.has(normalize(slot)));
      if (unfillable.length > 0) {
        return {
          reason:
            `the observed create request has slots this plan does not fill ` +
            `(${unfillable.sort().join(', ')}), so replaying it would send them empty`,
        };
      }

      const slotNames = new Set([...slots].map((slot) => normalize(slot)));
      const unplaced = Object.keys(node.fields).filter((field) => !slotNames.has(normalize(field)));
      if (unplaced.length > 0) {
        return {
          reason:
            `the observed create request has nowhere to put ${unplaced.sort().join(', ')}, so a ` +
            'record created through it would not be the one that was composed',
        };
      }

      return null;
    },

    async materialize(
      node: CompositionNode,
      descriptor: MaterializerDescriptor,
      context: MaterializationContext,
    ): Promise<MaterializationOutcome> {
      if (descriptor.spec.kind !== 'api') {
        return { ok: false, failure: { reason: 'the descriptor is not an API materializer' } };
      }

      const resolved = resolveReferences(node.fields, context);
      const filled = fill(descriptor.spec.payloadTemplate, resolved);
      if (!filled.ok) return { ok: false, failure: { reason: filled.reason } };

      const result = await options.dispatcher.run(
        {
          operation: 'api_create',
          jobId: randomUUID(),
          tenantId: context.tenantId,
          applicationId: context.applicationId,
          memoryVersionId: context.memoryVersionId,
          sessionId: context.sessionId,
          planId: context.plan.id,
          nodeId: node.nodeId,
          entity: node.entity,
          method: descriptor.spec.method,
          path: descriptor.spec.path,
          payload: filled.payload,
          readBackPath: descriptor.spec.readBackPath,
          deadlineMs: context.deadlineMs,
        },
        context.deadlineMs,
      );

      if (result.outcome === 'failed' || result.externalRef === null) {
        return {
          ok: false,
          failure: { reason: result.failureReason ?? 'the API materializer created no record' },
        };
      }

      const reversal = options.reversalFor(node.entity, result.externalRef);

      return {
        ok: true,
        record: {
          externalRef: result.externalRef,
          // The record's page, reconstructed from the route the delete control was indexed on —
          // never observed, because a replay never landed anywhere. Null when it could not be
          // reconstructed, and then `inverseOp` is `none` and the two agree.
          payload: { fields: node.fields, detailPath: reversal.detailPath },
          inverseOp: reversal.inverseOp,
        },
      };
    },

    async revert(
      inverseOp: InverseOperation,
      context: RevertContext,
    ): Promise<MaterializationRefusal | null> {
      if (inverseOp.kind === 'none') return { reason: inverseOp.reason };
      if (inverseOp.kind !== 'api') {
        return { reason: `the API adapter cannot run a ${inverseOp.kind} inverse operation` };
      }

      const result = await options.dispatcher.run(
        {
          operation: 'api_revert',
          jobId: randomUUID(),
          tenantId: context.tenantId,
          applicationId: context.applicationId,
          memoryVersionId: context.memoryVersionId,
          entity: context.entity,
          externalRef: context.externalRef,
          path: inverseOp.path,
          deadlineMs: context.deadlineMs,
        },
        context.deadlineMs,
      );

      return result.outcome === 'succeeded'
        ? null
        : { reason: result.failureReason ?? 'the delete request did not remove the record' };
    },
  };
}

/* ------------------------------------------------------------------------------ templates ---- */

/** `{{accountId}}`, `{{lines[].sku}}` — a whole string that is nothing but one slot. */
const SLOT = /^\{\{(.+)\}\}$/;

/**
 * Every slot path in an observed payload template.
 *
 * `templatize` in the indexer writes them as the path to the value it replaced, so a repeated
 * group reads `lines[].sku`. The `[]` is dropped when matching against a schema field, because
 * the form observer names that same field `lines.sku`.
 */
export function slotsIn(template: unknown): ReadonlySet<string> {
  const found = new Set<string>();

  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      const match = SLOT.exec(value);
      if (match?.[1] !== undefined) found.add(match[1]);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const nested of Object.values(value)) walk(nested);
    }
  };

  walk(template);
  return found;
}

/** `lines[].sku` and `lines.sku` are the same field; `poNumber` and `po_number` are too. */
function normalize(name: string): string {
  return name
    .replaceAll('[]', '')
    .replaceAll(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

type FillResult =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly reason: string };

/**
 * Put the composed values into the observed shape.
 *
 * The shape is the application's, not ours — nesting, key spelling and array structure all come
 * from a request the application actually accepted. Only the leaves change.
 *
 * A repeated group is filled as the single element the template holds, which is the same thing the
 * UI adapter does: a plan node's `fields` is a flat record, so "three line items" is not something
 * a node can currently express. When it can, this is where the cardinality would be read.
 */
export function fill(template: unknown, values: ReadonlyMap<string, unknown>): FillResult {
  const byName = new Map([...values].map(([name, value]) => [normalize(name), value] as const));
  // Collected rather than assigned to a `string | null`: the assignment happens inside `walk`,
  // and TypeScript cannot see through the closure to know the variable was ever written.
  const missing: string[] = [];

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const match = SLOT.exec(value);
      const slot = match?.[1];
      if (slot === undefined) return value;

      const key = normalize(slot);
      if (!byName.has(key)) {
        missing.push(slot);
        return value;
      }
      return byName.get(key);
    }
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, walk(nested)]));
    }
    return value;
  };

  const payload = walk(template);

  // Unreachable when `canHandle` ran first, and checked anyway: sending `{{status}}` as a literal
  // is the failure mode this whole module is arranged to prevent, and it must not depend on two
  // methods agreeing about which slots exist.
  const [first] = missing;
  if (first !== undefined) {
    return {
      ok: false,
      reason: `the observed payload has a ${first} slot this plan cannot fill`,
    };
  }

  return { ok: true, payload };
}

/**
 * Swap plan-local node ids for the identifiers the records actually got.
 *
 * A field pointing at another node holds that node's id until the node is created; this is where
 * a dependency edge becomes a real foreign key. The same substitution the UI adapter makes before
 * typing a value into a control.
 */
function resolveReferences(
  fields: CompositionNode['fields'],
  context: MaterializationContext,
): ReadonlyMap<string, unknown> {
  return new Map(
    Object.entries(fields).map(([field, value]) => [
      field,
      context.created.get(String(value)) ?? value,
    ]),
  );
}
