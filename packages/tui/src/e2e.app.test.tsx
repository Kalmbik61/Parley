/**
 * E2E со stub-бинарём: полный цикл состояний по событиям хуков, живость после
 * перезапуска и мышь (чек-лист спецификации TUI v2, пункты 34–36), тихий старт
 * до отчёта и удаление сессии (чек-лист плана от 2026-09-06, пункты 35–37).
 *
 * Настоящий `claude` здесь не запускается никогда: вместо него stub-бинарь,
 * а `~/.harnas`, проект и корни истории — во временных каталогах.
 */

import {
  addSession,
  createWork,
  processStartedAt,
  readMap,
  isAlive,
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
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
const ENTER = '\r';

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

/** Ожидание условия, за которым надо сходить на диск: карта или индекс работ. */
const waitFor2 = async (check: () => Promise<boolean>, timeoutMs = 8000): Promise<void> => {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались');
    await settle(25);
  }
};

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

/**
 * Один вызов инструмента у настоящего MCP-сервера сессии: сервер поднимается той
 * же командой из `mcp/<id>.json`, что и у агента, и говорит по stdio JSON-RPC.
 * Так `report` доходит до карты тем же путём, что в жизни.
 */
async function callTool(
  configFile: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const config = JSON.parse(await readFile(configFile, 'utf8')) as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };
  const server = config.mcpServers['harnas'];
  if (server === undefined) throw new Error(`в ${configFile} нет сервера harnas`);

  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...server.env },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  outside.push(child);
  try {
    const answer = new Promise<string>((resolve, reject) => {
      let buffer = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let at = buffer.indexOf('\n');
        while (at !== -1) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          const message = JSON.parse(line) as { id?: number; result?: unknown };
          if (message.id === 2) resolve(JSON.stringify(message.result));
          at = buffer.indexOf('\n');
        }
      });
      child.on('exit', () => reject(new Error('MCP-сервер вышел без ответа')));
    });

    const send = (message: unknown): void => {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    };
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '0.0.0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
    return await answer;
  } finally {
    child.kill('SIGKILL');
  }
}

describe('план 2026-09-06, пункт 37: тихий старт доходит до отчёта', () => {
  it('prefix C → пользователь пишет → ход идёт → report → done', async () => {
    const app = open();
    try {
      await mounted(app.stdin);
      await launch(app);
      const workId = await firstWorkId();
      const plan = await waitSession(workId, (item) => item.status === 'active');
      await rename(workId, plan.id, 'план');
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'план') !== '');

      app.stdin.write(`${PREFIX}C`);
      const child = await waitSession(workId, (item) => item.id !== plan.id);
      await waitFor(() => (app.lastFrame() ?? '').includes(`harnas=${child.id}@`));
      await rename(workId, child.id, 'ревью');
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'ревью') !== '');
      // Задачи у тихой сессии нет: пока пользователь молчит, хода тоже нет.
      expect(child.task).toBe('');
      expect(lineWith(app.lastFrame() ?? '', 'ревью')).not.toContain('working');

      // Первое сообщение пользователя — хук `UserPromptSubmit` (4.2).
      app.stdin.write(`event ${JSON.stringify({ hook_event_name: 'UserPromptSubmit' })}\r`);
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'ревью').includes('working'));

      // Агент отчитался своим MCP-сервером: сессия уходит в `done` с резюме.
      const mcpConfig = path.join(workPaths(project, workId).mcp, `${child.id}.json`);
      const answer = await callTool(mcpConfig, 'report', {
        status: 'done',
        summary: 'ревью прошло',
      });
      expect(answer).toContain('done');

      const done = await waitSession(
        workId,
        (item) => item.id === child.id && item.status === 'done',
      );
      expect(done.summary).toBe('ревью прошло');
      expect(done.summarySource).toBe('agent');
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'ревью').includes('done'));
    } finally {
      app.unmount();
    }
  }, 40_000);
});

describe('план 2026-09-06, пункт 35: удаление живой сессии с детьми (макет 4.10)', () => {
  it('SIGHUP → выход → дети поднялись, сайдбар и панель обновились', async () => {
    const app = open();
    try {
      await mounted(app.stdin);
      await launch(app);
      const workId = await firstWorkId();
      const plan = await waitSession(workId, (item) => item.status === 'active');
      await rename(workId, plan.id, 'план');
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'план') !== '');

      app.stdin.write(`${PREFIX}C`);
      const child = await waitSession(workId, (item) => item.id !== plan.id);
      await rename(workId, child.id, 'ревью');
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'ревью') !== '');

      // Обратно на родителя: его PTY у харнесса, панель показывает его гостя.
      app.stdin.write(`${PREFIX}k`);
      await waitFor(() => (app.lastFrame() ?? '').includes(`harnas=${plan.id}@`));
      const pid = (await waitSession(workId, (item) => item.id === plan.id)).pid as number;
      expect(isAlive(pid)).toBe(true);

      app.stdin.write(`${PREFIX}d`);
      await waitFor(() => (app.lastFrame() ?? '').includes('Enter — удалить'));
      await settle(150);
      app.stdin.write(ENTER);

      // Процесс получил SIGHUP и вышел, и только потом исчезла запись.
      await waitFor2(async () => (await readMap(project, workId)).sessions.length === 1);
      expect(isAlive(pid)).toBe(false);

      const map = await readMap(project, workId);
      expect(map.sessions[0]?.id).toBe(child.id);
      expect(map.sessions[0]?.parent).toBeNull();

      // Сайдбар и панель догнали карту: строки удалённой нет, экран не её.
      await waitFor(() => lineWith(app.lastFrame() ?? '', 'план') === '');
      expect(app.lastFrame()).not.toContain(`harnas=${plan.id}@`);
      expect(app.lastFrame()).toContain('ревью');
    } finally {
      app.unmount();
    }
  }, 40_000);
});

describe('план 2026-09-06, пункт 36: сессия не слышит SIGHUP', () => {
  it('через три секунды уходит SIGKILL, и только тогда удаляется запись', async () => {
    const app = open();
    try {
      await mounted(app.stdin);
      await launch(app);
      const workId = await firstWorkId();
      const session = await waitSession(workId, (item) => item.status === 'active');
      const pid = session.pid as number;

      // Stub перестаёт слушать мягкое завершение: выйти он сам не согласится.
      app.stdin.write('deaf\r');
      await waitFor(() => (app.lastFrame() ?? '').includes('deaf'));

      app.stdin.write(`${PREFIX}d`);
      await waitFor(() => (app.lastFrame() ?? '').includes('Enter — удалить'));
      await settle(150);
      const started = Date.now();
      app.stdin.write(ENTER);

      await waitFor2(async () => (await readMap(project, workId)).sessions.length === 0, 15_000);
      // Ждали выхода, а не убили сразу: запись пережила SIGHUP на три секунды.
      expect(Date.now() - started).toBeGreaterThanOrEqual(2500);
      expect(isAlive(pid)).toBe(false);
    } finally {
      app.unmount();
    }
  }, 40_000);
});
