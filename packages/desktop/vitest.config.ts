import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Рендерер понадобится jsdom, начиная с куска 1.10 — остальной код (main,
    // preload, shared) тестируется как обычный node-процесс.
    environmentMatchGlobs: [['src/renderer/**', 'jsdom']],
    exclude: ['**/node_modules/**', 'e2e/**', 'out/**'],
  },
});
