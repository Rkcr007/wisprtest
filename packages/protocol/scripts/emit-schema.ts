/**
 * Write the JSON Schema bundle to `dist/schema.json`.
 *
 * Runs as the second half of `pnpm --filter protocol build`, after `tsc` has produced `dist/`.
 * The bundle is the published artifact the pydantic generator consumes and the only file any
 * non-TypeScript consumer needs.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { protocolSchemas, toJsonSchemaBundle } from '../src/index.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA_OUTPUT_PATH = join(packageRoot, 'dist', 'schema.json');

export async function emitSchema(): Promise<string> {
  const bundle = toJsonSchemaBundle();
  const definitionCount = Object.keys(bundle.$defs).length;

  if (definitionCount !== protocolSchemas().size) {
    throw new Error(
      `bundle holds ${String(definitionCount)} definitions but ` +
        `${String(protocolSchemas().size)} schemas are registered`,
    );
  }

  await mkdir(dirname(SCHEMA_OUTPUT_PATH), { recursive: true });
  await writeFile(SCHEMA_OUTPUT_PATH, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  return SCHEMA_OUTPUT_PATH;
}

const path = await emitSchema();
process.stdout.write(`wrote ${path} (${String(protocolSchemas().size)} definitions)\n`);
