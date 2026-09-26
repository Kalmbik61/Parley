import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Компоненты сайдбара (кусок 1.10) — .tsx с автоматическим JSX-рантаймом,
  // как в electron.vite.config.ts; без этого esbuild берёт классический
  // трансформ и ждёт глобальный `React`, которого в модуле нет.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    // Рендерер понадобится jsdom, начиная с куска 1.10 — остальной код (main,
    // preload, shared) тестируется как обычный node-процесс.
    environmentMatchGlobs: [['src/renderer/**', 'jsdom']],
    // `dist/**` — вывод `electron-builder` (кусок 1.13): внутри упакованного
    // `.app` лежит `pnpm deploy` хоста целиком, вместе с его `*.test.ts` —
    // без исключения vitest пытается прогнать их тут, под чужим tsconfig.
    exclude: ['**/node_modules/**', 'e2e/**', 'out/**', 'dist/**'],
  },
});
