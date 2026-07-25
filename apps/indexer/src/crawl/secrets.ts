import { readFile } from 'node:fs/promises';

import { z } from 'zod';
import type { SecretRef } from 'protocol';

import { SecretError } from '../errors.js';

/**
 * Secret resolution.
 *
 * ARCHITECTURE § 8: "Credentials for the app under test — never stored by WisprTest in
 * plaintext. Auth profiles hold a reference to the customer's secret manager, or the tester
 * supplies them per session." This module is the whole of the "resolve the reference" half, and
 * it is deliberately small.
 *
 * ## Rules this module holds to
 *
 * - A resolved value is returned to the caller and referenced nowhere else. Nothing here caches,
 *   logs, or attaches a secret to an error.
 * - Errors name the *reference* — provider and key — and never the value, nor its length. A
 *   length is a meaningful clue about a credential and has no diagnostic use.
 * - Two providers, `env` and `file`, because those are the two shapes every secret manager
 *   projects into in production. See the `SecretProvider` doc comment in the contract.
 *
 * A JavaScript string cannot be wiped after use — the engine owns the buffer — so "never
 * persisted" is enforced by never handing the value anywhere it could be persisted, rather than
 * by scrubbing after the fact.
 */

export interface SecretResolver {
  /** The secret's value, or a {@link SecretError} naming only the reference. */
  resolve(ref: SecretRef): Promise<string>;
}

export function createSecretResolver(env: NodeJS.ProcessEnv = process.env): SecretResolver {
  return {
    async resolve(ref: SecretRef): Promise<string> {
      if (ref.provider === 'env') {
        const value = env[ref.key];
        if (value === undefined || value === '') {
          throw new SecretError(ref.provider, ref.key, 'environment variable is unset or empty');
        }
        return value;
      }

      try {
        const contents = (await readFile(ref.key, 'utf8')).trim();
        if (contents === '') {
          throw new SecretError(ref.provider, ref.key, 'file is empty');
        }
        return contents;
      } catch (error: unknown) {
        if (error instanceof SecretError) throw error;
        // The node error's message contains the path, which is the key we are already reporting,
        // and nothing else — but only the code is carried through, to keep that guaranteed.
        const code = error instanceof Error && 'code' in error ? String(error.code) : 'unreadable';
        throw new SecretError(ref.provider, ref.key, `file could not be read (${code})`);
      }
    },
  };
}

/** The document a form profile's `credentialsRef` must resolve to. */
const credentialsSchema = z.strictObject({
  username: z.string().min(1),
  password: z.string().min(1),
});

export type Credentials = z.infer<typeof credentialsSchema>;

/**
 * Resolve and parse a form profile's credentials.
 *
 * The validation error is reduced to which *fields* were wrong before it is thrown. A Zod issue
 * list would be safe today, but it is one library change away from quoting the offending value
 * into a message that ends up in a log line.
 */
export async function resolveCredentials(
  resolver: SecretResolver,
  ref: SecretRef,
): Promise<Credentials> {
  const raw = await resolver.resolve(ref);

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new SecretError(
      ref.provider,
      ref.key,
      'expected a JSON document of the form {"username":…,"password":…}',
    );
  }

  const parsed = credentialsSchema.safeParse(payload);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'root'))];
    throw new SecretError(
      ref.provider,
      ref.key,
      `credential fields are invalid: ${fields.join(', ')}`,
    );
  }

  return parsed.data;
}

/**
 * The Playwright storage state a `storage_state` profile's reference must resolve to.
 *
 * Every field Playwright requires is required here, and unknown keys are stripped rather than
 * rejected: what goes into `browser.newContext({ storageState })` is then exactly the document
 * Playwright's own `context.storageState()` produces — which is how a tester captures one — with
 * no room for a shape mismatch to surface as an obscure failure three routes into a crawl.
 */
const storageStateSchema = z.object({
  cookies: z.array(
    z.object({
      name: z.string(),
      value: z.string(),
      domain: z.string(),
      path: z.string(),
      expires: z.number(),
      httpOnly: z.boolean(),
      secure: z.boolean(),
      sameSite: z.enum(['Strict', 'Lax', 'None']),
    }),
  ),
  origins: z.array(
    z.object({
      origin: z.string(),
      localStorage: z.array(z.object({ name: z.string(), value: z.string() })),
    }),
  ),
});

export type StorageState = z.infer<typeof storageStateSchema>;

/**
 * Resolve and parse a tester-captured storage state.
 *
 * Loose rather than strict: this document belongs to Playwright, whose shape may gain fields, and
 * rejecting a state because it carries one more key than we knew about would break a crawl for no
 * safety benefit. The two arrays are checked because those are the ones we depend on existing.
 */
export async function resolveStorageState(
  resolver: SecretResolver,
  ref: SecretRef,
): Promise<StorageState> {
  const raw = await resolver.resolve(ref);

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new SecretError(
      ref.provider,
      ref.key,
      'expected a Playwright storageState JSON document',
    );
  }

  const parsed = storageStateSchema.safeParse(payload);
  if (!parsed.success) {
    // Field paths only. A cookie's *value* is a session token, and an error message quoting one
    // would put it wherever this error is eventually logged.
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'root'))];
    throw new SecretError(
      ref.provider,
      ref.key,
      `storage state does not match Playwright's format at: ${fields.join(', ')}`,
    );
  }
  return parsed.data;
}
