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
  // Скрипты выбора и меток (кусок 9.3a, этап B браузера) лежат в src/main, но исполняются в странице гостя.
  {
    files: ['packages/desktop/src/main/browser/guest-pick.js', 'packages/desktop/src/main/browser/guest-dom.js', 'packages/desktop/src/main/browser/guest-annotate.js'],
    languageOptions: {
      globals: { ...browserGlobals, getComputedStyle: 'readonly', CSS: 'readonly', NodeFilter: 'readonly', Element: 'readonly', performance: 'readonly' },
    },
  },
);
