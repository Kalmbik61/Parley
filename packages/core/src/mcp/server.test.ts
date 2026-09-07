import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GUIDE } from '../work/guide.js';
import { addMessage, addSession, transitionSession } from '../work/map.js';
import { createWork, updateMap, workPaths } from '../work/store.js';
import type { WorkMap } from '../work/types.js';
import { contextFromEnv } from './context.js';
import {
  DEFAULT_TIMEOUT_SEC,
  MAX_TIMEOUT_SEC,
  createHarnasServer,
  waitTimeoutMs,
} from './tools.js';

let home = '';
let project = '';
let binDir = '';
let workId = '';
let savedPath: string | undefined;

/** Всё, что пришлось поднять для одного клиента: закрываем в afterEach. */
const opened: { client: Client; server: Server }[] = [];

interface Call {
  isError: boolean;
  text: string;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Call> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  return { isError: result.isError === true, text: content[0]?.text ?? '' };
}

async function callOk(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await call(client, name, args);
  expect(result.isError, result.text).toBe(false);
  return JSON.parse(result.text) as Record<string, unknown>;
}

async function connect(sessionId: string | null, pollMs = 40): Promise<Client> {
  const context = {
    projectPath: project,
    workId,
    workDir: workPaths(project, workId).dir,
    sessionId,
    pollMs,
  };
  const server = createHarnasServer(context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  opened.push({ client, server });
  return client;
}

const readMapFile = async (): Promise<WorkMap> =>
  JSON.parse(await readFile(workPaths(project, workId).map, 'utf8')) as WorkMap;

const session = (map: WorkMap, id: string) => {
  const found = map.sessions.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`нет сессии ${id}`);
  return found;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
  binDir = await mkdtemp(path.join(tmpdir(), 'harnas-bin-'));
  process.env.HARNAS_HOME = home;
  // PATH пустой, а `claude` подсунут оверрайдом: доступность провайдеров в тесте
  // не зависит от того, что стоит на машине. Настоящий бинарь не запускается.
  savedPath = process.env.PATH;
  process.env.PATH = '';
  const stub = path.join(binDir, 'claude');
  await writeFile(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.HARNAS_CLAUDE_BIN = stub;

  const map = await createWork(project, { title: 'Авторизация', goal: 'логин по паролю' });
  workId = map.work.id;
  await updateMap(project, workId, (current) => {
    addSession(current, { provider: 'claude', label: 'план', task: 'составить план' });
  });
});

afterEach(async () => {
  for (const { client, server } of opened.splice(0)) {
    await client.close();
    await server.close();
  }
  delete process.env.HARNAS_HOME;
  delete process.env.HARNAS_CLAUDE_BIN;
  delete process.env.HARNAS_WORK_DIR;
  delete process.env.HARNAS_SESSION_ID;
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  await Promise.all(
    [home, project, binDir].map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('contextFromEnv', () => {
  it('раскладывает HARNAS_WORK_DIR на проект и работу', () => {
    process.env.HARNAS_WORK_DIR = workPaths(project, workId).dir;
    process.env.HARNAS_SESSION_ID = 's-01';

    expect(contextFromEnv()).toEqual({
      projectPath: project,
      workId,
      workDir: workPaths(project, workId).dir,
      sessionId: 's-01',
    });
  });

  it('без HARNAS_SESSION_ID сессии нет, а без HARNAS_WORK_DIR — ошибка', () => {
    process.env.HARNAS_WORK_DIR = workPaths(project, workId).dir;
    expect(contextFromEnv().sessionId).toBeNull();

    delete process.env.HARNAS_WORK_DIR;
    expect(() => contextFromEnv()).toThrow(/HARNAS_WORK_DIR/);
  });

  it('отвергает каталог не из раскладки работы', () => {
    process.env.HARNAS_WORK_DIR = project;
    expect(() => contextFromEnv()).toThrow(/\.harnas/);
  });
});

describe('список инструментов', () => {
  it('ровно семь инструментов спецификации', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'check_inbox',
      'get_map',
      'read_guide',
      'report',
      'send_message',
      'spawn_session',
      'wait_for',
    ]);
    expect(tools.every((tool) => (tool.description ?? '') !== '')).toBe(true);
  });

  it('описание get_map отсылает ко второму слою гида', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const getMap = tools.find((tool) => tool.name === 'get_map');

    expect(getMap?.description).toMatch(/подробный гид — инструмент read_guide$/);
  });
});

describe('read_guide', () => {
  it('отдаёт подробный гид целиком', async () => {
    const client = await connect('s-01');
    const result = await call(client, 'read_guide');

    expect(result.isError, result.text).toBe(false);
    expect(result.text).toBe(GUIDE);
  });

  it('работает без HARNAS_SESSION_ID: гид не про конкретную сессию', async () => {
    const client = await connect(null);
    const result = await call(client, 'read_guide');

    expect(result.isError, result.text).toBe(false);
    expect(result.text).toBe(GUIDE);
  });
});

describe('get_map', () => {
  it('отдаёт карту, свою сессию и провайдеров с флагом доступности', async () => {
    const client = await connect('s-01');
    const result = await callOk(client, 'get_map');

    expect(result['sessionId']).toBe('s-01');
    expect((result['map'] as WorkMap).work.title).toBe('Авторизация');
    expect((result['map'] as WorkMap).sessions).toHaveLength(1);

    const providers = result['providers'] as { id: string; label: string; available: boolean }[];
    expect(providers.find((entry) => entry.id === 'claude')).toEqual({
      id: 'claude',
      label: 'Claude',
      available: true,
    });
    expect(providers.find((entry) => entry.id === 'codex')?.available).toBe(false);
  });

  it('работает без HARNAS_SESSION_ID', async () => {
    const client = await connect(null);
    const result = await callOk(client, 'get_map');

    expect(result['sessionId']).toBeNull();
    expect((result['map'] as WorkMap).work.id).toBe(workId);
  });
});

describe('без HARNAS_SESSION_ID', () => {
  it('остальные инструменты объясняют, что сессию надо создать через харнесс', async () => {
    const client = await connect(null);
    const calls = [
      call(client, 'report', { status: 'progress', summary: 'что-то' }),
      call(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' }),
      call(client, 'wait_for', { target: 'inbox', timeoutSec: 0 }),
      call(client, 'send_message', { to: 's-01', text: 'привет' }),
      call(client, 'check_inbox'),
    ];

    for (const result of await Promise.all(calls)) {
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/HARNAS_SESSION_ID/);
    }
    // Ни одна запись в карте не появилась.
    expect((await readMapFile()).sessions).toHaveLength(1);
  });
});

describe('report', () => {
  it('progress обновляет резюме и не трогает статус', async () => {
    const client = await connect('s-01');
    const result = await callOk(client, 'report', { status: 'progress', summary: 'середина' });

    expect(result['status']).toBe('pending');
    const stored = session(await readMapFile(), 's-01');
    expect(stored.summary).toBe('середина');
    expect(stored.summarySource).toBe('agent');
    expect(stored.status).toBe('pending');
    expect(stored.history.map((entry) => entry.status)).toEqual(['pending']);
  });

  it('done переводит сессию и сохраняет артефакты', async () => {
    const client = await connect('s-01');
    const result = await callOk(client, 'report', {
      status: 'done',
      summary: 'план готов',
      artifacts: [{ kind: 'plan', path: '.harnas/works/w-0001/artifacts/plan.md' }],
    });

    expect(result['status']).toBe('done');
    const stored = session(await readMapFile(), 's-01');
    expect(stored.status).toBe('done');
    expect(stored.summary).toBe('план готов');
    expect(stored.artifacts).toEqual([
      { kind: 'plan', path: '.harnas/works/w-0001/artifacts/plan.md' },
    ]);
    expect(stored.endedAt).not.toBeNull();
  });

  it('повторный report перезаписывает резюме и артефакты', async () => {
    const client = await connect('s-01');
    await callOk(client, 'report', {
      status: 'progress',
      summary: 'первое',
      artifacts: [{ kind: 'plan', path: 'docs/plan.md' }],
    });
    await callOk(client, 'report', { status: 'failed', summary: 'второе' });

    const stored = session(await readMapFile(), 's-01');
    expect(stored.summary).toBe('второе');
    expect(stored.artifacts).toEqual([]);
    expect(stored.status).toBe('failed');
  });

  it('абсолютный путь артефакта — ошибка, карта не меняется', async () => {
    const client = await connect('s-01');
    const result = await call(client, 'report', {
      status: 'done',
      summary: 'готово',
      artifacts: [{ kind: 'plan', path: '/tmp/plan.md' }],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/относительн/i);
    expect(session(await readMapFile(), 's-01').summary).toBeNull();
  });

  it('путь за пределы проекта — ошибка', async () => {
    const client = await connect('s-01');
    const result = await call(client, 'report', {
      status: 'done',
      summary: 'готово',
      artifacts: [{ kind: 'plan', path: '../чужое/plan.md' }],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/за пределы проекта/);
    expect(session(await readMapFile(), 's-01').status).toBe('pending');
  });

  it('неизвестный статус — ошибка', async () => {
    const client = await connect('s-01');
    const result = await call(client, 'report', { status: 'готово', summary: 'x' });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/done/);
  });
});

describe('spawn_session', () => {
  it('создаёт pending с родителем, брифом и возвращает id', async () => {
    const client = await connect('s-01');
    const result = await callOk(client, 'spawn_session', {
      provider: 'claude',
      label: 'бэкенд',
      task: 'реализовать шаги 1–3',
      contextFrom: ['s-01'],
    });

    expect(result).toEqual({ sessionId: 's-02' });
    const stored = session(await readMapFile(), 's-02');
    expect(stored.status).toBe('pending');
    expect(stored.provider).toBe('claude');
    expect(stored.parent).toBe('s-01');
    expect(stored.contextFrom).toEqual(['s-01']);

    const brief = await readFile(path.join(workPaths(project, workId).briefs, 's-02.md'), 'utf8');
    expect(brief).toContain('бэкенд');
    expect(brief).toContain('реализовать шаги 1–3');
    expect(brief).toContain('get_map');
  });

  it('неизвестный провайдер — ошибка с перечнем допустимых, записи нет', async () => {
    const client = await connect('s-01');
    const result = await call(client, 'spawn_session', {
      provider: 'gpt',
      label: 'бэк',
      task: 'делать',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('claude');
    expect(result.text).toContain('codex');
    expect((await readMapFile()).sessions).toHaveLength(1);
  });

  it('команды нет в PATH — ошибка, записи нет', async () => {
    const client = await connect('s-01');
    const result = await call(client, 'spawn_session', {
      provider: 'codex',
      label: 'бэк',
      task: 'делать',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/PATH/);
    expect((await readMapFile()).sessions).toHaveLength(1);
  });

  it('неизвестная сессия в contextFrom — ошибка, записи нет', async () => {
    const client = await connect('s-01');
    const result = await call(client, 'spawn_session', {
      provider: 'claude',
      label: 'бэк',
      task: 'делать',
      contextFrom: ['s-09'],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('s-09');
    expect((await readMapFile()).sessions).toHaveLength(1);
  });
});

describe('send_message и check_inbox', () => {
  it('сообщение доходит и помечается прочитанным один раз', async () => {
    const first = await connect('s-01');
    await callOk(first, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    const second = await connect('s-02');

    const sent = await callOk(second, 'send_message', { to: 's-01', text: 'нужен план' });
    expect(sent['messageId']).toBe('m-01');

    const stored = (await readMapFile()).messages[0];
    const inbox = await callOk(first, 'check_inbox');
    expect(inbox['messages']).toEqual([
      { id: 'm-01', from: 's-02', at: stored?.at, text: 'нужен план' },
    ]);
    expect((await readMapFile()).messages[0]?.readAt).not.toBeNull();

    const again = await callOk(first, 'check_inbox');
    expect(again['messages']).toEqual([]);
  });

  it('чужие сообщения в ящик не попадают', async () => {
    const first = await connect('s-01');
    await callOk(first, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    await updateMap(project, workId, (map) => {
      addMessage(map, { from: 's-01', to: 's-02', text: 'не тебе' });
    });

    expect(await callOk(first, 'check_inbox')).toEqual({ messages: [] });
  });

  it('несуществующий адресат — ошибка', async () => {
    const client = await connect('s-01');
    const result = await call(client, 'send_message', { to: 's-77', text: 'эй' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('s-77');
    expect((await readMapFile()).messages).toEqual([]);
  });
});

describe('wait_for', () => {
  it('неизвестный id — ошибка, а не ожидание', async () => {
    const client = await connect('s-01');
    const started = Date.now();
    const result = await call(client, 'wait_for', { target: 's-77', timeoutSec: 30 });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('s-77');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('по таймауту возвращает running', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });

    expect(await callOk(client, 'wait_for', { target: 's-02', timeoutSec: 0.2 })).toEqual({
      state: 'running',
    });
  });

  it('уже завершённая сессия отвечает сразу и отдаёт резюме', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    await updateMap(project, workId, (map) => {
      const target = session(map, 's-02');
      target.summary = 'сделано';
      target.summarySource = 'agent';
      target.artifacts = [{ kind: 'code', path: 'src/auth.ts' }];
      transitionSession(map, 's-02', 'done');
    });

    expect(await callOk(client, 'wait_for', { target: 's-02', timeoutSec: 5 })).toEqual({
      state: 'done',
      sessionId: 's-02',
      summary: 'сделано',
      artifacts: [{ kind: 'code', path: 'src/auth.ts' }],
    });
  });

  it('дожидается записи в карту, сделанной пока висит вызов', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });

    const pending = callOk(client, 'wait_for', { target: 's-02', timeoutSec: 20 });
    await delay(60);
    await updateMap(project, workId, (map) => {
      session(map, 's-02').summary = 'упал на миграциях';
      transitionSession(map, 's-02', 'failed');
    });

    expect(await pending).toEqual({
      state: 'failed',
      sessionId: 's-02',
      summary: 'упал на миграциях',
      artifacts: [],
    });
  });

  it('exited тоже прекращает ожидание', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });

    const pending = callOk(client, 'wait_for', { target: 's-02', timeoutSec: 20 });
    await delay(60);
    await updateMap(project, workId, (map) => {
      transitionSession(map, 's-02', 'active');
      transitionSession(map, 's-02', 'exited', { exitCode: 1 });
    });

    expect(await pending).toEqual({
      state: 'exited',
      sessionId: 's-02',
      summary: null,
      artifacts: [],
    });
  });

  it('inbox просыпается на новом входящем', async () => {
    const client = await connect('s-01');
    const pending = callOk(client, 'wait_for', { target: 'inbox', timeoutSec: 20 });
    await delay(60);
    await updateMap(project, workId, (map) => {
      addMessage(map, { from: 's-01', to: 's-01', text: 'проснись' });
    });

    const result = await pending;
    expect(result['state']).toBe('message');
    expect((result['messages'] as { text: string }[]).map((item) => item.text)).toEqual([
      'проснись',
    ]);
    // Прочитанным помечает только check_inbox.
    expect((await readMapFile()).messages[0]?.readAt).toBeNull();
  });
});

describe('waitTimeoutMs', () => {
  it('по умолчанию десять минут, сверху ограничен получасом', () => {
    expect(waitTimeoutMs(undefined)).toBe(DEFAULT_TIMEOUT_SEC * 1000);
    expect(DEFAULT_TIMEOUT_SEC).toBe(600);
    expect(MAX_TIMEOUT_SEC).toBe(1800);
    expect(waitTimeoutMs(3600)).toBe(MAX_TIMEOUT_SEC * 1000);
    expect(waitTimeoutMs(5)).toBe(5000);
    expect(waitTimeoutMs(-1)).toBe(0);
  });
});
