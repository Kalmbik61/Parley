import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Дом тестового процесса — временный каталог: см. `test/sandbox-home.ts`.
    setupFiles: ['./test/sandbox-home.ts'],
  },
});
