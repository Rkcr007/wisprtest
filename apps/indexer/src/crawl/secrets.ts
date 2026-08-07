import { realpathSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath, sep } from 'node:path';

import { z } from 'zod';
import type { SecretRef } from 'protocol';

import { SecretError } from '../errors.js';

/**
 * Secret resolution.
 *
 * ARCHITECTURE § 8: "Credentials for the app under test — never stored by WisprTest in
 * plaintext. Auth profiles hold a reference to the customer's secret manager, or the tester
 * supplies them per session." This module is the whole of the "resolve the reference" half.
 *
 * ## Rules this module holds to
 *
 * - A resolved value is returned to the caller and referenced nowhere else. Nothing here caches,
 *   logs, or attaches a secret to an error.
 * - Errors name the *reference* — provider and key — and never the value, nor its length. A
 *   length is a meaningful clue about a credential and has no diagnostic use.
 * - Two providers, `env` and `file`, because those are the two shapes every secret manager
 *   projects into in production. See the `SecretProvider` doc comment in the contract.
 * - **A resolver can only see one tenant's secrets.** See below.
 *
 * A JavaScript string cannot be wiped after use — the engine owns the buffer — so "never
 * persisted" is enforced by never handing the value anywhere it could be persisted, rather than
 * by scrubbing after the fact.
 *
 * ## Why a resolver is bound to a tenant
 *
 * A `SecretRef` arrives on a `CrawlJob`, and a `CrawlJob` is built from a request a tenant made.
 * `AuthProfile` validates the *shape* of that reference and can say nothing about whose secret it
 * points at — `{provider:'file', key:'/anything'}` is a well-formed reference to any file this
 * process can read, and `{provider:'env', key:'ANYTHING'}` to any variable it was started with.
 *
 * Resolving one unscoped is therefore an arbitrary-read primitive available to any authenticated
 * tenant, and it exfiltrates: a `form` profile ends with the resolved credential being *typed into
 * a login form* at the `baseUrl` the same tenant registered. Kubernetes service-account tokens,
 * another tenant's projected credentials and `~/.aws/credentials` are all reachable that way.
 *
 * So a resolver is constructed for one tenant and can reach nothing else. That is a property of
 * the object rather than a check a caller has to remember: {@link createSecretResolverFactory}
 * hands out `SecretResolver`s bound to a tenant id, and there is no method on a resolver that
 * takes a different one. A call site that forgets to scope cannot compile, because there is
 * nothing unscoped to call.
 *
 * ## The two namespaces
 *
 * | Provider | A tenant may name | Enforced by |
 * |---|---|---|
 * | `file` | anything under `<root>/<tenant-id>/` | lexical resolve, then `realpath`, then prefix |
 * | `env` | `WISPR_SECRET_<TENANT_ID>_*` | prefix match on the variable name |
 *
 * Both checks run *before* any read. A rejected reference never opens a file and never touches
 * `process.env`, so a probe cannot distinguish "outside your namespace" from "does not exist" by
 * timing an error that had to stat something first.
 *
 * `realpath` is what makes the file check mean anything: a lexical prefix test alone is defeated
 * by a symlink inside the tenant's own directory pointing at `/run/secrets/somebody-else`. The
 * real path is resolved and re-checked, so an escape has to survive both.
 *
 * There is a TOCTOU window between `realpath` and `readFile` — a path could be re-pointed in
 * between. Closing it needs an `openat`-style handle Node does not expose, and exploiting it needs
 * write access to the mounted secret directory, which is a compromise of the node rather than of
 * this boundary. Recorded rather than silently accepted.
 */

/** A resolver bound to one tenant. It cannot name another tenant's secret. */
export interface SecretResolver {
  /** The secret's value, or a {@link SecretError} naming only the reference. */
  resolve(ref: SecretRef): Promise<string>;
}

export interface SecretResolverFactory {
  /**
   * A resolver scoped to one tenant. Build one per job, from the job's own `tenantId` — never
   * from anything a request body carried.
   */
  forTenant(tenantId: string): SecretResolver;
}

export interface SecretResolverFactoryOptions {
  /**
   * Directory holding every tenant's projected secrets, one subdirectory per tenant id.
   *
   * Required, with no default. A default here would be a security control that silently does
   * nothing on a misconfigured deployment, which is the failure mode CLAUDE.md rule #10 exists to
   * prevent — and the one that matters most for the control that makes a tenant boundary real.
   */
  readonly root: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Injected in tests. Defaults to `fs.realpath`. */
  readonly realpath?: (path: string) => Promise<string>;
}

/** Prefix every tenant-scoped environment variable carries, before the tenant's own segment. */
export const SECRET_ENV_PREFIX = 'WISPR_SECRET_';

/**
 * A tenant id as it appears in an environment variable name.
 *
 * Uppercased with dashes turned into underscores, because a POSIX variable name cannot hold a
 * dash. No mapping table and no configuration: the name is derivable from the id in both
 * directions, so an operator projecting a secret can write the variable name by hand and be right.
 */
export function envNamespaceFor(tenantId: string): string {
  return `${SECRET_ENV_PREFIX}${tenantId.toUpperCase().replaceAll('-', '_')}_`;
}

/**
 * Tenant ids are UUIDs at the contract edge, and this re-checks it.
 *
 * Not paranoia about the contract — paranoia about the *namespace*. Both checks below build a
 * string from this value and compare a prefix against it. An id carrying a separator, a `..` or a
 * wildcard would be constructing the fence out of the thing it is meant to fence in.
 */
const tenantIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);

export function createSecretResolverFactory(
  options: SecretResolverFactoryOptions,
): SecretResolverFactory {
  const env = options.env ?? process.env;
  const realpathImpl = options.realpath ?? realpath;

  if (!isAbsolute(options.root)) {
    throw new ConfigurationError(`secret root must be an absolute path, got "${options.root}"`);
  }
  // Normalised once, so every per-tenant prefix below is built from a path with no trailing
  // separator and no `.` segments to make a prefix comparison ambiguous.
  const root = resolvePath(options.root);

  // And again, canonically. The root itself is very often reached through a symlink — `/tmp` is
  // `/private/tmp` on macOS, and a Kubernetes projected volume is a symlink farm under
  // `..data/` — so a real path checked against the *lexical* root would refuse every secret in a
  // correctly configured deployment. Both forms are kept: the lexical one to refuse cheaply, the
  // canonical one to decide.
  //
  // A root that does not exist yet is not an error. Nothing under it can resolve, so every
  // reference fails at its own `realpath` with a reason naming the reference.
  const canonicalRoot = canonicalise(root);

  return {
    forTenant(tenantId: string): SecretResolver {
      if (!tenantIdSchema.safeParse(tenantId).success) {
        throw new ConfigurationError('a secret resolver must be scoped to a uuid tenant id');
      }

      const namespaces: FileNamespaces = {
        // What a caller may *write*: either spelling of the root is accepted, because an operator
        // configuring `/tmp/secrets` should not have to know it is really `/private/tmp/secrets`.
        accepted: [resolvePath(root, tenantId) + sep, resolvePath(canonicalRoot, tenantId) + sep],
        // What a path must *resolve to*. One answer, so a symlink cannot pick the other.
        canonical: resolvePath(canonicalRoot, tenantId) + sep,
      };
      const envNamespace = envNamespaceFor(tenantId);

      return {
        async resolve(ref: SecretRef): Promise<string> {
          return ref.provider === 'env'
            ? resolveEnv(ref, envNamespace, env)
            : resolveFile(ref, namespaces, realpathImpl);
        },
      };
    },
  };
}

/**
 * The real path of the root, or the root itself when it does not exist yet.
 *
 * Synchronous, and deliberately: it runs once at construction, before any job, and making the
 * factory async would push a promise into every worker's wiring for a single `readlink`.
 */
function canonicalise(root: string): string {
  try {
    return realpathSync.native(root);
  } catch {
    return root;
  }
}

interface FileNamespaces {
  /** Spellings of the tenant directory a reference may be written as. */
  readonly accepted: readonly string[];
  /** The one spelling a reference must resolve to. */
  readonly canonical: string;
}

/** Thrown at construction, not at resolution: a misconfigured factory must not start a crawl. */
export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';
}

function resolveEnv(ref: SecretRef, namespace: string, env: NodeJS.ProcessEnv): string {
  if (!ref.key.startsWith(namespace)) {
    // Deliberately says what the namespace is. It is derivable from the tenant's own id, so it
    // reveals nothing, and the alternative is an operator guessing at a naming convention.
    throw new SecretError(
      ref.provider,
      ref.key,
      `environment variable is outside this tenant's namespace (${namespace}*)`,
    );
  }

  const value = env[ref.key];
  if (value === undefined || value === '') {
    throw new SecretError(ref.provider, ref.key, 'environment variable is unset or empty');
  }
  return value;
}

async function resolveFile(
  ref: SecretRef,
  namespaces: FileNamespaces,
  realpathImpl: (path: string) => Promise<string>,
): Promise<string> {
  // Lexical first: `resolve` collapses `..`, so a traversal is rejected before anything touches
  // the filesystem. A relative key resolves against the process cwd and will not match.
  const lexical = resolvePath(ref.key);
  if (!namespaces.accepted.some((namespace) => withinNamespace(lexical, namespace))) {
    throw new SecretError(ref.provider, ref.key, "path is outside this tenant's secret directory");
  }

  let real: string;
  try {
    real = await realpathImpl(lexical);
  } catch (error: unknown) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unreadable';
    throw new SecretError(ref.provider, ref.key, `file could not be read (${code})`);
  }

  // The lexical check passed, so the *name* is inside the namespace. This is the one that catches
  // a symlink inside the tenant's own directory pointing somewhere else entirely.
  if (!withinNamespace(real, namespaces.canonical)) {
    throw new SecretError(
      ref.provider,
      ref.key,
      "path resolves outside this tenant's secret directory",
    );
  }

  let contents: string;
  try {
    contents = (await readFile(real, 'utf8')).trim();
  } catch (error: unknown) {
    // Only the code is carried through. The node error's message contains the path, which is the
    // key already being reported, but keeping that guaranteed is cheaper than re-checking it.
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unreadable';
    throw new SecretError(ref.provider, ref.key, `file could not be read (${code})`);
  }

  if (contents === '') {
    throw new SecretError(ref.provider, ref.key, 'file is empty');
  }
  return contents;
}

/**
 * Whether an absolute path sits under a namespace directory.
 *
 * The namespace ends in a separator, which is what stops `/secrets/<uuid>-other/creds` passing a
 * check for `/secrets/<uuid>`. The directory itself is not a secret, so an exact match is not
 * accepted either — only something strictly inside it.
 */
function withinNamespace(candidate: string, namespace: string): boolean {
  return candidate.startsWith(namespace) && candidate.length > namespace.length;
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
