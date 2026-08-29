#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OSV_IMAGE =
  'ghcr.io/google/osv-scanner:v2.5.1@sha256:8108ae94eadea5a02c9bec6e646909d5b790b44bd62d7f5b7f0b1d6d0ffc7734';

/** @typedef {{ readonly name: string, readonly run: () => void }} SecurityCheck */

function execute(command, args, options = {}) {
  const rendered = [command, ...args].join(' ');
  process.stdout.write(`\n$ ${rendered}\n`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test' },
    encoding: 'utf8',
    stdio: options.capture === true ? 'pipe' : 'inherit',
  });

  if (result.error !== undefined) {
    throw new Error(`${rendered} could not start: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    const detail =
      options.capture === true ? `\n${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd() : '';
    throw new Error(`${rendered} exited with status ${String(result.status)}${detail}`);
  }
  return result.stdout ?? '';
}

function assertExtensionPermissionJustifications() {
  const source = readFileSync(resolve(ROOT, 'apps/extension/src/manifest.ts'), 'utf8');
  const permissions = ['cookies', 'storage', 'alarms', 'offscreen', 'debugger'];

  for (const permission of permissions) {
    if (!source.includes(`\`${permission}\` —`)) {
      throw new Error(
        `extension permission "${permission}" has no adjacent manifest justification`,
      );
    }
  }
}

function requireComposeStack() {
  const running = execute('docker', ['compose', 'ps', '--status', 'running', '--services'], {
    capture: true,
  })
    .split(/\s+/)
    .filter(Boolean);
  const missing = ['postgres', 'redis'].filter((service) => !running.includes(service));
  if (missing.length > 0) {
    throw new Error(
      `Compose services are not healthy: ${missing.join(', ')}. Run "make db-up db-migrate db-seed" first.`,
    );
  }
}

/** @type {readonly SecurityCheck[]} */
const checks = [
  {
    name: 'JavaScript dependency advisories',
    run: () => execute('pnpm', ['audit', '--audit-level=high']),
  },
  {
    name: 'Python dependency advisories',
    run: () =>
      execute('docker', [
        'run',
        '--rm',
        '--volume',
        `${ROOT}:/src:ro`,
        OSV_IMAGE,
        'scan',
        'source',
        '--lockfile=/src/apps/composer/uv.lock',
      ]),
  },
  {
    name: 'Console content security policy',
    run: () =>
      execute('pnpm', [
        '--filter',
        'console',
        'exec',
        'vitest',
        'run',
        'src/security/headers.test.ts',
        'src/security/proxy.test.ts',
      ]),
  },
  {
    name: 'Extension permission review',
    run: () => {
      assertExtensionPermissionJustifications();
      execute('pnpm', ['--filter', 'extension', 'exec', 'vitest', 'run', 'src/manifest.test.ts']);
    },
  },
  {
    name: 'Log-sink customer-content redaction',
    run: () => {
      requireComposeStack();
      execute('pnpm', ['--filter', 'indexer', 'exec', 'vitest', 'run', 'src/logger.test.ts']);
      execute('pnpm', [
        '--filter',
        'gateway',
        'exec',
        'vitest',
        'run',
        '--config',
        'vitest.db.config.ts',
        'test/db/observability.test.ts',
      ]);
    },
  },
  {
    name: 'PostgreSQL row-level isolation',
    run: () => {
      requireComposeStack();
      execute('pnpm', [
        '--filter',
        'gateway',
        'exec',
        'vitest',
        'run',
        '--config',
        'vitest.db.config.ts',
        'test/db/rls.test.ts',
      ]);
    },
  },
  {
    name: 'Model-provider redaction boundary',
    run: () => {
      requireComposeStack();
      execute('pnpm', ['--filter', 'fingerprint', 'test']);
      execute('pnpm', [
        '--filter',
        'extension',
        'exec',
        'vitest',
        'run',
        'src/resolver/tier2.test.ts',
      ]);
      execute('pnpm', [
        '--filter',
        'gateway',
        'exec',
        'vitest',
        'run',
        '--config',
        'vitest.resolve.config.ts',
        'test/resolve/escalate.test.ts',
      ]);
    },
  },
];

const results = [];
for (const check of checks) {
  process.stdout.write(`\n=== ${check.name} ===\n`);
  try {
    check.run();
    results.push({ name: check.name, passed: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`FAILED: ${message}\n`);
    results.push({ name: check.name, passed: false });
  }
}

process.stdout.write('\nSecurity audit summary\n');
for (const result of results) {
  process.stdout.write(`${result.passed ? 'PASS' : 'FAIL'}  ${result.name}\n`);
}

const failures = results.filter((result) => !result.passed);
if (failures.length > 0) {
  process.stderr.write(
    `\nSecurity audit failed: ${String(failures.length)} check(s) did not pass.\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write('\nSecurity audit passed.\n');
}
