import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The T9a replay RUN: one file, which judges every frozen goal on real processes. The routine `tools` run excludes it by name (vitest.config.ts); the gate script
// runs it explicitly with this config. Retry is 0 and pinned: a retried attempt would hide a flaky arm. Nothing here skips or excludes a test.
export default defineConfig({
  // the root is this directory whatever the working directory is, so `--config tools/vitest.replay-run.config.ts` from the repository root finds the one run file
  root: path.dirname(fileURLToPath(import.meta.url)),
  test: {
    include: ['parley-token-benchmark-replay.run.test.ts'],
    setupFiles: ['../packages/core/test/sandbox-home.ts'],
    retry: 0,
    testTimeout: 30 * 60_000,
    hookTimeout: 5 * 60_000,
  },
});
