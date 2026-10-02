import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../config.js';
import { BRANCH_PREFIX, MCP_SERVER_NAME } from '../names.js';
import { PROVIDERS, selectableModels } from '../providers.js';
import { GUIDE, GUIDE_TOPICS, guideTopic } from '../work/guide.js';
import {
  addMessage,
  addSession,
  removeSession,
  setResult,
  transitionSession,
} from '../work/map.js';
import { activityOf } from '../work/activity.js';
import { openEvents } from '../work/events.js';
import { PROPOSAL_TEXT_MAX, resolveProposal } from '../work/proposals.js';
import { addRoom } from '../work/rooms.js';
import { createWork, readMap, updateMap, workPaths } from '../work/store.js';
import { decisionsOf, threadOf } from '../work/thread.js';
import { HUMAN, type WorkMap } from '../work/types.js';
import { contextFromEnv } from './context.js';
import type { Ring } from './inbox-watch.js';
import {
  DEFAULT_TIMEOUT_SEC,
  MAX_TIMEOUT_SEC,
  createParleyServer,
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
  worktreeRoot = DEFAULT_CONFIG.worktreeRoot,
): Promise<Client> {
  const context = {
    projectPath: project,
    workId,
    workDir: workPaths(project, workId).dir,
    sessionId,
    pollMs,
    messageRate,
    channel,
    worktreeRoot,
  };
  const server = createParleyServer(context);
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

const run = promisify(execFile);
const git = (dir: string, args: string[]) => run('git', ['-C', dir, ...args]);

/**
 * Репозиторий с одним коммитом на `main` — для тестов `spawn_session
 * { worktree: true }`. Сам инструмент зовёт настоящий git по PATH: `beforeEach`
 * глушит PATH ради проверки провайдеров, здесь он на время теста возвращается.
 */
async function initGitProject(): Promise<void> {
  process.env.PATH = savedPath ?? '';
  await run('git', ['init', '-b', 'main', project]);
  await git(project, ['config', 'user.email', 'тест@parley']);
  await git(project, ['config', 'user.name', 'тест']);
  await writeFile(path.join(project, 'README.md'), 'старт\n', 'utf8');
  await git(project, ['add', 'README.md']);
  await git(project, ['commit', '-m', 'первый']);
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  binDir = await mkdtemp(path.join(tmpdir(), 'parley-bin-'));
  process.env.PARLEY_HOME = home;
  // PATH пустой, а `claude` подсунут оверрайдом: доступность провайдеров в тесте
  // не зависит от того, что стоит на машине. Настоящий бинарь не запускается.
  savedPath = process.env.PATH;
  process.env.PATH = '';
  const stub = path.join(binDir, 'claude');
  await writeFile(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.PARLEY_CLAUDE_BIN = stub;

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
  delete process.env.PARLEY_HOME;
  delete process.env.PARLEY_CLAUDE_BIN;
  delete process.env.PARLEY_CODEX_BIN;
  delete process.env.PARLEY_WORK_DIR;
  delete process.env.PARLEY_SESSION_ID;
  delete process.env.PARLEY_CHANNEL;
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  await Promise.all(
    [home, project, binDir].map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('contextFromEnv', () => {
  it('раскладывает PARLEY_WORK_DIR на проект и работу', () => {
    process.env.PARLEY_WORK_DIR = workPaths(project, workId).dir;
    process.env.PARLEY_SESSION_ID = 's-01';

    expect(contextFromEnv()).toEqual({
      projectPath: project,
      workId,
      workDir: workPaths(project, workId).dir,
      sessionId: 's-01',
      channel: false,
    });
  });

  it('PARLEY_CHANNEL включает звонок, без переменной его нет', () => {
    process.env.PARLEY_WORK_DIR = workPaths(project, workId).dir;
    process.env.PARLEY_SESSION_ID = 's-01';
    expect(contextFromEnv().channel).toBe(false);

    process.env.PARLEY_CHANNEL = '1';
    expect(contextFromEnv().channel).toBe(true);
  });

  it('без PARLEY_SESSION_ID сессии нет, а без PARLEY_WORK_DIR — ошибка', () => {
    process.env.PARLEY_WORK_DIR = workPaths(project, workId).dir;
    expect(contextFromEnv().sessionId).toBeNull();

    delete process.env.PARLEY_WORK_DIR;
    expect(() => contextFromEnv()).toThrow(/PARLEY_WORK_DIR/);
  });

  it('отвергает каталог не из раскладки работы', () => {
    process.env.PARLEY_WORK_DIR = project;
    expect(() => contextFromEnv()).toThrow(/\.parley/);
  });
});

describe('список инструментов', () => {
  it('ровно двенадцать инструментов спецификации', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'add_to_room',
      'check_inbox',
      'close_session',
      'create_room',
      'get_map',
      'propose_decision',
      'read_guide',
      'read_room',
      'report',
      'send_message',
      'spawn_session',
      'wait_for',
    ]);
    expect(tools.every((tool) => (tool.description ?? '') !== '')).toBe(true);
  });

  it('сервер называется parley (R8): так же, как его ключ в конфиге MCP, — под ним агент видит mcp__parley__*', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();

    expect(client.getServerVersion()?.name).toBe(MCP_SERVER_NAME);
    expect(client.getServerVersion()?.name).toBe('parley');
    // Оговорка у `agent` называет тот же префикс: роль с урезанным `tools` без него ни письма, ни отчёта.
    const spawn = tools.find((tool) => tool.name === 'spawn_session');
    const agent = (spawn?.inputSchema.properties?.['agent'] ?? {}) as { description?: string };
    expect(agent.description).toContain(`mcp__${MCP_SERVER_NAME}__*`);
    expect(agent.description).not.toContain('mcp__harnas__');
  });

  it('propose_decision: room и text обязательны, описание — про ведущего, ожидание человека и повтор', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const propose = tools.find((tool) => tool.name === 'propose_decision');

    expect(propose?.inputSchema.required).toEqual(['room', 'text']);
    expect(Object.keys(propose?.inputSchema.properties ?? {}).sort()).toEqual(['room', 'text']);
    // Тон соседних описаний: только ведущий, решение ждёт человека, повтор заменяет, ответ — письмом.
    expect(propose?.description).toMatch(/lead only/i);
    expect(propose?.description).toMatch(/waits for the human's answer/);
    expect(propose?.description).toMatch(/replaces/);
    expect(propose?.description).toMatch(/as a message/);
    // Предел текста в схеме — та же константа, что держит setProposal.
    expect(JSON.stringify(propose?.inputSchema.properties?.['text'])).toContain(
      String(PROPOSAL_TEXT_MAX),
    );
  });

  it('read_guide: описание называет комнаты и роли ведущего и участника', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const guide = tools.find((tool) => tool.name === 'read_guide');

    expect(guide?.description).toMatch(/rooms and the roles in them \(lead, participant\)/);
  });

  it('add_to_room: room и session обязательны, описание — про ведущего, одну комнату и строку в ленте', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const add = tools.find((tool) => tool.name === 'add_to_room');

    expect(add?.inputSchema.required).toEqual(['room', 'session']);
    expect(Object.keys(add?.inputSchema.properties ?? {}).sort()).toEqual(['room', 'session']);
    // Тон соседних описаний: только ведущий, одна комната на сессию, системная строка, письма нет.
    expect(add?.description).toMatch(/Lead only/);
    expect(add?.description).toMatch(/One room per session/);
    expect(add?.description).toContain('@s04 joined the room');
    expect(add?.description).toMatch(/gets no message/);
  });

  it('spawn_session: model и effort необязательны, effort — три уровня, описание отсылает к get_map', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const spawn = tools.find((tool) => tool.name === 'spawn_session');

    expect(spawn?.inputSchema.required).toEqual(['provider', 'label', 'task']);
    expect(spawn?.inputSchema.properties?.['model']).toMatchObject({ type: 'string' });
    expect(spawn?.inputSchema.properties?.['effort']).toMatchObject({
      type: 'string',
      enum: ['low', 'medium', 'high'],
    });
    expect(JSON.stringify(spawn?.inputSchema.properties?.['model'])).toContain('get_map');
    expect(JSON.stringify(spawn?.inputSchema.properties?.['effort'])).toContain('get_map');
  });

  it('гид называет в подписи spawn_session все параметры инструмента, в том же порядке', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const spawn = tools.find((tool) => tool.name === 'spawn_session');
    const signature = /`spawn_session\(([^)]*)\)`/.exec(guideTopic('tools') ?? '')?.[1];

    // Подпись в теме `tools` — то, что агент читает вместо схемы: параметр, которого в ней нет, он не найдёт.
    expect(signature?.split(',').map((name) => name.trim())).toEqual(
      Object.keys(spawn?.inputSchema.properties ?? {}),
    );
  });

  it('send_message: replyTo — необязательная строка; описание — про id из check_inbox или read_room и цитату в окне', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const send = tools.find((tool) => tool.name === 'send_message');
    const replyTo = send?.inputSchema.properties?.['replyTo'] as
      { type?: string; description?: string } | undefined;

    expect(send?.inputSchema.required).toEqual(['text']);
    expect(replyTo?.type).toBe('string');
    expect(replyTo?.description).toMatch(/check_inbox or read_room/);
    expect(replyTo?.description).toMatch(/quote/);
    expect(replyTo?.description).toMatch(/Only together with room/);
  });

  it('гид называет в подписи send_message все параметры инструмента, в том же порядке', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const send = tools.find((tool) => tool.name === 'send_message');
    const signature = /`send_message\(([^)]*)\)`/.exec(guideTopic('tools') ?? '')?.[1];

    expect(signature?.split(',').map((name) => name.trim())).toEqual(
      Object.keys(send?.inputSchema.properties ?? {}),
    );
  });

  it('read_guide: topic необязателен, enum — темы гида, описание перечисляет их', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const guide = tools.find((tool) => tool.name === 'read_guide');
    const names = GUIDE_TOPICS.map((item) => item.topic);

    expect(guide?.inputSchema.required ?? []).toEqual([]);
    expect(Object.keys(guide?.inputSchema.properties ?? {})).toEqual(['topic']);
    expect(guide?.inputSchema.properties?.['topic']).toMatchObject({ type: 'string', enum: names });
    for (const name of names) expect(guide?.description).toContain(name);
  });

  it('create_room: lead необязателен, описание называет ведущего по умолчанию', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const createRoom = tools.find((tool) => tool.name === 'create_room');

    expect(createRoom?.inputSchema.required).toEqual(['title', 'members']);
    expect(Object.keys(createRoom?.inputSchema.properties ?? {}).sort()).toEqual([
      'lead',
      'members',
      'title',
    ]);
    expect(createRoom?.description).toMatch(/lead/);
  });

  it('описание get_map отсылает ко второму слою гида', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const getMap = tools.find((tool) => tool.name === 'get_map');

    expect(getMap?.description).toMatch(/the detailed guide is the read_guide tool$/);
  });

  it('описания инструментов и параметров — по-английски: кириллицы в списке инструментов нет', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();

    expect(JSON.stringify(tools)).not.toMatch(/[А-Яа-яЁё]/);
  });

  it('ни в одном описании нет устаревшего текста «pending запускает человек»', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.description ?? '').not.toContain('pending is started by the human');
    }
  });

  it('report и close_session говорят, что done не закрывает сессию, а close_session — только с согласия', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const report = tools.find((tool) => tool.name === 'report');
    const closeSession = tools.find((tool) => tool.name === 'close_session');

    expect(report?.description).toMatch(/stays reachable/);
    expect(closeSession?.description).toMatch(/only after the human's explicit consent/);
  });

  it('wait_for предупреждает: сдавшей report сессии — ждать через inbox, не по id', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const waitFor = tools.find((tool) => tool.name === 'wait_for');

    expect(waitFor?.description).toMatch(/"inbox"[\s\S]*not by id/);
  });
});

describe('read_guide', () => {
  it('отдаёт подробный гид целиком', async () => {
    const client = await connect('s-01');
    const result = await call(client, 'read_guide');

    expect(result.isError, result.text).toBe(false);
    expect(result.text).toBe(GUIDE);
  });

  it('работает без PARLEY_SESSION_ID: гид не про конкретную сессию', async () => {
    const client = await connect(null);
    const result = await call(client, 'read_guide');

    expect(result.isError, result.text).toBe(false);
    expect(result.text).toBe(GUIDE);
  });

  it('с темой отдаёт один раздел — каждая тема гида отвечает своим текстом', async () => {
    const client = await connect('s-01');

    for (const { topic } of GUIDE_TOPICS) {
      const result = await call(client, 'read_guide', { topic });
      expect(result.isError, `${topic}: ${result.text}`).toBe(false);
      expect(result.text, topic).toBe(guideTopic(topic));
      // Раздел короче всего гида: тема не отдаёт лишнего.
      expect(result.text.length, topic).toBeLessThan(GUIDE.length);
    }
  });

  it('тема работает и без PARLEY_SESSION_ID', async () => {
    const client = await connect(null);
    const result = await call(client, 'read_guide', { topic: 'rooms' });

    expect(result.isError, result.text).toBe(false);
    expect(result.text).toBe(guideTopic('rooms'));
  });

  it('пустая тема — как её отсутствие: весь гид', async () => {
    const client = await connect('s-01');
    const result = await call(client, 'read_guide', { topic: '' });

    expect(result.isError, result.text).toBe(false);
    expect(result.text).toBe(GUIDE);
  });

  it('регистр и пробелы по краям темы не мешают', async () => {
    const client = await connect('s-01');
    const result = await call(client, 'read_guide', { topic: ' Lead ' });

    expect(result.isError, result.text).toBe(false);
    expect(result.text).toBe(guideTopic('lead'));
  });

  it('неизвестная тема — ошибка со списком тем', async () => {
    const client = await connect('s-01');
    const result = await call(client, 'read_guide', { topic: 'нет-такой' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('нет-такой');
    for (const { topic } of GUIDE_TOPICS) expect(result.text).toContain(topic);
  });

  it('тема не строкой — ошибка с именем аргумента', async () => {
    const client = await connect('s-01');
    const result = await call(client, 'read_guide', { topic: 7 });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('topic');
  });
});

describe('get_map', () => {
  it('отдаёт карту, свою сессию и провайдеров с флагом доступности', async () => {
    const client = await connect('s-01');
    const result = await callOk(client, 'get_map');

    expect(result['sessionId']).toBe('s-01');
    expect((result['map'] as WorkMap).work.title).toBe('Авторизация');
    expect((result['map'] as WorkMap).sessions).toHaveLength(1);

    const providers = result['providers'] as {
      id: string;
      label: string;
      available: boolean;
      models: { id: string; label: string }[] | null;
      effort: boolean;
    }[];
    expect(providers.find((entry) => entry.id === 'claude')).toMatchObject({
      id: 'claude',
      label: 'Claude',
      available: true,
    });
    expect(providers.find((entry) => entry.id === 'codex')?.available).toBe(false);
  });

  it('провайдеры несут то же, что providers.list окна: список моделей и принимает ли усилие', async () => {
    const client = await connect('s-01');
    const result = await callOk(client, 'get_map');
    const providers = result['providers'] as {
      id: string;
      models: { id: string; label: string }[] | null;
      effort: boolean;
    }[];
    const byId = (id: string) => providers.find((entry) => entry.id === id);

    expect(byId('claude')?.models).toEqual(selectableModels(PROVIDERS.claude));
    expect(byId('claude')?.models?.map((model) => model.id)).toContain('opus');
    expect(byId('claude')?.effort).toBe(true);
    expect(byId('codex')?.models).toEqual(selectableModels(PROVIDERS.codex));
    expect(byId('codex')?.effort).toBe(true);
    // У glm нет ни шаблона с моделью, ни списка: контролов у него нет.
    expect(byId('glm')).toMatchObject({ models: null, effort: false });
  });

  it('работает без PARLEY_SESSION_ID', async () => {
    const client = await connect(null);
    const result = await callOk(client, 'get_map');

    expect(result['sessionId']).toBeNull();
    expect((result['map'] as WorkMap).work.id).toBe(workId);
  });
});

describe('без PARLEY_SESSION_ID', () => {
  it('остальные инструменты объясняют, что сессию надо создать через харнесс', async () => {
    const client = await connect(null);
    const calls = [
      call(client, 'report', { status: 'progress', summary: 'что-то' }),
      call(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' }),
      call(client, 'wait_for', { target: 'inbox', timeoutSec: 0 }),
      call(client, 'send_message', { to: 's-01', text: 'привет' }),
      call(client, 'check_inbox'),
      call(client, 'create_room', { title: 'x', members: ['s-01'] }),
      call(client, 'read_room', { room: 'r-01' }),
      call(client, 'propose_decision', { room: 'r-01', text: 'решение' }),
      call(client, 'close_session', { target: 's-01' }),
    ];

    for (const result of await Promise.all(calls)) {
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/PARLEY_SESSION_ID/);
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
      artifacts: [{ kind: 'plan', path: '.parley/works/w-0001/artifacts/plan.md' }],
    });

    expect(result['status']).toBe('done');
    const stored = session(await readMapFile(), 's-01');
    expect(stored.result).toBe('done');
    // Итог процесс не меняет (спецификация 7.1).
    expect(stored.lifecycle).toBe('pending');
    expect(stored.summary).toBe('план готов');
    expect(stored.artifacts).toEqual([
      { kind: 'plan', path: '.parley/works/w-0001/artifacts/plan.md' },
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
    expect(result.text).toMatch(/relative to the project root/i);
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
    expect(result.text).toMatch(/outside the project/);
    expect(session(await readMapFile(), 's-01').result).toBeNull();
  });

  it('неизвестный статус — ошибка', async () => {
    const client = await connect('s-01');
    const result = await call(client, 'report', { status: 'готово', summary: 'x' });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/done/);
  });

  it('после close_session — ошибка любым статусом, резюме не меняется', async () => {
    const client = await connect('s-01');
    await callOk(client, 'close_session', { target: 's-01' });

    const progress = await call(client, 'report', { status: 'progress', summary: 'x' });
    expect(progress.isError).toBe(true);
    expect(progress.text).toContain('is closed');

    const done = await call(client, 'report', { status: 'done', summary: 'x' });
    expect(done.isError).toBe(true);
    expect(session(await readMapFile(), 's-01').summary).toBeNull();
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

  it('пустая задача — ошибка: тихий старт доступен только окну и CLI', async () => {
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
    expect(result.text).toContain('agent reviewer does not exist');
    expect((await readMapFile()).sessions).toHaveLength(1);
  });

  it('провайдер без подстановки {agent} — ошибка, записи нет', async () => {
    // У codex флага роли нет: запись, которую нечем запустить ролью, не заводим.
    process.env.PARLEY_CODEX_BIN = path.join(binDir, 'claude');
    const client = await connect('s-01');
    const result = await call(client, 'spawn_session', {
      provider: 'codex',
      label: 'ревью',
      task: 'проверить план',
      agent: 'reviewer',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('does not accept agents');
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

describe('spawn_session worktree', () => {
  it('проект не git — ошибка, записи нет', async () => {
    const client = await connect('s-01');

    const result = await call(client, 'spawn_session', {
      provider: 'claude',
      label: 'бэк',
      task: 'делать',
      worktree: true,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('the project has no git');
    expect((await readMapFile()).sessions).toHaveLength(1);
  });

  it('git-проект — план worktree с createdAt: null и базой от ветки проекта', async () => {
    await initGitProject();
    const worktreeRoot = path.join(home, 'worktrees');
    const client = await connect('s-01', 40, DEFAULT_CONFIG.messageRate, false, [], worktreeRoot);

    const result = await callOk(client, 'spawn_session', {
      provider: 'claude',
      label: 'бэк',
      task: 'делать',
      worktree: true,
    });
    expect(result).toEqual({ sessionId: 's-02' });

    const stored = session(await readMapFile(), 's-02');
    expect(stored.worktree).not.toBeNull();
    expect(stored.worktree?.branch).toBe(`${BRANCH_PREFIX}${workId}/s-02`);
    expect(stored.worktree?.branch).toBe(`parley/${workId}/s-02`);
    expect(stored.worktree?.base).toBe('main');
    expect(stored.worktree?.createdAt).toBeNull();
    expect(path.dirname(stored.worktree?.path ?? '')).toContain(worktreeRoot);
  });

  it('ребёнок сессии в worktree берёт базой ветку родителя', async () => {
    await initGitProject();
    const worktreeRoot = path.join(home, 'worktrees');
    const first = await connect('s-01', 40, DEFAULT_CONFIG.messageRate, false, [], worktreeRoot);
    await callOk(first, 'spawn_session', {
      provider: 'claude',
      label: 'бэк',
      task: 'делать',
      worktree: true,
    }); // s-02, база — main

    const second = await connect('s-02', 40, DEFAULT_CONFIG.messageRate, false, [], worktreeRoot);
    await callOk(second, 'spawn_session', {
      provider: 'claude',
      label: 'ревью',
      task: 'проверить',
      worktree: true,
    }); // s-03, родитель — s-02, уже в своём worktree

    const parentBranch = session(await readMapFile(), 's-02').worktree?.branch;
    const child = session(await readMapFile(), 's-03');
    expect(child.worktree?.base).toBe(parentBranch);
  });
});

describe('spawn_session: модель и усилие', () => {
  /** Свои провайдеры: шаблоны решают, что доедет до команды. Бинарь — заглушка из `beforeEach`. */
  async function withProviders(): Promise<void> {
    await writeFile(
      path.join(home, 'providers.json'),
      JSON.stringify({
        // `{model}` есть, списка нет: значение идёт в команду как есть.
        smart: { badge: 'Smart', command: 'smart', args: ['--m', '{model}', '{prompt}'] },
        // Ни `{model}`, ни `{effort}`: выбор отбрасывается.
        plain: { badge: 'Plain', command: 'plain', args: ['{prompt}'] },
      }),
      'utf8',
    );
    process.env.PARLEY_SMART_BIN = path.join(binDir, 'claude');
    process.env.PARLEY_PLAIN_BIN = path.join(binDir, 'claude');
  }
  afterEach(() => {
    delete process.env.PARLEY_SMART_BIN;
    delete process.env.PARLEY_PLAIN_BIN;
  });

  it('модель из списка и усилие ложатся в запись сессии', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', {
      provider: 'claude',
      label: 'бэк',
      task: 'делать',
      model: 'opus',
      effort: 'high',
    });

    const stored = session(await readMapFile(), 's-02');
    expect(stored.model).toBe('opus');
    expect(stored.effort).toBe('high');
  });

  it('каждая модель списка провайдера проходит', async () => {
    const client = await connect('s-01');
    for (const { id } of selectableModels(PROVIDERS.claude) ?? []) {
      const result = await call(client, 'spawn_session', {
        provider: 'claude',
        label: 'бэк',
        task: 'делать',
        model: id,
      });
      expect(result.isError, `${id}: ${result.text}`).toBe(false);
    }
  });

  it('без выбора полей в записи нет: модель и усилие по умолчанию', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });

    const stored = session(await readMapFile(), 's-02');
    expect('model' in stored).toBe(false);
    expect('effort' in stored).toBe(false);
  });

  it('пустые model и effort — как отсутствие', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', {
      provider: 'claude',
      label: 'бэк',
      task: 'делать',
      model: '',
      effort: '',
    });

    const stored = session(await readMapFile(), 's-02');
    expect('model' in stored).toBe(false);
    expect('effort' in stored).toBe(false);
  });

  it('модель не из списка — ошибка с допустимыми, записи нет', async () => {
    const client = await connect('s-01');
    // Значение чужого провайдера, иное написание и закреплённая версия — не из списка: сверка точная.
    for (const model of ['gpt-6-sol', 'Opus', 'claude-opus-5-5']) {
      const result = await call(client, 'spawn_session', {
        provider: 'claude',
        label: 'бэк',
        task: 'делать',
        model,
      });

      expect(result.isError, model).toBe(true);
      expect(result.text, model).toContain(model);
      expect(result.text, model).toContain('claude');
      expect(result.text, model).toContain('opusplan');
    }
    expect((await readMapFile()).sessions).toHaveLength(1);
  });

  it('модель, которую CLI принял бы за флаг или разорвал пробелом, — ошибка, записи нет', async () => {
    const client = await connect('s-01');
    for (const model of ['--effort', 'op us', 'x'.repeat(201)]) {
      const result = await call(client, 'spawn_session', {
        provider: 'claude',
        label: 'бэк',
        task: 'делать',
        model,
      });
      expect(result.isError, model).toBe(true);
    }
    expect((await readMapFile()).sessions).toHaveLength(1);
  });

  it('усилие вне трёх уровней — ошибка с перечнем, записи нет', async () => {
    const client = await connect('s-01');
    const result = await call(client, 'spawn_session', {
      provider: 'claude',
      label: 'бэк',
      task: 'делать',
      effort: 'extreme',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('low | medium | high');
    expect((await readMapFile()).sessions).toHaveLength(1);
  });

  it('codex: своя модель проходит, модель Claude — нет', async () => {
    process.env.PARLEY_CODEX_BIN = path.join(binDir, 'claude');
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', {
      provider: 'codex',
      label: 'бэк',
      task: 'делать',
      model: 'gpt-6-sol',
      effort: 'low',
    });
    expect(session(await readMapFile(), 's-02')).toMatchObject({ model: 'gpt-6-sol', effort: 'low' });

    const refused = await call(client, 'spawn_session', {
      provider: 'codex',
      label: 'бэк',
      task: 'делать',
      model: 'opus',
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('codex');
    expect((await readMapFile()).sessions).toHaveLength(2);
  });

  it('провайдер без списка, но с {model} в шаблоне: значение принимается как есть', async () => {
    await withProviders();
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', {
      provider: 'smart',
      label: 'бэк',
      task: 'делать',
      model: 'anything',
    });

    expect(session(await readMapFile(), 's-02').model).toBe('anything');
  });

  it('провайдер без флагов в шаблоне выбор отбрасывает молча: запись заводится без него', async () => {
    await withProviders();
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', {
      provider: 'plain',
      label: 'бэк',
      task: 'делать',
      model: 'anything',
      effort: 'high',
    });

    const stored = session(await readMapFile(), 's-02');
    expect('model' in stored).toBe(false);
    expect('effort' in stored).toBe(false);
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
      {
        id: 'm-01',
        from: 's-02',
        fromLabel: 'бэк',
        at: stored?.at,
        text: 'нужен план',
        kind: 'note',
        room: null,
      },
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
    expect(refused.text).toContain('too many messages');
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

  it('to массивом из одного элемента — как строка', async () => {
    const first = await connect('s-01');
    await callOk(first, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    const second = await connect('s-02');

    const sent = await callOk(second, 'send_message', { to: ['s-01'], text: 'массивом' });
    expect(sent['messageId']).toBe('m-01');
    expect((await readMapFile()).messages[0]?.to).toEqual(['s-01']);
  });

  it('без room несколько адресатов в to — ошибка, письмо не создано', async () => {
    const first = await connect('s-01');
    await callOk(first, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });

    const result = await call(first, 'send_message', { to: ['s-01', 's-02'], text: 'кому?' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('room');
    expect((await readMapFile()).messages).toEqual([]);
  });

  it('закрытому адресату без room — ошибка', async () => {
    const first = await connect('s-01');
    await callOk(first, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    await callOk(first, 'close_session', { target: 's-02' });

    const result = await call(first, 'send_message', { to: 's-02', text: 'привет' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('s-02');
    expect(result.text).toContain('is closed');
  });
});

describe('create_room', () => {
  it('незнакомый участник — ошибка, комната не создаётся', async () => {
    const client = await connect('s-01');
    const result = await call(client, 'create_room', { title: 'бэкенд', members: ['s-09'] });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('s-09');
    expect((await readMapFile()).rooms).toEqual([]);
  });

  it('повторы схлопнуты, создатель в members не попадает', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'ревью', task: 'делать' }); // s-03

    const result = await callOk(client, 'create_room', {
      title: 'бэкенд',
      members: ['s-02', 's-02', 's-03', 's-01'],
    });

    expect(result).toEqual({ roomId: 'r-01' });
    const room = (await readMapFile()).rooms[0];
    expect(room?.creator).toBe('s-01');
    expect(room?.members).toEqual(['s-02', 's-03']);
  });

  it('письмо о добавлении уходит всем участникам, кроме создателя', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'ревью', task: 'делать' }); // s-03
    await callOk(client, 'create_room', { title: 'бэкенд', members: ['s-02', 's-03'] });

    const second = await connect('s-02');
    const inboxSecond = await callOk(second, 'check_inbox');
    expect((inboxSecond['messages'] as { text: string }[]).map((m) => m.text)).toEqual([
      'You were added to r-01 "бэкенд" with S02 and S03',
    ]);

    const third = await connect('s-03');
    const inboxThird = await callOk(third, 'check_inbox');
    expect((inboxThird['messages'] as { text: string }[]).map((m) => m.text)).toEqual([
      'You were added to r-01 "бэкенд" with S02 and S03',
    ]);

    // Создатель своё же приглашение не получает.
    expect((await callOk(client, 'check_inbox'))['messages']).toEqual([]);
  });

  it('закрытый участник — ошибка, комната не создаётся', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await callOk(client, 'close_session', { target: 's-02' });

    const result = await call(client, 'create_room', { title: 'x', members: ['s-02'] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('s-02');
    expect((await readMapFile()).rooms).toEqual([]);
  });

  /** Id комнат работы, в которых состоит сессия: создатель или участник. */
  const roomsOf = (map: WorkMap, id: string): string[] =>
    map.rooms.filter((room) => room.creator === id || room.members.includes(id)).map((room) => room.id);

  it('одна комната на сессию: участник из другой комнаты после create_room состоит только в новой, прежняя остаётся с письмами', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'ревью', task: 'делать' }); // s-03
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'тесты', task: 'делать' }); // s-04
    const older = await connect('s-02');
    await callOk(older, 'create_room', { title: 'прежняя', members: ['s-03', 's-04'] }); // r-01: создатель и ведущий s-02
    expect(roomsOf(await readMapFile(), 's-03')).toEqual(['r-01']);

    // Отказ карту не меняет: s-04 не из круга новой комнаты, ведущим быть не может — s-03 остаётся в r-01.
    const refused = await call(client, 'create_room', { title: 'новая', members: ['s-03'], lead: 's-04' });
    expect(refused.isError).toBe(true);
    expect(roomsOf(await readMapFile(), 's-03')).toEqual(['r-01']);

    expect(await callOk(client, 'create_room', { title: 'новая', members: ['s-03'] })).toEqual({ roomId: 'r-02' });
    const map = await readMapFile();
    expect(roomsOf(map, 's-03')).toEqual(['r-02']);
    expect(map.rooms.find((room) => room.id === 'r-02')).toMatchObject({ creator: 's-01', members: ['s-03'], lead: 's-01' });
    // Прежняя комната не тронута, кроме ушедшего участника: создатель, ведущий и письма на месте.
    expect(map.rooms.find((room) => room.id === 'r-01')).toMatchObject({ creator: 's-02', members: ['s-04'], lead: 's-02' });
    expect(map.messages.filter((message) => message.roomId === 'r-01').map((message) => message.to)).toEqual([['s-03'], ['s-04']]);
  });

  it('одна комната на сессию: создатель прежней комнаты уступает её человеку и остаётся только в новой', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'ревью', task: 'делать' }); // s-03
    await callOk(client, 'create_room', { title: 'прежняя', members: ['s-02'] }); // r-01: создатель и ведущий s-01
    expect(roomsOf(await readMapFile(), 's-01')).toEqual(['r-01']);

    await callOk(client, 'create_room', { title: 'новая', members: ['s-03'] }); // r-02
    const map = await readMapFile();
    expect(roomsOf(map, 's-01')).toEqual(['r-02']);
    // Как `leaveOtherRooms`: создатель-сессия уступает комнату человеку, назначенный ведущий уходит с ней; участники остаются.
    expect(map.rooms.find((room) => room.id === 'r-01')).toMatchObject({ creator: HUMAN, members: ['s-02'], lead: null });
  });
});

describe('create_room: ведущий', () => {
  /** s-01 — вызывающий; s-02 и s-03 заведены заранее. */
  async function withColleagues(): Promise<Client> {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'ревью', task: 'делать' }); // s-03
    return client;
  }

  it('без lead ведущий — сам вызывающий, а не первый из members', async () => {
    const client = await withColleagues();
    await callOk(client, 'create_room', { title: 'бэкенд', members: ['s-02', 's-03'] });

    const room = (await readMapFile()).rooms[0];
    expect(room?.lead).toBe('s-01');
    expect(room?.creator).toBe('s-01');
    expect(room?.members).toEqual(['s-02', 's-03']);
  });

  it('lead из members — ведущий он, создатель остаётся создателем', async () => {
    const client = await withColleagues();
    await callOk(client, 'create_room', {
      title: 'бэкенд',
      members: ['s-02', 's-03'],
      lead: 's-03',
    });

    const room = (await readMapFile()).rooms[0];
    expect(room?.lead).toBe('s-03');
    expect(room?.creator).toBe('s-01');
  });

  it('lead — сам вызывающий, названный явно', async () => {
    const client = await withColleagues();
    await callOk(client, 'create_room', { title: 'бэкенд', members: ['s-02'], lead: 's-01' });

    expect((await readMapFile()).rooms[0]?.lead).toBe('s-01');
  });

  it('lead не из круга комнаты — ошибка, комнаты и писем нет, номер комнаты не потрачен', async () => {
    const client = await withColleagues();

    // s-03 есть в работе, но в комнату не входит; человек ведущим быть не может; s-77 нет вовсе.
    for (const lead of ['s-03', HUMAN, 's-77']) {
      const refused = await call(client, 'create_room', {
        title: 'бэкенд',
        members: ['s-02'],
        lead,
      });
      expect(refused.isError, lead).toBe(true);
      expect(refused.text, lead).toContain(lead);
    }
    const map = await readMapFile();
    expect(map.rooms).toEqual([]);
    expect(map.messages).toEqual([]);
    expect(await callOk(client, 'create_room', { title: 'бэкенд', members: ['s-02'] })).toEqual({
      roomId: 'r-01',
    });
  });
});

describe('add_to_room', () => {
  /**
   * Комната r-01 «комната»: s-01 — вызывающий и ведущий по умолчанию, s-02 — участник (приглашение
   * забрано). s-03 и s-04 заведены в работе, но в комнату не входят.
   */
  async function setup(): Promise<{ lead: Client; member: Client }> {
    const lead = await connect('s-01');
    await callOk(lead, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await callOk(lead, 'spawn_session', { provider: 'claude', label: 'ревью', task: 'делать' }); // s-03
    await callOk(lead, 'spawn_session', { provider: 'claude', label: 'тесты', task: 'делать' }); // s-04
    await callOk(lead, 'create_room', { title: 'комната', members: ['s-02'] });
    const member = await connect('s-02');
    await callOk(member, 'check_inbox');
    return { lead, member };
  }

  /** Карта как есть на диске: после отказа она должна совпасть байт в байт. */
  const rawMap = (): Promise<string> => readFile(workPaths(project, workId).map, 'utf8');

  it('ведущий вводит живую сессию: она в members, в ленте — системная строка, письма ей нет', async () => {
    const { lead } = await setup();
    const result = await callOk(lead, 'add_to_room', { room: 'r-01', session: 's-04' });

    const map = await readMapFile();
    expect(map.rooms[0]?.members).toEqual(['s-02', 's-04']);
    const line = map.messages.at(-1);
    expect(result).toEqual({ messageId: line?.id });
    expect(line).toMatchObject({
      roomId: 'r-01',
      from: 'system',
      to: [HUMAN],
      text: '@s04 joined the room',
    });
    // Письма о добавлении новому участнику не пишется: его ящик пуст.
    const added = await connect('s-04');
    expect(await callOk(added, 'check_inbox')).toEqual({ messages: [] });
  });

  it('одна комната на сессию: введённая уходит из другой комнаты той же работы', async () => {
    const { lead } = await setup();
    // Комнату с s-03 заводит s-04, а не ведущий r-01: тот, заведя её, сам ушёл бы из r-01 (`create_room` тоже проводит одну комнату на сессию).
    const other = await connect('s-04');
    await callOk(other, 'create_room', { title: 'вторая', members: ['s-03'] }); // r-02, ведущий s-04
    await callOk(lead, 'add_to_room', { room: 'r-01', session: 's-03' });

    const map = await readMapFile();
    expect(map.rooms.find((room) => room.id === 'r-01')?.members).toEqual(['s-02', 's-03']);
    expect(map.rooms.find((room) => room.id === 'r-02')?.members).toEqual([]);
  });

  it('участник комнаты вводить не может: ошибка «не ведущий», карта не изменилась', async () => {
    const { member } = await setup();
    const before = await rawMap();

    const refused = await call(member, 'add_to_room', { room: 'r-01', session: 's-04' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/not the lead/);
    expect(await rawMap()).toBe(before);
  });

  it('посторонний тоже не ведущий — карта не изменилась', async () => {
    await setup();
    const stranger = await connect('s-03');
    const before = await rawMap();

    const refused = await call(stranger, 'add_to_room', { room: 'r-01', session: 's-04' });
    expect(refused.isError).toBe(true);
    expect(await rawMap()).toBe(before);
  });

  it('ведущий — живой ведущий: назначенный закрыт — вводит первый живой участник', async () => {
    const { lead, member } = await setup();
    await callOk(lead, 'close_session', { target: 's-01' });
    const before = await rawMap();

    const closedLead = await call(lead, 'add_to_room', { room: 'r-01', session: 's-04' });
    expect(closedLead.isError).toBe(true);
    expect(await rawMap()).toBe(before);

    await callOk(member, 'add_to_room', { room: 'r-01', session: 's-04' });
    expect((await readMapFile()).rooms[0]?.members).toEqual(['s-02', 's-04']);
  });

  it('закрытая комната — ошибка, карта не изменилась', async () => {
    const { lead } = await setup();
    await callOk(lead, 'close_session', { target: 's-02' });
    await callOk(lead, 'close_session', { target: 's-01' });
    const before = await rawMap();

    const refused = await call(lead, 'add_to_room', { room: 'r-01', session: 's-04' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/is closed/);
    expect(await rawMap()).toBe(before);
  });

  it('чужая, закрытая сессия и уже участник — ошибка, карта не изменилась', async () => {
    const { lead } = await setup();
    await callOk(lead, 'close_session', { target: 's-03' });
    const before = await rawMap();

    const cases: Array<[string, RegExp]> = [
      ['s-77', /is not in the map/],
      ['s-03', /is closed/],
      ['s-02', /already a participant/],
      ['s-01', /already a participant/],
    ];
    for (const [session, message] of cases) {
      const refused = await call(lead, 'add_to_room', { room: 'r-01', session });
      expect(refused.isError, session).toBe(true);
      expect(refused.text, session).toMatch(message);
    }
    expect(await rawMap()).toBe(before);
  });

  it('комнаты нет — ошибка; без room или session — ошибка с именем аргумента', async () => {
    const { lead } = await setup();
    const before = await rawMap();

    const unknown = await call(lead, 'add_to_room', { room: 'r-09', session: 's-04' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('r-09');
    const noRoom = await call(lead, 'add_to_room', { session: 's-04' });
    expect(noRoom.isError).toBe(true);
    expect(noRoom.text).toContain('room');
    const noSession = await call(lead, 'add_to_room', { room: 'r-01' });
    expect(noSession.isError).toBe(true);
    expect(noSession.text).toContain('session');
    expect(await rawMap()).toBe(before);
  });

  it('сервер удалённой сессии ведущим не служит', async () => {
    const { lead } = await setup();
    // s-01 удалена человеком, а её сервер ещё жив: SessionEnd приходит раньше выхода процесса.
    await updateMap(project, workId, (map) => {
      removeSession(map, 's-01');
    });
    const before = await rawMap();

    const refused = await call(lead, 'add_to_room', { room: 'r-01', session: 's-04' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('s-01');
    expect(await rawMap()).toBe(before);
  });
});

describe('propose_decision', () => {
  /** Комната r-01 создана s-01 (ведущий по умолчанию) с s-02 и s-03; приглашения забраны. */
  async function leadRoom(): Promise<{ lead: Client; a: Client; b: Client }> {
    const lead = await connect('s-01');
    await callOk(lead, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await callOk(lead, 'spawn_session', { provider: 'claude', label: 'ревью', task: 'делать' }); // s-03
    await callOk(lead, 'create_room', { title: 'комната', members: ['s-02', 's-03'] });
    const a = await connect('s-02');
    const b = await connect('s-03');
    await callOk(a, 'check_inbox');
    await callOk(b, 'check_inbox');
    return { lead, a, b };
  }

  /** Карта как есть на диске: после отказа она должна совпасть байт в байт. */
  const rawMap = (): Promise<string> => readFile(workPaths(project, workId).map, 'utf8');

  it('ведущий: { proposalId, rev: 0 }, решение лежит в слоте комнаты', async () => {
    const { lead } = await leadRoom();
    const result = await callOk(lead, 'propose_decision', {
      room: 'r-01',
      text: 'Делаем через очередь.',
    });

    expect(result).toEqual({ proposalId: 'p-01', rev: 0 });
    const proposal = (await readMapFile()).rooms[0]?.proposal;
    expect(proposal).toMatchObject({
      id: 'p-01',
      from: 's-01',
      text: 'Делаем через очередь.',
      rev: 0,
    });
  });

  it('повтор до ответа человека — тот же proposalId, rev 1, текст заменён', async () => {
    const { lead } = await leadRoom();
    await callOk(lead, 'propose_decision', { room: 'r-01', text: 'первая редакция' });
    const again = await callOk(lead, 'propose_decision', { room: 'r-01', text: 'вторая редакция' });

    expect(again).toEqual({ proposalId: 'p-01', rev: 1 });
    const proposal = (await readMapFile()).rooms[0]?.proposal;
    expect(proposal).toMatchObject({ id: 'p-01', text: 'вторая редакция', rev: 1 });
  });

  it('после ответа человека новое решение — новый proposalId и rev 0', async () => {
    const { lead } = await leadRoom();
    await callOk(lead, 'propose_decision', { room: 'r-01', text: 'раз' });
    await updateMap(project, workId, (map) => {
      resolveProposal(map, 'r-01', 'p-01', 'return', { note: 'мало' });
    });

    expect(await callOk(lead, 'propose_decision', { room: 'r-01', text: 'два' })).toEqual({
      proposalId: 'p-02',
      rev: 0,
    });
  });

  it('не ведущий — ошибка, карта не изменилась', async () => {
    const { a } = await leadRoom();
    const before = await rawMap();

    const refused = await call(a, 'propose_decision', { room: 'r-01', text: 'я тоже хочу' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/not the lead/);
    expect(await rawMap()).toBe(before);
  });

  it('сессия не из комнаты — тоже не ведущий', async () => {
    const { lead } = await leadRoom();
    await callOk(lead, 'spawn_session', { provider: 'claude', label: 'сторонний', task: 'делать' }); // s-04
    const stranger = await connect('s-04');
    const before = await rawMap();

    const refused = await call(stranger, 'propose_decision', { room: 'r-01', text: 'а можно?' });
    expect(refused.isError).toBe(true);
    expect(await rawMap()).toBe(before);
  });

  it('закрытая комната (нет живых участников) — ошибка, карта не изменилась', async () => {
    const { lead } = await leadRoom();
    await callOk(lead, 'close_session', { target: 's-02' });
    await callOk(lead, 'close_session', { target: 's-03' });
    await callOk(lead, 'close_session', { target: 's-01' });
    const before = await rawMap();

    const refused = await call(lead, 'propose_decision', { room: 'r-01', text: 'решение' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/is closed/);
    expect(await rawMap()).toBe(before);
  });

  it('ведущий — живой ведущий: ушёл назначенный — решение приносит первый живой участник', async () => {
    const { lead, a, b } = await leadRoom();
    await callOk(lead, 'close_session', { target: 's-01' });

    const closedLead = await call(lead, 'propose_decision', { room: 'r-01', text: 'из могилы' });
    expect(closedLead.isError).toBe(true);
    const thirdInLine = await call(b, 'propose_decision', { room: 'r-01', text: 'я третий' });
    expect(thirdInLine.isError).toBe(true);
    expect(await callOk(a, 'propose_decision', { room: 'r-01', text: 'веду я' })).toEqual({
      proposalId: 'p-01',
      rev: 0,
    });
  });

  it('комната человека: ведущий — назначенный, ни создатель-человек, ни первый участник', async () => {
    const { a, b } = await leadRoom();
    await updateMap(project, workId, (map) => {
      addRoom(map, { title: 'штаб', creator: HUMAN, members: ['s-02', 's-03'], lead: 's-03' });
    });

    const refused = await call(a, 'propose_decision', { room: 'r-02', text: 'первый участник' });
    expect(refused.isError).toBe(true);
    expect(await callOk(b, 'propose_decision', { room: 'r-02', text: 'назначенный' })).toEqual({
      proposalId: 'p-01',
      rev: 0,
    });
  });

  it('комната старой карты (lead: null): ведущий — первый из участников', async () => {
    const { lead, a } = await leadRoom();
    await updateMap(project, workId, (map) => {
      addRoom(map, { title: 'старая', creator: HUMAN, members: ['s-02', 's-03'] });
    });

    expect((await call(lead, 'propose_decision', { room: 'r-02', text: 'x' })).isError).toBe(true);
    expect(await callOk(a, 'propose_decision', { room: 'r-02', text: 'x' })).toEqual({
      proposalId: 'p-01',
      rev: 0,
    });
  });

  it('пустой и слишком длинный текст — ошибка, карта не изменилась', async () => {
    const { lead } = await leadRoom();
    const before = await rawMap();

    for (const text of ['', '   \n ', 'я'.repeat(PROPOSAL_TEXT_MAX + 1)]) {
      const refused = await call(lead, 'propose_decision', { room: 'r-01', text });
      expect(refused.isError, JSON.stringify(text.slice(0, 8))).toBe(true);
    }
    expect(await rawMap()).toBe(before);
  });

  it('комнаты нет — ошибка; без room или text — ошибка с именем аргумента', async () => {
    const { lead } = await leadRoom();
    const before = await rawMap();

    const missingRoom = await call(lead, 'propose_decision', { room: 'r-77', text: 'решение' });
    expect(missingRoom.isError).toBe(true);
    expect(missingRoom.text).toContain('r-77');

    const noRoom = await call(lead, 'propose_decision', { text: 'решение' });
    expect(noRoom.isError).toBe(true);
    expect(noRoom.text).toContain('room');
    const noText = await call(lead, 'propose_decision', { room: 'r-01' });
    expect(noText.isError).toBe(true);
    expect(noText.text).toContain('text');
    expect(await rawMap()).toBe(before);
  });

  it('решение — слот, а не письмо: лента не растёт, участникам ничего не приходит', async () => {
    const { lead, a } = await leadRoom();
    const messagesBefore = (await readMapFile()).messages.length;

    await callOk(lead, 'propose_decision', { room: 'r-01', text: 'решение' });

    expect((await readMapFile()).messages).toHaveLength(messagesBefore);
    expect(await callOk(a, 'check_inbox')).toEqual({ messages: [] });
  });
});

describe('send_message и check_inbox в комнате', () => {
  /** Комната с двумя участниками; приглашения уже забраны check_inbox. */
  async function roomSetup(): Promise<{ owner: Client; a: Client; b: Client }> {
    const owner = await connect('s-01');
    await callOk(owner, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await callOk(owner, 'spawn_session', { provider: 'claude', label: 'ревью', task: 'делать' }); // s-03
    await callOk(owner, 'create_room', { title: 'комната', members: ['s-02', 's-03'] });
    const a = await connect('s-02');
    const b = await connect('s-03');
    await callOk(a, 'check_inbox');
    await callOk(b, 'check_inbox');
    return { owner, a, b };
  }

  it('рассылка видна каждому участнику и отмечается прочитанной отдельно', async () => {
    const { owner, a, b } = await roomSetup();
    await callOk(owner, 'send_message', { room: 'r-01', text: 'всем привет' });

    const inboxA = await callOk(a, 'check_inbox');
    const messagesA = inboxA['messages'] as { text: string; room: { id: string; title: string } }[];
    expect(messagesA.map((m) => m.text)).toEqual(['всем привет']);
    expect(messagesA[0]?.room).toEqual({ id: 'r-01', title: 'комната' });

    // b ещё не читал — письмо остаётся непрочитанным именно у него.
    const broadcast = (await readMapFile()).messages.find((m) => m.text === 'всем привет');
    expect(broadcast?.readBy['s-02']).toBeDefined();
    expect(broadcast?.readBy['s-03']).toBeUndefined();

    const inboxB = await callOk(b, 'check_inbox');
    expect((inboxB['messages'] as { text: string }[]).map((m) => m.text)).toEqual(['всем привет']);
  });

  it('адресное письмо в комнате видит только адресат', async () => {
    const { owner, a, b } = await roomSetup();
    await callOk(owner, 'send_message', { room: 'r-01', to: 's-02', text: 'только тебе' });

    expect((await callOk(a, 'check_inbox'))['messages']).toHaveLength(1);
    expect((await callOk(b, 'check_inbox'))['messages']).toEqual([]);
  });

  it('не участник комнаты — ошибка и отправителю, и как адресату', async () => {
    const owner = await connect('s-01');
    await callOk(owner, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await callOk(owner, 'spawn_session', { provider: 'claude', label: 'сторонний', task: 'делать' }); // s-03
    await callOk(owner, 'create_room', { title: 'комната', members: ['s-02'] });

    const stranger = await connect('s-03');
    const asSender = await call(stranger, 'send_message', { room: 'r-01', text: 'я тут?' });
    expect(asSender.isError).toBe(true);
    expect(asSender.text).toContain('s-03');

    const asRecipient = await call(owner, 'send_message', { room: 'r-01', to: 's-03', text: 'эй' });
    expect(asRecipient.isError).toBe(true);
    expect(asRecipient.text).toContain('s-03');
  });

  it('messageRate на рассылку в комнате считается как одно письмо', async () => {
    const owner = await connect('s-01', 40, 2); // лимит — два письма в час
    await callOk(owner, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await callOk(owner, 'spawn_session', { provider: 'claude', label: 'ревью', task: 'делать' }); // s-03
    // Комната заведена в обход create_room: его приглашения не должны путать счёт.
    await updateMap(project, workId, (map) => {
      addRoom(map, { title: 'комната', creator: 's-01', members: ['s-02', 's-03'] });
    });

    await callOk(owner, 'send_message', { room: 'r-01', text: 'раз' });
    await callOk(owner, 'send_message', { room: 'r-01', text: 'два' });
    const refused = await call(owner, 'send_message', { room: 'r-01', text: 'три' });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('too many messages');
    // Была бы рассылка на два письма (по адресату), лимит исчерпался бы на первом вызове.
    expect((await readMapFile()).messages).toHaveLength(2);
  });
});

describe('send_message: replyTo — ответ с цитатой (Parley 0.3.0)', () => {
  /**
   * Комната r-01 (создатель s-01, участники s-02 и s-03; приглашения забраны) и в ней вопрос человека m-03.
   * Рядом — то, на что отвечать нельзя: письмо человека в другой комнате r-02 (m-04) и прямое письмо
   * s-01 → s-02 (m-05). Следующее письмо получит id m-06.
   */
  async function replySetup(): Promise<{ owner: Client; a: Client; b: Client }> {
    const owner = await connect('s-01');
    await callOk(owner, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await callOk(owner, 'spawn_session', { provider: 'claude', label: 'ревью', task: 'делать' }); // s-03
    await callOk(owner, 'create_room', { title: 'комната', members: ['s-02', 's-03'] }); // r-01
    const a = await connect('s-02');
    const b = await connect('s-03');
    await callOk(a, 'check_inbox');
    await callOk(b, 'check_inbox');
    await updateMap(project, workId, (map) => {
      addMessage(map, {
        from: HUMAN,
        to: [],
        text: 'Кто берёт миграции?',
        kind: 'question',
        roomId: 'r-01',
      });
      addRoom(map, { title: 'другая', creator: HUMAN, members: [] });
      addMessage(map, { from: HUMAN, to: [], text: 'Про другое', roomId: 'r-02' });
      addMessage(map, { from: 's-01', to: ['s-02'], text: 'Лично тебе' });
    });
    return { owner, a, b };
  }

  it('replyTo на сообщение той же комнаты: письмо ложится с replyTo, ответ — { messageId }', async () => {
    const { a, b } = await replySetup();

    const sent = await callOk(a, 'send_message', { room: 'r-01', text: 'Беру', replyTo: 'm-03' });

    expect(sent).toEqual({ messageId: 'm-06' });
    const stored = (await readMapFile()).messages.find((message) => message.id === 'm-06');
    expect(stored).toMatchObject({ from: 's-02', roomId: 'r-01', text: 'Беру', replyTo: 'm-03' });

    // На сообщение коллеги — так же, и вместе с адресатом (`to`) тоже.
    const second = await callOk(b, 'send_message', {
      room: 'r-01',
      to: 's-02',
      text: 'А я тесты',
      replyTo: 'm-06',
    });
    expect(second).toEqual({ messageId: 'm-07' });
    const reply = (await readMapFile()).messages.find((message) => message.id === 'm-07');
    expect(reply).toMatchObject({ to: ['s-02'], replyTo: 'm-06' });
  });

  it('без replyTo ключа в письме нет — и обычная рассылка, и прямое письмо прежние', async () => {
    const { a } = await replySetup();

    await callOk(a, 'send_message', { room: 'r-01', text: 'Всем' }); // m-06
    await callOk(a, 'send_message', { to: 's-01', text: 'Лично' }); // m-07

    const messages = (await readMapFile()).messages;
    for (const id of ['m-06', 'm-07']) {
      const plain = messages.find((message) => message.id === id);
      expect(plain, id).toBeDefined();
      expect(plain, id).not.toHaveProperty('replyTo');
    }
  });

  it('replyTo без room — ошибка, писем в карте столько же', async () => {
    const { owner } = await replySetup();
    const before = await readMapFile();

    // Даже на то, что лежит в карте: цитата живёт только внутри комнаты.
    const refused = await call(owner, 'send_message', {
      to: 's-02',
      text: 'Лично',
      replyTo: 'm-05',
    });

    expect(refused).toEqual({ isError: true, text: 'replyTo works only together with room' });
    expect(await readMapFile()).toEqual(before);
  });

  it.each([
    ['несуществующий id', 'm-99'],
    ['сообщение другой комнаты', 'm-04'],
    ['прямое письмо', 'm-05'],
  ])('replyTo — %s: ошибка «not in room», карта не меняется', async (_name, replyTo) => {
    const { a } = await replySetup();
    const before = await readMapFile();

    const refused = await call(a, 'send_message', { room: 'r-01', text: 'Ответ', replyTo });

    expect(refused).toEqual({ isError: true, text: `message ${replyTo} is not in room r-01` });
    expect(await readMapFile()).toEqual(before);
  });

  it('пустой replyTo — как пустой room и прочие строковые аргументы: ошибка, карта не меняется', async () => {
    const { a } = await replySetup();
    const before = await readMapFile();

    const refused = await call(a, 'send_message', { room: 'r-01', text: 'Ответ', replyTo: '' });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('replyTo');
    expect(await readMapFile()).toEqual(before);
  });

  it('null в необязательном поле — как его отсутствие: replyTo: null и room: null письмо не роняют (ревью 0.3.0)', async () => {
    const { a } = await replySetup();

    await callOk(a, 'send_message', { room: 'r-01', text: 'Всем', replyTo: null }); // m-06
    await callOk(a, 'send_message', { to: 's-01', text: 'Лично', room: null, replyTo: null }); // m-07

    const messages = (await readMapFile()).messages;
    const broadcast = messages.find((message) => message.id === 'm-06');
    const direct = messages.find((message) => message.id === 'm-07');
    expect(broadcast).toMatchObject({ roomId: 'r-01', text: 'Всем' });
    expect(broadcast).not.toHaveProperty('replyTo');
    expect(direct).toMatchObject({ roomId: null, to: ['s-01'], text: 'Лично' });
    expect(direct).not.toHaveProperty('replyTo');
  });

  it('незнакомое поле (reply_to вместо replyTo) — письмо уходит, а в ответе предупреждение с подсказкой (Parley 0.3.0)', async () => {
    const { a } = await replySetup();

    const sent = await callOk(a, 'send_message', {
      room: 'r-01',
      text: 'Беру',
      reply_to: 'm-03',
      urgent: true,
    });

    expect(sent).toEqual({
      messageId: 'm-06',
      warning: 'unknown parameters ignored: reply_to (did you mean replyTo?), urgent',
    });
    const stored = (await readMapFile()).messages.find((message) => message.id === 'm-06');
    expect(stored).toMatchObject({ roomId: 'r-01', text: 'Беру' });
    expect(stored).not.toHaveProperty('replyTo');
    // Знакомые поля предупреждения не дают: ответ — один `messageId`.
    const plain = await callOk(a, 'send_message', { room: 'r-01', text: 'Ещё', replyTo: 'm-03' });
    expect(plain).toEqual({ messageId: 'm-07' });
  });

  it('read_room, wait_for("inbox") и check_inbox: у ответа есть replyTo, у обычного письма ключа нет совсем', async () => {
    const { owner, a } = await replySetup();
    await callOk(a, 'send_message', { room: 'r-01', text: 'Беру', replyTo: 'm-03' }); // m-06
    await callOk(a, 'send_message', { room: 'r-01', text: 'К слову' }); // m-07

    interface View {
      id: string;
      replyTo?: string;
    }
    const surfaces: [string, View[]][] = [
      ['read_room', (await callOk(owner, 'read_room', { room: 'r-01' }))['messages'] as View[]],
      [
        'wait_for',
        (await callOk(owner, 'wait_for', { target: 'inbox', timeoutSec: 5 }))['messages'] as View[],
      ],
      ['check_inbox', (await callOk(owner, 'check_inbox'))['messages'] as View[]],
    ];

    for (const [surface, messages] of surfaces) {
      expect(
        messages.find((message) => message.id === 'm-06'),
        surface,
      ).toMatchObject({
        replyTo: 'm-03',
      });
      for (const id of ['m-03', 'm-07']) {
        const plain = messages.find((message) => message.id === id);
        expect(plain, `${surface} ${id}`).toBeDefined();
        expect(plain, `${surface} ${id}`).not.toHaveProperty('replyTo');
      }
    }
  });
});

describe('read_room', () => {
  it('не участнику — ошибка, отметки не меняются', async () => {
    const owner = await connect('s-01');
    await callOk(owner, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await callOk(owner, 'spawn_session', { provider: 'claude', label: 'сторонний', task: 'делать' }); // s-03
    await callOk(owner, 'create_room', { title: 'комната', members: ['s-02'] });
    await callOk(owner, 'send_message', { room: 'r-01', text: 'привет' });

    const stranger = await connect('s-03');
    const result = await call(stranger, 'read_room', { room: 'r-01' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('s-03');
  });

  it('участнику отдаёт последние limit писем, не отмечая прочтение', async () => {
    const owner = await connect('s-01');
    await callOk(owner, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await callOk(owner, 'create_room', { title: 'комната', members: ['s-02'] });
    const second = await connect('s-02');
    await callOk(second, 'check_inbox'); // забрали приглашение

    await callOk(owner, 'send_message', { room: 'r-01', text: 'раз' });
    await callOk(owner, 'send_message', { room: 'r-01', text: 'два' });
    await callOk(owner, 'send_message', { room: 'r-01', text: 'три' });

    const result = await callOk(second, 'read_room', { room: 'r-01', limit: 2 });
    expect((result['messages'] as { text: string }[]).map((m) => m.text)).toEqual(['два', 'три']);

    const broadcasts = (await readMapFile()).messages.filter((m) =>
      ['раз', 'два', 'три'].includes(m.text),
    );
    expect(broadcasts.every((m) => Object.keys(m.readBy).length === 0)).toBe(true);
  });
});

describe('close_session', () => {
  it('закрывает себя', async () => {
    const client = await connect('s-01');
    const result = await callOk(client, 'close_session', { target: 's-01' });

    expect(result).toEqual({ sessionId: 's-01' });
    expect(session(await readMapFile(), 's-01').lifecycle).toBe('closed');
  });

  it('закрывает прямого потомка', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02

    await callOk(client, 'close_session', { target: 's-02' });
    expect(session(await readMapFile(), 's-02').lifecycle).toBe('closed');
  });

  it('закрывает косвенного потомка', async () => {
    const owner = await connect('s-01');
    await callOk(owner, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    const child = await connect('s-02');
    await callOk(child, 'spawn_session', { provider: 'claude', label: 'внук', task: 'делать' }); // s-03

    await callOk(owner, 'close_session', { target: 's-03' });
    expect(session(await readMapFile(), 's-03').lifecycle).toBe('closed');
  });

  it('соседа закрыть нельзя', async () => {
    const owner = await connect('s-01');
    await callOk(owner, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await callOk(owner, 'spawn_session', { provider: 'claude', label: 'ревью', task: 'делать' }); // s-03
    const second = await connect('s-02');

    const result = await call(second, 'close_session', { target: 's-03' });
    expect(result.isError).toBe(true);
    expect(session(await readMapFile(), 's-03').lifecycle).toBe('pending');
  });

  it('повторное закрытие — ошибка', async () => {
    const client = await connect('s-01');
    await callOk(client, 'close_session', { target: 's-01' });

    const result = await call(client, 'close_session', { target: 's-01' });
    expect(result.isError).toBe(true);
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

describe('wait_for: журнал ожидания (Parley 0.2.0)', () => {
  const eventsDir = (): string => workPaths(project, workId).events;
  const journalFile = (): string => path.join(eventsDir(), 's-01.jsonl');
  /** Строки журнала сессии `s-01` как объекты; журнала нет — пусто. */
  const journalLines = async (): Promise<Record<string, unknown>[]> => {
    const text = await readFile(journalFile(), 'utf8').catch(() => '');
    return text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };
  const started = (target: string) => ({
    hook_event_name: 'ParleyWaitStart',
    parley_wait_target: target,
    parley_wait_id: expect.any(String),
  });
  const ended = { hook_event_name: 'ParleyWaitEnd', parley_wait_id: expect.any(String) };
  /** Запись начала идёт параллельно висящему вызову: ждём, пока в журнале станет `count` строк. */
  const linesAre = (count: number): Promise<void> =>
    vi.waitFor(async () => expect(await journalLines()).toHaveLength(count), {
      timeout: 2000,
      interval: 10,
    });

  beforeEach(async () => {
    // Каталог `events/` заводит запуск сессии, а в `createWork` его нет.
    await mkdir(eventsDir(), { recursive: true });
  });

  it('inbox: ParleyWaitStart с целью, пока вызов висит, и ParleyWaitEnd после пробуждения', async () => {
    const client = await connect('s-01');
    const pending = callOk(client, 'wait_for', { target: 'inbox', timeoutSec: 20 });

    await linesAre(1);
    expect(await journalLines()).toEqual([started('inbox')]);

    await updateMap(project, workId, (map) => {
      addMessage(map, { from: 's-01', to: ['s-01'], text: 'проснись' });
    });
    expect((await pending)['state']).toBe('message');
    expect(await journalLines()).toEqual([started('inbox'), ended]);
  });

  it('таймаут по id сессии: Start с её id и End; строка — ровно один JSON с переводом строки', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });

    expect(await callOk(client, 'wait_for', { target: 's-02', timeoutSec: 0.2 })).toEqual({
      state: 'running',
    });
    // Id вызова — случайный, в обеих строках один: по нему конец снимает своё ожидание.
    const [start] = await journalLines();
    const id = start?.['parley_wait_id'];
    expect(typeof id === 'string' && id.length >= 16).toBe(true);
    expect(await readFile(journalFile(), 'utf8')).toBe(
      `${JSON.stringify({ hook_event_name: 'ParleyWaitStart', parley_wait_target: 's-02', parley_wait_id: id })}\n` +
        `${JSON.stringify({ hook_event_name: 'ParleyWaitEnd', parley_wait_id: id })}\n`,
    );
  });

  it('итог сессии пришёл, пока вызов висел: Start, затем End', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    const pending = callOk(client, 'wait_for', { target: 's-02', timeoutSec: 20 });

    await linesAre(1);
    await updateMap(project, workId, (map) => {
      setResult(map, 's-02', 'done');
    });

    expect((await pending)['state']).toBe('done');
    expect(await journalLines()).toEqual([started('s-02'), ended]);
  });

  it('сессию удалили, пока вызов висел: ответ deleted, и конец ожидания записан', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    const pending = callOk(client, 'wait_for', { target: 's-02', timeoutSec: 20 });

    await linesAre(1);
    await updateMap(project, workId, (map) => {
      removeSession(map, 's-02');
    });

    expect(await pending).toEqual({ state: 'deleted', sessionId: 's-02' });
    expect(await journalLines()).toEqual([started('s-02'), ended]);
  });

  it('ожидание кончилось ошибкой (карта не читается): End всё равно записан', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    const pending = call(client, 'wait_for', { target: 's-02', timeoutSec: 20 });

    await linesAre(1);
    await writeFile(workPaths(project, workId).map, 'не json', 'utf8');

    expect((await pending).isError).toBe(true);
    expect(await journalLines()).toEqual([started('s-02'), ended]);
  });

  it('ответ без ожидания строк не пишет: итог уже есть, письмо уже пришло, id неизвестен', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    await updateMap(project, workId, (map) => {
      setResult(map, 's-02', 'done');
      addMessage(map, { from: 's-02', to: ['s-01'], text: 'готово' });
    });

    expect((await callOk(client, 'wait_for', { target: 's-02', timeoutSec: 5 }))['state']).toBe(
      'done',
    );
    expect((await callOk(client, 'wait_for', { target: 'inbox', timeoutSec: 5 }))['state']).toBe(
      'message',
    );
    expect((await call(client, 'wait_for', { target: 's-77', timeoutSec: 5 })).isError).toBe(true);

    expect(await journalLines()).toEqual([]);
  });

  it('два вызова сразу: строки не перемешиваются, у каждого своя пара', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });

    await Promise.all([
      callOk(client, 'wait_for', { target: 'inbox', timeoutSec: 0.3 }),
      callOk(client, 'wait_for', { target: 's-02', timeoutSec: 0.3 }),
    ]);

    const lines = await journalLines();
    expect(lines).toHaveLength(4);
    expect(
      lines
        .filter((line) => line['hook_event_name'] === 'ParleyWaitStart')
        .map((line) => line['parley_wait_target'])
        .sort(),
    ).toEqual(['inbox', 's-02']);
    expect(lines.filter((line) => line['hook_event_name'] === 'ParleyWaitEnd')).toHaveLength(2);

    // У каждого вызова свой случайный id, и конец несёт id своего начала.
    const startIds = lines
      .filter((line) => line['hook_event_name'] === 'ParleyWaitStart')
      .map((line) => line['parley_wait_id']);
    const endIds = lines
      .filter((line) => line['hook_event_name'] === 'ParleyWaitEnd')
      .map((line) => line['parley_wait_id']);
    expect(new Set(startIds).size).toBe(2);
    expect([...endIds].sort()).toEqual([...startIds].sort());
  });

  it('отмена вызова клиентом прерывает ожидание и сразу пишет End с id начала', async () => {
    const client = await connect('s-01');
    const controller = new AbortController();
    const pending = client.callTool(
      { name: 'wait_for', arguments: { target: 'inbox', timeoutSec: 20 } },
      undefined,
      { signal: controller.signal },
    );
    // Клиент отвергает свой вызов при отмене.
    pending.catch(() => undefined);

    await linesAre(1);
    const started = Date.now();
    controller.abort();
    // End не ждёт двадцати секунд таймаута: ожидание прервано самой отменой.
    await linesAre(2);
    expect(Date.now() - started).toBeLessThan(2000);

    const [start, end] = await journalLines();
    expect(end).toEqual({
      hook_event_name: 'ParleyWaitEnd',
      parley_wait_id: start?.['parley_wait_id'],
    });
  });

  it('после отмены сервер жив, а следующий вызов отвечает как обычно и пишет свою пару', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    const controller = new AbortController();
    const cancelled = client.callTool(
      { name: 'wait_for', arguments: { target: 'inbox', timeoutSec: 20 } },
      undefined,
      { signal: controller.signal },
    );
    cancelled.catch(() => undefined);
    await linesAre(1);
    controller.abort();
    await linesAre(2);

    expect(await callOk(client, 'wait_for', { target: 's-02', timeoutSec: 0.2 })).toEqual({
      state: 'running',
    });
    const lines = await journalLines();
    expect(lines).toHaveLength(4);
    expect(lines.map((line) => line['hook_event_name'])).toEqual([
      'ParleyWaitStart',
      'ParleyWaitEnd',
      'ParleyWaitStart',
      'ParleyWaitEnd',
    ]);
  });

  it('отменённое ожидание не мешает идущему: activityOf держит waitingFor за вторым вызовом', async () => {
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });
    const waitingFor = async (): Promise<string | null> =>
      activityOf({ events: await openEvents(eventsDir()).read('s-01') }).waitingFor;

    const controller = new AbortController();
    const first = client.callTool(
      { name: 'wait_for', arguments: { target: 'inbox', timeoutSec: 20 } },
      undefined,
      { signal: controller.signal },
    );
    first.catch(() => undefined);
    await linesAre(1);
    const second = callOk(client, 'wait_for', { target: 's-02', timeoutSec: 20 });
    await linesAre(2);
    expect(await waitingFor()).toBe('s-02');

    // Отменили первое: его End пришёл, а второе идёт — ожидание не потеряно.
    controller.abort();
    await linesAre(3);
    expect(await waitingFor()).toBe('s-02');

    await updateMap(project, workId, (map) => {
      setResult(map, 's-02', 'done');
    });
    await second;
    expect(await waitingFor()).toBeNull();
  });

  it('сбой записи в журнал не ломает ожидание: на месте журнала каталог', async () => {
    await mkdir(journalFile());
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });

    expect(await callOk(client, 'wait_for', { target: 's-02', timeoutSec: 0.2 })).toEqual({
      state: 'running',
    });

    const pending = callOk(client, 'wait_for', { target: 'inbox', timeoutSec: 20 });
    await delay(60);
    await updateMap(project, workId, (map) => {
      addMessage(map, { from: 's-01', to: ['s-01'], text: 'проснись' });
    });
    expect((await pending)['state']).toBe('message');
  });

  it('каталог events ожидание не создаёт: без него хуков нет, и предупреждение хоста не заглушить', async () => {
    await rm(eventsDir(), { recursive: true, force: true });
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', { provider: 'claude', label: 'бэк', task: 'делать' });

    expect(await callOk(client, 'wait_for', { target: 's-02', timeoutSec: 0.2 })).toEqual({
      state: 'running',
    });
    await expect(stat(eventsDir())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('читатель журнала и activityOf понимают строки: waitingFor есть, пока вызов висит, и пропадает после', async () => {
    const client = await connect('s-01');
    const waitingFor = async (): Promise<string | null> => {
      const events = await openEvents(eventsDir()).read('s-01');
      return activityOf({ events }).waitingFor;
    };

    const pending = callOk(client, 'wait_for', { target: 'inbox', timeoutSec: 20 });
    await linesAre(1);
    expect(await waitingFor()).toBe('inbox');

    await updateMap(project, workId, (map) => {
      addMessage(map, { from: 's-01', to: ['s-01'], text: 'проснись' });
    });
    await pending;
    expect(await waitingFor()).toBeNull();
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
    expect(instructions).toContain(`source="${MCP_SERVER_NAME}"`);
    expect(instructions).toContain('source="parley"');
    expect(instructions).toContain('only to a `question`');
    expect(instructions).toContain('check_inbox');
    expect(instructions).not.toMatch(/[А-Яа-яЁё]/);
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

  it('без PARLEY_CHANNEL нет ни capability, ни instructions, ни звонка', async () => {
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

  it('без PARLEY_SESSION_ID сторожа нет и при PARLEY_CHANNEL', async () => {
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
