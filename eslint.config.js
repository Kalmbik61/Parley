import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

const nodeGlobals = { process: 'readonly', console: 'readonly' };

export default tseslint.config(
  { ignores: ['**/dist/**', 'claude-export/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  { languageOptions: { globals: nodeGlobals } },
);
