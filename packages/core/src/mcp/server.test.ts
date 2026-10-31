import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../config.js';
import { MCP_SERVER_NAME } from '../names.js';
import { PROVIDERS, selectableModels } from '../providers.js';
import { clearSecret, writeSecret } from '../secrets.js';
import { LEAD_ROLE, memberRole } from '../work/brief.js';
import { GUIDE, GUIDE_TOPICS, guideTopic } from '../work/guide.js';
import {
  addSession,
  removeSession,
  setResult,
  transitionSession,
} from '../work/map.js';
import { activityOf } from '../work/activity.js';
import { openEvents } from '../work/events.js';
import { planLaunch } from '../work/launch.js';
import { PROPOSAL_TEXT_MAX, resolveProposal } from '../work/proposals.js';
import { addRoom, archiveRoom } from '../work/rooms.js';
import type { SessionNeed } from '../work/stuck.js';
import { createWork, readMap, readStoredMap, replaceStoredMap, updateMap, workPaths, workVersion } from '../work/store.js';
import { decisionsOf, participantLabel, threadOf } from '../work/thread.js';
import { HUMAN, type WindowWorkMap, type WorkMap } from '../work/types.js';
import { addBacklogItem, readBacklog } from '../work/backlog.js';
import { listBacklogSuggestions } from '../work/backlog-suggestions.js';
import { acceptMemorySuggestion, listMemorySuggestions, listUndoableMemory } from '../work/memory-suggestions.js';
import { undoProjectMemory } from '../work/project-memory.js';
import { setBacklogRule } from '../work/project-preferences.js';
import { buildRoleCatalog } from '../roles/catalog.js';
import type { RoleCatalog } from '../roles/types.js';
import type { AgentChannel } from '../work/mcp-config.js';
import { contextFromEnv, type McpContext } from './context.js';
import type { Ring } from './inbox-watch.js';
import {
  DEFAULT_TIMEOUT_SEC,
  MAX_TIMEOUT_SEC,
  createParleyServer,
  createToolRunner,
  waitTimeoutMs,
  type ToolRunner,
} from './tools.js';
import { writeLetters, type NewLetter } from '../work/letter-store.js';
import { workDb } from '../work/db.js';

let home = '';
let project = '';
let binDir = '';
let workId = '';
let savedPath: string | undefined;

/** Всё, что пришлось поднять для одного клиента: закрываем в afterEach. */
const clientSessions = new WeakMap<Client, string | null>();
const opened: { client: Client; server: ReturnType<typeof createParleyServer> }[] = [];

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
  roleCatalog?: (cwd: string) => Promise<RoleCatalog>,
  agent?: AgentChannel,
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
    ...(roleCatalog ? { roleCatalog } : {}),
    ...(agent ? { agent } : {}),
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
  clientSessions.set(client, sessionId);
  return client;
}

/** Stored legacy-family fixtures preserve historical messaging tests without exposing session creation over MCP. */
async function addHistoricalSession(client: Client, init: { provider?: string; label: string; task: string }): Promise<void> {
  await updateMap(project, workId, map => {
    const created = addSession(map, { ...init, provider: init.provider ?? 'claude', parent: null });
    created.parent = clientSessions.get(client) ?? null;
  });
}

/** Карта из строк базы мимо кэша процесса: то, что записал инструмент, а не то, что запомнил читатель. */
const readMapFile = async (): Promise<WindowWorkMap> => readStoredMap(project, workId);

const session = (map: WorkMap, id: string) => {
  const found = map.sessions.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`нет сессии ${id}`);
  return found;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
      skillNavigator: false,
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
  it('набор инструментов включает только согласованные MCP routes', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'add_to_room',
      'attempt_status',
      'attempt_submit',
      'attempt_verify',
      'backlog_list',
      'backlog_suggest',
      'check_inbox',
      'close_session',
      'create_room',
      'get_map',
      'list_roles',
      'memory_read',
      'plan_submit',
      'plan_update',
      'plan_verify',
      'propose_completion',
      'propose_decision',
      'publish_agent_plan',
      'read_guide',
      'read_room',
      'remember',
      'report',
      'search_history',
      'send_message',
      'set_room_mode',
      'wait_for',
    ]);
    expect(tools.every((tool) => (tool.description ?? '') !== '')).toBe(true);
  });

  it('сервер называется parley (R8): так же, как его ключ в конфиге MCP, — под ним агент видит mcp__parley__*', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();

    expect(client.getServerVersion()?.name).toBe(MCP_SERVER_NAME);
    expect(client.getServerVersion()?.name).toBe('parley');
    expect(tools.some(tool => tool.name === 'spawn_session')).toBe(false);
  });

  it('propose_decision: room и text обязательны, описание — про ведущего, ожидание человека и повтор', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const propose = tools.find((tool) => tool.name === 'propose_decision');

    expect(propose?.inputSchema.required).toEqual(['room', 'text']);
    expect(Object.keys(propose?.inputSchema.properties ?? {}).sort()).toEqual(['kind', 'plan', 'planId', 'rev', 'room', 'text']);
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
    expect(replyTo?.description).toMatch(/Only with room/);
    expect(replyTo?.description).toMatch(/in this room/);
    // Подсказка, экономящая ход: отвечать только на question.
    expect(send?.description).toContain('Answer only a question');
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

  it('read_guide: topic необязателен, enum — темы гида; в описании их нет (список уже в enum, сумма описаний ограничена)', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const guide = tools.find((tool) => tool.name === 'read_guide');
    const names = GUIDE_TOPICS.map((item) => item.topic);

    expect(guide?.inputSchema.required ?? []).toEqual([]);
    expect(Object.keys(guide?.inputSchema.properties ?? {})).toEqual(['topic']);
    expect(guide?.inputSchema.properties?.['topic']).toMatchObject({ type: 'string', enum: names });
    // Список тем уже в enum схемы; в описании он только тратил бы токены каждого хода.
    expect(guide?.description).toContain('topic picks one section');
    expect(guide?.description).not.toContain(names.join(', '));
  });

  it('create_room: lead обязателен, описание отделяет владельца от участников', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const createRoom = tools.find((tool) => tool.name === 'create_room');

    expect(createRoom?.inputSchema.required).toEqual(['title', 'members', 'lead']);
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

    expect(getMap?.description).toMatch(/Details: read_guide\.$/);
    expect(getMap?.description).toContain('The provider catalog comes with field "providers"');
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

    expect(waitFor?.description).toContain('marked read');
    expect(waitFor?.description).toMatch(/already handed in its report returns the old result at once by id: wait for its answer[\s\S]*via "inbox"/);
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
  it('измеряет весь MCP-ответ, страницы списков и прямую сессию вне обзора', async () => {
    await updateMap(project, workId, (map) => {
      for (let i = 0; i < 118; i += 1) addSession(map, { provider: 'codex', label: '\u0000"\\😀'.repeat(1000), task: 'задача'.repeat(1000) });
    });
    const client = await connect('s-01');
    const result = await client.callTool({ name: 'get_map', arguments: {} });
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(49152);
    const overview = JSON.parse((result.content as { text: string }[])[0]!.text);
    expect(overview.map.collections.sessions.total).toBe(119);
    expect(overview.map.collections.sessions.complete).toBe(false);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await callOk(client, 'get_map', { field: 'sessions', maxBytes: 2048, ...(cursor === null ? {} : { cursor }) });
      seen.push(...(page['items'] as { id: string }[]).map((row) => row.id));
      cursor = (page['page'] as { next: string | null }).next;
    } while (cursor !== null);
    expect(new Set(seen).size).toBe(119);
    expect(seen).toHaveLength(119);
    const detail = await callOk(client, 'get_map', { session: 's-119' });
    expect(detail['session']).toMatchObject({ id: 's-119' });
    expect((await callOk(client, 'get_map', { session: 's-119', field: 'task' }))['text']).toContain('задача');
  });

  it('полный план читается по точной ревизии кусками; чужая комната скрыта', async () => {
    await updateMap(project, workId, (map) => {
      const room = addRoom(map, { title: 'План', creator: HUMAN, members: ['s-01'] });
      map.plans = [{ id: 'pl-01', rev: 3, roomId: room.id, mode: 'checklist', status: 'active', goal: 'ц'.repeat(10000), backlog: [],
        acceptedAt: null, completedAt: null, cancelledAt: null, completionSummary: null,
        items: [{ id: 1, title: 'проверка', owner: 's-01', scope: 'область', after: [], criteria: ['к'.repeat(10000)], verifier: null, status: 'waiting', evidence: { text: 'доказательство'.repeat(1000), artifacts: ['proof.txt'] }, note: null, log: [] }] }];
    });
    const client = await connect('s-01');
    let text = '';
    let cursor: string | null = null;
    do {
      const page = await callOk(client, 'get_map', { field: 'plan', id: 'pl-01', rev: 3, maxBytes: 2048, ...(cursor === null ? {} : { cursor }) });
      expect(page).toMatchObject({ id: 'pl-01', rev: 3, status: 'active' });
      text += page['text'];
      cursor = page['next'] as string | null;
    } while (cursor !== null);
    expect(JSON.parse(text)).toEqual((await readMap(project, workId)).plans![0]);
    expect(JSON.parse(text).items[0].criteria[0]).toHaveLength(10000);
    expect((await call(client, 'get_map', { field: 'plan', id: 'pl-01', rev: 2 })).text).toContain('unknown-target');
    const outsider = await connect(null);
    expect((await call(outsider, 'get_map', { field: 'plan', id: 'pl-01', rev: 3 })).text).toContain('not available');
  });

  it('без аргументов — карта и своя сессия, без providers и без note', async () => {
    const client = await connect('s-01');
    const result = await callOk(client, 'get_map');

    expect(result['sessionId']).toBe('s-01');
    expect((result['map'] as WorkMap).work.title).toBe('Авторизация');
    expect((result['map'] as WorkMap).sessions).toHaveLength(1);
    expect(Object.keys(result).sort()).toEqual(['map', 'sessionId']);
    expect(result['providers']).toBeUndefined();
    expect(result['note']).toBeUndefined();
  });

  it('field providers — провайдеры с флагом доступности', async () => {
    const client = await connect('s-01');
    const result = await callOk(client, 'get_map', { field: 'providers' });

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
    const result = await callOk(client, 'get_map', { field: 'providers' });
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
    expect(byId('glm')).toMatchObject({ models: selectableModels(PROVIDERS.glm), effort: true });
  });

  it('комната с рецептом показывает агенту id и имя, но не плейбук ведущего', async () => {
    await updateMap(project, workId, (current) => {
      addRoom(current, { title: 'R', creator: HUMAN, members: ['s-01'], lead: 's-01', recipe: { id: 'project:pay', name: 'Payments', playbook: 'SECRET LEAD PLAYBOOK' } });
    });
    const client = await connect('s-01');
    const result = await callOk(client, 'get_map');
    expect(JSON.stringify(result)).not.toContain('SECRET LEAD PLAYBOOK');
    expect((result['map'] as WorkMap).rooms[0]?.recipe).toEqual({ id: 'project:pay', name: 'Payments' });
  });

  it('модели несут свои уровни effort (нормалайзер, 5.6): у Claude и GLM пять, у Haiku — null, у Codex свои наборы', async () => {
    const client = await connect('s-01');
    const result = await callOk(client, 'get_map', { field: 'providers' });
    type Effort = { id: string; label: string; description?: string };
    const providers = result['providers'] as {
      id: string;
      models: { id: string; efforts?: Effort[] | null }[] | null;
    }[];
    const model = (provider: string, id: string) =>
      providers.find((entry) => entry.id === provider)?.models?.find((option) => option.id === id);
    const levels = (provider: string, id: string) =>
      model(provider, id)?.efforts?.map((effort) => effort.id);

    expect(levels('claude', 'opus')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(levels('claude', 'best')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    // У Haiku effort нет: агент видит это по null и поле effort не шлёт.
    expect(model('claude', 'haiku')?.efforts).toBeNull();
    expect(levels('glm', 'glm-5.3-flash[1m]')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(levels('codex', 'gpt-6.1-sol')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(levels('codex', 'gpt-6-luna')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    // Подпись и описание уровня — те же, что видит окно.
    expect(model('codex', 'gpt-6.1-sol')?.efforts?.at(-1)).toEqual({
      id: 'ultra',
      label: 'Ultra',
      description: 'Maximum reasoning with automatic task delegation',
    });
  });

  it('работает без PARLEY_SESSION_ID', async () => {
    const client = await connect(null);
    const result = await callOk(client, 'get_map');

    expect(result['sessionId']).toBeNull();
    expect((result['map'] as WorkMap).work.id).toBe(workId);
  });
});

describe('get_map: строки провайдеров от хоста (спека подписок 5.8, К7)', () => {
  const hostServers: Server[] = [];
  afterEach(async () => {
    await Promise.all(hostServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });
  const limits = { fiveHour: { usedPercent: 42, resetsAt: '2026-10-22T15:00:00.000Z' }, week: null, at: '2026-10-22T12:00:00.000Z' };
  const hostRows = [
    { id: 'claude', label: 'Claude Code', family: 'claude', available: true, needs: null, models: [{ id: 'opus', label: 'Opus' }], effort: true, limits },
    { id: 'custom-claude-2', label: 'Claude Code 2', family: 'claude', available: false, needs: 'sign-in', models: null, effort: false, limits: null },
  ];
  /** Хост-заглушка с точкой `/agent/providers`: отвечает строками `rows`. */
  async function fakeHost(rows: unknown): Promise<AgentChannel> {
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(req.method === 'POST' && req.url === '/agent/providers' ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { providers: rows } }));
    });
    hostServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/agent/browser`, token: 'a'.repeat(64) };
  }
  type MapRow = { id: string; label: string; family: string | null; available: boolean; needs?: string; models: unknown; effort: boolean; limits?: unknown };

  it('с каналом агента providers — строки хоста: family, needs, лимиты и вход; needs и limits только когда известны', async () => {
    const client = await connect('s-01', 40, DEFAULT_CONFIG.messageRate, false, [], DEFAULT_CONFIG.worktreeRoot, undefined, await fakeHost(hostRows));
    const result = await callOk(client, 'get_map', { field: 'providers' });
    const providers = result['providers'] as MapRow[];

    expect(providers).toEqual([
      { id: 'claude', label: 'Claude Code', family: 'claude', available: true, models: [{ id: 'opus', label: 'Opus' }], effort: true, limits },
      { id: 'custom-claude-2', label: 'Claude Code 2', family: 'claude', available: false, needs: 'sign-in', models: null, effort: false },
    ]);
    // Готовый провайдер несёт компактную строку без `needs`; недоступный называет причину.
    expect('needs' in providers[0]!).toBe(false);
    expect('limits' in providers[1]!).toBe(false);
    // Строки хоста — без пометки и без остального ответа: карты в каталоге нет.
    expect(Object.keys(result)).toEqual(['providers']);
  });

  it('без канала агента — прежние локальные строки и note о недоступном хосте', async () => {
    const client = await connect('s-01');
    const result = await callOk(client, 'get_map', { field: 'providers' });
    const providers = result['providers'] as MapRow[];

    expect(result['note']).toBe('host unreachable: sign-in state and limits unknown');
    expect(providers.find((entry) => entry.id === 'claude')).toMatchObject({ id: 'claude', available: true });
    expect(providers.some((entry) => 'limits' in entry)).toBe(false);
  });

  it('хост не ответил (порт закрыт, 404, кривое тело) — то же: локальные строки и note', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as { port: number };
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const channels: AgentChannel[] = [
      { url: `http://127.0.0.1:${port}/agent/browser`, token: 'a'.repeat(64) },
      await fakeHost('not-a-list'),
    ];
    for (const agent of channels) {
      const client = await connect('s-01', 40, DEFAULT_CONFIG.messageRate, false, [], DEFAULT_CONFIG.worktreeRoot, undefined, agent);
      const result = await callOk(client, 'get_map', { field: 'providers' });
      // Пометка идёт рядом со списком, а не внутри карты.
      expect(Object.keys(result).sort()).toEqual(['note', 'providers']);
      expect(result['note']).toBe('host unreachable: sign-in state and limits unknown');
      expect((result['providers'] as MapRow[]).find((entry) => entry.id === 'claude')?.available).toBe(true);
    }
  });

  it('get_map без аргументов не несёт ни providers, ни note — даже когда хост недоступен или отвечает', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as { port: number };
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const channels: AgentChannel[] = [
      { url: `http://127.0.0.1:${port}/agent/browser`, token: 'a'.repeat(64) },
      await fakeHost(hostRows),
    ];
    for (const agent of channels) {
      const client = await connect('s-01', 40, DEFAULT_CONFIG.messageRate, false, [], DEFAULT_CONFIG.worktreeRoot, undefined, agent);
      expect(Object.keys(await callOk(client, 'get_map')).sort()).toEqual(['map', 'sessionId']);
    }
  });

  it('постраничные ответы get_map хоста не спрашивают', async () => {
    const client = await connect('s-01', 40, DEFAULT_CONFIG.messageRate, false, [], DEFAULT_CONFIG.worktreeRoot, undefined, await fakeHost(hostRows));
    const page = await callOk(client, 'get_map', { field: 'goal' });
    expect(page['providers']).toBeUndefined();
    expect(page['note']).toBeUndefined();
  });

  it('описание create_session отсылает к get_map {field: "providers"}: аккаунт того же CLI — отдельная подписка', async () => {
    const client = await connect('s-01', 40, DEFAULT_CONFIG.messageRate, false, [], DEFAULT_CONFIG.worktreeRoot, undefined, await fakeHost(hostRows));
    const tool = (await client.listTools()).tools.find((item) => item.name === 'create_session');
    expect(tool?.description).toContain('limits from get_map {field: "providers"}');
    expect(tool?.description).toContain('an account of the same CLI (for example custom-claude-2) is a separate subscription');
    const getMap = (await client.listTools()).tools.find((item) => item.name === 'get_map');
    expect(getMap?.description).toContain('field "providers"');
    expect(JSON.stringify(getMap?.inputSchema)).toContain('"providers"');
  });
});

describe('get_map: компактная карта и страницы (P35)', () => {
  const longText = (n: number, mark = 'я'): string => mark.repeat(n);

  /** s-01 (план) и s-02, комната r-01 из обоих; письма дописывает `fill`. */
  async function seedRoom(): Promise<void> {
    await updateMap(project, workId, (current) => {
      addSession(current, { provider: 'claude', label: 'код', task: 'писать', parent: null }).parent = 's-01';
      addRoom(current, { title: 'Обсуждение', creator: HUMAN, members: ['s-01', 's-02'], lead: 's-01' });
    });
  }
  const fill = async (count: number, size: number, extra: Partial<NewLetter> = {}): Promise<void> => {
    await updateMap(project, workId, (current, letters) => {
      for (let i = 0; i < count; i += 1) letters.add({ kind: 'note', from: 's-02', to: [], roomId: 'r-01', text: `${i}:`.padEnd(size, 'я'), ...extra });
    });
  };

  it('по умолчанию — топология без текстов писем: размер не растёт с перепиской, счётчики и подсказка страниц на месте', async () => {
    await seedRoom();
    const client = await connect('s-01');
    const before = (await call(client, 'get_map')).text.length;
    await fill(400, 5000);
    const after = await call(client, 'get_map');
    expect(after.isError).toBe(false);
    expect(after.text.length).toBeLessThan(before + 1500);
    expect(after.text).not.toContain('яяяя');
    const result = JSON.parse(after.text) as { map: { messages: { total: number; latestId: string; unreadForYou: { total: number } }; pages: string; rooms: { messages: { total: number } }[] } };
    expect(result.map.messages).toMatchObject({ total: 400, latestId: 'm-400' });
    expect(result.map.messages.unreadForYou.total).toBe(400);
    expect(result.map.rooms[0]?.messages.total).toBe(400);
    expect(result.map.pages).toContain('field: messages');
  });

  it('длинная цель сокращена с полным размером в cut и читается страницами field goal до конца, без потерь', async () => {
    const goal = longText(60_000, 'ц');
    await updateMap(project, workId, (current) => { current.work.goal = goal; });
    const client = await connect('s-01');
    const map = (await callOk(client, 'get_map'))['map'] as { work: { cut: { goal: number }; goal: string } };
    expect(map.work.cut.goal).toBe(120_000);
    expect(map.work.goal).toContain('cut: 120000 bytes in full');

    let text = '';
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await callOk(client, 'get_map', { field: 'goal', ...(cursor === undefined ? {} : { cursor }), maxBytes: 32768 });
      text += page['text'] as string;
      expect(page['totalBytes']).toBe(120_000);
      if (page['complete'] === true) break;
      cursor = page['next'] as string;
    }
    expect(text).toBe(goal);
  });

  it('поля сессии: task, summary, history, artifacts, contextFrom; без session — понятная ошибка', async () => {
    await seedRoom();
    await updateMap(project, workId, (current) => {
      const target = current.sessions[1]!;
      target.task = longText(30_000, 'з');
      target.summary = 'итог';
      target.artifacts = [{ kind: 'file', path: 'a.md' }, { kind: 'file', path: 'b.md' }];
      target.contextFrom = ['s-01'];
    });
    const client = await connect('s-01');
    const task = await callOk(client, 'get_map', { session: 's-02', field: 'task', maxBytes: 65536 });
    expect(task).toMatchObject({ session: 's-02', field: 'task', totalBytes: 60_000, complete: true });
    expect(await callOk(client, 'get_map', { session: 's-02', field: 'summary' })).toMatchObject({ text: 'итог', complete: true });
    const artifacts = await callOk(client, 'get_map', { session: 's-02', field: 'artifacts' });
    expect((artifacts['artifacts'] as { path: string }[]).map((a) => a.path)).toEqual(['a.md', 'b.md']);
    expect(artifacts['page']).toMatchObject({ total: 2, complete: true, next: null });
    const history = await callOk(client, 'get_map', { session: 's-02', field: 'history' });
    expect((history['history'] as { event: string }[])[0]?.event).toBe('pending');
    expect(await callOk(client, 'get_map', { session: 's-02', field: 'contextFrom' })).toMatchObject({ contextFrom: ['s-01'] });
    expect(await callOk(client, 'get_map', { session: 's-02' })).toMatchObject({ session: { id: 's-02', artifactCount: 2 } });

    const noSession = await call(client, 'get_map', { field: 'task' });
    expect(noSession.isError).toBe(true);
    expect(noSession.text).toContain('session');
    expect((await call(client, 'get_map', { session: 's-99', field: 'task' })).isError).toBe(true);
  });

  it('страницы писем комнаты: байтовый потолок, next ведёт к старым без повторов, kind отбирает решения', async () => {
    await seedRoom();
    await fill(120, 3000);
    await fill(1, 20, { kind: 'decision', from: 's-01' });
    const client = await connect('s-01');
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 100; guard += 1) {
      const page = await call(client, 'get_map', { field: 'messages', room: 'r-01', maxBytes: 16384, ...(cursor === undefined ? {} : { cursor }) });
      expect(page.isError, page.text).toBe(false);
      expect(page.text.length).toBeLessThanOrEqual(16384);
      const parsed = JSON.parse(page.text) as { messages: { id: string }[]; page: { complete: boolean; next: string | null; total: number } };
      seen.unshift(...parsed.messages.map((m) => m.id));
      expect(parsed.page.total).toBe(121);
      if (parsed.page.complete) break;
      cursor = parsed.page.next as string;
    }
    expect(seen).toHaveLength(121);
    expect(new Set(seen).size).toBe(121);
    expect(seen[0]).toBe('m-001'.replace('m-001', 'm-01'));
    const decisions = await callOk(client, 'get_map', { field: 'messages', room: 'r-01', kind: 'decision' });
    expect((decisions['messages'] as { id: string }[]).map((m) => m.id)).toEqual(['m-121']);
    expect((await call(client, 'get_map', { field: 'messages', room: 'r-01', kind: 'bogus' })).isError).toBe(true);
  });

  it('страницы писем не длиннее 100: ни read_room с большим limit, ни get_map messages не отдают больше', async () => {
    await seedRoom();
    await fill(150, 20);
    const client = await connect('s-01');
    const room = await callOk(client, 'read_room', { room: 'r-01', limit: 500, maxBytes: 262144 });
    expect((room['messages'] as unknown[]).length).toBe(100);
    expect(room['page']).toMatchObject({ total: 150, complete: false, next: 'before:51' });
    const mapPage = await callOk(client, 'get_map', { field: 'messages', room: 'r-01', maxBytes: 262144 });
    expect((mapPage['messages'] as unknown[]).length).toBe(100);
    const older = await callOk(client, 'read_room', { room: 'r-01', cursor: 'before:51', limit: 500, maxBytes: 262144 });
    expect((older['messages'] as unknown[]).length).toBe(50);
    expect(older['page']).toMatchObject({ complete: true, next: null });
  });

  it('письма комнаты читает только участник; без сессии страницы писем недоступны', async () => {
    await seedRoom();
    await updateMap(project, workId, (current) => { addSession(current, { provider: 'claude', label: 'сторонний', task: 'x' }); });
    await fill(3, 20);
    const stranger = await connect('s-03');
    const denied = await call(stranger, 'get_map', { field: 'messages', room: 'r-01' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('not a participant');
    const none = await connect(null);
    expect((await call(none, 'get_map', { field: 'messages' })).isError).toBe(true);
  });

  it('прямые письма: только из треда сессии; field message читает длинное письмо страницами', async () => {
    await seedRoom();
    await updateMap(project, workId, (current, letters) => {
      letters.add({ roomId: null, kind: 'note', from: 's-01', to: ['s-02'], text: longText(40_000) }); // m-01
      addSession(current, { provider: 'claude', label: 'чужой', task: 'x', parent: null }); // s-03
      addSession(current, { provider: 'claude', label: 'чужой2', task: 'x', parent: null }); // s-04
      letters.add({ roomId: null, kind: 'note', from: 's-03', to: ['s-04'], text: 'секрет' }); // m-02
    });
    const client = await connect('s-02');
    const direct = await callOk(client, 'get_map', { field: 'messages' });
    expect((direct['messages'] as { id: string }[]).map((m) => m.id)).toEqual(['m-01']);
    // 40 000 знаков по два байта — больше страницы по умолчанию: письмо сокращено, а целиком читается полем message.
    expect((direct['page'] as { cut: number }).cut).toBe(1);
    expect(JSON.stringify(direct)).not.toContain('секрет');

    let text = '';
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await callOk(client, 'get_map', { field: 'message', id: 'm-01', maxBytes: 32768, ...(cursor === undefined ? {} : { cursor }) });
      text += page['text'] as string;
      if (page['complete'] === true) break;
      cursor = page['next'] as string;
    }
    expect(text).toBe(longText(40_000));
    const hidden = await call(client, 'get_map', { field: 'message', id: 'm-02' });
    expect(hidden.isError).toBe(true);
    expect(hidden.text).toContain('unknown-target');
  });

  it('устаревший или кривой курсор — понятная ошибка, а не молчаливая склейка', async () => {
    await seedRoom();
    const client = await connect('s-01');
    const bad = await call(client, 'get_map', { field: 'messages', room: 'r-01', cursor: 'next-please' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('invalid-cursor');
    await updateMap(project, workId, (current) => { current.sessions[0]!.summary = 'я'.repeat(9000); });
    const first = await callOk(client, 'get_map', { session: 's-01', field: 'summary', maxBytes: 2048 });
    expect(first['complete']).toBe(false);
    await updateMap(project, workId, (current) => { current.sessions[0]!.summary = 'новое резюме'; });
    const stale = await call(client, 'get_map', { session: 's-01', field: 'summary', cursor: first['next'] });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('stale-cursor');
  });

  it('summaries и archive: страницы по номеру; архив — другие работы этого проекта', async () => {
    await seedRoom();
    await updateMap(project, workId, (current) => {
      current.sessions[0]!.summary = 'первое';
      current.sessions[1]!.summary = 'я'.repeat(20_000);
    });
    const other = await createWork(project, { title: 'Старая работа', goal: '' });
    const client = await connect('s-01');
    const summaries = await callOk(client, 'get_map', { field: 'summaries', maxBytes: 8192 });
    const list = summaries['summaries'] as { id: string; text: string; textBytes?: number }[];
    expect(list.map((row) => row.id)).toEqual(['s-01', 's-02']);
    expect(list[1]?.textBytes).toBe(40_000);
    expect(list[1]?.text).toContain('get_map {session: "s-02", field: "summary"}');
    const archive = await callOk(client, 'get_map', { field: 'archive' });
    expect((archive['workspaces'] as { id: string }[]).map((row) => row.id)).toEqual([other.work.id]);
    expect(archive['page']).toMatchObject({ total: 1, complete: true });
  });

  it('get_map {room}: комната целиком, с решением полностью, без плейбука', async () => {
    await seedRoom();
    await updateMap(project, workId, (current) => {
      current.rooms[0]!.recipe = { id: 'project:x', name: 'X', playbook: 'SECRET PLAYBOOK' };
      current.rooms[0]!.proposal = { id: 'p-01', from: 's-01', text: 'р'.repeat(8000), rev: 0, at: '2026-10-05T00:00:00.000Z' };
    });
    const client = await connect('s-01');
    const result = await call(client, 'get_map', { room: 'r-01' });
    expect(result.text).not.toContain('SECRET PLAYBOOK');
    const parsed = JSON.parse(result.text) as { room: { proposal: { text: string }; recipe: { id: string } } };
    expect(parsed.room.proposal.text).toHaveLength(8000);
    expect(parsed.room.recipe).toEqual({ id: 'project:x', name: 'X' });
  });

  it('read_room: потолок в байтах, длинное письмо сокращено с полным размером, page.next идёт к старым', async () => {
    await seedRoom();
    await fill(40, 2000);
    await fill(1, 300_000, { from: 's-01' });
    const client = await connect('s-02');
    const first = await call(client, 'read_room', { room: 'r-01', limit: 100, maxBytes: 16384 });
    expect(first.isError, first.text).toBe(false);
    expect(first.text.length).toBeLessThanOrEqual(16384);
    const parsed = JSON.parse(first.text) as { messages: { id: string; text: string; textBytes?: number }[]; page: { complete: boolean; next: string; cut: number } };
    expect(parsed.messages.at(-1)).toMatchObject({ id: 'm-41', textBytes: 599_998 });
    expect(parsed.messages.at(-1)?.text).toContain('cut: ');
    expect(parsed.page.cut).toBe(1);
    expect(parsed.page.complete).toBe(false);
    const older = await callOk(client, 'read_room', { room: 'r-01', limit: 5, cursor: parsed.page.next });
    expect((older['messages'] as { id: string }[]).map((m) => m.id).every((id) => id < parsed.messages[0]!.id)).toBe(true);
  });
});

describe('GLM readiness in MCP', () => {
  async function versionStub(version: string): Promise<void> {
    await writeFile(process.env.PARLEY_CLAUDE_BIN!, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
  }
  it('get_map reports unavailable without key, after key removal, or with old/unknown/custom CLI', async () => {
    const client = await connect('s-01');
    const available = async () => ((await callOk(client, 'get_map', { field: 'providers' }))['providers'] as { id: string; available: boolean }[]).find((entry) => entry.id === 'glm')!.available;
    await versionStub('2.1.287');
    expect(await available()).toBe(false);
    await writeSecret('zai', 'fake-key');
    expect(await available()).toBe(true);
    await clearSecret('zai');
    expect(await available()).toBe(false);
    await writeSecret('zai', 'fake-key');
    for (const version of ['2.1.286', 'unknown']) {
      await versionStub(version);
      expect(await available()).toBe(false);
    }
    await writeFile(path.join(home, 'providers.json'), JSON.stringify({ glm: { command: 'wrapper' } }));
    expect(await available()).toBe(false);
  });
});


describe('без PARLEY_SESSION_ID', () => {
  it('остальные инструменты объясняют, что сессию надо создать через харнесс', async () => {
    const client = await connect(null);
    const calls = [
      call(client, 'report', { status: 'progress', summary: 'что-то' }),
      call(client, 'wait_for', { target: 'inbox', timeoutSec: 0 }),
      call(client, 'send_message', { to: 's-01', text: 'привет' }),
      call(client, 'check_inbox'),
      call(client, 'create_room', { title: 'x', members: ['s-01', 's-01'], lead: 's-01' }),
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
    await callOk(await connect('s-01'), 'close_session', { target: 's-01' });

    const progress = await call(client, 'report', { status: 'progress', summary: 'x' });
    expect(progress.isError).toBe(true);
    expect(progress.text).toContain('is closed');

    const done = await call(client, 'report', { status: 'done', summary: 'x' });
    expect(done.isError).toBe(true);
    expect(session(await readMapFile(), 's-01').summary).toBeNull();
  });
});





describe('close_session', () => {
  /** s-01 — вызывающая; s-02 создала она, s-03 — s-02, s-04 завёл человек, s-05 создала s-01, но она в рое. */
  async function seedCreated(): Promise<void> {
    await updateMap(project, workId, (map) => {
      addSession(map, { provider: 'claude', label: 'дитя', task: 'x', createdBy: 's-01' });
      addSession(map, { provider: 'claude', label: 'внук', task: 'x', createdBy: 's-02' });
      addSession(map, { provider: 'claude', label: 'человека', task: 'x' });
      addSession(map, { provider: 'claude', label: 'трутень', task: 'x', createdBy: 's-01' });
      map.swarms = [{
        id: 'sw-01', tag: 'T', creator: { kind: 'human' }, objective: 'o', queen: 's-05',
        members: [{ sessionId: 's-05', role: 'queen', n: 1, addedAt: new Date().toISOString(), handedAt: null }],
        status: 'running', createdAt: new Date().toISOString(), endedAt: null, expiredAt: null, result: null, failure: null, seenAt: null,
      }];
    });
  }

  it('себя можно; созданную собой и потомка потомка — тоже, без согласия человека', async () => {
    await seedCreated();
    const client = await connect('s-01');

    await callOk(client, 'close_session', { target: 's-03' });
    await callOk(client, 'close_session', { target: 's-02' });
    await callOk(client, 'close_session', { target: 's-01' });

    const map = await readMapFile();
    expect(['s-01', 's-02', 's-03'].map((id) => session(map, id).lifecycle)).toEqual(['closed', 'closed', 'closed']);
  });

  it('чужую, созданную человеком и участника роя — отказ с понятным текстом, карта не меняется', async () => {
    await seedCreated();
    const child = await connect('s-02');

    const foreign = await call(child, 'close_session', { target: 's-01' });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain('the calling session or a session it created');
    const human = await call(await connect('s-01'), 'close_session', { target: 's-04' });
    expect(human.isError).toBe(true);
    expect(human.text).toContain('s-04 is not one of them');
    const swarm = await call(await connect('s-01'), 'close_session', { target: 's-05' });
    expect(swarm.isError).toBe(true);
    expect(swarm.text).toContain('swarm member');

    const map = await readMapFile();
    expect(['s-01', 's-04', 's-05'].map((id) => session(map, id).lifecycle)).not.toContain('closed');
  });
});

describe('send_message и check_inbox', () => {
  it('сообщение доходит и помечается прочитанным один раз', async () => {
    const first = await connect('s-01');
    await addHistoricalSession(first, { provider: 'claude', label: 'бэк', task: 'делать' });
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

  it('check_inbox с пустым ящиком ничего не пишет: версия работы и updatedAt прежние; с письмом — оба сдвигаются', async () => {
    const first = await connect('s-01');
    await addHistoricalSession(first, { provider: 'claude', label: 'бэк', task: 'делать' });
    const second = await connect('s-02');
    const versionBefore = workVersion(project, workId);
    const updatedBefore = (await readMap(project, workId)).work.updatedAt;

    expect(await callOk(first, 'check_inbox')).toEqual({ messages: [] });
    expect(workVersion(project, workId)).toBe(versionBefore);
    expect((await readMap(project, workId)).work.updatedAt).toBe(updatedBefore);

    await callOk(second, 'send_message', { to: 's-01', text: 'нужен план' });
    expect(workVersion(project, workId)).toBeGreaterThan(versionBefore!);
    // Состарить `updatedAt`: сдвиг от `check_inbox` должен быть виден независимо от разрешения часов.
    const aged = '2020-01-01T00:00:00.000Z';
    await updateMap(project, workId, (current) => {
      current.work.updatedAt = aged;
    }, { touch: false });
    expect((await readMap(project, workId)).work.updatedAt).toBe(aged);
    const versionSent = workVersion(project, workId);
    expect(((await callOk(first, 'check_inbox'))['messages'] as unknown[]).length).toBe(1);
    expect(workVersion(project, workId)).toBeGreaterThan(versionSent!);
    const touched = (await readMap(project, workId)).work.updatedAt;
    expect(touched).not.toBe(aged);
    expect(touched > aged).toBe(true);
    // Повтор снова пустой: версия не растёт.
    const versionRead = workVersion(project, workId);
    expect(await callOk(first, 'check_inbox')).toEqual({ messages: [] });
    expect(workVersion(project, workId)).toBe(versionRead);
  });

  it('чужие сообщения в ящик не попадают', async () => {
    const first = await connect('s-01');
    await addHistoricalSession(first, { provider: 'claude', label: 'бэк', task: 'делать' });
    await updateMap(project, workId, (map, letters) => {
      letters.add({ roomId: null, kind: 'note', from: 's-01', to: ['s-02'], text: 'не тебе' });
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
    await addHistoricalSession(first, { provider: 'claude', label: 'бэк', task: 'делать' });
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
    await addHistoricalSession(first, { provider: 'claude', label: 'бэк', task: 'делать' });
    const second = await connect('s-02');
    await callOk(second, 'send_message', { to: 's-01', text: 'где миграция?', kind: 'question' });

    const waited = await callOk(first, 'wait_for', { target: 'inbox', timeoutSec: 5 });
    expect((waited['messages'] as { kind: string }[]).map((item) => item.kind)).toEqual([
      'question',
    ]);

    // wait_for уже забрал первое письмо: check_inbox нужно новое.
    await callOk(second, 'send_message', { to: 's-01', text: 'а сейчас?', kind: 'question' });
    const inbox = await callOk(first, 'check_inbox');
    expect((inbox['messages'] as { kind: string }[]).map((item) => item.kind)).toEqual([
      'question',
    ]);
  });

  it('окно messageRate: третье письмо за час отказано, письмо старше часа не считается', async () => {
    const first = await connect('s-01');
    await addHistoricalSession(first, { provider: 'claude', label: 'бэк', task: 'делать' });
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
    // Письма не правятся через API, поэтому ход времени — прямой правкой строки в таблице писем.
    workDb()
      .prepare('UPDATE messages SET at = ? WHERE project_path = ? AND work_id = ? AND seq = 1')
      .run(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), project, workId);
    expect(await callOk(second, 'send_message', { to: 's-01', text: 'три' })).toEqual({
      messageId: 'm-04',
    });
  });

  it('письмо длиннее потолка: отказ с советом писать файл, в карте письма нет', async () => {
    const first = await connect('s-01');
    await addHistoricalSession(first, { provider: 'claude', label: 'бэк', task: 'делать' });
    const second = await connect('s-02');

    const refused = await call(second, 'send_message', { to: 's-01', text: 'я'.repeat(4097) });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe('letter is 4097 chars, limit 4096: write a file and send its path');
    expect((await readMapFile()).messages).toEqual([]);

    // Ровно на потолке — ещё письмо, текст не обрезан.
    await callOk(second, 'send_message', { to: 's-01', text: 'я'.repeat(4096) });
    expect((await readMapFile()).messages[0]?.text).toHaveLength(4096);
  });

  it('письмо длиннее мягкого порога пишется с предупреждением, короткое — без замечаний', async () => {
    const first = await connect('s-01');
    await addHistoricalSession(first, { provider: 'claude', label: 'бэк', task: 'делать' });
    const second = await connect('s-02');

    const long = await callOk(second, 'send_message', { to: 's-01', text: 'я'.repeat(1500) });
    expect(long['warning']).toBe('long letter (1500 chars): prefer a file and a path');
    expect((await readMapFile()).messages).toHaveLength(1);

    const both = await callOk(second, 'send_message', { to: 's-01', text: 'я'.repeat(1500), reply_to: 'm-01' });
    expect(both['warning']).toContain('long letter (1500 chars): prefer a file and a path; unknown parameters ignored');

    const short = await callOk(second, 'send_message', { to: 's-01', text: 'я'.repeat(800) });
    expect(short).toEqual({ messageId: 'm-03' });
  });

  it('to массивом из одного элемента — как строка', async () => {
    const first = await connect('s-01');
    await addHistoricalSession(first, { provider: 'claude', label: 'бэк', task: 'делать' });
    const second = await connect('s-02');

    const sent = await callOk(second, 'send_message', { to: ['s-01'], text: 'массивом' });
    expect(sent['messageId']).toBe('m-01');
    expect((await readMapFile()).messages[0]?.to).toEqual(['s-01']);
  });

  it('без room несколько адресатов в to — ошибка, письмо не создано', async () => {
    const first = await connect('s-01');
    await addHistoricalSession(first, { provider: 'claude', label: 'бэк', task: 'делать' });

    const result = await call(first, 'send_message', { to: ['s-01', 's-02'], text: 'кому?' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('room');
    expect((await readMapFile()).messages).toEqual([]);
  });

  it('закрытому адресату без room — ошибка', async () => {
    const first = await connect('s-01');
    await addHistoricalSession(first, { provider: 'claude', label: 'бэк', task: 'делать' });
    await callOk(await connect('s-02'), 'close_session', { target: 's-02' });

    const result = await call(first, 'send_message', { to: 's-02', text: 'привет' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('s-02');
    expect(result.text).toContain('is closed');
  });
});

describe('create_room explicit working membership and ownership', () => {
  async function colleagues(): Promise<Client> {
    const caller = await connect('s-01');
    for (const label of ['Lead A', 'Member A', 'Lead B', 'Lead C']) {
      await updateMap(project, workId, map => { addSession(map, { provider: 'codex', label, task: '', parent: null }); });
    }
    return caller;
  }

  it('requires nonempty members and an explicit lead from that list without mutation', async () => {
    const caller = await colleagues();
    const before = await readMapFile();
    for (const args of [
      { title: 'Missing lead', members: ['s-02'] },
      { title: 'Empty members', members: [], lead: 's-01' },
      { title: 'Outside lead', members: ['s-02'], lead: 's-03' },
      { title: 'Unknown member', members: ['s-99'], lead: 's-99' },
    ]) expect((await call(caller, 'create_room', args)).isError).toBe(true);
    expect(await readMapFile()).toEqual(before);
  });

  it('deduplicates explicit members and includes the caller only when named', async () => {
    const caller = await colleagues();
    await callOk(caller, 'create_room', { title: 'Working', members: ['s-02', 's-02', 's-01'], lead: 's-02' });
    expect((await readMapFile()).rooms[0]).toMatchObject({ ownerId: 's-01', members: ['s-02', 's-01'], lead: 's-02' });
  });

  it('creates three owned rooms without moving the caller or enrolling it', async () => {
    const caller = await colleagues();
    await updateMap(project, workId, map => { addRoom(map, { title: 'Current work', creator: HUMAN, members: ['s-01'], lead: 's-01' }); });
    for (const [index, lead] of ['s-02', 's-04', 's-05'].entries()) {
      await callOk(caller, 'create_room', { title: `Owned ${index}`, members: [lead], lead });
    }
    const map = await readMapFile();
    expect(map.rooms.filter(room => room.members.includes('s-01')).map(room => room.id)).toEqual(['r-01']);
    expect(map.rooms.filter(room => room.ownerId === 's-01')).toHaveLength(3);
    expect(map.sessions.slice(1).every(session => session.parent === null)).toBe(true);
  });

  it('moves explicit working members while preserving ownership and history', async () => {
    const caller = await colleagues();
    await callOk(caller, 'create_room', { title: 'Earlier', members: ['s-02', 's-03'], lead: 's-02' });
    await callOk(caller, 'create_room', { title: 'Later', members: ['s-03', 's-04'], lead: 's-04' });
    const map = await readMapFile();
    expect(map.rooms[0]).toMatchObject({ ownerId: 's-01', creator: 's-01', members: ['s-02'], lead: 's-02' });
    expect(map.rooms[1]).toMatchObject({ ownerId: 's-01', members: ['s-03', 's-04'], lead: 's-04' });
    expect(map.messages.some(message => message.roomId === 'r-01')).toBe(true);
  });

  it('permits owner reads and addressed owner/lead replies, excluding ordinary broadcasts', async () => {
    const owner = await colleagues();
    await callOk(owner, 'create_room', { title: 'Owned', members: ['s-02', 's-03'], lead: 's-02' });
    const lead = await connect('s-02');
    const member = await connect('s-03');
    await callOk(lead, 'check_inbox');
    await callOk(member, 'check_inbox');
    await callOk(owner, 'send_message', { room: 'r-01', to: 's-02', text: 'Milestone?', kind: 'question' });
    await callOk(lead, 'send_message', { room: 'r-01', to: 's-01', text: 'Ready for review' });
    await callOk(member, 'send_message', { room: 'r-01', text: 'Internal progress' });
    const inbox = await callOk(owner, 'check_inbox');
    expect((inbox.messages as { text: string }[]).map(message => message.text)).toEqual(['Ready for review']);
    expect((await callOk(owner, 'read_room', { room: 'r-01' })).messages).toBeDefined();
    expect((await callOk(owner, 'get_map', { room: 'r-01' })).room).toMatchObject({ ownerId: 's-01' });
    for (const args of [
      { room: 'r-01', text: 'Owner broadcast' },
      { room: 'r-01', to: 's-03', text: 'Bypass lead' },
    ]) expect((await call(owner, 'send_message', args)).isError).toBe(true);
    expect((await call(owner, 'add_to_room', { room: 'r-01', session: 's-04' })).isError).toBe(true);
    expect((await call(owner, 'propose_decision', { room: 'r-01', text: 'Owner decision' })).isError).toBe(true);
    await updateMap(project, workId, (map, letters) => { archiveRoom(map, letters, 'r-01'); });
    expect((await call(owner, 'read_room', { room: 'r-01' })).isError).toBe(false);
    expect((await call(owner, 'get_map', { room: 'r-01' })).isError).toBe(false);
    expect((await call(owner, 'get_map', { room: 'r-01', field: 'messages' })).isError).toBe(false);
    expect((await call(owner, 'send_message', { room: 'r-01', to: 's-02', text: 'Archived' })).isError).toBe(true);
  });

  it('rejects unavailable leads and closed owners without writing messages', async () => {
    const owner = await colleagues();
    await callOk(owner, 'create_room', { title: 'Owned', members: ['s-02'], lead: 's-02' });
    await updateMap(project, workId, map => { session(map, 's-02').lifecycle = 'closed'; });
    const before = await readMapFile();
    expect((await call(owner, 'send_message', { room: 'r-01', to: 's-02', text: 'Unavailable' })).isError).toBe(true);
    expect(await readMapFile()).toEqual(before);
    await updateMap(project, workId, map => {
      session(map, 's-02').lifecycle = 'sleeping';
      session(map, 's-01').lifecycle = 'closed';
    });
    const lead = await connect('s-02');
    expect((await call(lead, 'send_message', { room: 'r-01', to: 's-01', text: 'Closed owner' })).isError).toBe(true);
    expect((await call(owner, 'send_message', { room: 'r-01', to: 's-02', text: 'Closed sender' })).isError).toBe(true);
  });
});

describe('add_to_room', () => {
  /**
   * Комната r-01 «комната»: s-01 — вызывающий и ведущий по умолчанию, s-02 — участник (приглашение
   * забрано). s-03 и s-04 заведены в работе, но в комнату не входят.
   */
  async function setup(): Promise<{ lead: Client; member: Client }> {
    const lead = await connect('s-01');
    await addHistoricalSession(lead, { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await addHistoricalSession(lead, { provider: 'claude', label: 'ревью', task: 'делать' }); // s-03
    await addHistoricalSession(lead, { provider: 'claude', label: 'тесты', task: 'делать' }); // s-04
    await callOk(lead, 'create_room', { title: 'комната', members: ['s-01', 's-02'], lead: 's-01' });
    const member = await connect('s-02');
    await callOk(member, 'check_inbox');
    return { lead, member };
  }

  /** Версия строки работы: после отказа она не сдвинулась — карту не записывали. */
  const rawMap = (): number | undefined => workVersion(project, workId);

  it('ведущий вводит живую сессию: она в members, в ленте — системная строка, письма ей нет', async () => {
    const { lead } = await setup();
    const result = await callOk(lead, 'add_to_room', { room: 'r-01', session: 's-04' });

    const map = await readMapFile();
    expect(map.rooms[0]?.members).toEqual(['s-01', 's-02', 's-04']);
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
    await callOk(other, 'create_room', { title: 'вторая', members: ['s-04', 's-03'], lead: 's-04' }); // r-02, ведущий s-04
    await callOk(lead, 'add_to_room', { room: 'r-01', session: 's-03' });

    const map = await readMapFile();
    expect(map.rooms.find((room) => room.id === 'r-01')?.members).toEqual(['s-01', 's-02', 's-03']);
    expect(map.rooms.find((room) => room.id === 'r-02')?.members).toEqual(['s-04']);
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
    await callOk(await connect('s-01'), 'close_session', { target: 's-01' });
    const before = await rawMap();

    const closedLead = await call(lead, 'add_to_room', { room: 'r-01', session: 's-04' });
    expect(closedLead.isError).toBe(true);
    expect(await rawMap()).toBe(before);

    await callOk(member, 'add_to_room', { room: 'r-01', session: 's-04' });
    expect((await readMapFile()).rooms[0]?.members).toEqual(['s-01', 's-02', 's-04']);
  });

  it('закрытая комната — ошибка, карта не изменилась', async () => {
    const { lead } = await setup();
    await callOk(await connect('s-02'), 'close_session', { target: 's-02' });
    await callOk(await connect('s-01'), 'close_session', { target: 's-01' });
    const before = await rawMap();

    const refused = await call(lead, 'add_to_room', { room: 'r-01', session: 's-04' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/is closed/);
    expect(await rawMap()).toBe(before);
  });

  it('чужая, закрытая сессия и уже участник — ошибка, карта не изменилась', async () => {
    const { lead } = await setup();
    await callOk(await connect('s-03'), 'close_session', { target: 's-03' });
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
    await updateMap(project, workId, (map, letters) => {
      removeSession(map, letters, 's-01');
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
    await addHistoricalSession(lead, { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await addHistoricalSession(lead, { provider: 'claude', label: 'ревью', task: 'делать' }); // s-03
    await callOk(lead, 'create_room', { title: 'комната', members: ['s-01', 's-02', 's-03'], lead: 's-01' });
    const a = await connect('s-02');
    const b = await connect('s-03');
    await callOk(a, 'check_inbox');
    await callOk(b, 'check_inbox');
    return { lead, a, b };
  }

  /** Версия строки работы: после отказа она не сдвинулась — карту не записывали. */
  const rawMap = (): number | undefined => workVersion(project, workId);

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
    await updateMap(project, workId, (map, letters) => {
      resolveProposal(map, letters, 'r-01', 'p-01', 'return', { note: 'мало' });
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
    await addHistoricalSession(lead, { provider: 'claude', label: 'сторонний', task: 'делать' }); // s-04
    const stranger = await connect('s-04');
    const before = await rawMap();

    const refused = await call(stranger, 'propose_decision', { room: 'r-01', text: 'а можно?' });
    expect(refused.isError).toBe(true);
    expect(await rawMap()).toBe(before);
  });

  it('закрытая комната (нет живых участников) — ошибка, карта не изменилась', async () => {
    const { lead } = await leadRoom();
    await callOk(await connect('s-02'), 'close_session', { target: 's-02' });
    await callOk(await connect('s-03'), 'close_session', { target: 's-03' });
    await callOk(await connect('s-01'), 'close_session', { target: 's-01' });
    const before = await rawMap();

    const refused = await call(lead, 'propose_decision', { room: 'r-01', text: 'решение' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/live launched caller/);
    expect(await rawMap()).toBe(before);
  });

  it('ведущий — живой ведущий: ушёл назначенный — решение приносит первый живой участник', async () => {
    const { lead, a, b } = await leadRoom();
    await callOk(await connect('s-01'), 'close_session', { target: 's-01' });

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
    await addHistoricalSession(owner, { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await addHistoricalSession(owner, { provider: 'claude', label: 'ревью', task: 'делать' }); // s-03
    await callOk(owner, 'create_room', { title: 'комната', members: ['s-01', 's-02', 's-03'], lead: 's-01' });
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
    await addHistoricalSession(owner, { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await addHistoricalSession(owner, { provider: 'claude', label: 'сторонний', task: 'делать' }); // s-03
    await callOk(owner, 'create_room', { title: 'комната', members: ['s-01', 's-02'], lead: 's-01' });

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
    await addHistoricalSession(owner, { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await addHistoricalSession(owner, { provider: 'claude', label: 'ревью', task: 'делать' }); // s-03
    // Комната заведена в обход create_room: его приглашения не должны путать счёт.
    await updateMap(project, workId, (map) => {
      addRoom(map, { title: 'комната', creator: 's-01', members: ['s-01', 's-02', 's-03'] });
    });

    await callOk(owner, 'send_message', { room: 'r-01', text: 'раз' });
    await callOk(owner, 'send_message', { room: 'r-01', text: 'два' });
    const refused = await call(owner, 'send_message', { room: 'r-01', text: 'три' });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('too many messages');
    // Была бы рассылка на два письма (по адресату), лимит исчерпался бы на первом вызове.
    expect((await readMapFile()).messages).toHaveLength(2);
  });

  describe('задача человека всем: роль приходит вместе с письмом (roomTask)', () => {
    interface TaskView {
      text: string;
      toEveryone?: boolean;
      roomTask?: {
        role: string;
        lead: string;
        leadLabel: string;
        proposalWaiting: boolean;
        hint: string;
      };
    }
    const TASK = 'Делаем вход по паролю';

    /** Письмо человека в r-01: без `to` — задача всем, с `to` — адресное. */
    const humanSays = (to: string[] = []): Promise<unknown> =>
      updateMap(project, workId, (map, letters) => {
        letters.add({ kind: 'note', from: HUMAN, to, text: TASK, roomId: 'r-01' });
      });

    const inboxOf = async (client: Client): Promise<TaskView[]> =>
      (await callOk(client, 'check_inbox'))['messages'] as TaskView[];

    it('ведущему и участнику: toEveryone и roomTask с ролью, ведущим и подсказкой', async () => {
      const { owner, a } = await roomSetup();
      await humanSays();
      const leadLabel = participantLabel(await readMapFile(), 's-01');

      const [forLead] = await inboxOf(owner);
      expect(forLead).toMatchObject({ text: TASK, toEveryone: true });
      expect(forLead?.roomTask).toEqual({
        role: 'lead',
        lead: 's-01',
        leadLabel,
        proposalWaiting: false,
        hint: LEAD_ROLE,
      });

      const [forMember] = await inboxOf(a);
      expect(forMember).toMatchObject({ text: TASK, toEveryone: true });
      expect(forMember?.roomTask).toEqual({
        role: 'member',
        lead: 's-01',
        leadLabel,
        proposalWaiting: false,
        hint: memberRole('@s02'),
      });
      expect(forMember?.roomTask?.hint).toContain('@s02');
    });

    it('адресное письмо человека в комнате — без toEveryone и без roomTask', async () => {
      const { a } = await roomSetup();
      await humanSays(['s-02']);

      const [letter] = await inboxOf(a);
      expect(letter?.text).toBe(TASK);
      expect(letter).not.toHaveProperty('toEveryone');
      expect(letter).not.toHaveProperty('roomTask');
    });

    it('рассылка агента: toEveryone есть, roomTask нет — роль раздаёт только человек', async () => {
      const { owner, a } = await roomSetup();
      await callOk(owner, 'send_message', { room: 'r-01', text: 'раздаю части' });

      const [letter] = await inboxOf(a);
      expect(letter).toMatchObject({ text: 'раздаю части', toEveryone: true });
      expect(letter).not.toHaveProperty('roomTask');
    });

    it('прямое письмо агента вне комнаты — без toEveryone', async () => {
      const { owner, a } = await roomSetup();
      await callOk(owner, 'send_message', { to: 's-02', text: 'лично тебе' });

      const [letter] = await inboxOf(a);
      expect(letter?.text).toBe('лично тебе');
      expect(letter).not.toHaveProperty('toEveryone');
      expect(letter).not.toHaveProperty('roomTask');
    });

    it('решение уже ждёт: proposalWaiting — true и у ведущего, и у участника', async () => {
      const { owner, a } = await roomSetup();
      await callOk(owner, 'propose_decision', { room: 'r-01', text: 'Делаем через очередь.' });
      await humanSays();

      expect((await inboxOf(owner))[0]?.roomTask).toMatchObject({ role: 'lead', proposalWaiting: true });
      expect((await inboxOf(a))[0]?.roomTask).toMatchObject({ role: 'member', proposalWaiting: true });
    });

    it('wait_for("inbox") отдаёт тот же roomTask, что и check_inbox', async () => {
      const { a } = await roomSetup();
      // Эталон — check_inbox; письмо второй раз, потому что отданное им уже прочитано.
      await humanSays();
      const [fromInbox] = await inboxOf(a);
      await humanSays();

      const waited = await callOk(a, 'wait_for', { target: 'inbox', timeoutSec: 5 });
      const fromWait = (waited['messages'] as TaskView[])[0];

      expect(fromWait).toMatchObject({ text: TASK, toEveryone: true });
      expect(fromWait?.roomTask).toBeDefined();
      expect(fromWait?.roomTask).toEqual(fromInbox?.roomTask);
    });

    it('в комнате нет живых участников — roomTask нет, письмо и toEveryone остаются', async () => {
      const { a } = await roomSetup();
      await humanSays();
      await callOk(await connect('s-02'), 'close_session', { target: 's-02' });
      await callOk(await connect('s-03'), 'close_session', { target: 's-03' });
      await callOk(await connect('s-01'), 'close_session', { target: 's-01' });

      const [letter] = await inboxOf(a);
      expect(letter).toMatchObject({ text: TASK, toEveryone: true });
      expect(letter).not.toHaveProperty('roomTask');
    });

    it('ведущий закрыт: роль считается по живому ведущему, а не по записи комнаты', async () => {
      const { a, b } = await roomSetup();
      await humanSays();
      await callOk(await connect('s-01'), 'close_session', { target: 's-01' });

      // Ведущим становится первый живой из members — s-02.
      const forNewLead = (await inboxOf(a))[0]?.roomTask;
      expect(forNewLead).toMatchObject({ role: 'lead', lead: 's-02', hint: LEAD_ROLE });
      expect((await inboxOf(b))[0]?.roomTask).toMatchObject({
        role: 'member',
        lead: 's-02',
        hint: memberRole('@s03'),
      });
    });

    it('read_room показывает toEveryone, но roomTask не добавляет: это чтение контекста, не доставка', async () => {
      const { owner } = await roomSetup();
      await humanSays();

      const feed = (await callOk(owner, 'read_room', { room: 'r-01' }))['messages'] as TaskView[];
      const task = feed.find((message) => message.text === TASK);
      expect(task).toMatchObject({ toEveryone: true });
      expect(task).not.toHaveProperty('roomTask');
    });
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
    await addHistoricalSession(owner, { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await addHistoricalSession(owner, { provider: 'claude', label: 'ревью', task: 'делать' }); // s-03
    await callOk(owner, 'create_room', { title: 'комната', members: ['s-01', 's-02', 's-03'], lead: 's-01' }); // r-01
    const a = await connect('s-02');
    const b = await connect('s-03');
    await callOk(a, 'check_inbox');
    await callOk(b, 'check_inbox');
    await updateMap(project, workId, (map, letters) => {
      letters.add({ from: HUMAN,
        to: [],
        text: 'Кто берёт миграции?',
        kind: 'question',
        roomId: 'r-01' });
      addRoom(map, { title: 'другая', creator: HUMAN, members: [] });
      letters.add({ kind: 'note', from: HUMAN, to: [], text: 'Про другое', roomId: 'r-02' });
      letters.add({ roomId: null, kind: 'note', from: 's-01', to: ['s-02'], text: 'Лично тебе' });
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
    // wait_for отмечает отданное прочитанным, поэтому check_inbox идёт от второго получателя тех же писем (s-03).
    const { owner, a, b } = await replySetup();
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
      ['check_inbox', (await callOk(b, 'check_inbox'))['messages'] as View[]],
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

  it('read_room: письмо человека через помощника приходит с via, обычное — без ключа', async () => {
    const { owner } = await replySetup();
    await updateMap(project, workId, (map, letters) => {
      letters.add({ kind: 'note', from: HUMAN, to: [], text: 'Через помощника', roomId: 'r-01', via: 'assistant' }); // m-06
      letters.add({ kind: 'note', from: HUMAN, to: [], text: 'Сам в окне', roomId: 'r-01' }); // m-07
    });

    const messages = (await callOk(owner, 'read_room', { room: 'r-01' }))['messages'] as { id: string }[];

    expect(messages.find((message) => message.id === 'm-06')).toMatchObject({ via: 'assistant' });
    expect(messages.find((message) => message.id === 'm-07')).not.toHaveProperty('via');
  });
});

describe('read_room', () => {
  it('не участнику — ошибка, отметки не меняются', async () => {
    const owner = await connect('s-01');
    await addHistoricalSession(owner, { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await addHistoricalSession(owner, { provider: 'claude', label: 'сторонний', task: 'делать' }); // s-03
    await callOk(owner, 'create_room', { title: 'комната', members: ['s-01', 's-02'], lead: 's-01' });
    await callOk(owner, 'send_message', { room: 'r-01', text: 'привет' });

    const stranger = await connect('s-03');
    const result = await call(stranger, 'read_room', { room: 'r-01' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('not available');
  });

  it('участнику отдаёт последние limit писем, не отмечая прочтение', async () => {
    const owner = await connect('s-01');
    await addHistoricalSession(owner, { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await callOk(owner, 'create_room', { title: 'комната', members: ['s-01', 's-02'], lead: 's-01' });
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

  it('исторический родитель не закрывает ребёнка; ребёнок закрывает себя', async () => {
    const client = await connect('s-01');
    await addHistoricalSession(client, { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02

    expect((await call(client, 'close_session', { target: 's-02' })).isError).toBe(true);
    await callOk(await connect('s-02'), 'close_session', { target: 's-02' });
    expect(session(await readMapFile(), 's-02').lifecycle).toBe('closed');
  });

  it('исторический предок не может закрыть потомка; сессия закрывает себя', async () => {
    const owner = await connect('s-01');
    await addHistoricalSession(owner, { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    const child = await connect('s-02');
    await addHistoricalSession(child, { provider: 'claude', label: 'внук', task: 'делать' }); // s-03

    expect((await call(owner, 'close_session', { target: 's-03' })).isError).toBe(true);
    await callOk(await connect('s-03'), 'close_session', { target: 's-03' });
    expect(session(await readMapFile(), 's-03').lifecycle).toBe('closed');
  });

  it('соседа закрыть нельзя', async () => {
    const owner = await connect('s-01');
    await addHistoricalSession(owner, { provider: 'claude', label: 'бэк', task: 'делать' }); // s-02
    await addHistoricalSession(owner, { provider: 'claude', label: 'ревью', task: 'делать' }); // s-03
    const second = await connect('s-02');

    const result = await call(second, 'close_session', { target: 's-03' });
    expect(result.isError).toBe(true);
    expect(session(await readMapFile(), 's-03').lifecycle).toBe('pending');
  });

  it('повторное закрытие — ошибка', async () => {
    const client = await connect('s-01');
    await callOk(await connect('s-01'), 'close_session', { target: 's-01' });

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
    await addHistoricalSession(client, { provider: 'claude', label: 'бэк', task: 'делать' });

    expect(await callOk(client, 'wait_for', { target: 's-02', timeoutSec: 0.2 })).toEqual({
      state: 'running',
    });
  });

  it('уже завершённая сессия отвечает сразу и отдаёт резюме', async () => {
    const client = await connect('s-01');
    await addHistoricalSession(client, { provider: 'claude', label: 'бэк', task: 'делать' });
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
    await addHistoricalSession(client, { provider: 'claude', label: 'бэк', task: 'делать' });

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
    await addHistoricalSession(client, { provider: 'claude', label: 'бэк', task: 'делать' });

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

  it('inbox просыпается на новом входящем и помечает его прочитанным', async () => {
    const client = await connect('s-01');
    const pending = callOk(client, 'wait_for', { target: 'inbox', timeoutSec: 20 });
    await delay(60);
    await updateMap(project, workId, (map, letters) => {
      letters.add({ roomId: null, kind: 'note', from: 's-01', to: ['s-01'], text: 'проснись' });
    });

    const result = await pending;
    expect(result['state']).toBe('message');
    expect((result['messages'] as { text: string }[]).map((item) => item.text)).toEqual([
      'проснись',
    ]);
    // Отданное письмо wait_for отмечает прочитанным сам.
    expect(Object.keys((await readMapFile()).messages[0]?.readBy ?? {})).toEqual(['s-01']);
    expect(await callOk(client, 'check_inbox')).toEqual({ messages: [] });
  });

  /** Письма от `s-02` к `s-01`: `s-02` заводится в карте, тексты — по порядку. */
  async function lettersFromBack(client: Client, ...texts: string[]): Promise<void> {
    if (!(await readMapFile()).sessions.some((item) => item.id === 's-02')) {
      await addHistoricalSession(client, { provider: 'claude', label: 'бэк', task: 'делать' });
    }
    await updateMap(project, workId, (map, letters) => {
      for (const text of texts) letters.add({ roomId: null, kind: 'note', from: 's-02', to: ['s-01'], text });
    });
  }
  const textsOf = (result: Record<string, unknown>): string[] =>
    ((result['messages'] ?? []) as { text: string }[]).map((item) => item.text);

  it('inbox: отданные письма помечены прочитанными, check_inbox после — пустой', async () => {
    const client = await connect('s-01');
    await lettersFromBack(client, 'раз', 'два');

    const waited = await callOk(client, 'wait_for', { target: 'inbox', timeoutSec: 5 });

    expect(waited['state']).toBe('message');
    expect(textsOf(waited)).toEqual(['раз', 'два']);
    expect((await readMapFile()).messages.every((message) => message.readBy['s-01'] !== undefined)).toBe(true);
    expect(await callOk(client, 'check_inbox')).toEqual({ messages: [] });
  });

  it('повторный wait_for без новых писем ждёт до таймаута и отвечает running', async () => {
    const client = await connect('s-01');
    await lettersFromBack(client, 'раз');
    await callOk(client, 'wait_for', { target: 'inbox', timeoutSec: 5 });

    const started = Date.now();
    expect(await callOk(client, 'wait_for', { target: 'inbox', timeoutSec: 0.3 })).toEqual({ state: 'running' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('wait_for и check_inbox одновременно: каждое письмо отдано хотя бы одним, непомеченных-неотданных нет', async () => {
    const client = await connect('s-01');
    await lettersFromBack(client, 'раз', 'два', 'три');

    const [waited, inbox] = await Promise.all([
      callOk(client, 'wait_for', { target: 'inbox', timeoutSec: 0.5 }),
      callOk(client, 'check_inbox'),
    ]);

    // Запись одна и целиком: письмо уходит ровно одному из вызовов, а проигравший wait_for ждёт до таймаута, не отвечая пустым message.
    expect([...textsOf(waited), ...textsOf(inbox)].sort()).toEqual(['два', 'раз', 'три']);
    if (waited['state'] !== 'message') expect(waited).toEqual({ state: 'running' });
    expect((await readMapFile()).messages.every((message) => message.readBy['s-01'] !== undefined)).toBe(true);
  });

  describe('отмена и гонка с check_inbox (исполнитель без транспорта)', () => {
    const textOf = (result: Awaited<ReturnType<ToolRunner['call']>>): string => (result.content[0] as { text: string }).text;

    /** Исполнитель `s-01` с подпиской `mapChanges`, которую тест дёргает сам; `onStop` — когда ожидание подписку снимает. */
    function runnerWithChanges(onStop: () => void = () => undefined, pollMs = 60_000): { runner: ToolRunner; listener: () => (() => void) | null } {
      const state = { listener: null as (() => void) | null };
      const runner = createToolRunner({
        projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false,
        messageRate: DEFAULT_CONFIG.messageRate, pollMs,
        mapChanges: (onChange) => { state.listener = onChange; return () => { state.listener = null; onStop(); }; },
      });
      return { runner, listener: () => state.listener };
    }
    /** Подписка заводится после первой пробы: ждём её, а не гадаем по времени. */
    const subscribed = (listener: () => (() => void) | null): Promise<void> =>
      vi.waitFor(() => expect(listener()).not.toBeNull(), { timeout: 2000, interval: 10 });

    it('отменённый wait_for не помечает: check_inbox отдаёт письмо', async () => {
      const client = await connect('s-01');
      await lettersFromBack(client);
      const controller = new AbortController();
      const { runner, listener } = runnerWithChanges();
      const waiting = runner.call('wait_for', { target: 'inbox', timeoutSec: 30 }, undefined, controller.signal);
      await subscribed(listener);

      controller.abort();
      await waiting;
      await lettersFromBack(client, 'пришло после отмены');

      expect((await readMapFile()).messages[0]?.readBy).toEqual({});
      expect(textsOf(JSON.parse(textOf(await runner.call('check_inbox', {}, undefined))))).toEqual(['пришло после отмены']);
    });

    it('отмена в тот же миг, когда письмо найдено: ничего не помечено, check_inbox отдаёт письмо', async () => {
      const client = await connect('s-01');
      await lettersFromBack(client);
      const controller = new AbortController();
      // Подписку ожидание снимает, решив, что письмо есть, и ровно в этот миг клиент отменяет вызов.
      const { runner, listener } = runnerWithChanges(() => controller.abort());
      const waiting = runner.call('wait_for', { target: 'inbox', timeoutSec: 30 }, undefined, controller.signal);
      await subscribed(listener);
      await lettersFromBack(client, 'письмо');

      listener()!();

      expect(JSON.parse(textOf(await waiting))).toEqual({ state: 'running' });
      expect((await readMapFile()).messages[0]?.readBy).toEqual({});
      expect(textsOf(JSON.parse(textOf(await runner.call('check_inbox', {}, undefined))))).toEqual(['письмо']);
    });

    it('письма в тот же миг забрал check_inbox: wait_for не отвечает пустым message, а ждёт дальше', async () => {
      const client = await connect('s-01');
      await lettersFromBack(client);
      const stolen: { texts: string[] | null } = { texts: null };
      // В миг, когда ожидание решило, что письмо есть, параллельный check_inbox забирает его (один раз). Пауза перед новым
      // ожиданием — pollMs, поэтому он короткий.
      const { runner, listener } = runnerWithChanges(() => {
        if (stolen.texts !== null) return;
        stolen.texts = writeLetters(project, workId, (letters) => {
          const inbox = letters.unreadFor('s-01');
          letters.markRead('s-01', inbox.map((message) => message.id), new Date().toISOString());
          return inbox.map((message) => message.text);
        });
      }, 50);
      const waiting = runner.call('wait_for', { target: 'inbox', timeoutSec: 30 }, undefined);
      await subscribed(listener);
      await lettersFromBack(client, 'первое');
      listener()!();
      await vi.waitFor(() => expect(stolen.texts).toEqual(['первое']), { timeout: 2000, interval: 10 });

      // Ожидание продолжается с новой подпиской; ответ пришёл бы пустым message, если бы оно отвечало сразу.
      await subscribed(listener);
      await lettersFromBack(client, 'второе');
      listener()!();

      const body = JSON.parse(textOf(await waiting)) as Record<string, unknown>;
      expect(body['state']).toBe('message');
      expect(textsOf(body)).toEqual(['второе']);
    });
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

    await updateMap(project, workId, (map, letters) => {
      letters.add({ roomId: null, kind: 'note', from: 's-01', to: ['s-01'], text: 'проснись' });
    });
    expect((await pending)['state']).toBe('message');
    expect(await journalLines()).toEqual([started('inbox'), ended]);
  });

  it('таймаут по id сессии: Start с её id и End; строка — ровно один JSON с переводом строки', async () => {
    const client = await connect('s-01');
    await addHistoricalSession(client, { provider: 'claude', label: 'бэк', task: 'делать' });

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
    await addHistoricalSession(client, { provider: 'claude', label: 'бэк', task: 'делать' });
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
    await addHistoricalSession(client, { provider: 'claude', label: 'бэк', task: 'делать' });
    const pending = callOk(client, 'wait_for', { target: 's-02', timeoutSec: 20 });

    await linesAre(1);
    await updateMap(project, workId, (map, letters) => {
      removeSession(map, letters, 's-02');
    });

    expect(await pending).toEqual({ state: 'deleted', sessionId: 's-02' });
    expect(await journalLines()).toEqual([started('s-02'), ended]);
  });

  it('ожидание кончилось ошибкой (карта не собирается из базы): End всё равно записан', async () => {
    const client = await connect('s-01');
    await addHistoricalSession(client, { provider: 'claude', label: 'бэк', task: 'делать' });
    const pending = call(client, 'wait_for', { target: 's-02', timeoutSec: 20 });

    await linesAre(1);
    // Карта, которую `normalizeMap` не принимает: неизвестный режим комнаты (файла карты больше нет, портят строки базы).
    const broken = readStoredMap(project, workId);
    broken.rooms.push({ id: 'r-99', title: 'битая', creator: 'human', ownerId: null, members: [], createdAt: '2026-10-24T00:00:00.000Z', lead: null, proposal: null, archivedAt: null, mode: 'bogus' } as unknown as WorkMap['rooms'][number]);
    replaceStoredMap(project, workId, broken);

    expect((await pending).isError).toBe(true);
    expect(await journalLines()).toEqual([started('s-02'), ended]);
  });

  it('ответ без ожидания строк не пишет: итог уже есть, письмо уже пришло, id неизвестен', async () => {
    const client = await connect('s-01');
    await addHistoricalSession(client, { provider: 'claude', label: 'бэк', task: 'делать' });
    await updateMap(project, workId, (map, letters) => {
      setResult(map, 's-02', 'done');
      letters.add({ roomId: null, kind: 'note', from: 's-02', to: ['s-01'], text: 'готово' });
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
    await addHistoricalSession(client, { provider: 'claude', label: 'бэк', task: 'делать' });

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
    await addHistoricalSession(client, { provider: 'claude', label: 'бэк', task: 'делать' });
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
    await addHistoricalSession(client, { provider: 'claude', label: 'бэк', task: 'делать' });
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
    await addHistoricalSession(client, { provider: 'claude', label: 'бэк', task: 'делать' });

    expect(await callOk(client, 'wait_for', { target: 's-02', timeoutSec: 0.2 })).toEqual({
      state: 'running',
    });

    const pending = callOk(client, 'wait_for', { target: 'inbox', timeoutSec: 20 });
    await delay(60);
    await updateMap(project, workId, (map, letters) => {
      letters.add({ roomId: null, kind: 'note', from: 's-01', to: ['s-01'], text: 'проснись' });
    });
    expect((await pending)['state']).toBe('message');
  });

  it('каталог events ожидание не создаёт: без него хуков нет, и предупреждение хоста не заглушить', async () => {
    await rm(eventsDir(), { recursive: true, force: true });
    const client = await connect('s-01');
    await addHistoricalSession(client, { provider: 'claude', label: 'бэк', task: 'делать' });

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

    await updateMap(project, workId, (map, letters) => {
      letters.add({ roomId: null, kind: 'note', from: 's-01', to: ['s-01'], text: 'проснись' });
    });
    await pending;
    expect(await waitingFor()).toBeNull();
  });
});

describe('удалённая сессия (план от 2026-09-06, раздел C)', () => {
  it('27: wait_for на id из deletedSessions отвечает deleted сразу', async () => {
    const client = await connect('s-01');
    await addHistoricalSession(client, { provider: 'claude', label: 'бэк', task: 'делать' });
    await updateMap(project, workId, (map, letters) => {
      removeSession(map, letters, 's-02');
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
    await addHistoricalSession(client, { provider: 'claude', label: 'бэк', task: 'делать' });

    const pending = callOk(client, 'wait_for', { target: 's-02', timeoutSec: 20 });
    await delay(60);
    await updateMap(project, workId, (map, letters) => {
      removeSession(map, letters, 's-02');
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
    await addHistoricalSession(owner, { provider: 'claude', label: 'бэк', task: 'делать' });
    // Сервер сессии `s-02` ещё жив: SessionEnd приходит раньше выхода процесса.
    const orphan = await connect('s-02');
    await updateMap(project, workId, (map, letters) => {
      removeSession(map, letters, 's-02');
    });
    const before = await readMapFile();

    const calls = [
      call(orphan, 'report', { status: 'done', summary: 'успел' }),
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
    await addHistoricalSession(owner, { provider: 'claude', label: 'бэк', task: 'делать' });
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
    await addHistoricalSession(first, { provider: 'claude', label: 'бэк', task: 'делать' });
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

  it('при висящем wait_for письмо остаётся одно: wait_for отдаёт его и отмечает, звонок не дублируется, а сторож рядом жив', async () => {
    const rings: Ring[] = [];
    const first = await withChannel('s-01', rings);
    await addHistoricalSession(first, { provider: 'claude', label: 'бэк', task: 'делать' });
    const second = await connect('s-02');

    const waiting = callOk(first, 'wait_for', { target: 'inbox', timeoutSec: 5 });
    await delay(50);
    await callOk(second, 'send_message', { to: 's-01', text: 'привет' });

    const waited = await waiting;
    expect(waited['messages']).toHaveLength(1);
    // Звонок и wait_for просыпаются от одной записи: если wait_for забрал письмо раньше сторожа, звонить уже не о чем.
    await delay(150);
    expect(rings.length).toBeLessThanOrEqual(1);
    expect((await readMapFile()).messages).toHaveLength(1);
    expect((await callOk(first, 'check_inbox'))['messages']).toEqual([]);

    // Сторож жив рядом с wait_for: следующее письмо, которого никто не ждёт, звонит (счёт — с учётом того, что звонок про первое мог быть).
    const before = rings.length;
    await callOk(second, 'send_message', { to: 's-01', text: 'ещё одно' });
    await rung(rings, before + 1);
    expect(rings.at(-1)?.meta['from']).toBe('s-02');
  });

  it('без PARLEY_CHANNEL нет ни capability, ни instructions, ни звонка', async () => {
    const rings: Ring[] = [];
    const first = await connect('s-01', 40, DEFAULT_CONFIG.messageRate, false, rings);
    await addHistoricalSession(first, { provider: 'claude', label: 'бэк', task: 'делать' });
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
    await addHistoricalSession(plan, { provider: 'claude', label: 'бэк', task: 'делать' });
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

    const thread = threadOf(readStoredMap(project, workId), 's-02');
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
    // Письмо в карте одно, и wait_for его уже отметил: check_inbox после него пуст (4.3). Звонок мог прийти
    // раньше или не прийти вовсе — сторож и wait_for просыпаются от одной записи, — поэтому его не ждём.
    expect(texts(await callOk(plan, 'check_inbox'))).toEqual([]);

    await callOk(plan, 'send_message', {
      to: 's-02',
      text: 'миграции отдельным PR',
      kind: 'decision',
    });
    await rung(ringsB, 2);
    expect(texts(await callOk(back, 'check_inbox'))).toEqual(['миграции отдельным PR']);

    const map = readStoredMap(project, workId);
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

describe('source-qualified session roles', () => {
  it('lists safe current participant role metadata with no prompt or file paths', async () => {
    let observed = '';
    await updateMap(project, workId, map => { map.sessions[0]!.worktree = { path: '/participant/worktree', branch: 'b', base: 'main', createdAt: null }; });
    const catalog = buildRoleCatalog({ roles: [{ id: 'claude:exact', source: 'claude', provider: 'claude', name: 'exact', nativeAgent: 'exact', description: 'Native role', path: '/sensitive/role.md', readOnly: false }], diagnostics: [], partial: false });
    const client = await connect('s-01', 40, DEFAULT_CONFIG.messageRate, false, [], DEFAULT_CONFIG.worktreeRoot, async cwd => { observed = cwd; return catalog; });
    const result = await callOk(client, 'list_roles');
    expect(observed).toBe('/participant/worktree');
    expect(result).toHaveProperty('roles');
    expect(JSON.stringify(result)).not.toContain('/sensitive'); expect(JSON.stringify(result)).not.toContain('prompt');
  });
});



describe('trusted caller backlog MCP tools', () => {
  beforeEach(() => { process.env.PATH = savedPath ?? ''; });
  it('reads without writes and cannot redirect project/work/session through tool parameters', async () => {
    const client = await connect('s-01');
    const before = await readMapFile();
    const listed = await callOk(client, 'backlog_list');
    expect(listed.items).toEqual([]); expect(listed.rule).toBe('problems');
    expect(await readMapFile()).toEqual(before);
    expect(await readFile(path.join(project, '.parley', 'backlog.md')).catch(() => null)).toBeNull();
    for (const name of ['backlog_list', 'backlog_suggest']) {
      const response = await call(client, name, { projectPath: '/private/secret', workId: 'w-99', sessionId: 's-99', kind: 'bug', title: 'Spoof', why: 'Reason' });
      expect(response.isError).toBe(true); expect(response.text).not.toContain('/private/secret');
    }
    expect(await readBacklog(project)).toMatchObject({ items: [] });
  });
  it('applies project rules, binds the author, deduplicates only open/pending titles, and adds one room feed notice', async () => {
    await updateMap(project, workId, map => { addRoom(map, { title: 'Backlog room', creator: 's-01', members: ['s-01'] }); });
    const client = await connect('s-01');
    const added = await callOk(client, 'backlog_suggest', { kind: 'bug', title: 'Observed regression', details: 'Reproduction', why: 'Evidence' });
    expect(added.message).toBe('added: b-001');
    expect((await readBacklog(project)).items[0]).toMatchObject({ by: 's-01', title: 'Observed regression' });
    const duplicate = await callOk(client, 'backlog_suggest', { kind: 'bug', title: 'OBSERVED REGRESSION', why: 'Again' });
    expect(duplicate.message).toBe('already in backlog: b-001');
    const notices = readStoredMap(project, workId).messages.filter(row => row.text.includes('added to the backlog'));
    expect(notices).toHaveLength(1); expect(notices[0]).toMatchObject({ from: 'system', text: 'S01 added to the backlog: Observed regression' });
    const proposed = await callOk(client, 'backlog_suggest', { kind: 'idea', title: 'New feature', why: 'Useful later' });
    expect(proposed.message).toBe('suggested: sg-02');
    expect((await listBacklogSuggestions(project))[0]).toMatchObject({ workId, sessionId: 's-01', title: 'New feature' });
    expect((await readBacklog(project)).items).toHaveLength(1);
    await setBacklogRule(project, 'ask');
    expect((await callOk(client, 'backlog_suggest', { kind: 'debt', title: 'Missing test', why: 'Observed' })).message).toBe('suggested: sg-03');
    await setBacklogRule(project, 'everything');
    expect((await callOk(client, 'backlog_suggest', { kind: 'idea', title: 'Later feature', why: 'Useful' })).message).toBe('added: b-002');
  });
  it('supports bounded status/text reads while exposing no manual mutation tool', async () => {
    await addBacklogItem(project, { title: 'Human item', details: 'Needle detail' });
    const client = await connect('s-01');
    expect((await callOk(client, 'backlog_list', { filter: 'open', text: 'needle' })).items).toHaveLength(1);
    expect((await callOk(client, 'backlog_list', { filter: 'done' })).items).toEqual([]);
    const names = (await client.listTools()).tools.map(row => row.name);
    expect(names.filter(name => name.startsWith('backlog'))).toEqual(['backlog_list', 'backlog_suggest']);
    for (const args of [{ filter: 'private' }, { text: 'x'.repeat(4097) }, { text: '\0' }, { taken: 'w-01/r-01' }])
      expect((await call(client, 'backlog_list', args)).isError).toBe(true);
    expect((await readBacklog(project)).items[0]).toMatchObject({ checked: false });
  });
  it('unknown/closed callers and malformed local data fail with safe fixed errors', async () => {
    const unknown = await connect('s-99');
    const failed = await call(unknown, 'backlog_suggest', { kind: 'bug', title: 'No author', why: 'Reason' });
    expect(failed.isError).toBe(true); expect((await readBacklog(project)).items).toEqual([]);
    await updateMap(project, workId, map => { map.sessions.find(row => row.id === 's-01')!.lifecycle = 'closed'; });
    const closed = await connect('s-01'); expect((await call(closed, 'backlog_suggest', { kind: 'bug', title: 'Closed', why: 'Reason' })).isError).toBe(true);
    const noSession = await connect(null); expect((await call(noSession, 'backlog_list')).isError).toBe(true);
    await writeFile(path.join(project, '.parley', 'preferences.json'), 'secret native parser input');
    const response = await call(closed, 'backlog_list'); expect(response.isError).toBe(true); expect(response.text).not.toContain('secret');
    expect(response.text).toContain('preferences-invalid');
  });
});

describe('memory and history MCP tools', () => {
  beforeEach(() => { process.env.PATH = savedPath ?? ''; });
  const FACT = 'PTY tests flake in worktrees with long paths';
  /** Системная вставка, с которой стартует новая сессия claude. */
  async function newSessionPrompt(client: Client): Promise<string> {
    const id = `s-0${(await readMapFile()).sessions.length + 1}`;
    await addHistoricalSession(client, { provider: 'claude', label: 'Fresh', task: 'Check the memory' });
    const plan = await planLaunch(project, workId, session(await readMapFile(), id));
    return plan.args[plan.args.indexOf('--append-system-prompt') + 1] ?? '';
  }
  it('обычный remember ждёт человека: файла памяти нет, в комнате строка-предложение, повтор не принимается', async () => {
    await updateMap(project, workId, map => { addRoom(map, { title: 'Memory room', creator: 's-01', members: ['s-01'] }); });
    const client = await connect('s-01');
    const first = await callOk(client, 'remember', { kind: 'lesson', fact: FACT, details: 'Compare with a baseline run.', why: 'Seen twice' });
    expect(first.message).toBe('suggested: ms-01');
    expect(await readFile(path.join(project, '.parley', 'memory.md')).catch(() => null)).toBeNull();
    expect(await listMemorySuggestions(project)).toMatchObject([{ id: 'ms-01', kind: 'lesson', fact: FACT, why: 'Seen twice' }]);
    expect((await callOk(client, 'remember', { kind: 'lesson', fact: FACT.toUpperCase(), why: 'Again' })).message).toBe('already remembered: ms-01');
    const notices = readStoredMap(project, workId).messages.filter(row => row.text.includes('remembering'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ from: 'system', text: `S01 suggests remembering: ${FACT}` });
    expect(await listUndoableMemory(project)).toEqual([]);
  });
  it('принятый урок виден новой сессии с первого хода', async () => {
    const client = await connect('s-01');
    await callOk(client, 'remember', { kind: 'lesson', fact: FACT, why: 'Seen twice' });
    expect(await newSessionPrompt(client)).not.toContain(FACT);
    expect((await acceptMemorySuggestion(project, 'ms-01')).status).toBe('remembered');
    const prompt = await newSessionPrompt(client);
    expect(prompt).toContain('Project memory (.parley/memory.md):');
    expect(prompt).toContain(FACT);
  });
  it('remember по просьбе человека пишет сразу с пометкой, строка в комнате честная, Undo убирает запись', async () => {
    await updateMap(project, workId, map => { addRoom(map, { title: 'Memory room', creator: 's-01', members: ['s-01'] }); });
    const client = await connect('s-01');
    const done = await callOk(client, 'remember', { kind: 'agreement', fact: 'Sessions close only with consent', why: 'The human said so', onHumanRequest: true });
    expect(done.message).toBe('remembered: m-001');
    const file = await readFile(path.join(project, '.parley', 'memory.md'), 'utf8');
    expect(file).toContain('Sessions close only with consent');
    expect(file).toContain('on request');
    expect(readStoredMap(project, workId).messages.at(-1)).toMatchObject({ from: 'system', text: 'S01 remembered, saying you asked for it: Sessions close only with consent' });
    expect(await newSessionPrompt(client)).toContain('Sessions close only with consent');
    const [undoable] = await listUndoableMemory(project);
    expect(undoable).toMatchObject({ memoryId: 'm-001', fact: 'Sessions close only with consent', sessionId: 's-01' });
    expect((await undoProjectMemory(project, undoable!.operationId)).status).toBe('undone');
    expect(await listUndoableMemory(project)).toEqual([]);
    expect(await readFile(path.join(project, '.parley', 'memory.md'), 'utf8')).not.toContain('Sessions close only with consent');
    expect(await newSessionPrompt(client)).not.toContain('Sessions close only with consent');
  });
  it('memory_read отдаёт подробности, фильтрует по ids и не пишет файлов', async () => {
    const client = await connect('s-01');
    await callOk(client, 'remember', { kind: 'fact', fact: 'Build with pnpm', details: 'Use pnpm build, not npm.', why: 'Asked', onHumanRequest: true });
    await callOk(client, 'remember', { kind: 'lesson', fact: 'Second fact', why: 'Asked', onHumanRequest: true });
    const all = await callOk(client, 'memory_read');
    expect(all.total).toBe(2);
    expect((all.items as { id: string; details: string; by: string; onRequest?: true }[])[0]).toMatchObject({ id: 'm-001', details: 'Use pnpm build, not npm.', by: 's-01', onRequest: true });
    const one = await callOk(client, 'memory_read', { ids: ['m-002'] });
    expect((one.items as { fact: string }[]).map(row => row.fact)).toEqual(['Second fact']);
    for (const args of [{ ids: ['x-1'] }, { ids: 'm-001' }, { ids: Array.from({ length: 101 }, () => 'm-001') }, { projectPath: '/private/secret' }])
      expect((await call(client, 'memory_read', args)).isError).toBe(true);
  });
  it('search_history находит урок и пункт бэклога, пустой результат — подсказка, скиллы не читаются', async () => {
    await addBacklogItem(project, { title: 'Flaky pty harness', details: 'Needs a baseline' });
    await mkdir(path.join(project, '.claude', 'skills', 'pty'), { recursive: true });
    await writeFile(path.join(project, '.claude', 'skills', 'pty', 'SKILL.md'), '# pty flake skill\nSKILLBODYNEEDLE');
    const client = await connect('s-01');
    await callOk(client, 'remember', { kind: 'lesson', fact: FACT, why: 'Seen twice', onHumanRequest: true });
    const found = await callOk(client, 'search_history', { query: 'pty flake' });
    const sources = (found.hits as { source: string }[]).map(row => row.source);
    expect(sources).toContain('memory');
    expect((await callOk(client, 'search_history', { query: 'pty', scope: 'backlog' })).total).toBe(1);
    expect((await callOk(client, 'search_history', { query: 'pty', limit: 1 })).hits).toHaveLength(1);
    const none = await callOk(client, 'search_history', { query: 'SKILLBODYNEEDLE' });
    expect(none.total).toBe(0); expect(none.message).toMatch(/Nothing found/);
  });
  it('search_history и remember отвергают чужие поля и неверные значения фиксированными ошибками', async () => {
    const client = await connect('s-01');
    for (const args of [{ query: '' }, { query: 'x', scope: 'skills' }, { query: 'x', limit: 31 }, { query: 'x', limit: 1.5 }, { query: 5 }, { query: 'x', sessionId: 's-99' }])
      expect((await call(client, 'search_history', args)).isError, JSON.stringify(args)).toBe(true);
    for (const args of [{ kind: 'note', fact: 'x', why: 'y' }, { kind: 'fact', fact: 'a\nb', why: 'y' }, { kind: 'fact', fact: 'x', why: 'y', onHumanRequest: 'yes' },
      { kind: 'fact', fact: 'x', why: 'y', workId: 'w-99' }, { kind: 'fact', fact: 'x' }]) {
      const response = await call(client, 'remember', args);
      expect(response.isError, JSON.stringify(args)).toBe(true); expect(response.text).not.toContain('w-99');
    }
    expect(await listMemorySuggestions(project)).toEqual([]);
  });
  it('без сессии, с неизвестной или закрытой сессией — отказ; закрытая читает, но не пишет', async () => {
    expect((await call(await connect(null), 'memory_read')).isError).toBe(true);
    expect((await call(await connect(null), 'search_history', { query: 'x' })).isError).toBe(true);
    expect((await call(await connect('s-99'), 'remember', { kind: 'fact', fact: 'x', why: 'y' })).isError).toBe(true);
    await updateMap(project, workId, map => { map.sessions.find(row => row.id === 's-01')!.lifecycle = 'closed'; });
    const closed = await connect('s-01');
    expect((await call(closed, 'remember', { kind: 'fact', fact: 'x', why: 'y' })).isError).toBe(true);
    expect((await call(closed, 'memory_read')).isError).toBe(false);
  });
  it('ошибка памяти (маркеры конфликта) — безопасный отказ без текста файла', async () => {
    await mkdir(path.join(project, '.parley'), { recursive: true });
    await writeFile(path.join(project, '.parley', 'memory.md'), '# Project memory\n\n## Facts\n<<<<<<< ours\nsecret text\n');
    const client = await connect('s-01');
    const response = await call(client, 'memory_read');
    expect(response.isError).toBe(true); expect(response.text).toContain('memory-merge-conflict'); expect(response.text).not.toContain('secret');
  });
});

describe('архивная комната в MCP (архив комнат, 3.3, 3.4, 3.6)', () => {
  beforeEach(() => { process.env.PATH = savedPath ?? ''; });
  const AT = '2026-10-08T12:00:00.000Z';
  const REFUSAL = 'room r-01 is archived: only the human can reopen it';

  /**
   * Комната r-01 «архив» в архиве: s-01 — создатель и ведущий, s-02 — участник; s-03 вне её и ведёт открытую r-02.
   * До архивации s-02 написал всей комнате «до архива».
   */
  async function setup(): Promise<{ lead: Client; member: Client; outsider: Client }> {
    await updateMap(project, workId, (current, letters) => {
      addSession(current, { provider: 'claude', label: 'бэк', task: 'делать' });
      addSession(current, { provider: 'claude', label: 'ревью', task: 'делать' });
      addRoom(current, { title: 'архив', creator: 's-01', members: ['s-01', 's-02'], lead: 's-01' });
      addRoom(current, { title: 'открытая', creator: 's-03', members: ['s-03'] });
      letters.add({ kind: 'note', from: 's-02', to: [], roomId: 'r-01', text: 'до архива' });
      archiveRoom(current, letters, 'r-01', AT);
    });
    return { lead: await connect('s-01'), member: await connect('s-02'), outsider: await connect('s-03') };
  }

  /** Версия строки работы: после отказа она не сдвинулась — карту не записывали. */
  const rawMap = (): number | undefined => workVersion(project, workId);

  it('send_message и add_to_room в архивную комнату отказывают текстом из спеки, карта не меняется', async () => {
    const { lead, member } = await setup();
    const before = await rawMap();

    for (const refused of [
      await call(lead, 'send_message', { room: 'r-01', text: 'поздно' }),
      await call(member, 'send_message', { room: 'r-01', to: 's-01', text: 'поздно' }),
      await call(lead, 'add_to_room', { room: 'r-01', session: 's-03' }),
    ]) {
      expect(refused).toEqual({ isError: true, text: REFUSAL });
    }
    expect(await rawMap()).toBe(before);
  });

  it('инструменты решения и режима отказывают тем же текстом', async () => {
    const { lead } = await setup();
    const before = await rawMap();

    expect(await call(lead, 'propose_decision', { room: 'r-01', text: 'решение' })).toEqual({ isError: true, text: REFUSAL });
    expect(await call(lead, 'set_room_mode', { room: 'r-01', mode: 'checklist', reason: 'пробуем' })).toEqual({ isError: true, text: REFUSAL });
    expect(await rawMap()).toBe(before);
  });

  it('открытая комната рядом работает как прежде', async () => {
    const { outsider } = await setup();
    const sent = await call(outsider, 'send_message', { room: 'r-02', text: 'живая' });
    expect(sent.isError, sent.text).toBe(false);
  });

  it('чтение остаётся: read_room, get_map {room}, страницы писем; письма архивной комнаты не непрочитаны и не будят', async () => {
    const { lead, member } = await setup();

    const read = await callOk(member, 'read_room', { room: 'r-01' });
    expect((read['messages'] as { text: string }[]).map((m) => m.text)).toEqual(['до архива', 'Room archived by the human.']);

    const detail = await callOk(lead, 'get_map', { room: 'r-01' });
    expect(detail['room']).toMatchObject({ id: 'r-01', archivedAt: AT });
    expect(detail['messages']).toMatchObject({ total: 2 });

    const page = await callOk(lead, 'get_map', { field: 'messages', room: 'r-01' });
    expect((page['messages'] as { text: string }[]).map((m) => m.text)).toEqual(['до архива', 'Room archived by the human.']);

    // «до архива» было рассылкой комнаты: до архивации оно ждало s-01, после — нет.
    expect(await callOk(lead, 'check_inbox')).toEqual({ messages: [] });
  });

  it('get_map: archived: true только у архивной комнаты', async () => {
    const { lead } = await setup();
    const rooms = ((await callOk(lead, 'get_map'))['map'] as { rooms: { id: string; archived?: boolean }[] }).rooms;

    expect(rooms.find((room) => room.id === 'r-01')?.archived).toBe(true);
    expect(rooms.find((room) => room.id === 'r-02')).not.toHaveProperty('archived');
  });

  it('backlog_suggest и remember не пишут строку в ленту архивной комнаты', async () => {
    const { member } = await setup();
    const before = readStoredMap(project, workId).messages.length;

    expect((await callOk(member, 'backlog_suggest', { kind: 'bug', title: 'Observed regression', why: 'Evidence' })).message).toBe('added: b-001');
    expect((await callOk(member, 'remember', { kind: 'lesson', fact: 'PTY tests flake in worktrees', why: 'Seen twice' })).message).toBe('suggested: ms-01');

    const after = readStoredMap(project, workId);
    expect(after.messages).toHaveLength(before);
    expect(after.messages.filter((m) => m.roomId === 'r-01' && m.from === 'system').map((m) => m.text)).toEqual(['Room archived by the human.']);
  });
});

describe('owner private message visibility', () => {
  it('denies worker private mail in lists and lookups but retains own and owned-room messages', async () => {
    let privateId = '';
    let ownId = '';
    let roomMessageId = '';
    await updateMap(project, workId, (map, letters) => {
      addSession(map, { provider: 'claude', label: 'worker', task: 'work' });
      addSession(map, { provider: 'claude', label: 'reviewer', task: 'review' });
      const room = addRoom(map, { creator: 's-01', ownerId: 's-01', title: 'owned', members: ['s-02', 's-03'], lead: 's-02' });
      privateId = letters.add({ roomId: null, from: 's-02', to: ['s-03'], text: 'private worker mail', kind: 'decision' }).id;
      ownId = letters.add({ roomId: null, from: 's-02', to: ['s-01'], text: 'direct owner mail', kind: 'note' }).id;
      roomMessageId = letters.add({ from: 's-02', to: [], roomId: room.id, text: 'room mail', kind: 'note' }).id;
    });
    const owner = await connect('s-01');
    const page = await callOk(owner, 'get_map', { field: 'messages' });
    expect((page.messages as { id: string }[]).map((message) => message.id)).toEqual([ownId]);
    const roomPage = await callOk(owner, 'get_map', { field: 'messages', room: 'r-01' });
    expect((roomPage.messages as { id: string }[]).map((message) => message.id)).toEqual([roomMessageId]);
    expect((await call(owner, 'get_map', { field: 'message', id: privateId })).isError).toBe(true);
    expect((await callOk(owner, 'get_map', { field: 'message', id: ownId })).id).toBe(ownId);
    expect((await callOk(owner, 'get_map', { field: 'message', id: roomMessageId })).id).toBe(roomMessageId);
    expect((await callOk(owner, 'read_room', { room: 'r-01' })).messages).toHaveLength(1);
  });
});

describe('застрявшая сессия: get_map, wait_for и send_message (спека застрявших 5.3)', () => {
  const need = (over: Partial<SessionNeed> = {}): SessionNeed => ({
    kind: 'approval',
    since: '2026-10-21T14:02:00.000Z',
    detail: 'npm install',
    resetsAt: null,
    window: null,
    account: null,
    ...over,
  });
  const setStuck = (id: string, value: SessionNeed | null): Promise<unknown> =>
    updateMap(project, workId, (map) => {
      session(map, id).stuck = value;
    });
  const HINT_APPROVAL =
    '@s02 waits for the human (waiting for approval). Do not wait_for it again: end your turn or wait_for("inbox") — Parley writes to you when it is back.';

  /** s-01 ведёт комнату r-01, в ней s-02 и s-03. */
  async function stuckSetup(): Promise<Client> {
    const lead = await connect('s-01');
    await addHistoricalSession(lead, { provider: 'codex', label: 'бэк', task: 'делать' }); // s-02
    await addHistoricalSession(lead, { provider: 'claude', label: 'ревью', task: 'делать' }); // s-03
    await callOk(lead, 'create_room', { title: 'комната', members: ['s-01', 's-02', 's-03'], lead: 's-01' }); // r-01
    return lead;
  }

  it('get_map: stuck у сессии из карты, а у сессий без поля — null', async () => {
    const lead = await stuckSetup();
    await setStuck('s-02', need());

    const { sessions } = (await callOk(lead, 'get_map'))['map'] as {
      sessions: { id: string; stuck: SessionNeed['kind'] | null }[];
    };

    expect(sessions.find((item) => item.id === 's-02')?.stuck).toBe(need().kind);
    const detail = await callOk(lead, 'get_map', { session: 's-02' });
    expect((detail['session'] as { stuck: SessionNeed }).stuck).toEqual(need());
    expect(sessions.find((item) => item.id === 's-03')?.stuck).toBeNull();
  });

  it('wait_for на застрявшую сессию отвечает сразу: state stuck, потребность и подсказка не ждать снова', async () => {
    const lead = await stuckSetup();
    await setStuck('s-02', need());

    const started = Date.now();
    const answer = await callOk(lead, 'wait_for', { target: 's-02', timeoutSec: 30 });

    expect(Date.now() - started).toBeLessThan(5000);
    expect(answer).toEqual({ state: 'stuck', sessionId: 's-02', stuck: need(), hint: HINT_APPROVAL });
  });

  it('wait_for: причина лимита называет время сброса по местным часам', async () => {
    const lead = await stuckSetup();
    const resetsAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
    await setStuck('s-02', need({ kind: 'limit', detail: null, resetsAt, window: 'session' }));

    const answer = await callOk(lead, 'wait_for', { target: 's-02', timeoutSec: 30 });

    expect(answer['hint']).toMatch(/^@s02 waits for the human \(usage limit until (?:[A-Z][a-z]{2} \d{1,2}, )?\d{2}:\d{2} local time\)\. /);
  });

  it('итог важнее stuck: у сессии есть result — прежний ответ без stuck и hint', async () => {
    const lead = await stuckSetup();
    await updateMap(project, workId, (map) => {
      session(map, 's-02').stuck = need();
      session(map, 's-02').summary = 'сделано';
      setResult(map, 's-02', 'done');
    });

    expect(await callOk(lead, 'wait_for', { target: 's-02', timeoutSec: 5 })).toEqual({
      state: 'done',
      sessionId: 's-02',
      summary: 'сделано',
      artifacts: [],
    });
  });

  it('stuck: null — сессия ещё работает, wait_for по таймауту отвечает running', async () => {
    const lead = await stuckSetup();
    await setStuck('s-02', null);

    expect(await callOk(lead, 'wait_for', { target: 's-02', timeoutSec: 0.2 })).toEqual({ state: 'running' });
  });

  it('висящий wait_for просыпается, когда хост записал stuck', async () => {
    const lead = await stuckSetup();

    const pending = callOk(lead, 'wait_for', { target: 's-02', timeoutSec: 20 });
    await delay(60);
    await setStuck('s-02', need());

    expect(await pending).toEqual({ state: 'stuck', sessionId: 's-02', stuck: need(), hint: HINT_APPROVAL });
  });

  it('описания wait_for и send_message говорят про stuck', async () => {
    const lead = await stuckSetup();
    const { tools } = await lead.listTools();
    const description = (name: string): string => tools.find((tool) => tool.name === name)?.description ?? '';

    expect(description('wait_for')).toContain(
      '{"state":"stuck"}: that session waits for the human or its usage limit — do not wait for it again, Parley writes when it is back.',
    );
    expect(description('send_message')).toContain('stuck');
  });

  it('send_message в комнату: застрявший адресат даёт warning, письмо записано', async () => {
    const lead = await stuckSetup();
    await setStuck('s-02', need());

    const sent = await callOk(lead, 'send_message', { room: 'r-01', text: 'Как дела?' });

    expect(sent['warning']).toBe('@s02 is stuck (waiting for approval): it reads this when it is back');
    const stored = (await readMapFile()).messages.find((message) => message.id === sent['messageId']);
    expect(stored).toMatchObject({ roomId: 'r-01', text: 'Как дела?' });
  });

  it('несколько застрявших адресатов — предупреждения через «; »; прямое письмо тоже предупреждает', async () => {
    const lead = await stuckSetup();
    await setStuck('s-02', need());
    await setStuck('s-03', need({ kind: 'sign-in', account: 'auth', detail: null }));

    const broadcast = await callOk(lead, 'send_message', { room: 'r-01', text: 'Всем' });
    expect(broadcast['warning']).toBe(
      '@s02 is stuck (waiting for approval): it reads this when it is back; @s03 is stuck (signed out): it reads this when it is back',
    );

    const direct = await callOk(lead, 'send_message', { to: 's-03', text: 'Лично' });
    expect(direct['warning']).toBe('@s03 is stuck (signed out): it reads this when it is back');
  });

  it('явный адресат: предупреждает только о нём, не о других участниках комнаты', async () => {
    const lead = await stuckSetup();
    await setStuck('s-02', need());

    const toOther = await callOk(lead, 'send_message', { room: 'r-01', to: ['s-03'], text: 'Тебе' });
    expect(toOther).not.toHaveProperty('warning');

    const toStuck = await callOk(lead, 'send_message', { room: 'r-01', to: ['s-02'], text: 'Тебе' });
    expect(toStuck['warning']).toBe('@s02 is stuck (waiting for approval): it reads this when it is back');
  });

  it('без застрявших ответ прежний — один messageId', async () => {
    const lead = await stuckSetup();

    expect(await callOk(lead, 'send_message', { room: 'r-01', text: 'Всем' })).toEqual({ messageId: expect.any(String) });
  });

  it('stuck вместе с незнакомым полем: оба предупреждения через «; »', async () => {
    const lead = await stuckSetup();
    await setStuck('s-02', need());

    const sent = await callOk(lead, 'send_message', { room: 'r-01', text: 'Всем', reply_to: 'm-01' });

    expect(sent['warning']).toBe(
      'unknown parameters ignored: reply_to (did you mean replyTo?); @s02 is stuck (waiting for approval): it reads this when it is back',
    );
  });
});

describe('createToolRunner: инструменты Parley без транспорта (спека хранилища 6.9)', () => {
  /** Текст первого блока ответа: ответы инструментов — один текстовый блок. */
  const textOf = (result: Awaited<ReturnType<ToolRunner['call']>>): string => (result.content[0] as { text: string }).text;

  it('исполнитель без сервера: в list нет браузера и create_session, call пишет письмо как MCP', async () => {
    await updateMap(project, workId, (map) => { addSession(map, { provider: 'claude', label: 'ревью', task: 't' }); });
    const runner = createToolRunner({ projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false, messageRate: DEFAULT_CONFIG.messageRate });
    const names = (await runner.list()).map((tool) => tool.name);
    expect(names).toContain('send_message');
    expect(names).not.toContain('create_session');
    expect(names.some((name) => name.startsWith('browser_'))).toBe(false);
    const sent = await runner.call('send_message', { to: 's-02', text: 'привет' }, undefined);
    expect(sent.isError).not.toBe(true);
    expect(readStoredMap(project, workId).messages.at(-1)).toMatchObject({ from: 's-01', to: ['s-02'], text: 'привет' });
  });

  it('get_map берёт строки провайдеров из context.providerRows — без запроса к хосту и без пометки', async () => {
    const row = { id: 'claude', label: 'Claude', family: 'claude' as const, available: true, needs: null, models: null, effort: false, limits: null };
    const runner = createToolRunner({ projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false, messageRate: DEFAULT_CONFIG.messageRate, providerRows: async () => [row] });
    const body = JSON.parse(textOf(await runner.call('get_map', { field: 'providers' }, undefined)));
    expect(body.providers).toEqual([{ id: 'claude', label: 'Claude', family: 'claude', available: true, models: null, effort: false }]);
    expect(body.note).toBeUndefined();
  });

  it('wait_for inbox просыпается от context.mapChanges', async () => {
    await updateMap(project, workId, (map) => { addSession(map, { provider: 'claude', label: 'ревью', task: 't' }); });
    let listener = null as (() => void) | null;
    const runner = createToolRunner({ projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false, messageRate: DEFAULT_CONFIG.messageRate, pollMs: 60_000,
      mapChanges: (onChange) => { listener = onChange; return () => { listener = null; }; } });
    const waiting = runner.call('wait_for', { target: 'inbox', timeoutSec: 30 }, undefined);
    // Подписка заводится после первой пробы: ждём её, а не гадаем по времени — под нагрузкой пятидесяти миллисекунд мало.
    await vi.waitFor(() => expect(listener).not.toBeNull(), { timeout: 2000, interval: 10 });
    await updateMap(project, workId, (map, letters) => { letters.add({ roomId: null, kind: 'note', from: 's-02', to: ['s-01'], text: 'есть' }); });
    listener!();
    const body = JSON.parse(textOf(await waiting));
    expect(body.state).toBe('message');
  });

  describe('сервер с явным исполнителем', () => {
    /** Подставной исполнитель: что звал сервер, остаётся в `seen`; собственных инструментов у сервера в списке нет. */
    const seen: { name: string; args: Record<string, unknown>; meta: Record<string, unknown> | undefined; signal: AbortSignal | undefined }[] = [];
    const stub: ToolRunner = {
      list: async () => [{ name: 'stub_tool', description: 'подставной', inputSchema: { type: 'object' } }],
      call: async (name, args, meta, signal) => {
        seen.push({ name, args, meta, signal });
        return { content: [{ type: 'text', text: 'готово' }] };
      },
    };
    beforeEach(() => { seen.length = 0; });

    async function connectStub(context: McpContext, rings: Ring[] = []): Promise<Client> {
      const server = createParleyServer(context, stub);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test', version: '0.0.0' });
      client.fallbackNotificationHandler = async (notification) => {
        if (notification.method === 'notifications/claude/channel') rings.push(notification.params as unknown as Ring);
      };
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      opened.push({ client, server });
      return client;
    }

    it('list и call идут через него, с _meta и сигналом отмены; браузер и create_session остаются за сервером', async () => {
      const agent: AgentChannel = { url: 'http://127.0.0.1:1/agent/browser', token: 'a'.repeat(64) };
      const client = await connectStub({ projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false, agent });

      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names[0]).toBe('stub_tool');
      expect(names).toContain('create_session');
      expect(names.some((name) => name.startsWith('browser_'))).toBe(true);
      // Своих инструментов у сервера нет: всё остальное — от исполнителя.
      expect(names).not.toContain('get_map');

      const result = await client.callTool({ name: 'stub_tool', arguments: { n: 1 }, _meta: { threadId: 'T' } });
      expect(result.content).toEqual([{ type: 'text', text: 'готово' }]);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ name: 'stub_tool', args: { n: 1 }, meta: { threadId: 'T' } });
      expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
    });

    it('сторож входящих не запускается: карту такой сервер не читает, звонка нет', async () => {
      await updateMap(project, workId, (map, letters) => {
        addSession(map, { provider: 'claude', label: 'бэк', task: 'делать' });
        letters.add({ roomId: null, kind: 'note', from: 's-02', to: ['s-01'], text: 'привет' });
      });
      const rings: Ring[] = [];
      await connectStub({ projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: true, pollMs: 40 }, rings);

      await delay(200);
      expect(rings).toHaveLength(0);
    });

    it('с исполнителем сервер не объявляет claude/channel и его instructions даже при channel: true — звонить некому', async () => {
      const client = await connectStub({ projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: true });

      expect(client.getServerCapabilities()?.experimental).toBeUndefined();
      expect(client.getInstructions()).toBeUndefined();
    });
  });
});
