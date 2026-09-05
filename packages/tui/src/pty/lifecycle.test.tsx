/**
 * Жизненный цикл агента в панели (TUI v2, 2.2 и 5.1): процесс вышел — панель
 * показывает карточку `exited` с кодом выхода, а карта фиксирует переход.
 *
 * Настоящий агент не запускается никогда: вместо него stub-бинарь (specs/pty.md).
 */

import { readMap, readWorksIndex } from '@harnas/core';
import { render } from 'ink-testing-library';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pinUnicodeGlyphs } from '../../test/glyphs-env.js';
import { App } from '../app.js';

const STUB = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'stub-agent.mjs',
);

const PREFIX = String.fromCharCode(0x11);

pinUnicodeGlyphs();

const waitFor = async (check: () => boolean, timeoutMs = 8000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

let home = '';
let project = '';
let logs = '';
const previousBin = process.env['HARNAS_CLAUDE_BIN'];

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
  logs = await mkdtemp(path.join(tmpdir(), 'harnas-logs-'));
  process.env['HARNAS_HOME'] = home;
  process.env['HARNAS_CLAUDE_BIN'] = STUB;
});

afterEach(async () => {
  delete process.env['HARNAS_HOME'];
  if (previousBin === undefined) delete process.env['HARNAS_CLAUDE_BIN'];
  else process.env['HARNAS_CLAUDE_BIN'] = previousBin;
  await Promise.all([home, project, logs].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Панель с живым stub: `prefix c` заводит работу и сразу подключает агента. */
const withAgent = async (): Promise<ReturnType<typeof render>> => {
  const app = render(<App sessions={[]} root={logs} codexRoot={logs} projectPath={project} />);
  await waitFor(() => app.stdin.listenerCount('data') > 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  app.stdin.write(`${PREFIX}c`);
  await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));
  return app;
};

describe('жизненный цикл агента', () => {
  it('выход процесса переводит сессию в exited и показывает её карточку', async () => {
    const app = await withAgent();
    try {
      // Ввод идёт гостю: команда `exit` завершает stub с нужным кодом.
      app.stdin.write('exit 3\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('Enter — возобновить'));

      const frame = app.lastFrame() ?? '';
      expect(frame).toContain('exited');
      expect(frame).toContain('код 3');
      // Экран умершего агента панель уже не показывает.
      expect(frame).not.toContain('stub готов');

      const { works } = await readWorksIndex();
      const workId = works[0]?.id as string;
      const session = (await readMap(project, workId)).sessions[0];
      expect(session?.status).toBe('exited');
      expect(session?.history.at(-1)).toMatchObject({ status: 'exited', exitCode: 3 });
    } finally {
      app.unmount();
    }
  }, 30_000);
});
