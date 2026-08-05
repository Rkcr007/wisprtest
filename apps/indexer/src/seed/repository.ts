import { AuthProfile, ElementFingerprint } from 'protocol';

import type { ScopedDatabase } from '../db/pool.js';
import { SeedError } from '../errors.js';

/**
 * The reads the UI materializer performs before it opens a browser.
 *
 * A `SeedJob` carries ids, not data — element fingerprints and secret references have no
 * business sitting in a Redis stream, and a job that carried them would be a second copy of
 * memory that could disagree with the first. Everything the adapter needs is loaded here, scoped
 * by row-level security like every other read in the service.
 */

/** Where a background browser has to go, and how it authenticates when it gets there. */
export interface SeedApplication {
  readonly id: string;
  readonly baseUrl: string;
  readonly env: string;
  readonly authProfile: AuthProfile;
}

/**
 * The application, with its stored auth profile parsed against the contract.
 *
 * The column is jsonb with only a shape CHECK on it, so this is where it becomes an `AuthProfile`.
 * A profile that does not parse fails the job with the reason rather than being coerced to
 * `{kind:'none'}`: seeding into an application while silently unauthenticated would either fail
 * confusingly at the form or, worse, write to whatever an anonymous session can reach.
 */
export async function findSeedApplication(
  db: ScopedDatabase,
  applicationId: string,
): Promise<SeedApplication | null> {
  const row = await db
    .selectFrom('applications')
    .select(['id', 'baseUrl', 'env', 'authProfile'])
    .where('id', '=', applicationId)
    .executeTakeFirst();

  if (row === undefined) return null;

  const profile = AuthProfile.safeParse(row.authProfile);
  if (!profile.success) {
    throw new SeedError(
      `the stored auth profile for application ${applicationId} does not match the contract: ` +
        profile.error.issues.map((issue) => issue.message).join('; '),
    );
  }

  return { id: row.id, baseUrl: row.baseUrl, env: row.env, authProfile: profile.data };
}

/** One indexed element: the fingerprint to match against, and the screen it was seen on. */
export interface IndexedElement {
  readonly elementKey: string;
  readonly fingerprint: ElementFingerprint;
  readonly routePattern: string;
}

/**
 * Load the indexed elements named by a set of element keys.
 *
 * Returned as a map rather than an array because every caller wants it by key, and because the
 * *absence* of a key is the interesting case: a plan naming a control the memory version does not
 * hold is a plan composed against a different version, and the adapter must say so rather than
 * fill the fields it recognises and submit a half-filled form.
 *
 * Scoped to one memory version. Two versions of the same application hold the same element keys
 * with different fingerprints, and matching against the wrong one is how an adapter ends up
 * typing into the control that used to be there.
 */
export async function loadIndexedElements(
  db: ScopedDatabase,
  memoryVersionId: string,
  elementKeys: readonly string[],
): Promise<Map<string, IndexedElement>> {
  if (elementKeys.length === 0) return new Map();

  const rows = await db
    .selectFrom('elements')
    .innerJoin('screens', 'screens.id', 'elements.screenId')
    .select(['elements.elementKey', 'elements.fingerprint', 'screens.routePattern'])
    .where('screens.memoryVersionId', '=', memoryVersionId)
    .where('elements.elementKey', 'in', [...elementKeys])
    .execute();

  const found = new Map<string, IndexedElement>();
  for (const row of rows) {
    const fingerprint = ElementFingerprint.safeParse(row.fingerprint);
    if (!fingerprint.success) {
      throw new SeedError(
        `the stored fingerprint for ${row.elementKey} does not match the contract: ` +
          fingerprint.error.issues.map((issue) => issue.message).join('; '),
      );
    }
    // An element key is unique per screen, not per version — the same control can appear on two
    // screens. First one wins, and the caller's own route is what actually decides which element
    // is matched, since only one of them is on the page it navigates to.
    if (!found.has(row.elementKey)) {
      found.set(row.elementKey, {
        elementKey: row.elementKey,
        fingerprint: fingerprint.data,
        routePattern: row.routePattern,
      });
    }
  }

  return found;
}
