import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addSession,
  createWork,
  createWorktree,
  NEW_LABEL,
  plannedWorktree,
  readMap,
  saveConfig,
  SYSTEM,
  transitionSession,
  updateMap,
  workPaths,
} from '@harnas/core';
import type { WorkEntry, WorktreeInfo } from '@harnas/core';
import type { EventData, EventName, SessionRef } from '@harnas/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import { createPtyManager } from '../pty/pty-manager.js';
import { createWorksService } from '../works/works-service.js';
import type { WorksService } from '../works/works-service.js';
import { autoLaunchCandidates } from './auto-launch.js';
import { createSessionsService } from './sessions-service.js';

const STUB = fileURLToPath(new URL('../../test/stub-agent.mjs', import.meta.url));
const runGit = promisify(execFile);

/** Репозиторий с одним коммитом на ветке `main` — общая точка отсчёта тестов worktree. */
async function initGitProject(dir: string): Promise<void> {
  await runGit('git', ['init', '-b', 'main', dir]);
  await runGit('git', ['-C', dir, 'config', 'user.email', 'тест@harnas']);
  await runGit('git', ['-C', dir, 'config', 'user.name', 'тест']);
  await writeFile(path.join(dir, 'README.md'), 'старт\n', 'utf8');
  await runGit('git', ['-C', dir, 'add', 'README.md']);
  await runGit('git', ['-C', dir, 'commit', '-m', 'первый']);
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - started > timeoutMs) throw new Error('не дождались условия');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let broadcasts: Array<{ event: EventName; data: unknown }>;

/** Минимальный `HostContext`: сервису сессий нужны только `log` и `broadcast`. */
function fakeHost(): HostContext {
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    clients: () => [],
    liveSessions: () => 0,
    broadcast: (event, data) => broadcasts.push({ event, data: data as EventData<EventName> }),
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
  };
}

/** Заглушка `WorksService`: тестам вне autoLaunch она не нужна — `launch()` читает карту сам. */
function fakeWorks(): WorksService {
  return {
    start: async () => {},
    snapshot: () => ({ entries: [], branches: {} }),
    entry: () => undefined,
    firstReadDone: () => false,
    onChange: () => () => {},
    stop: async () => {},
  };
}

/** Заглушка `ActivityService`: сервису сессий из неё нужен только `markSeen`. */
function fakeActivity(): ActivityService {
  return {
    start: async () => {},
    get: () => undefined,
    markSeen: () => {},
    onChange: () => () => {},
    stop: async () => {},
  };
}

let project = '';
let extraEnv: string[] = [];
let worksServices: WorksService[] = [];

function setEnv(key: string, value: string): void {
  process.env[key] = value;
  extraEnv.push(key);
}

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'harnas-sessions-project-'));
  broadcasts = [];
  // Настоящий бинарь в автотестах не запускается никогда — заглушка стоит
  // под именем claude через тот же оверрайд, что и в проде (`findRunnerBinary`).
  setEnv('HARNAS_CLAUDE_BIN', STUB);
});

afterEach(async () => {
  for (const key of extraEnv) delete process.env[key];
  extraEnv = [];
  await Promise.all(worksServices.map((service) => service.stop()));
  worksServices = [];
  await rm(project, { recursive: true, force: true });
});

async function tempArgsFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'harnas-sessions-args-'));
  return path.join(dir, 'args.json');
}

/** Корень worktree отдельно от `project`: `<root>/<проект>-<хеш6>/…` не должен жить внутри самого репозитория. */
async function tempWorktreeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'harnas-sessions-worktrees-'));
}

interface StubArgs {
  argv: string[];
  cwd: string;
  env: { HARNAS_WORK_DIR: string | null; HARNAS_SESSION_ID: string | null; CLAUDE_CODE_SESSION_ID: string | null };
}

async function readArgs(file: string): Promise<StubArgs> {
  await waitFor(() => existsSync(file));
  return JSON.parse(await readFile(file, 'utf8')) as StubArgs;
}

describe('create() + launch(): argv и окружение процесса', () => {
  it('сессия с задачей: settings/mcp-config/append-system-prompt есть, бриф — последним аргументом, канала нет', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);

    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const ref = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: 'бэкенд',
      task: 'сделай штуку',
      parent: null,
    });

    const args = await readArgs(argsFile);
    expect(args.argv).toContain('--mcp-config');
    expect(args.argv).toContain('--append-system-prompt');
    const settingsIndex = args.argv.indexOf('--settings');
    expect(settingsIndex).toBeGreaterThan(-1);
    expect(args.argv[settingsIndex + 1]).toContain('settings.json');
    // Флаг канала звонка хост не передаёт никогда (спека 4.2, юридическая
    // граница) — сам текст флага в исходниках хоста не пишем даже в тесте,
    // приёмка куска ищет его строку.
    expect(args.argv.some((arg) => arg.startsWith('--dangerously'))).toBe(false);

    const briefFile = path.join(workPaths(project, work.work.id).briefs, `${ref.sessionId}.md`);
    const brief = await readFile(briefFile, 'utf8');
    expect(args.argv[args.argv.length - 1]).toBe(brief);

    await service.stop(ref);
  });

  it('окружение процесса: HARNAS_WORK_DIR/HARNAS_SESSION_ID есть, CLAUDE_CODE_SESSION_ID — нет, даже если задан у хоста', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    // Метка родительской сессии Claude Code, унаследованная хостом от своего
    // логина — `agentEnv` (П0) обязана её вырезать.
    setEnv('CLAUDE_CODE_SESSION_ID', 'чужая-родительская-сессия');

    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const ref = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: 'бэкенд',
      task: 'сделай штуку',
      parent: null,
    });

    const args = await readArgs(argsFile);
    expect(args.env.HARNAS_WORK_DIR).toBe(workPaths(project, work.work.id).dir);
    expect(args.env.HARNAS_SESSION_ID).toBe(ref.sessionId);
    expect(args.env.CLAUDE_CODE_SESSION_ID).toBeNull();

    await service.stop(ref);
  });

  it('быстрая сессия (без задачи и родителя): промпта в argv нет', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);

    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const ref = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: 'новая сессия',
      task: '',
      parent: null,
    });

    const args = await readArgs(argsFile);
    // Системная вставка — последняя пара флаг+значение: следом ничего не идёт,
    // значит стартового промпта в команде нет вовсе.
    expect(args.argv[args.argv.length - 2]).toBe('--append-system-prompt');

    await service.stop(ref);
  });

  it('быстрая сессия сохраняет ярлык из диалога; пустой ярлык оставляет «новую сессию»', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    setEnv('STUB_ARGS_FILE', await tempArgsFile());

    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const named = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: '  бэкенд ',
      task: '',
      parent: null,
    });
    const unnamed = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: '',
      task: '',
      parent: null,
    });

    const map = await readMap(project, work.work.id);
    expect(map.sessions.find((s) => s.id === named.sessionId)?.label).toBe('бэкенд');
    expect(map.sessions.find((s) => s.id === unnamed.sessionId)?.label).toBe(NEW_LABEL);

    await service.stop(named);
    await service.stop(unnamed);
  });
});

describe('create(): модель и усилие из диалога (дизайн комнат, 3.2)', () => {
  /** Запускает сессию провайдера и отдаёт argv стаба; `task: ''` — тихий старт, как у комнат. */
  async function launched(
    provider: string,
    choice: { model?: string; effort?: 'low' | 'medium' | 'high' },
    task = '',
  ): Promise<string[]> {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const ref = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider,
      label: '',
      task,
      parent: null,
      ...choice,
    });
    const { argv } = await readArgs(argsFile);
    await service.stop(ref);
    return argv;
  }

  it('claude: --model и --effort доезжают до команды', async () => {
    const argv = await launched('claude', { model: 'opus', effort: 'high' });

    expect(argv[argv.indexOf('--model') + 1]).toBe('opus');
    expect(argv[argv.indexOf('--effort') + 1]).toBe('high');
  });

  it('claude с задачей: бриф по-прежнему последним аргументом, флаги перед ним', async () => {
    const argv = await launched('claude', { model: 'sonnet', effort: 'low' }, 'сделай штуку');

    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
    expect(argv[argv.indexOf('--effort') + 1]).toBe('low');
    expect(argv.at(-1)).toContain('сделай штуку');
  });

  it('без выбора флагов нет: сессия живёт на модели и усилии по умолчанию', async () => {
    const argv = await launched('claude', {});

    expect(argv).not.toContain('--model');
    expect(argv).not.toContain('--effort');
  });

  it('codex: --model и -c model_reasoning_effort в аргументах', async () => {
    setEnv('HARNAS_CODEX_BIN', STUB);
    const argv = await launched('codex', { model: 'gpt-6.1-sol', effort: 'medium' });

    expect(argv[argv.indexOf('--model') + 1]).toBe('gpt-6.1-sol');
    expect(argv).toContain('model_reasoning_effort="medium"');
  });

  it('claude: значение списка со скобками доезжает до команды как есть, одним аргументом', async () => {
    const argv = await launched('claude', { model: 'sonnet[1m]' });

    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet[1m]');
  });

  it('пустая model — «по умолчанию»: флага нет, как без выбора', async () => {
    const argv = await launched('claude', { model: '', effort: 'low' });

    expect(argv).not.toContain('--model');
    // Усилие — отдельный выбор и от пустой модели не зависит.
    expect(argv[argv.indexOf('--effort') + 1]).toBe('low');
  });

  it('модель не из списка провайдера — bad_request: процесс не запускается, записей в карте не появляется', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    setEnv('HARNAS_CODEX_BIN', STUB);
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const worksDir = path.join(project, '.harnas', 'works');
    const worksBefore = await readdir(worksDir);

    const create = (workId: string | null, provider: string, task: string, model: string) =>
      service.create({ projectPath: project, workId, provider, label: '', task, parent: null, model });
    // Все три пути создания: тихий старт, сессия с задачей (`pending`) и новая работа под быструю сессию.
    for (const attempt of [
      create(work.work.id, 'claude', '', 'gpt-6-sol'),
      create(work.work.id, 'claude', 'сделай штуку', 'sonnet[1M]'),
      create(null, 'codex', '', 'opus'),
    ]) {
      await expect(attempt).rejects.toMatchObject({ name: 'HostError', code: 'bad_request' });
    }

    expect(existsSync(argsFile)).toBe(false);
    expect((await readMap(project, work.work.id)).sessions).toEqual([]);
    // Отказ раньше первой записи: новой работы под `workId: null` тоже не завели.
    expect(await readdir(worksDir)).toEqual(worksBefore);
  });

  describe('свои списки моделей из providers.json', () => {
    /** Свой дом харнесса с `providers.json`: реестр читается оттуда же, откуда и хост в бою. */
    async function withProviders(data: unknown): Promise<void> {
      const home = path.join(project, 'свой-дом-харнесса');
      await mkdir(home, { recursive: true });
      await writeFile(path.join(home, 'providers.json'), JSON.stringify(data), 'utf8');
      setEnv('HARNAS_HOME', home);
    }

    it('модель из своего списка доезжает до команды, а из встроенного, которого в нём нет, — bad_request', async () => {
      await withProviders({ claude: { models: [{ id: 'my-new-model', label: 'Моя новая' }] } });

      const argv = await launched('claude', { model: 'my-new-model' });
      expect(argv[argv.indexOf('--model') + 1]).toBe('my-new-model');
      await expect(launched('claude', { model: 'opus' })).rejects.toMatchObject({ code: 'bad_request' });
    });

    it('провайдер без списка — прежнее правило: любое значение идёт в команду, где шаблон принимает {model}', async () => {
      await withProviders({
        smart: { badge: 'Smart', command: 'smart', args: ['--m', '{model}', '{prompt}'] },
      });
      setEnv('HARNAS_SMART_BIN', STUB);

      const argv = await launched('smart', { model: 'что-то-своё' });
      expect(argv[argv.indexOf('--m') + 1]).toBe('что-то-своё');
    });
  });

  it('провайдер без флагов (glm) выбор не получает: поле отбрасывается', async () => {
    setEnv('HARNAS_GLM_BIN', STUB);
    const argv = await launched('glm', { model: 'glm-4', effort: 'high' });

    expect(argv.slice(2)).toEqual([]);
  });
});

describe('create(): карта после старта', () => {
  it('active, pid стаба, launchedBy host, providerSessionId — uuid из --session-id', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);

    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const ref = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: 'бэкенд',
      task: 'сделай штуку',
      parent: null,
    });

    const args = await readArgs(argsFile);
    const uuidIndex = args.argv.indexOf('--session-id');
    const uuid = args.argv[uuidIndex + 1];

    const map = await readMap(project, work.work.id);
    const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
    expect(session?.lifecycle).toBe('active');
    expect(session?.launchedBy).toBe('host');
    expect(session?.pid).toBeGreaterThan(0);
    expect(session?.providerSessionId).toBe(uuid);

    await service.stop(ref);
  });
});

describe('выход процесса', () => {
  it('STUB_EXIT_AFTER_MS=100: сессия засыпает (sleeping), код 3 в истории, приходит pty.exit', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    setEnv('STUB_EXIT_AFTER_MS', '100');

    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const ref = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: 'бэкенд',
      task: 'сделай штуку',
      parent: null,
    });

    await waitFor(async () => (await readMap(project, work.work.id)).sessions.find((s) => s.id === ref.sessionId)?.lifecycle === 'sleeping');

    const map = await readMap(project, work.work.id);
    const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
    expect(session?.history.at(-1)).toMatchObject({ event: 'sleeping', exitCode: 3 });

    const exitEvent = broadcasts.find((b) => b.event === 'pty.exit');
    expect(exitEvent).toBeDefined();
    expect((exitEvent?.data as { ref: SessionRef }).ref).toEqual(ref);
  });
});

describe('autoLaunchCandidates', () => {
  it('только новая pending-с-родителем, появившаяся после первого чтения работы хостом', () => {
    const entry = (sessions: WorkEntry['map']['sessions']): WorkEntry => ({
      projectPath: '/tmp/project',
      map: { work: { id: 'w-01' }, sessions } as WorkEntry['map'],
    });
    const pendingWithParent = { id: 's-2', lifecycle: 'pending', parent: 's-1' } as WorkEntry['map']['sessions'][number];
    const pendingNoParent = { id: 's-3', lifecycle: 'pending', parent: null } as WorkEntry['map']['sessions'][number];

    // До старта хоста: даже если сессия pending-с-родителем, без firstReadDone
    // это первое чтение работы — трогать её нельзя.
    expect(autoLaunchCandidates(undefined, entry([pendingWithParent]), false)).toEqual([]);

    // После первого чтения: новая pending-с-родителем — кандидат.
    expect(autoLaunchCandidates(entry([]), entry([pendingWithParent]), true)).toEqual(['s-2']);

    // Без родителя — не кандидат, даже после первого чтения.
    expect(autoLaunchCandidates(entry([]), entry([pendingNoParent]), true)).toEqual([]);

    // Уже известная (была и в previous) — не кандидат повторно.
    expect(autoLaunchCandidates(entry([pendingWithParent]), entry([pendingWithParent]), true)).toEqual([]);
  });
});

function service(options: Parameters<typeof createWorksService>[1] = {}): WorksService {
  const created = createWorksService(fakeHost(), options);
  worksServices.push(created);
  return created;
}

describe('autoLaunch: сервис', () => {
  it('поднимает только дочернюю pending, дописанную после первого чтения; старую и без родителя — не трогает', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    let parentId = '';
    await updateMap(project, work.work.id, (map) => {
      parentId = addSession(map, { provider: 'claude', label: 'родитель', task: 'т' }).id;
    });
    let oldNoParentId = '';
    await updateMap(project, work.work.id, (map) => {
      oldNoParentId = addSession(map, { provider: 'claude', label: 'без родителя', task: '' }).id;
    });

    const works = service({ debounceMs: 30 });
    const pty = createPtyManager(fakeHost());
    const sessions = createSessionsService(fakeHost(), works, pty, fakeActivity());
    await works.start();

    let spawnedId = '';
    await updateMap(project, work.work.id, (map) => {
      spawnedId = addSession(map, { provider: 'claude', label: 'дочерняя', task: 'т', parent: parentId }).id;
    });

    await waitFor(
      async () => (await readMap(project, work.work.id)).sessions.find((s) => s.id === spawnedId)?.lifecycle === 'active',
    );

    const map = await readMap(project, work.work.id);
    expect(map.sessions.find((s) => s.id === oldNoParentId)?.lifecycle).toBe('pending');

    await sessions.stop({ projectPath: project, workId: work.work.id, sessionId: spawnedId });
  });

  it('autoLaunch: false в настройках — сессия остаётся pending', async () => {
    await saveConfig({ autoLaunch: false });

    const work = await createWork(project, { title: 'Работа', goal: '' });
    let parentId = '';
    await updateMap(project, work.work.id, (map) => {
      parentId = addSession(map, { provider: 'claude', label: 'родитель', task: 'т' }).id;
    });

    const works = service({ debounceMs: 30 });
    const pty = createPtyManager(fakeHost());
    createSessionsService(fakeHost(), works, pty, fakeActivity());
    await works.start();

    let spawnedId = '';
    await updateMap(project, work.work.id, (map) => {
      spawnedId = addSession(map, { provider: 'claude', label: 'дочерняя', task: 'т', parent: parentId }).id;
    });

    // Ждать нечего: изменение уже пройдёт цикл сервиса, лишь бы не запустилось.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const map = await readMap(project, work.work.id);
    expect(map.sessions.find((s) => s.id === spawnedId)?.lifecycle).toBe('pending');
  });
});

describe('stop() / delete()', () => {
  it('stop(): сессия становится sleeping; delete() живой сессии останавливает процесс и убирает запись с диска', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const pty = createPtyManager(fakeHost());
    const service = createSessionsService(fakeHost(), fakeWorks(), pty, fakeActivity());

    const stopped = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: 'a',
      task: 'т',
      parent: null,
    });
    await service.stop(stopped);
    const afterStop = await readMap(project, work.work.id);
    expect(afterStop.sessions.find((s) => s.id === stopped.sessionId)?.lifecycle).toBe('sleeping');

    const deleted = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: 'b',
      task: 'т',
      parent: null,
    });
    expect(service.live(deleted)).toBe(true);
    await service.delete(deleted);
    expect(service.live(deleted)).toBe(false);

    const afterDelete = await readMap(project, work.work.id);
    expect(afterDelete.sessions.find((s) => s.id === deleted.sessionId)).toBeUndefined();
    const briefFile = path.join(workPaths(project, work.work.id).briefs, `${deleted.sessionId}.md`);
    expect(existsSync(briefFile)).toBe(false);
  });
});

describe('запуск без бинаря', () => {
  it('бинаря нет: host.notice(launch-failed), сессия остаётся pending, метод отвечает ошибкой', async () => {
    setEnv('HARNAS_CLAUDE_BIN', '/несуществующий/путь/до/claude');
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());

    await expect(
      service.create({
        projectPath: project,
        workId: work.work.id,
        provider: 'claude',
        label: 'a',
        task: 'т',
        parent: null,
      }),
    ).rejects.toThrow();

    const notice = broadcasts.find((b) => b.event === 'host.notice');
    expect(notice).toBeDefined();
    expect(notice?.data).toMatchObject({ kind: 'launch-failed' });

    const map = await readMap(project, work.work.id);
    expect(map.sessions).toHaveLength(1);
    expect(map.sessions[0]?.lifecycle).toBe('pending');
  });
});

describe('stopAll()', () => {
  it('гасит все живые сессии — в картах sleeping', async () => {
    const workA = await createWork(project, { title: 'A', goal: '' });
    const workB = await createWork(project, { title: 'B', goal: '' });
    const pty = createPtyManager(fakeHost());
    const service = createSessionsService(fakeHost(), fakeWorks(), pty, fakeActivity());

    const refA = await service.create({
      projectPath: project,
      workId: workA.work.id,
      provider: 'claude',
      label: 'a',
      task: 'т',
      parent: null,
    });
    const refB = await service.create({
      projectPath: project,
      workId: workB.work.id,
      provider: 'claude',
      label: 'b',
      task: 'т',
      parent: null,
    });

    const started = Date.now();
    await service.stopAll();
    // Стаб не игнорирует SIGHUP — выходит почти сразу; добивание SIGKILL было
    // бы не раньше 3 с (grace по умолчанию).
    expect(Date.now() - started).toBeLessThan(2000);

    const mapA = await readMap(project, workA.work.id);
    const mapB = await readMap(project, workB.work.id);
    expect(mapA.sessions.find((s) => s.id === refA.sessionId)?.lifecycle).toBe('sleeping');
    expect(mapB.sessions.find((s) => s.id === refB.sessionId)?.lifecycle).toBe('sleeping');
  });
});

describe('закрытие по карте', () => {
  it('8: close_session в карте при живом PTY — процесс получил SIGHUP, карта остаётся closed', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const works = service({ debounceMs: 20 });
    const pty = createPtyManager(fakeHost());
    const sessions = createSessionsService(fakeHost(), works, pty, fakeActivity());
    await works.start();

    const ref = await sessions.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: 'a',
      task: 'т',
      parent: null,
    });
    expect(sessions.live(ref)).toBe(true);

    // Так карту меняет `close_session` агента: прямо в файле, мимо хоста.
    await updateMap(project, work.work.id, (map) => {
      transitionSession(map, ref.sessionId, 'closed');
    });

    await waitFor(() => broadcasts.some((b) => b.event === 'pty.exit'));
    const exit = broadcasts.find((b) => b.event === 'pty.exit')?.data as { ref: SessionRef; signal: number | null };
    expect(exit.ref).toEqual(ref);
    // SIGHUP — 1: хост гасит процесс той же дорогой, что и «Остановить».
    expect(exit.signal).toBe(1);
    expect(sessions.live(ref)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const map = await readMap(project, work.work.id);
    expect(map.sessions.find((s) => s.id === ref.sessionId)?.lifecycle).toBe('closed');
  });
});

describe('worktree (план, кусок 4.2)', () => {
  it('1: sessions.create({ worktree: true }) — cwd стаба и createdAt в карте', async () => {
    await initGitProject(project);
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    setEnv('HARNAS_WORKTREE_ROOT', await tempWorktreeRoot());

    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const ref = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: 'бэкенд',
      task: 'сделай штуку',
      parent: null,
      worktree: true,
    });

    const args = await readArgs(argsFile);
    const map = await readMap(project, work.work.id);
    const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
    expect(session?.worktree).not.toBeNull();
    expect(session?.worktree?.createdAt).not.toBeNull();
    // Путь сравнивается разрешённым симлинков: на macOS `/tmp` — симлинк на
    // `/private/tmp`, а PTY отдаёт `cwd` уже разрешённым (тот же приём, что и в
    // `worktree.test.ts` core про `baseCheckout`).
    expect(await realpath(args.cwd)).toBe(await realpath(session?.worktree?.path as string));
    expect(existsSync(session?.worktree?.path as string)).toBe(true);

    await service.stop(ref);
  });

  it('1б: sessions.create({ worktree: true }) — бриф на диске называет ветку и базу worktree (fix-guide, п. 3)', async () => {
    // Бриф пишется при создании записи, а план worktree — следом: без
    // перезаписи агент получил бы бриф без строки о своей ветке.
    await initGitProject(project);
    const work = await createWork(project, { title: 'Работа', goal: '' });
    setEnv('STUB_ARGS_FILE', await tempArgsFile());
    setEnv('HARNAS_WORKTREE_ROOT', await tempWorktreeRoot());

    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const ref = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: 'бэкенд',
      task: 'сделай штуку',
      parent: null,
      worktree: true,
    });

    const map = await readMap(project, work.work.id);
    const worktree = map.sessions.find((candidate) => candidate.id === ref.sessionId)?.worktree;
    const brief = await readFile(path.join(workPaths(project, work.work.id).briefs, `${ref.sessionId}.md`), 'utf8');
    expect(brief).toContain(`Worktree: ветка \`${worktree?.branch}\` от базы \`${worktree?.base}\``);

    await service.stop(ref);
  });

  it('2: дочерняя сессия со своим worktree, поднятая autoLaunch, — каталог заведён до запуска стаба', async () => {
    // Тест «autoLaunch: false в настройках» выше по файлу пишет флаг в общий
    // для процесса `config.json` (сандбокс-дом один на файл) и не возвращает
    // его назад — без явного включения здесь autoLaunch остался бы выключен и
    // для этого теста тоже.
    await saveConfig({ autoLaunch: true });

    await initGitProject(project);
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const worktreeRootDir = await tempWorktreeRoot();
    let parentId = '';
    await updateMap(project, work.work.id, (map) => {
      parentId = addSession(map, { provider: 'claude', label: 'родитель', task: 'т' }).id;
    });

    const works = service({ debounceMs: 30 });
    const pty = createPtyManager(fakeHost());
    const sessions = createSessionsService(fakeHost(), works, pty, fakeActivity());
    await works.start();

    // Так `spawn_session({ worktree: true })` пишет план в карту (core, кусок 4.1):
    // каталог на диске к этому моменту ещё не существует, `createdAt` — `null`.
    let childId = '';
    await updateMap(project, work.work.id, (map) => {
      const child = addSession(map, {
        provider: 'claude',
        label: 'дочерняя',
        task: 'т',
        parent: parentId,
      });
      childId = child.id;
      child.worktree = plannedWorktree(project, work.work.id, child.id, 'main', worktreeRootDir);
    });

    await waitFor(
      async () =>
        (await readMap(project, work.work.id)).sessions.find((s) => s.id === childId)?.lifecycle === 'active',
    );

    const map = await readMap(project, work.work.id);
    const child = map.sessions.find((s) => s.id === childId);
    expect(child?.worktree?.createdAt).not.toBeNull();
    expect(existsSync(child?.worktree?.path as string)).toBe(true);

    await sessions.stop({ projectPath: project, workId: work.work.id, sessionId: childId });
  });

  it('3: ветка уже существует — launch-failed, письмо от system родителю, сессия остаётся pending', async () => {
    await initGitProject(project);
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const worktreeRootDir = await tempWorktreeRoot();
    let parentId = '';
    await updateMap(project, work.work.id, (map) => {
      parentId = addSession(map, { provider: 'claude', label: 'родитель', task: 'т' }).id;
    });

    let childId = '';
    await updateMap(project, work.work.id, (map) => {
      const child = addSession(map, {
        provider: 'claude',
        label: 'дочерняя',
        task: 'т',
        parent: parentId,
      });
      childId = child.id;
      child.worktree = plannedWorktree(project, work.work.id, child.id, 'main', worktreeRootDir);
    });

    // Ветка плана уже занята — `git worktree add -b <ветка>` откажет.
    const branch = (await readMap(project, work.work.id)).sessions.find((s) => s.id === childId)
      ?.worktree?.branch as string;
    await runGit('git', ['-C', project, 'branch', branch]);

    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const ref: SessionRef = { projectPath: project, workId: work.work.id, sessionId: childId };

    await expect(service.launch(ref, 'launch')).rejects.toThrow();

    const notice = broadcasts.find(
      (b) => b.event === 'host.notice' && (b.data as { kind: string }).kind === 'launch-failed',
    );
    expect(notice).toBeDefined();

    const map = await readMap(project, work.work.id);
    expect(map.sessions.find((s) => s.id === childId)?.lifecycle).toBe('pending');
    const letter = map.messages.find((m) => m.from === SYSTEM && m.to.includes(parentId));
    expect(letter).toBeDefined();
    expect(letter?.text).toContain('worktree');
  });

  it('7: sessions.delete грязного worktree без force — conflict; с force — сессия и worktree убраны целиком', async () => {
    await initGitProject(project);
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const worktreeRootDir = await tempWorktreeRoot();

    let sessionId = '';
    let info!: WorktreeInfo;
    await updateMap(project, work.work.id, (map) => {
      const created = addSession(map, { provider: 'claude', label: 'a', task: 'т' });
      sessionId = created.id;
      created.worktree = plannedWorktree(project, work.work.id, created.id, 'main', worktreeRootDir);
      info = created.worktree;
    });
    await createWorktree(project, info);
    await updateMap(project, work.work.id, (map) => {
      const session = map.sessions.find((candidate) => candidate.id === sessionId);
      if (session?.worktree !== null && session?.worktree !== undefined) {
        session.worktree.createdAt = new Date().toISOString();
      }
    });
    await writeFile(path.join(info.path, 'черновик.md'), 'незакоммиченное\n', 'utf8');

    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const ref: SessionRef = { projectPath: project, workId: work.work.id, sessionId };

    await expect(service.delete(ref)).rejects.toMatchObject({ code: 'conflict' });
    expect(existsSync(info.path)).toBe(true);
    expect((await readMap(project, work.work.id)).sessions.some((s) => s.id === sessionId)).toBe(true);

    await service.delete(ref, true);
    expect(existsSync(info.path)).toBe(false);
    expect((await readMap(project, work.work.id)).sessions.some((s) => s.id === sessionId)).toBe(false);
  });

  it('8: sessions.delete с флагом вместо ветки в карте — bad_request, как merge/discard; worktree и запись на месте (долг 8.1)', async () => {
    await initGitProject(project);
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const worktreeRootDir = await tempWorktreeRoot();

    let sessionId = '';
    let info!: WorktreeInfo;
    await updateMap(project, work.work.id, (map) => {
      const created = addSession(map, { provider: 'claude', label: 'a', task: 'т' });
      sessionId = created.id;
      created.worktree = plannedWorktree(project, work.work.id, created.id, 'main', worktreeRootDir);
      info = created.worktree;
    });
    await createWorktree(project, info);
    // Карту мог переписать агент: ветка стала флагом.
    await updateMap(project, work.work.id, (map) => {
      const session = map.sessions.find((candidate) => candidate.id === sessionId);
      if (session?.worktree !== null && session?.worktree !== undefined) {
        session.worktree.createdAt = new Date().toISOString();
        session.worktree.branch = '-c';
      }
    });

    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const ref: SessionRef = { projectPath: project, workId: work.work.id, sessionId };

    await expect(service.delete(ref, true)).rejects.toMatchObject({ code: 'bad_request' });
    expect(existsSync(info.path)).toBe(true);
    expect((await readMap(project, work.work.id)).sessions.some((s) => s.id === sessionId)).toBe(true);
  });

  it('9: sessions.delete worktree с подложенным .git — bad_request worktree-corrupt; worktree и запись на месте (fix-final-a, C1)', async () => {
    await initGitProject(project);
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const worktreeRootDir = await tempWorktreeRoot();

    let sessionId = '';
    let info!: WorktreeInfo;
    await updateMap(project, work.work.id, (map) => {
      const created = addSession(map, { provider: 'claude', label: 'a', task: 'т' });
      sessionId = created.id;
      created.worktree = plannedWorktree(project, work.work.id, created.id, 'main', worktreeRootDir);
      info = created.worktree;
    });
    await createWorktree(project, info);
    await updateMap(project, work.work.id, (map) => {
      const session = map.sessions.find((candidate) => candidate.id === sessionId);
      if (session?.worktree !== null && session?.worktree !== undefined) {
        session.worktree.createdAt = new Date().toISOString();
      }
    });
    // Агент заменил файл .git своей копии: gitdir — каталог внутри неё же.
    await mkdir(path.join(info.path, 'evil', '.git'), { recursive: true });
    await writeFile(path.join(info.path, '.git'), `gitdir: ${path.join(info.path, 'evil', '.git')}\n`, 'utf8');

    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const ref: SessionRef = { projectPath: project, workId: work.work.id, sessionId };

    await expect(service.delete(ref, true)).rejects.toMatchObject({
      code: 'bad_request',
      data: { reason: 'worktree-corrupt' },
    });
    expect(existsSync(info.path)).toBe(true);
    expect((await readMap(project, work.work.id)).sessions.some((s) => s.id === sessionId)).toBe(true);
  });
});
