import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Дом тестового процесса — временный каталог: см. `test/sandbox-home.ts`.
    // Уровень темы фиксируется отдельно от `chalk.level`: см. `test/theme-env.ts`.
    setupFiles: ['./test/sandbox-home.ts', './test/theme-env.ts'],
  },
});
