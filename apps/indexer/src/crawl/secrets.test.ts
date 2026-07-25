import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SecretError } from '../errors.js';
import { createSecretResolver, resolveCredentials, resolveStorageState } from './secrets.js';

describe('resolving a reference', () => {
  it('reads an environment variable', async () => {
    const resolver = createSecretResolver({ CRAWLER_CREDENTIALS: 'value' });
    expect(await resolver.resolve({ provider: 'env', key: 'CRAWLER_CREDENTIALS' })).toBe('value');
  });

  it('reads a file, which is how every secret manager projects into a pod', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wispr-secret-'));
    const path = join(directory, 'credentials.json');
    await writeFile(path, '  file-value  ');

    const resolver = createSecretResolver({});
    expect(await resolver.resolve({ provider: 'file', key: path })).toBe('file-value');
  });

  it('fails loudly on an unset variable rather than crawling unauthenticated', async () => {
    const resolver = createSecretResolver({});
    await expect(resolver.resolve({ provider: 'env', key: 'MISSING' })).rejects.toBeInstanceOf(
      SecretError,
    );
  });

  it('never reports the value, or its length, in an error', async () => {
    const resolver = createSecretResolver({ CREDS: 'not-json-at-all-hunter2' });
    const error = await resolveCredentials(resolver, { provider: 'env', key: 'CREDS' }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(SecretError);
    const serialised = `${(error as Error).message}${JSON.stringify((error as SecretError).details)}`;
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('23'); // the value's length
    expect(serialised).toContain('CREDS'); // the reference, which is what an operator needs
  });
});

describe('credentials', () => {
  it('parses the documented shape', async () => {
    const resolver = createSecretResolver({
      CREDS: JSON.stringify({ username: 'crawler@northwind.example', password: 'pw' }),
    });

    const credentials = await resolveCredentials(resolver, { provider: 'env', key: 'CREDS' });
    expect(credentials.username).toBe('crawler@northwind.example');
  });

  it('names the invalid fields without quoting them', async () => {
    const resolver = createSecretResolver({
      CREDS: JSON.stringify({ username: 'crawler', secret: 'wrong-key-name' }),
    });

    const error = await resolveCredentials(resolver, { provider: 'env', key: 'CREDS' }).catch(
      (thrown: unknown) => thrown,
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
    const resolver = createSecretResolver({ STATE: JSON.stringify(state) });
    const parsed = await resolveStorageState(resolver, { provider: 'env', key: 'STATE' });
    expect(parsed.cookies[0]?.name).toBe('session');
  });

  it('does not put a session token in an error message', async () => {
    // A storage state is a credential: it holds live session cookies and bearer tokens.
    const broken = { cookies: [{ ...state.cookies[0], expires: 'soon' }], origins: [] };
    const resolver = createSecretResolver({ STATE: JSON.stringify(broken) });

    const error = await resolveStorageState(resolver, { provider: 'env', key: 'STATE' }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(SecretError);
    expect((error as Error).message).not.toContain('a-live-session-token');
    expect((error as Error).message).toContain('cookies.0.expires');
  });
});
