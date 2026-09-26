import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../config.js';
import { GUIDE } from '../work/guide.js';
import {
  addMessage,
  addSession,
  removeSession,
  setResult,
  transitionSession,
} from '../work/map.js';
import { createWork, readMap, updateMap, workPaths } from '../work/store.js';
import { decisionsOf, threadOf } from '../work/thread.js';
import type { WorkMap } from '../work/types.js';
import { contextFromEnv } from './context.js';
import type { Ring } from './inbox-watch.js';
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

async function connect(
  sessionId: string | null,
  pollMs = 40,
  messageRate = DEFAULT_CONFIG.messageRate,
  channel = false,
  rings: Ring[] = [],
): Promise<Client> {
  const context = {
    projectPath: project,
    workId,
    workDir: workPaths(project, workId).dir,
    sessionId,
    pollMs,
    messageRate,
    channel,
  };
  const server = createHarnasServer(context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  // Звонок ловится общим обработчиком, а не `setNotificationHandler`: тот
  // требует zod-схему, а zod в зависимостях core нет.
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method === 'notifications/claude/channel') {
      rings.push(notification.params as unknown as Ring);
    }
  };
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
  delete process.env.HARNAS_CODEX_BIN;
  delete process.env.HARNAS_WORK_DIR;
  delete process.env.HARNAS_SESSION_ID;
  delete process.env.HARNAS_CHANNEL;
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
      channel: false,
    });
  });

  it('HARNAS_CHANNEL включает звонок, без переменной его нет', () => {
    process.env.HARNAS_WORK_DIR = workPaths(project, workId).dir;
    process.env.HARNAS_SESSION_ID = 's-01';
    expect(contextFromEnv().channel).toBe(false);

    process.env.HARNAS_CHANNEL = '1';
    expect(contextFromEnv().channel).toBe(true);
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
    expect(stored.lifecycle).toBe('pending');
    expect(stored.result).toBeNull();
    expect(stored.history.map((entry) => entry.event)).toEqual(['pending']);
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
    expect(stored.result).toBe('done');
    // Итог процесс не меняет (спецификация 7.1).
    expect(stored.lifecycle).toBe('pending');
    expect(stored.summary).toBe('план готов');
    expect(stored.artifacts).toEqual([
      { kind: 'plan', path: '.harnas/works/w-0001/artifacts/plan.md' },
    ]);
    expect(stored.resultAt).not.toBeNull();
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
    expect(stored.result).toBe('failed');
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
    expect(session(await readMapFile(), 's-01').result).toBeNull();
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
    expect(stored.lifecycle).toBe('pending');
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

  it('пустая задача — ошибка: тихий старт доступен только TUI и CLI', async () => {
    const client = await connect('s-01');
    const result = await call(client, 'spawn_session', {
      provider: 'claude',
      label: 'бэк',
      task: '',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('task');
    expect((await readMapFile()).sessions).toHaveLength(1);
  });

  it('роль агента проверяется по определению проекта и попадает в карту', async () => {
    await mkdir(path.join(project, '.claude', 'agents'), { recursive: true });
    await writeFile(path.join(project, '.claude', 'agents', 'reviewer.md'), '# роль\n', 'utf8');
    const client = await connect('s-01');

    await callOk(client, 'spawn_session', {
      provider: 'claude',
      label: 'ревью',
      task: 'проверить план',
      agent: 'reviewer',
    });

    expect(session(await readMapFile(), 's-02').agent).toBe('reviewer');
  });

  it('определения агента нет — ошибка, записи нет', async () => {
    const client = await connect('s-01');
    const result = await call(client, 'spawn_session', {
      provider: 'claude',
      label: 'ревью',
      task: 'проверить план',
      agent: 'reviewer',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('агента reviewer нет');
    expect((await readMapFile()).sessions).toHaveLength(1);
  });

  it('провайдер без подстановки {agent} — ошибка, записи нет', async () => {
    // У codex флага роли нет: запись, которую нечем запустить ролью, не заводим.
    process.env.HARNAS_CODEX_BIN = path.join(binDir, 'claude');
    const client = await connect('s-01');
    const result = await call(client, 'spawn_session', {
      provider: 'codex',
      label: 'ревью',
      task: 'проверить план',
      agent: 'reviewer',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('агентов не принимает');
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
      { id: 'm-01', from: 's-02', at: stored?.at, text: 'нужен план', kind: 'note' },
    ]);
    expect((await readMapFile()).messages[0]?.readBy['s-01']).toBeDefined();

    const again = await callOk(first, 'check_inbox');
    expect(again['messages']).toEqual([]);
  });

  it('чужие сообщения в ящик не попадают', async () => {
    const first = await connect('s-01');
    await callOk(first, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    await updateMap(project, workId, (map) => {
      addMessage(map, { from: 's-01', to: ['s-02'], text: 'не тебе' });
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

  it('принимает три вида, четвёртый — ошибка с перечнем, без kind — note', async () => {
    const first = await connect('s-01');
    await callOk(first, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    const second = await connect('s-02');

    await callOk(second, 'send_message', { to: 's-01', text: 'где миграция?', kind: 'question' });
    await callOk(second, 'send_message', { to: 's-01', text: 'делаем так', kind: 'decision' });
    await callOk(second, 'send_message', { to: 's-01', text: 'просто так' });
    expect((await readMapFile()).messages.map((message) => message.kind)).toEqual([
      'question',
      'decision',
      'note',
    ]);

    const broken = await call(second, 'send_message', {
      to: 's-01',
      text: 'а так?',
      kind: 'вопрос',
    });
    expect(broken.isError).toBe(true);
    expect(broken.text).toContain('question');
    expect(broken.text).toContain('decision');
    expect((await readMapFile()).messages).toHaveLength(3);
  });

  it('ответ check_inbox и wait_for несёт kind', async () => {
    const first = await connect('s-01');
    await callOk(first, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    const second = await connect('s-02');
    await callOk(second, 'send_message', { to: 's-01', text: 'где миграция?', kind: 'question' });

    const waited = await callOk(first, 'wait_for', { target: 'inbox', timeoutSec: 5 });
    expect((waited['messages'] as { kind: string }[]).map((item) => item.kind)).toEqual([
      'question',
    ]);

    const inbox = await callOk(first, 'check_inbox');
    expect((inbox['messages'] as { kind: string }[]).map((item) => item.kind)).toEqual([
      'question',
    ]);
  });

  it('окно messageRate: третье письмо за час отказано, письмо старше часа не считается', async () => {
    const first = await connect('s-01');
    await callOk(first, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    const second = await connect('s-02', 40, 2);

    await callOk(second, 'send_message', { to: 's-01', text: 'раз' });
    await callOk(second, 'send_message', { to: 's-01', text: 'два' });
    // Письмо другой сессии в чужой счёт не идёт: окно считает только свои.
    await callOk(first, 'send_message', { to: 's-02', text: 'от другого' });

    const refused = await call(second, 'send_message', { to: 's-01', text: 'три' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('слишком часто');
    expect(refused.text).toContain('report');
    expect((await readMapFile()).messages).toHaveLength(3);

    // Первое письмо уезжает за окно — место в часе освобождается само.
    await updateMap(project, workId, (map) => {
      const oldest = map.messages[0];
      if (oldest !== undefined) oldest.at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    });
    expect(await callOk(second, 'send_message', { to: 's-01', text: 'три' })).toEqual({
      messageId: 'm-04',
    });
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
      setResult(map, 's-02', 'done');
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
      setResult(map, 's-02', 'failed');
    });

    expect(await pending).toEqual({
      state: 'failed',
      sessionId: 's-02',
      summary: 'упал на миграциях',
      artifacts: [],
    });
  });

  it('sleeping тоже прекращает ожидание', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });

    const pending = callOk(client, 'wait_for', { target: 's-02', timeoutSec: 20 });
    await delay(60);
    await updateMap(project, workId, (map) => {
      transitionSession(map, 's-02', 'active');
      transitionSession(map, 's-02', 'sleeping', { exitCode: 1 });
    });

    expect(await pending).toEqual({
      state: 'sleeping',
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
      addMessage(map, { from: 's-01', to: ['s-01'], text: 'проснись' });
    });

    const result = await pending;
    expect(result['state']).toBe('message');
    expect((result['messages'] as { text: string }[]).map((item) => item.text)).toEqual([
      'проснись',
    ]);
    // Прочитанным помечает только check_inbox.
    expect((await readMapFile()).messages[0]?.readBy).toEqual({});
  });
});

describe('удалённая сессия (план от 2026-09-06, раздел C)', () => {
  it('27: wait_for на id из deletedSessions отвечает deleted сразу', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    await updateMap(project, workId, (map) => {
      removeSession(map, 's-02');
    });

    const started = Date.now();
    expect(await callOk(client, 'wait_for', { target: 's-02', timeoutSec: 30 })).toEqual({
      state: 'deleted',
      sessionId: 's-02',
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('27: сессия, удалённая пока висит вызов, будит wait_for', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });

    const pending = callOk(client, 'wait_for', { target: 's-02', timeoutSec: 20 });
    await delay(60);
    await updateMap(project, workId, (map) => {
      removeSession(map, 's-02');
    });

    expect(await pending).toEqual({ state: 'deleted', sessionId: 's-02' });
  });

  it('27: id, которого не было никогда, — по-прежнему ошибка сразу', async () => {
    const client = await connect('s-01');
    const started = Date.now();
    const result = await call(client, 'wait_for', { target: 's-77', timeoutSec: 30 });

    expect(result.isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('28: сервер удалённой сессии не пишет в карту ни одним инструментом', async () => {
    const owner = await connect('s-01');
    await callOk(owner, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    // Сервер сессии `s-02` ещё жив: SessionEnd приходит раньше выхода процесса.
    const orphan = await connect('s-02');
    await updateMap(project, workId, (map) => {
      removeSession(map, 's-02');
    });
    const before = await readMapFile();

    const calls = [
      call(orphan, 'report', { status: 'done', summary: 'успел' }),
      call(orphan, 'spawn_session', { provider: 'claude', label: 'ещё', task: 'делать' }),
      call(orphan, 'send_message', { to: 's-01', text: 'я ещё тут' }),
      call(orphan, 'check_inbox'),
    ];
    for (const result of await Promise.all(calls)) {
      expect(result.isError).toBe(true);
      expect(result.text).toContain('s-02');
    }

    const after = await readMapFile();
    expect(after.sessions).toEqual(before.sessions);
    expect(after.messages).toEqual(before.messages);
  });
});

describe('channel: звонок про письмо (разговор агентов, 4.2)', () => {
  const withChannel = (sessionId: string | null, rings: Ring[] = []): Promise<Client> =>
    connect(sessionId, 40, DEFAULT_CONFIG.messageRate, true, rings);

  const rung = (rings: Ring[], count: number): Promise<void> =>
    vi.waitFor(() => expect(rings).toHaveLength(count), { timeout: 2000, interval: 10 });

  /** Пара «отправитель — адресат»: письмо пишет вторая сессия, звонит первой. */
  async function pair(): Promise<Client> {
    const owner = await connect('s-01');
    await callOk(owner, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    return connect('s-02');
  }

  it('объявляет capability и учит этикету в instructions', async () => {
    const client = await withChannel('s-01');

    expect(client.getServerCapabilities()?.experimental).toEqual({ 'claude/channel': {} });
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('source="harnas"');
    expect(instructions).toContain('только на `question`');
    expect(instructions).toContain('check_inbox');
  });

  it('письмо звонит один раз, карта не тронута, check_inbox отдаёт его', async () => {
    const rings: Ring[] = [];
    const first = await withChannel('s-01', rings);
    await callOk(first, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    const second = await connect('s-02');
    await callOk(second, 'send_message', { to: 's-01', text: 'где миграция?', kind: 'question' });

    await rung(rings, 1);
    // Звонок без текста письма: агент забирает его сам.
    expect(rings[0]?.content).not.toContain('миграция');
    expect(rings[0]?.meta).toEqual({
      message_id: 'm-01',
      from: 's-02',
      from_label: 'бэк',
      kind: 'question',
      unread: '1',
    });
    expect((await readMapFile()).messages[0]?.readBy).toEqual({});

    const inbox = await callOk(first, 'check_inbox');
    expect((inbox['messages'] as { text: string }[]).map((item) => item.text)).toEqual([
      'где миграция?',
    ]);
    await delay(150);
    expect(rings).toHaveLength(1);
  });

  it('письмо, лежавшее в карте до подключения, звонит после initialize', async () => {
    const second = await pair();
    await callOk(second, 'send_message', { to: 's-01', text: 'привет' });

    const rings: Ring[] = [];
    await withChannel('s-01', rings);
    await rung(rings, 1);
    expect(rings[0]?.meta['kind']).toBe('note');
  });

  it('звонок доходит и при висящем wait_for, письмо остаётся одно', async () => {
    const rings: Ring[] = [];
    const first = await withChannel('s-01', rings);
    await callOk(first, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    const second = await connect('s-02');

    const waiting = callOk(first, 'wait_for', { target: 'inbox', timeoutSec: 5 });
    await delay(50);
    await callOk(second, 'send_message', { to: 's-01', text: 'привет' });

    const waited = await waiting;
    expect(waited['messages']).toHaveLength(1);
    await rung(rings, 1);
    expect((await readMapFile()).messages).toHaveLength(1);
  });

  it('без HARNAS_CHANNEL нет ни capability, ни instructions, ни звонка', async () => {
    const rings: Ring[] = [];
    const first = await connect('s-01', 40, DEFAULT_CONFIG.messageRate, false, rings);
    await callOk(first, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    const second = await connect('s-02');
    await callOk(second, 'send_message', { to: 's-01', text: 'привет' });

    await delay(200);
    expect(first.getServerCapabilities()?.experimental).toBeUndefined();
    expect(first.getInstructions()).toBeUndefined();
    expect(rings).toHaveLength(0);
  });

  it('без HARNAS_SESSION_ID сторожа нет и при HARNAS_CHANNEL', async () => {
    const rings: Ring[] = [];
    const guest = await withChannel(null, rings);
    const second = await pair();
    await callOk(second, 'send_message', { to: 's-01', text: 'привет' });

    await delay(200);
    expect(guest.getServerCapabilities()?.experimental).toBeUndefined();
    expect(guest.getInstructions()).toBeUndefined();
    expect(rings).toHaveLength(0);
  });
});

describe('двухсторонний разговор (разговор агентов, 8.29)', () => {
  const rung = (rings: Ring[], count: number): Promise<void> =>
    vi.waitFor(() => expect(rings).toHaveLength(count), { timeout: 2000, interval: 10 });

  const texts = (result: Record<string, unknown>): string[] =>
    (result['messages'] as { text: string }[]).map((item) => item.text);

  /** Две сессии одной работы, у каждой свой сервер со звонком: план и его бэк. */
  async function talkers(ringsA: Ring[], ringsB: Ring[]): Promise<{ plan: Client; back: Client }> {
    const plan = await connect('s-01', 40, DEFAULT_CONFIG.messageRate, true, ringsA);
    await callOk(plan, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    const back = await connect('s-02', 40, DEFAULT_CONFIG.messageRate, true, ringsB);
    return { plan, back };
  }

  it('вопрос → звонок → ответ → звонок → решение: три письма, одно решение', async () => {
    const ringsA: Ring[] = [];
    const ringsB: Ring[] = [];
    const { plan, back } = await talkers(ringsA, ringsB);

    await callOk(plan, 'send_message', {
      to: 's-02',
      text: 'где лежит миграция users?',
      kind: 'question',
    });
    await rung(ringsB, 1);
    expect(ringsB[0]?.meta).toMatchObject({ from: 's-01', from_label: 'план', kind: 'question' });
    expect(texts(await callOk(back, 'check_inbox'))).toEqual(['где лежит миграция users?']);

    await callOk(back, 'send_message', { to: 's-01', text: 'в db/migrations/0007' });
    await rung(ringsA, 1);
    expect(ringsA[0]?.meta).toMatchObject({ from: 's-02', from_label: 'бэк', kind: 'note' });
    expect(texts(await callOk(plan, 'check_inbox'))).toEqual(['в db/migrations/0007']);

    await callOk(plan, 'send_message', {
      to: 's-02',
      text: 'миграции отдельным PR',
      kind: 'decision',
    });
    await rung(ringsB, 2);
    expect(texts(await callOk(back, 'check_inbox'))).toEqual(['миграции отдельным PR']);

    const thread = threadOf(await readMap(project, workId), 's-02');
    expect(thread.messages.map((message) => message.kind)).toEqual([
      'question',
      'note',
      'decision',
    ]);
    expect(decisionsOf(thread).map((message) => message.text)).toEqual(['миграции отдельным PR']);
    // Звонков ровно три — по одному на письмо, и каждое забрано check_inbox.
    expect(ringsB.map((ring) => ring.meta['message_id'])).toEqual(['m-01', 'm-03']);
    expect(ringsA.map((ring) => ring.meta['message_id'])).toEqual(['m-02']);
    expect(thread.messages.every((message) => Object.keys(message.readBy).length > 0)).toBe(true);
    await delay(150);
    expect(ringsA.length + ringsB.length).toBe(3);
  });

  it('тот же разговор, когда план ждёт wait_for("inbox") вместо звонка', async () => {
    const ringsA: Ring[] = [];
    const ringsB: Ring[] = [];
    const { plan, back } = await talkers(ringsA, ringsB);

    await callOk(plan, 'send_message', {
      to: 's-02',
      text: 'где лежит миграция users?',
      kind: 'question',
    });
    await rung(ringsB, 1);
    expect(texts(await callOk(back, 'check_inbox'))).toEqual(['где лежит миграция users?']);

    // План не ждёт звонка: висящий wait_for будит его тем же самым письмом.
    const waiting = callOk(plan, 'wait_for', { target: 'inbox', timeoutSec: 5 });
    await delay(50);
    await callOk(back, 'send_message', { to: 's-01', text: 'в db/migrations/0007' });
    expect(texts(await waiting)).toEqual(['в db/migrations/0007']);
    // Звонок приходит и сюда, но письмо в карте одно: wait_for его не помечает,
    // и забирает его тот же check_inbox (4.3).
    await rung(ringsA, 1);
    expect(texts(await callOk(plan, 'check_inbox'))).toEqual(['в db/migrations/0007']);

    await callOk(plan, 'send_message', {
      to: 's-02',
      text: 'миграции отдельным PR',
      kind: 'decision',
    });
    await rung(ringsB, 2);
    expect(texts(await callOk(back, 'check_inbox'))).toEqual(['миграции отдельным PR']);

    const map = await readMap(project, workId);
    const thread = threadOf(map, 's-02');
    expect(thread.messages).toHaveLength(3);
    expect(decisionsOf(thread)).toHaveLength(1);
    expect(map.messages.filter((message) => message.to.includes('s-01'))).toHaveLength(1);
    expect(map.messages.every((message) => Object.keys(message.readBy).length > 0)).toBe(true);
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
