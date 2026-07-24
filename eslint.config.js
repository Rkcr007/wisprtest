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

  // Config files at the repo root are plain JS and belong to no tsconfig.
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Prettier owns formatting; this must stay last so it can switch off conflicting rules.
  prettier,
);
