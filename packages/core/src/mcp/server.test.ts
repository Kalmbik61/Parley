import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
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
  await git(project, ['config', 'user.email', 'тест@harnas']);
  await git(project, ['config', 'user.name', 'тест']);
  await writeFile(path.join(project, 'README.md'), 'старт\n', 'utf8');
  await git(project, ['add', 'README.md']);
  await git(project, ['commit', '-m', 'первый']);
}

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
  it('ровно одиннадцать инструментов спецификации', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
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

  it('propose_decision: room и text обязательны, описание — про ведущего, ожидание человека и повтор', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const propose = tools.find((tool) => tool.name === 'propose_decision');

    expect(propose?.inputSchema.required).toEqual(['room', 'text']);
    expect(Object.keys(propose?.inputSchema.properties ?? {}).sort()).toEqual(['room', 'text']);
    // Тон соседних описаний: только ведущий, решение ждёт человека, повтор заменяет, ответ — письмом.
    expect(propose?.description).toMatch(/только ведущий/i);
    expect(propose?.description).toMatch(/ждёт (ответа )?человека/);
    expect(propose?.description).toMatch(/заменя/);
    expect(propose?.description).toMatch(/письм/);
    // Предел текста в схеме — та же константа, что держит setProposal.
    const textSchema = propose?.inputSchema.properties?.['text'] as { description?: string } | undefined;
    expect(textSchema?.description).toContain(String(PROPOSAL_TEXT_MAX));
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
    expect(createRoom?.description).toMatch(/ведущ/);
  });

  it('описание get_map отсылает ко второму слою гида', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const getMap = tools.find((tool) => tool.name === 'get_map');

    expect(getMap?.description).toMatch(/подробный гид — инструмент read_guide$/);
  });

  it('ни в одном описании нет устаревшего текста «pending запускает человек»', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.description ?? '').not.toContain('pending запускает человек');
    }
  });

  it('report и close_session говорят, что done не закрывает сессию, а close_session — только с согласия', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const report = tools.find((tool) => tool.name === 'report');
    const closeSession = tools.find((tool) => tool.name === 'close_session');

    expect(report?.description).toMatch(/остаётся на связи/);
    expect(closeSession?.description).toMatch(/только после явного согласия/);
  });

  it('wait_for предупреждает: сдавшей report сессии — ждать через inbox, не по id', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const waitFor = tools.find((tool) => tool.name === 'wait_for');

    expect(waitFor?.description).toMatch(/"inbox"[\s\S]*не по id/);
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
      call(client, 'create_room', { title: 'x', members: ['s-01'] }),
      call(client, 'read_room', { room: 'r-01' }),
      call(client, 'propose_decision', { room: 'r-01', text: 'решение' }),
      call(client, 'close_session', { target: 's-01' }),
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

  it('после close_session — ошибка любым статусом, резюме не меняется', async () => {
    const client = await connect('s-01');
    await callOk(client, 'close_session', { target: 's-01' });

    const progress = await call(client, 'report', { status: 'progress', summary: 'x' });
    expect(progress.isError).toBe(true);
    expect(progress.text).toContain('закрыта');

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
    expect(result.text).toContain('в проекте нет git');
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
    expect(stored.worktree?.branch).toBe(`harnas/${workId}/s-02`);
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
    expect(result.text).toContain('закрыта');
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
      'Вас добавили в r-01 «бэкенд» с S02 и S03',
    ]);

    const third = await connect('s-03');
    const inboxThird = await callOk(third, 'check_inbox');
    expect((inboxThird['messages'] as { text: string }[]).map((m) => m.text)).toEqual([
      'Вас добавили в r-01 «бэкенд» с S02 и S03',
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
    await callOk(client, 'create_room', { title: 'бэкенд', members: ['s-02', 's-03'], lead: 's-03' });

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
      const refused = await call(client, 'create_room', { title: 'бэкенд', members: ['s-02'], lead });
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
    const result = await callOk(lead, 'propose_decision', { room: 'r-01', text: 'Делаем через очередь.' });

    expect(result).toEqual({ proposalId: 'p-01', rev: 0 });
    const proposal = (await readMapFile()).rooms[0]?.proposal;
    expect(proposal).toMatchObject({ id: 'p-01', from: 's-01', text: 'Делаем через очередь.', rev: 0 });
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
    expect(refused.text).toMatch(/не ведущий/);
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
    expect(refused.text).toMatch(/закрыта/);
    expect(await rawMap()).toBe(before);
  });

  it('ведущий — живой ведущий: ушёл назначенный — решение приносит первый живой участник', async () => {
    const { lead, a, b } = await leadRoom();
    await callOk(lead, 'close_session', { target: 's-01' });

    expect((await call(lead, 'propose_decision', { room: 'r-01', text: 'из могилы' })).isError).toBe(true);
    expect((await call(b, 'propose_decision', { room: 'r-01', text: 'я третий' })).isError).toBe(true);
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
    expect(refused.text).toContain('слишком часто');
    // Была бы рассылка на два письма (по адресату), лимит исчерпался бы на первом вызове.
    expect((await readMapFile()).messages).toHaveLength(2);
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
