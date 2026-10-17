import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Дом тестового процесса — временный каталог: стенд токен-бенчмарка зовёт `discoverSessions` → `parleyHome()`,
    // а без песочницы под vitest тот отвергает настоящий дом (см. `packages/core/test/sandbox-home.ts`).
    setupFiles: ['../packages/core/test/sandbox-home.ts'],
  },
});
