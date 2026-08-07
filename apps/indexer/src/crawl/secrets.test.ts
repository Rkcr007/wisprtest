import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { SecretError } from '../errors.js';
import {
  ConfigurationError,
  createSecretResolverFactory,
  envNamespaceFor,
  resolveCredentials,
  resolveStorageState,
  type SecretResolver,
} from './secrets.js';

/**
 * The tenant boundary, and the two ways a reference could cross it.
 *
 * Most of this suite asserts a *refusal*. An unscoped resolver is an arbitrary-read primitive
 * available to any authenticated tenant — a `SecretRef` is validated for shape and says nothing
 * about whose secret it names — and a `form` profile ends by typing the resolved value into a
 * login form at a `baseUrl` the same tenant registered. So these are exfiltration tests.
 */

const TENANT = '8b0dd7cb-10df-439e-bf42-11ad9f111d31';
const OTHER_TENANT = '11111111-1111-4111-8111-111111111111';
const ENV_NS = envNamespaceFor(TENANT);

let root: string;
let ownDirectory: string;
let ownSecret: string;
let neighbourSecret: string;
let outsideSecret: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'wispr-secret-root-'));

  ownDirectory = join(root, TENANT);
  await mkdir(ownDirectory, { recursive: true });
  ownSecret = join(ownDirectory, 'credentials.json');
  await writeFile(ownSecret, '  file-value  ');

  const neighbourDirectory = join(root, OTHER_TENANT);
  await mkdir(neighbourDirectory, { recursive: true });
  neighbourSecret = join(neighbourDirectory, 'credentials.json');
  await writeFile(neighbourSecret, 'the-neighbours-password');

  // Stands in for /run/secrets, ~/.aws/credentials, a service-account token: anything the process
  // can read that is not inside the tree at all.
  outsideSecret = join(root, 'service-account-token');
  await writeFile(outsideSecret, 'a-cluster-token');
});

function resolverFor(tenantId: string, env: NodeJS.ProcessEnv = {}): SecretResolver {
  return createSecretResolverFactory({ root, env }).forTenant(tenantId);
}

async function thrownBy(work: Promise<unknown>): Promise<unknown> {
  return await work.catch((error: unknown) => error);
}

describe('the tenant fence — files', () => {
  it('reads a secret inside the tenant’s own directory', async () => {
    expect(await resolverFor(TENANT).resolve({ provider: 'file', key: ownSecret })).toBe(
      'file-value',
    );
  });

  it('refuses another tenant’s secret', async () => {
    // The whole vulnerability, in one assertion. This path is well-formed, readable, and belongs
    // to somebody else.
    const error = await thrownBy(
      resolverFor(TENANT).resolve({ provider: 'file', key: neighbourSecret }),
    );

    expect(error).toBeInstanceOf(SecretError);
    expect((error as Error).message).toContain('outside');
  });

  it('refuses a path outside the secret root entirely', async () => {
    await expect(
      resolverFor(TENANT).resolve({ provider: 'file', key: outsideSecret }),
    ).rejects.toBeInstanceOf(SecretError);
  });

  it('refuses a traversal that would climb out and back in', async () => {
    const traversal = join(ownDirectory, '..', OTHER_TENANT, 'credentials.json');

    await expect(
      resolverFor(TENANT).resolve({ provider: 'file', key: traversal }),
    ).rejects.toBeInstanceOf(SecretError);
  });

  it('refuses a symlink inside the tenant’s directory pointing out of it', async () => {
    // The reason a lexical prefix check is not enough on its own. The *name* is inside the fence;
    // the file is not.
    const link = join(ownDirectory, 'escape.json');
    await symlink(neighbourSecret, link).catch(() => undefined);

    const error = await thrownBy(resolverFor(TENANT).resolve({ provider: 'file', key: link }));

    expect(error).toBeInstanceOf(SecretError);
    expect((error as Error).message).toContain('resolves outside');
  });

  it('refuses a sibling directory whose name merely starts with the tenant id', async () => {
    // `/root/<uuid>-archive/creds` must not pass a check for `/root/<uuid>`.
    const lookalike = join(root, `${TENANT}-archive`);
    await mkdir(lookalike, { recursive: true });
    const path = join(lookalike, 'credentials.json');
    await writeFile(path, 'not-yours');

    await expect(
      resolverFor(TENANT).resolve({ provider: 'file', key: path }),
    ).rejects.toBeInstanceOf(SecretError);
  });

  it('refuses the tenant directory itself, which is not a secret', async () => {
    await expect(
      resolverFor(TENANT).resolve({ provider: 'file', key: ownDirectory }),
    ).rejects.toBeInstanceOf(SecretError);
  });

  it('refuses a relative path rather than resolving it against the working directory', async () => {
    await expect(
      resolverFor(TENANT).resolve({ provider: 'file', key: 'credentials.json' }),
    ).rejects.toBeInstanceOf(SecretError);
  });

  it('does not open a file it is going to refuse', async () => {
    // A rejection must not be distinguishable from a miss by having stat-ed something first.
    let opened = false;
    const factory = createSecretResolverFactory({
      root,
      realpath: async (path: string) => {
        opened = true;
        return await Promise.resolve(path);
      },
    });

    await thrownBy(factory.forTenant(TENANT).resolve({ provider: 'file', key: neighbourSecret }));

    expect(opened).toBe(false);
  });
});

describe('the tenant fence — environment', () => {
  it('reads a variable inside the tenant’s namespace', async () => {
    const resolver = resolverFor(TENANT, { [`${ENV_NS}CRAWLER`]: 'value' });

    expect(await resolver.resolve({ provider: 'env', key: `${ENV_NS}CRAWLER` })).toBe('value');
  });

  it('refuses another tenant’s variable even when it is set', async () => {
    const other = envNamespaceFor(OTHER_TENANT);
    const resolver = resolverFor(TENANT, { [`${other}CRAWLER`]: 'the-neighbours-password' });

    const error = await thrownBy(resolver.resolve({ provider: 'env', key: `${other}CRAWLER` }));

    expect(error).toBeInstanceOf(SecretError);
    expect((error as Error).message).toContain('namespace');
  });

  it('refuses an unnamespaced variable, however innocuous', async () => {
    const resolver = resolverFor(TENANT, { AWS_SECRET_ACCESS_KEY: 'a-real-key', PATH: '/usr/bin' });

    await expect(
      resolver.resolve({ provider: 'env', key: 'AWS_SECRET_ACCESS_KEY' }),
    ).rejects.toBeInstanceOf(SecretError);
  });

  it('does not read a variable it is going to refuse', async () => {
    // A getter on the env object proves the refusal happens before the lookup.
    let read = false;
    const env: NodeJS.ProcessEnv = new Proxy(
      {},
      {
        get: (): undefined => {
          read = true;
          return undefined;
        },
      },
    );

    await thrownBy(resolverFor(TENANT, env).resolve({ provider: 'env', key: 'SOMETHING_ELSE' }));

    expect(read).toBe(false);
  });

  it('derives a namespace an operator can write by hand', () => {
    // No mapping table: the variable name is derivable from the tenant id in both directions.
    expect(envNamespaceFor('8b0dd7cb-10df-439e-bf42-11ad9f111d31')).toBe(
      'WISPR_SECRET_8B0DD7CB_10DF_439E_BF42_11AD9F111D31_',
    );
  });

  it('fails loudly on an unset variable inside the namespace', async () => {
    await expect(
      resolverFor(TENANT).resolve({ provider: 'env', key: `${ENV_NS}MISSING` }),
    ).rejects.toBeInstanceOf(SecretError);
  });
});

describe('the factory itself', () => {
  it('refuses a relative root, which would fence nothing', () => {
    expect(() => createSecretResolverFactory({ root: 'secrets' })).toThrow(ConfigurationError);
  });

  it('refuses a tenant id that is not a uuid', () => {
    // The id is concatenated into both fences. One carrying a separator or a `..` would be
    // building the fence out of the thing it is meant to fence in.
    const factory = createSecretResolverFactory({ root });

    expect(() => factory.forTenant('../..')).toThrow(ConfigurationError);
    expect(() => factory.forTenant('')).toThrow(ConfigurationError);
    expect(() => factory.forTenant(`${TENANT}/../${OTHER_TENANT}`)).toThrow(ConfigurationError);
  });

  it('hands out resolvers that cannot be widened after construction', async () => {
    // There is no method taking a different tenant id, so a call site that forgot to scope cannot
    // compile. This asserts the runtime half: two resolvers do not share a fence.
    const factory = createSecretResolverFactory({ root });

    await expect(
      factory.forTenant(OTHER_TENANT).resolve({ provider: 'file', key: ownSecret }),
    ).rejects.toBeInstanceOf(SecretError);
    expect(await factory.forTenant(TENANT).resolve({ provider: 'file', key: ownSecret })).toBe(
      'file-value',
    );
  });
});

describe('what an error may say', () => {
  it('never reports the value, or its length', async () => {
    const resolver = resolverFor(TENANT, { [`${ENV_NS}CREDS`]: 'not-json-at-all-hunter2' });
    const error = await thrownBy(
      resolveCredentials(resolver, { provider: 'env', key: `${ENV_NS}CREDS` }),
    );

    expect(error).toBeInstanceOf(SecretError);
    const serialised = `${(error as Error).message}${JSON.stringify((error as SecretError).details)}`;
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('23'); // the value's length
    expect(serialised).toContain('CREDS'); // the reference, which is what an operator needs
  });

  it('does not leak whether a refused path exists', async () => {
    // Same message either way. Otherwise a tenant enumerates the filesystem by watching which
    // refusals differ.
    const present = await thrownBy(
      resolverFor(TENANT).resolve({ provider: 'file', key: neighbourSecret }),
    );
    const absent = await thrownBy(
      resolverFor(TENANT).resolve({ provider: 'file', key: join(root, 'nothing-here') }),
    );

    expect((present as Error).message).toBe((absent as Error).message);
  });
});

describe('credentials', () => {
  it('parses the documented shape', async () => {
    const resolver = resolverFor(TENANT, {
      [`${ENV_NS}CREDS`]: JSON.stringify({
        username: 'crawler@northwind.example',
        password: 'pw',
      }),
    });

    const credentials = await resolveCredentials(resolver, {
      provider: 'env',
      key: `${ENV_NS}CREDS`,
    });
    expect(credentials.username).toBe('crawler@northwind.example');
  });

  it('names the invalid fields without quoting them', async () => {
    const resolver = resolverFor(TENANT, {
      [`${ENV_NS}CREDS`]: JSON.stringify({ username: 'crawler', secret: 'wrong-key-name' }),
    });

    const error = await thrownBy(
      resolveCredentials(resolver, { provider: 'env', key: `${ENV_NS}CREDS` }),
    );
    expect((error as Error).message).toContain('password');
    expect((error as Error).message).not.toContain('wrong-key-name');
  });
});

describe('storage state', () => {
  const state = {
    cookies: [
      {
        name: 'session',
        value: 'a-live-session-token',
        domain: 'northwind.example',
        path: '/',
        expires: 1_800_000_000,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ],
    origins: [
      { origin: 'https://northwind.example', localStorage: [{ name: 'theme', value: 'dark' }] },
    ],
  };

  it('accepts what Playwright produces', async () => {
    const resolver = resolverFor(TENANT, { [`${ENV_NS}STATE`]: JSON.stringify(state) });
    const parsed = await resolveStorageState(resolver, {
      provider: 'env',
      key: `${ENV_NS}STATE`,
    });
    expect(parsed.cookies[0]?.name).toBe('session');
  });

  it('does not put a session token in an error message', async () => {
    // A storage state is a credential: it holds live session cookies and bearer tokens.
    const broken = { cookies: [{ ...state.cookies[0], expires: 'soon' }], origins: [] };
    const resolver = resolverFor(TENANT, { [`${ENV_NS}STATE`]: JSON.stringify(broken) });

    const error = await thrownBy(
      resolveStorageState(resolver, { provider: 'env', key: `${ENV_NS}STATE` }),
    );
    expect(error).toBeInstanceOf(SecretError);
    expect((error as Error).message).not.toContain('a-live-session-token');
    expect((error as Error).message).toContain('cookies.0.expires');
  });
});
