import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {ignores: ['**/dist/', '**/node_modules/', 'smoke/state/']},
    eslint.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname
            }
        }
    },
    {
        files: ['**/*.js', '**/*.mjs'],
        ...tseslint.configs.disableTypeChecked
    },
    {
        // node:test's test() returns a promise the runner itself awaits.
        files: ['**/*.test.ts', '**/test-support/**'],
        rules: {
            '@typescript-eslint/no-floating-promises': 'off',
            // Tests deliberately over-guard index accesses and use async bodies for uniformity.
            '@typescript-eslint/no-unnecessary-condition': 'off',
            '@typescript-eslint/require-await': 'off'
        }
    }
);
