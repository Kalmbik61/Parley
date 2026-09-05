import type { SessionIndex } from '@harnas/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './app.js';

const STUB = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'stub-agent.mjs',
);

const ENTER = '\r';
/** Заголовок правой панели: он рисуется в той же строке кадра, что и SESSIONS. */
const rightHeader = (frame: string): string => {
  const line = frame.split('\n').find((item) => item.includes('SESSIONS')) ?? '';
  return (
    line
      .split('│')
      .filter((cell) => cell.trim() !== '')
      .at(-1) ?? ''
  );
};

/** Префикс харнесса по умолчанию — Ctrl+Q (дизайн TUI v2, 3.1). */
const PREFIX = String.fromCharCode(0x11);
/** Единственное подключённое действие: `s` — фокус в списки (сайдбар придёт позже). */
const TO_LISTS = `${PREFIX}s`;

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
    lastUserRecordAt: null,
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

/**
 * Ink подписывается на stdin в эффекте после монтирования, а stdin в тестах —
 * заглушка: запись до подписки теряется молча. Ждём саму подписку, а не паузу.
 */
const mounted = async (stdin: { listenerCount: (event: string) => number }): Promise<void> => {
  await waitFor(() => stdin.listenerCount('readable') > 0);
};

/**
 * Домашняя папка харнесса и проект — во временных каталогах: App читает работы,
 * и настоящие ~/.harnas и <cwd>/.harnas тесты не касаются.
 */
let home = '';
let project = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
  process.env['HARNAS_HOME'] = home;
});

afterEach(async () => {
  delete process.env['HARNAS_HOME'];
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('маршрутизация ввода в PTY', () => {
  let root: string;
  const original = process.env['HARNAS_CLAUDE_BIN'];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'harnas-input-'));
    process.env['HARNAS_CLAUDE_BIN'] = STUB;
  });

  afterEach(async () => {
    if (original === undefined) delete process.env['HARNAS_CLAUDE_BIN'];
    else process.env['HARNAS_CLAUDE_BIN'] = original;
    await rm(root, { recursive: true, force: true });
  });

  const openTerminal = async (sessions: SessionIndex[]): Promise<ReturnType<typeof render>> => {
    const app = render(<App sessions={sessions} root={root} projectPath={project} />);
    await waitFor(() => (app.lastFrame() ?? '').includes('Enter на сессии'));
    await mounted(app.stdin);
    app.stdin.write(ENTER);
    await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));
    return app;
  };

  it('обычный ввод уходит агенту, а не в навигацию', async () => {
    const app = await openTerminal([session()]);
    try {
      app.stdin.write('echo из-терминала\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('из-терминала'));
    } finally {
      app.unmount();
    }
  }, 25_000);

  it('q внутри терминала не выходит из TUI, а идёт агенту', async () => {
    const app = await openTerminal([session()]);
    try {
      app.stdin.write('echo q-внутри\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('q-внутри'));
      // Приложение живо: списки по-прежнему рисуются.
      expect(app.lastFrame()).toContain('SESSIONS (1)');
    } finally {
      app.unmount();
    }
  }, 25_000);

  it('префикс с действием s возвращает фокус спискам, и навигация снова работает', async () => {
    const app = await openTerminal([
      session({ id: 'a', title: 'первая' }),
      session({ id: 'b', title: 'вторая' }),
    ]);
    try {
      app.stdin.write(TO_LISTS);
      await new Promise((resolve) => setTimeout(resolve, 150));

      // j снова двигает список, а не уходит в PTY: выбор видно по тому, какую
      // сессию открывает Enter — стрелки у строки больше нет (дизайн 6.2).
      app.stdin.write('j');
      await new Promise((resolve) => setTimeout(resolve, 150));
      app.stdin.write(ENTER);
      await waitFor(() => rightHeader(app.lastFrame() ?? '').includes('вторая'));
    } finally {
      app.unmount();
    }
  }, 25_000);

  it('префикс в середине чанка: до него и после действия ввод уходит агенту', async () => {
    const app = await openTerminal([session()]);
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
  }, 25_000);
});

describe('терминал без живого процесса не держит фокус', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'harnas-noagent-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('Tab проходит панель терминала насквозь, пока там плейсхолдер', async () => {
    const app = render(<App sessions={[session()]} root={root} projectPath={project} />);
    try {
      await waitFor(() => (app.lastFrame() ?? '').includes('Enter на сессии'));
      await mounted(app.stdin);

      // sessions → subsessions → terminal → sessions
      app.stdin.write('\t');
      app.stdin.write('\t');
      app.stdin.write('\t');
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Фокус вернулся к спискам: j снова двигает выбор.
      app.stdin.write('j');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(app.lastFrame()).toContain('SESSIONS (1)');
    } finally {
      app.unmount();
    }
  }, 25_000);
});
