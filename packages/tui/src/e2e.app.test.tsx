/**
 * E2E со stub-бинарём (чек-лист спецификации TUI v2, пункты 34–36): полный цикл
 * состояний по событиям хуков, живость после перезапуска и мышь.
 *
 * Настоящий `claude` здесь не запускается никогда: вместо него stub-бинарь,
 * а `~/.harnas`, проект и корни истории — во временных каталогах.
 */

import {
  addSession,
  createWork,
  processStartedAt,
  readMap,
  readWorksIndex,
  transitionSession,
  updateMap,
  workPaths,
  type SessionIndex,
  type WorkSession,
} from '@harnas/core';
import { render } from 'ink-testing-library';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pinUnicodeGlyphs } from '../test/glyphs-env.js';
import { App } from './app.js';

const STUB = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'stub-agent.mjs',
);

/** Префикс харнесса (дизайн 3.1–3.2). */
const PREFIX = String.fromCharCode(0x11);

pinUnicodeGlyphs();

let home = '';
let project = '';
let logs = '';
/** Процессы, поднятые мимо харнесса: их гасит уборка, а не unmount. */
let outside: ChildProcess[] = [];
const previousBin = process.env['HARNAS_CLAUDE_BIN'];

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
  logs = await mkdtemp(path.join(tmpdir(), 'harnas-logs-'));
  outside = [];
  process.env['HARNAS_HOME'] = home;
  process.env['HARNAS_CLAUDE_BIN'] = STUB;
});

afterEach(async () => {
  for (const child of outside) child.kill('SIGKILL');
  delete process.env['HARNAS_HOME'];
  if (previousBin === undefined) delete process.env['HARNAS_CLAUDE_BIN'];
  else process.env['HARNAS_CLAUDE_BIN'] = previousBin;
  // Stub мог дописывать файлы работы в момент уборки: без повторов `rm` падает
  // с ENOTEMPTY, когда каталог пополнился между чтением и удалением.
  const clean = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 };
  await Promise.all([home, project, logs].map((dir) => rm(dir, clean)));
});

const waitFor = async (check: () => boolean, timeoutMs = 8000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Ink подписывается на stdin эффектом: до подписки запись теряется молча. */
const mounted = async (stdin: { listenerCount: (event: string) => number }): Promise<void> => {
  await waitFor(() => stdin.listenerCount('data') > 0 || stdin.listenerCount('readable') > 0);
  await settle(100);
};

const lineWith = (frame: string, text: string): string =>
  frame.split('\n').find((line) => line.includes(text)) ?? '';

const open = (sessions: SessionIndex[] = []): ReturnType<typeof render> =>
  render(<App sessions={sessions} root={logs} codexRoot={logs} projectPath={project} />);

/** Ждём состояния карты: запись идёт после кадра с запущенным агентом. */
const waitSession = async (
  workId: string,
  pick: (session: WorkSession) => boolean,
  timeoutMs = 8000,
): Promise<WorkSession> => {
  const started = Date.now();
  for (;;) {
    const found = (await readMap(project, workId)).sessions.find(pick);
    if (found !== undefined) return found;
    if (Date.now() - started > timeoutMs) throw new Error('карта не дождалась');
    await settle(25);
  }
};

const firstWorkId = async (): Promise<string> => {
  const { works } = await readWorksIndex();
  const first = works[0];
  if (first === undefined) throw new Error('работ нет');
  return first.id;
};

/** Ярлык руками: обе быстрые сессии зовутся одинаково, а в кадре их надо различать. */
const rename = async (workId: string, sessionId: string, label: string): Promise<void> => {
  await updateMap(project, workId, (map) => {
    const session = map.sessions.find((item) => item.id === sessionId);
    if (session !== undefined) session.label = label;
  });
};

/** `prefix c`: работа заводится сама, stub стартует и сразу подключается (5.1). */
const launch = async (app: ReturnType<typeof render>): Promise<void> => {
  app.stdin.write(`${PREFIX}c`);
  await waitFor(() => (app.lastFrame() ?? '').includes('stub готов'));
  // Работа приходит из watcher: до её кадра клавишам харнесса не о чем говорить.
  await waitFor(() => (app.lastFrame() ?? '').includes('сессии · '));
  await settle(100);
};

describe('34: полный цикл состояний по событиям хуков (4.1, 4.2)', () => {
  it('new → события stub → working → blocked → unseen → подключение → idle', async () => {
    const app = open();
    try {
      await mounted(app.stdin);
      await launch(app);
      const workId = await firstWorkId();
      const plan = await waitSession(workId, (item) => item.status === 'active');
      await rename(workId, plan.id, 'план');
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'план') !== '');

      // Хук `UserPromptSubmit` пишет stub — тем же `>> events/<сессия>.jsonl`.
      app.stdin.write(`event ${JSON.stringify({ hook_event_name: 'UserPromptSubmit' })}\r`);
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'план').includes('working'));

      app.stdin.write(
        `event ${JSON.stringify({
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
        })}\r`,
      );
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'план').includes('blocked'));

      // Панель уезжает на вторую сессию: ход, законченный без нас, — `unseen`.
      app.stdin.write(`${PREFIX}c`);
      const second = await waitSession(workId, (item) => item.id !== plan.id);
      await waitFor(() => (app.lastFrame() ?? '').includes(`harnas=${second.id}@`));

      // Журнал по-прежнему пишет stub по команде со stdin, но уже второй: stdin
      // достаётся подключённой сессии, а работа и каталог `events/` общие.
      app.stdin.write(`event ${plan.id} ${JSON.stringify({ hook_event_name: 'Stop' })}\r`);
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'план').includes('unseen'));

      // Подключение к панели гасит `unseen` (4.1). Экран самого гостя при
      // возврате пуст до первого нового байта — см. openIssues про буфер PTY.
      app.stdin.write(`${PREFIX}k`);
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'план').includes('idle'));
    } finally {
      app.unmount();
    }
  }, 40_000);
});

describe('35: живость после перезапуска харнесса (5.4)', () => {
  /** Живая сессия, поднятая мимо харнесса: pid и время старта записаны в карту. */
  const outsideSession = async (): Promise<{ workId: string; id: string; child: ChildProcess }> => {
    const created = await createWork(project, { title: 'Авторизация' });
    const workId = created.work.id;
    let id = '';
    await updateMap(project, workId, (map) => {
      const session = addSession(map, { provider: 'claude', label: 'ревью', task: 'шаги 1–3' });
      transitionSession(map, session.id, 'active');
      id = session.id;
    });
    await mkdir(workPaths(project, workId).events, { recursive: true });

    // Настоящий процесс: живость проверяется `process.kill(pid, 0)` и временем
    // старта из ОС, а не выдумкой теста. stdin трубой — иначе stub сразу выйдет.
    const child = spawn(process.execPath, [STUB], { stdio: ['pipe', 'ignore', 'ignore'] });
    outside.push(child);
    const pid = child.pid as number;
    const startedAtProcess = await processStartedAt(pid);
    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((item) => item.id === id);
      if (session === undefined) return;
      session.pid = pid;
      session.startedAtProcess = startedAtProcess;
      session.launchedBy = 'cli';
    });
    return { workId, id, child };
  };

  it('перезапуск поверх живого stub оставляет сессию active, убитый stub → exited', async () => {
    const { workId, child } = await outsideSession();

    // Первый запуск харнесса: процесс жив, подключиться к нему нечем.
    const first = open();
    try {
      await mounted(first.stdin);
      await waitFor(() => (first.lastFrame() ?? '').includes('вне харнесса'));
    } finally {
      first.unmount();
    }
    expect((await readMap(project, workId)).sessions[0]?.status).toBe('active');

    const app = open();
    try {
      await mounted(app.stdin);
      // Перезапуск: pid и время старта совпали — сессия по-прежнему живая (5.4).
      await waitFor(() => (app.lastFrame() ?? '').includes('вне харнесса'));
      expect((await readMap(project, workId)).sessions[0]?.status).toBe('active');

      child.kill('SIGKILL');
      await once(child, 'exit');
      // Живость сверяется по событию watcher, не по таймеру: правка карты — оно.
      await updateMap(project, workId, (map) => {
        map.work.goal = 'проверка живости';
      });

      const session = await waitSession(workId, (item) => item.status === 'exited');
      expect(session.history.at(-1)?.status).toBe('exited');
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'ревью').includes('exited'));
    } finally {
      app.unmount();
    }
  }, 40_000);
});

describe('36: мышь (3.3)', () => {
  const count = (frame: string, text: string): number => frame.split(text).length - 1;

  it('клик по строке сессии подключает её, клик в панели доезжает до гостя', async () => {
    const app = open();
    try {
      await mounted(app.stdin);
      await launch(app);
      const workId = await firstWorkId();
      const plan = await waitSession(workId, (item) => item.status === 'active');
      await rename(workId, plan.id, 'план');
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'план') !== '');

      // Вторая сессия: панель у неё, и клик по первой должен её сместить.
      app.stdin.write(`${PREFIX}c`);
      const second = await waitSession(workId, (item) => item.id !== plan.id);
      await waitFor(() => (app.lastFrame() ?? '').includes(`harnas=${second.id}@`));
      // Обе строки в кадре: выбрана вторая, и клик должен попасть строго в первую.
      await waitFor(() => lineWith(app.lastFrame() ?? '', second.label) !== '');

      const y = (app.lastFrame() ?? '').split('\n').findIndex((line) => line.includes('план')) + 1;
      expect(y).toBeGreaterThan(0);
      app.stdin.write(`\u001B[<0;3;${y}M`);

      // Подключилась ли та сессия, по строке которой кликнули: событие пишет
      // stub, получивший ввод, — и точка `план` уходит в `working` только у неё.
      app.stdin.write(`event ${JSON.stringify({ hook_event_name: 'UserPromptSubmit' })}\r`);
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'план').includes('working'));

      // Гость попросил отслеживание мыши: эхо PTY и ответ stub — две строки.
      app.stdin.write('mouse on\r');
      await waitFor(() => count(app.lastFrame() ?? '', 'mouse on') >= 2);
      await settle(150);

      // Клик в панели уходит гостю с пересчётом колонки: 30 − 27 = 3. Перевод
      // строки нужен самому stub: он читает stdin построчно, а настоящий
      // полноэкранный агент держал бы raw-режим и увидел байты сразу.
      app.stdin.write('\u001B[<0;30;5M\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('mouse-event 0 3 5'));
    } finally {
      app.unmount();
    }
  }, 40_000);
});
