/**
 * Маршрутизация ввода в живой панели (дизайн TUI v2, 3.1): всё уходит гостю,
 * префикс перехватывается в любом месте чанка. Байтовые случаи 16–21 живут в
 * `use-prefix-input.test.ts`; здесь проверяется целая композиция со stub-агентом.
 */

import { render } from 'ink-testing-library';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './app.js';

const STUB = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'stub-agent.mjs',
);

const PREFIX = String.fromCharCode(0x11);

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
  // Stub мог дописывать файлы работы в момент уборки: без повторов `rm` падает
  // с ENOTEMPTY, когда каталог пополнился между чтением и удалением.
  const clean = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 };
  await Promise.all([home, project, logs].map((dir) => rm(dir, clean)));
});

/** Панель с живым stub: `prefix c` заводит работу и сразу подключает агента (5.1). */
const withAgent = async (): Promise<ReturnType<typeof render>> => {
  const app = render(<App sessions={[]} root={logs} codexRoot={logs} projectPath={project} />);
  await waitFor(() => app.stdin.listenerCount('data') > 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  app.stdin.write(`${PREFIX}c`);
  await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));
  return app;
};

describe('ввод панели', () => {
  it('обычный ввод уходит агенту, включая занятые прежде клавиши', async () => {
    const app = await withAgent();
    try {
      app.stdin.write('echo из-панели\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('из-панели'));

      // `q` без префикса — обычный символ гостя, а не выход из харнесса.
      app.stdin.write('echo q-внутри\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('q-внутри'));
    } finally {
      app.unmount();
    }
  }, 30_000);

  it('префикс в середине чанка: до него и после действия ввод уходит агенту', async () => {
    const app = await withAgent();
    try {
      // `z` действием не занята: префикс отменяется молча, сама клавиша гостю не
      // уходит, а всё, что после неё, — снова обычный ввод агента.
      app.stdin.write(`echo до-префикса\r${PREFIX}zecho после-префикса\r`);
      await waitFor(() => (app.lastFrame() ?? '').includes('до-префикса'));
      await waitFor(() => (app.lastFrame() ?? '').includes('после-префикса'));
      expect(app.lastFrame()).not.toContain('zecho');
    } finally {
      app.unmount();
    }
  }, 30_000);
});
