import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.venv/**',
      'apps/console/.next/**',
      'apps/console/next-env.d.ts',
      // Parallel-track git worktrees are created under `.claude/worktrees/`, inside the
      // repository. Each is a full checkout, so without this the type-checked rules load every
      // copy's program at once and eslint dies with a V8 heap abort rather than a lint error.
      // Each worktree lints itself, on its own branch, in CI.
      '.claude/**',
    ],
  },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Resolves each file against the nearest tsconfig, so type-aware rules work
        // across every workspace package without listing projects here.
        // Every linted file belongs to a real tsconfig — including each package's
        // vitest.config.ts. The inferred default project would silently drop strictNullChecks
        // and disable half the type-aware rules, so nothing is allowed to fall back to it.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `const { omitted: _omitted, ...rest }` is how these tests build an invalid environment
      // from a valid one. The underscore prefix marks the discard as deliberate.
      // `non-nullable-type-assertion-style` (stylistic) tells you to replace `x as T` with `x!`,
      // and `no-non-null-assertion` (strict) forbids `x!`. Left on together they are a loop with
      // no exit. The safety rule wins: a `!` hides a real possibility of undefined at runtime,
      // whereas a narrow, commented `as` on a provably in-bounds typed-array read does not.
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',

      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // `packages/fingerprint` is shared verbatim by the extension and the Playwright indexer
  // (CLAUDE.md rule #4), so it may use standard DOM APIs and nothing else. Node types are on for
  // the SHA-256 test, which checks our implementation against the platform's; this keeps that
  // from leaking into code that has to run in a content script.
  {
    files: ['packages/fingerprint/src/**/*.ts'],
    ignores: ['packages/fingerprint/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message:
                'packages/fingerprint runs in a browser content script — Node built-ins are unavailable there.',
            },
          ],
        },
      ],
    },
  },

  // Files written by a generator, not by a person. `kysely-codegen` emits its `JsonObject` as a
  // `type` alias, which `consistent-type-definitions` objects to — and "fixing" it would be undone
  // by the next `make db-codegen`, whose diff check then fails the build. The contents are
  // verified against the live database by that same target, which is a stronger guarantee than a
  // style rule. Correctness rules still apply; only the stylistic one is switched off.
  {
    files: ['**/src/db/schema.generated.ts'],
    rules: {
      '@typescript-eslint/consistent-type-definitions': 'off',
    },
  },

  // Config files at the repo root are plain JS and belong to no tsconfig.
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Prettier owns formatting; this must stay last so it can switch off conflicting rules.
  prettier,
);
