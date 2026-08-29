import { describe, expect, it } from 'vitest';

import { parseArgs, UsageError } from './cli.js';

describe('parseArgs', () => {
  it('ignores a leading -- so pnpm can pass flags through', () => {
    const flags = parseArgs(['--', '--url', 'http://127.0.0.1:8080/', '--out', 's.json']);
    expect(flags.url).toBe('http://127.0.0.1:8080/');
    expect(flags.out).toBe('s.json');
    expect(flags.allowPrivate).toBe(false);
  });

  it('requires --url and --out', () => {
    expect(() => parseArgs([])).toThrow(UsageError);
    expect(() => parseArgs(['--url', 'http://127.0.0.1:8080'])).toThrow(UsageError);
    expect(() => parseArgs(['--out', 'snap.json'])).toThrow(UsageError);
  });

  it('rejects a file: URL and a bare host', () => {
    expect(() => parseArgs(['--url', 'file:///tmp/app.html', '--out', 's.json'])).toThrow(
      UsageError,
    );
    expect(() => parseArgs(['--url', 'example.com', '--out', 's.json'])).toThrow(UsageError);
  });

  it('accepts repeated --never-interact and maps numeric flags', () => {
    const flags = parseArgs([
      '--url',
      'https://orders.example.com/app',
      '--out',
      'memory.json',
      '--max-depth',
      '1',
      '--max-pages',
      '8',
      '--rpm',
      '45',
      '--never-interact',
      '[data-destructive]',
      '--never-interact',
      '.danger',
    ]);
    expect(flags.url).toBe('https://orders.example.com/app');
    expect(flags.out).toBe('memory.json');
    expect(flags.maxDepth).toBe(1);
    expect(flags.maxPages).toBe(8);
    expect(flags.rpm).toBe(45);
    expect(flags.neverInteract).toEqual(['[data-destructive]', '.danger']);
    expect(flags.allowPrivate).toBe(false);
  });

  it('accepts a valueless --allow-private', () => {
    const flags = parseArgs([
      '--url',
      'https://staging.example.com/',
      '--out',
      's.json',
      '--allow-private',
    ]);
    expect(flags.allowPrivate).toBe(true);
  });

  it('rejects a non-integer numeric flag', () => {
    expect(() =>
      parseArgs(['--url', 'http://127.0.0.1/', '--out', 's.json', '--max-pages', 'many']),
    ).toThrow(UsageError);
  });
});
