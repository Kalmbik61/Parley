import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

const nodeGlobals = { process: 'readonly', console: 'readonly' };

// Рендерер и прелоад окна — браузерный контекст, не node: без этих глобалов
// eslint принимает `window`/`document` за неопределённые переменные.
const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  ResizeObserver: 'readonly',
  HTMLElement: 'readonly',
  globalThis: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      'claude-export/**',
      'packages/desktop/out/**',
      // Интерактивный прототип комнат — пользовательский, со своей сборкой; не код окна.
      // Vitest окна его уже исключает (`packages/desktop/vitest.config.ts`).
      'packages/desktop/prototype/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  { languageOptions: { globals: nodeGlobals } },
  {
    files: ['packages/desktop/src/renderer/**', 'packages/desktop/src/preload/**'],
    languageOptions: { globals: browserGlobals },
  },
  // Код входа `@parley/protocol/remote` исполняется в Hermes и браузере: без Node (спека 3.1).
  {
    files: ['packages/protocol/src/remote/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Buffer', message: 'Hermes and browsers have no Buffer; use Uint8Array.' },
        { name: 'process', message: 'Hermes and browsers have no process.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'No Node built-ins in the remote entry.' },
            { group: ['../framing.js', '../index.js'], message: 'The protocol root pulls Buffer; use import type only.' },
          ],
        },
      ],
    },
  },
  // Тесты входа проверяют его в процессе Node (сборка, импорт без Buffer) и сверяют списки с корнем протокола.
  {
    files: ['packages/protocol/src/remote/**/*.test.ts'],
    rules: { 'no-restricted-globals': 'off', 'no-restricted-imports': 'off' },
  },
  // `@parley/noise` идёт в Hermes и браузер, как вход remote: без Buffer, process и node:* (план §0, A3).
  {
    files: ['packages/noise/src/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Buffer', message: 'Hermes and browsers have no Buffer; use Uint8Array.' },
        { name: 'process', message: 'Hermes and browsers have no process.' },
      ],
      'no-restricted-imports': ['error', { patterns: [{ group: ['node:*'], message: 'No Node built-ins in @parley/noise.' }] }],
    },
  },
  // `@parley/remote-client` идёт в Hermes: без Buffer, process и node:*; из корней `@parley/core` и `@parley/protocol` — только типы (план A11, A12 п. 5).
  {
    files: ['packages/remote-client/src/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Buffer', message: 'Hermes has no Buffer; use Uint8Array.' },
        { name: 'process', message: 'Hermes has no process.' },
      ],
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@parley/core', message: 'Use @parley/core/* subpaths.', allowTypeImports: true },
            { name: '@parley/protocol', message: 'The protocol root pulls Buffer; use @parley/protocol/remote or import type.', allowTypeImports: true },
          ],
          patterns: [{ group: ['node:*'], message: 'No Node built-ins in @parley/remote-client.' }],
        },
      ],
    },
  },
  // Скрипты выбора и меток (кусок 9.3a, этап B браузера) лежат в src/main, но исполняются в странице гостя.
  {
    files: ['packages/desktop/src/main/browser/guest-pick.js', 'packages/desktop/src/main/browser/guest-dom.js', 'packages/desktop/src/main/browser/guest-annotate.js'],
    languageOptions: {
      globals: { ...browserGlobals, getComputedStyle: 'readonly', CSS: 'readonly', NodeFilter: 'readonly', Element: 'readonly', performance: 'readonly' },
    },
  },
);
