/**
 * Generate the composer's pydantic models from the JSON Schema bundle.
 *
 * `pnpm --filter protocol gen:python`, and part of `make build`. The output under
 * `apps/composer/src/composer/protocol/` is committed: it is source the composer imports and
 * that `mypy --strict` checks, and reviewing a contract change means reviewing both sides of
 * it in the same diff.
 *
 * The pipeline is: emit the bundle → run datamodel-code-generator → drop the generator's
 * artificial document-root model → format and lint with the composer's own ruff configuration.
 * Every step fails loudly; nothing is patched up silently.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emitSchema } from './emit-schema.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(packageRoot, '..', '..');
const composerRoot = join(repoRoot, 'apps', 'composer');
const outputDir = join(composerRoot, 'src', 'composer', 'protocol');
const modelsPath = join(outputDir, 'models.py');
const fixturesPath = join(composerRoot, 'tests', 'protocol_fixtures.json');

/**
 * datamodel-code-generator emits a model for the document root itself. Our bundle has no root
 * type — it is a container of `$defs` — so that model is always this exact untyped stub. It is
 * removed rather than shipped, because a `Model(RootModel[Any])` sitting at the top of the
 * contract is the kind of thing a reader assumes is meaningful.
 *
 * The match is exact on purpose: if a generator upgrade changes the stub, this script fails
 * instead of leaving something unexpected in place.
 */
const ROOT_MODEL_STUB = 'class Model(RootModel[Any]):\n    root: Any\n\n\n';

const HEADER = `# Generated from packages/protocol by \`pnpm --filter protocol gen:python\`.
# Do not edit. Change the Zod schemas in packages/protocol/src and regenerate.
#
# The TypeScript side is the source of truth for every shape here; this file exists so the
# composer cannot drift from it. Field names are snake_case with the wire name as an alias,
# and every model accepts either form (\`populate_by_name\`).
`;

function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, [...args], { cwd, stdio: 'inherit' });
  if (result.error !== undefined) {
    throw new Error(`failed to start ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${String(result.status)}`);
  }
}

async function generate(): Promise<void> {
  const schemaPath = await emitSchema();
  await mkdir(outputDir, { recursive: true });

  run(
    'uv',
    [
      'run',
      'datamodel-codegen',
      '--input',
      schemaPath,
      '--input-file-type',
      'jsonschema',
      '--output',
      modelsPath,
      '--output-model-type',
      'pydantic_v2.BaseModel',
      '--target-python-version',
      '3.13',
      // Idiomatic Python field names, with the camelCase wire name kept as an alias.
      '--snake-case-field',
      '--allow-population-by-field-name',
      // `list`/`dict` and `X | None` rather than typing.List / Optional[X].
      '--use-standard-collections',
      '--use-union-operator',
      // Schema descriptions become docstrings; `title` on a union member names its class,
      // which is what turns `Constraint1..Constraint5` into `ConstraintEquals` and friends.
      '--use-schema-description',
      '--use-title-as-name',
      '--capitalise-enum-members',
      // Primitives carry a title so an array of them generates `list[ElementKey]` rather than
      // a wrapper named after a field. In scalar position that same title would produce a
      // pointless `RootModel[str]` indirection; collapsing folds those back to the plain type
      // with their constraints intact.
      '--collapse-root-models',
      // Without these the generator emits a fresh `NonEmptyString8`, `NonEmptyString28`, … for
      // every array that holds the same primitive, and the numbering shifts whenever a schema
      // is added — turning an unrelated contract change into a churn of renames. Deduplicated
      // by replacing the references, not by subclassing.
      '--reuse-model',
      '--collapse-reuse-models',
      // Constraints as Annotated metadata, so they survive inside `list[...]` and `X | None`.
      '--use-annotated',
      // Emit min/max/pattern as Field(...) constraints rather than constrained subtypes,
      // which keeps the models readable and mypy-clean.
      '--field-constraints',
      // The output is committed; a timestamp would make every regeneration a diff.
      '--disable-timestamp',
      '--formatters',
      'black',
      '--formatters',
      'isort',
    ],
    composerRoot,
  );

  const generated = await readFile(modelsPath, 'utf8');
  if (!generated.includes(ROOT_MODEL_STUB)) {
    throw new Error(
      `expected the generator's document-root stub in ${modelsPath} but did not find it; ` +
        'datamodel-code-generator output has changed and gen-python.ts needs updating',
    );
  }

  await writeFile(modelsPath, HEADER + generated.replace(ROOT_MODEL_STUB, ''), 'utf8');

  // ruff owns the final shape of the file so it matches the rest of the composer. `--fix`
  // applies only the mechanical modernisations the generator does not target at 3.13 (PEP 695
  // type aliases, `typing` over `typing_extensions`); the unfixed `check` afterwards is the
  // real gate, and it proves the generated file satisfies the same rules as hand-written code
  // — including the unused-import rule, which is what would catch the stripped root stub
  // taking an import with it.
  run('uv', ['run', 'ruff', 'check', '--fix-only', modelsPath], composerRoot);
  run('uv', ['run', 'ruff', 'format', modelsPath], composerRoot);
  run('uv', ['run', 'ruff', 'check', modelsPath], composerRoot);

  await writeConformanceFixtures();

  process.stdout.write(`generated ${relative(repoRoot, modelsPath)}\n`);
}

/**
 * Export the TypeScript fixtures so the composer's test suite can validate the *same* payloads
 * against the generated models.
 *
 * Matching schemas is a weaker claim than it sounds: two sides can agree on a shape and still
 * disagree about whether a given payload satisfies it. This file is what turns the drift
 * guarantee into something executable on the Python side.
 *
 * Only the valid payloads are exported. Several invalid fixtures fail on cross-field
 * refinements that JSON Schema cannot express — the reversibility rules on `ActionRequest`
 * above all — so a shared rejection suite would assert something that is deliberately not
 * true of the generated models.
 */
async function writeConformanceFixtures(): Promise<void> {
  const { FIXTURES } = await import('../src/fixtures.js');

  const payloads = Object.fromEntries(
    Object.entries(FIXTURES)
      .map(([id, fixture]) => [id, fixture.valid] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

  await writeFile(fixturesPath, `${JSON.stringify(payloads, null, 2)}\n`, 'utf8');
}

await generate();
