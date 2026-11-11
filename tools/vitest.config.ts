import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The T9a replay RUN judges every frozen goal on real processes (minutes, machine-bound): it is run explicitly by the gate script with vitest.replay-run.config.ts.
    // Two exclusions, each by name and each with its reason; the gate script runs both explicitly (the run file through vitest.replay-run.config.ts, the other under `node --test`).
    exclude: [
      ...configDefaults.exclude,
      '**/parley-token-benchmark-replay.run.test.ts', // the full replay run: minutes, machine-bound, run by the gate script
      '**/bench/window-sync/observer.test.mjs', // a node:test file (`import { test } from 'node:test'`): vitest finds no suite in it, so it runs under `node --test`
    ],
    // Дом тестового процесса — временный каталог: стенд токен-бенчмарка зовёт `discoverSessions` → `parleyHome()`,
    // а без песочницы под vitest тот отвергает настоящий дом (см. `packages/core/test/sandbox-home.ts`).
    setupFiles: ['../packages/core/test/sandbox-home.ts'],
  },
});
