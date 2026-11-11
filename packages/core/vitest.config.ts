import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Дом тестового процесса — временный каталог: см. `test/sandbox-home.ts`.
    setupFiles: ['./test/sandbox-home.ts'],
    // Корень домов на прогон: создаёт и убирает главный процесс (см. `sandbox-home-root.ts`).
    globalSetup: ['./test/sandbox-home-root.ts'],
  },
});
