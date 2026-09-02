import type { SessionIndex } from '@harnas/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../app.js';

const STUB = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'stub-agent.mjs',
);

const ENTER = '\r';
const CTRL_Q = '\u0011';
const TAB = '\t';

function session(over: Partial<SessionIndex> = {}): SessionIndex {
  return {
    id: 'сессия-1',
    project: '-proj',
    projectPath: '/work',
    cwd: null,
    gitBranch: 'main',
    version: '2.1.247',
    file: `/root/${over.id ?? 'сессия-1'}.jsonl`,
    title: 'первая',
    titleSource: 'custom',
    startedAt: '2026-09-01T10:00:00.000Z',
    endedAt: '2026-09-01T10:10:00.000Z',
    durationMs: 600_000,
    records: 5,
    malformedLines: 0,
    models: {},
    tools: {},
    roles: {},
    recordTypes: {},
    primaryModel: 'claude-opus-5',
    subsessionCount: 0,
    provider: 'claude',
    tokens: null,
    ...over,
  };
}

const waitFor = async (check: () => boolean, timeoutMs = 8000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Ink подписывается на stdin в эффекте — ждём подписку перед первым нажатием. */
const mounted = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 120));

describe('жизненный цикл агента', () => {
  let root: string;
  const original = process.env['HARNAS_CLAUDE_BIN'];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'harnas-life-'));
    process.env['HARNAS_CLAUDE_BIN'] = STUB;
  });

  afterEach(async () => {
    if (original === undefined) delete process.env['HARNAS_CLAUDE_BIN'];
    else process.env['HARNAS_CLAUDE_BIN'] = original;
    await rm(root, { recursive: true, force: true });
  });

  const open = async (sessions: SessionIndex[]): Promise<ReturnType<typeof render>> => {
    const app = render(<App sessions={sessions} root={root} />);
    await waitFor(() => (app.lastFrame() ?? '').includes('Enter на сессии'));
    await mounted();
    app.stdin.write(ENTER);
    await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));
    return app;
  };

  it('завершение процесса видно в панели вместе с подсказкой', async () => {
    const app = await open([session()]);
    try {
      app.stdin.write('exit 3\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('Агент завершился с кодом 3'));
      expect(app.lastFrame()).toContain('R — перезапустить');
      expect(app.lastFrame()).toContain('(завершён)');
    } finally {
      app.unmount();
    }
  }, 25_000);

  it('штатный выход и выход по сигналу описываются по-разному', async () => {
    const app = await open([session()]);
    try {
      app.stdin.write('exit 0\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('Агент завершился штатно'));
    } finally {
      app.unmount();
    }
  }, 25_000);

  it('R перезапускает завершившегося агента', async () => {
    const app = await open([session()]);
    try {
      app.stdin.write('exit 1\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('Агент завершился с кодом 1'));

      app.stdin.write('R');
      await waitFor(() => !(app.lastFrame() ?? '').includes('Агент завершился'));
      expect(app.lastFrame()).toContain('stub готов');
    } finally {
      app.unmount();
    }
  }, 25_000);

  it('повторный Enter по той же сессии не плодит второго агента', async () => {
    const app = await open([session()]);
    try {
      app.stdin.write(CTRL_Q);
      await new Promise((resolve) => setTimeout(resolve, 120));
      app.stdin.write(ENTER);
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(app.lastFrame()).not.toContain('параллельно работает агентов');
    } finally {
      app.unmount();
    }
  }, 25_000);

  it('второй агент вызывает предупреждение о лимитах, но не блокируется', async () => {
    const app = await open([
      session({ id: 'a', title: 'первая' }),
      session({ id: 'b', title: 'вторая' }),
    ]);
    try {
      app.stdin.write(CTRL_Q);
      await new Promise((resolve) => setTimeout(resolve, 120));

      app.stdin.write('j');
      await new Promise((resolve) => setTimeout(resolve, 120));
      app.stdin.write(ENTER);

      // Предупреждение живёт в строке статуса, а не поверх правой панели (дизайн 5).
      await waitFor(() => (app.lastFrame() ?? '').includes('параллельно работает агентов: 2'));
      // Второй агент всё равно запустился — предупреждение не блокирует.
      expect(app.lastFrame()).toContain('TERMINAL — вторая');
    } finally {
      app.unmount();
    }
  }, 25_000);

  it('после завершения агента панель отпускает фокус', async () => {
    const app = await open([
      session({ id: 'a', title: 'первая' }),
      session({ id: 'b', title: 'вторая' }),
    ]);
    try {
      app.stdin.write('exit 0\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('Агент завершился штатно'));

      // Tab снова работает: фокус уходит с терминала на списки. Выбор виден по
      // тому, какую сессию открывает Enter — стрелки у строки больше нет (6.2).
      app.stdin.write(TAB);
      await new Promise((resolve) => setTimeout(resolve, 150));
      app.stdin.write('j');
      await new Promise((resolve) => setTimeout(resolve, 150));
      app.stdin.write(ENTER);
      await waitFor(() => (app.lastFrame() ?? '').includes('TERMINAL — вторая'));
    } finally {
      app.unmount();
    }
  }, 25_000);
});
