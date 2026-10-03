import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addSession,
  buildRoleCatalog,
  createPendingSession,
  createWork,
  createWorktree,
  NEW_LABEL,
  plannedWorktree,
  readMap,
  saveConfig,
  SKILL_MD,
  SYSTEM,
  transitionSession,
  updateMap,
  workPaths,
} from '@parley/core';
import type { WorkEntry, WorktreeInfo } from '@parley/core';
import type { EventData, EventName, SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import type { ProviderVersions } from '../providers/versions.js';
import { createPtyManager } from '../pty/pty-manager.js';
import { createWorksService } from '../works/works-service.js';
import type { WorksService } from '../works/works-service.js';
import { autoLaunchCandidates } from './auto-launch.js';
import { createSessionsService } from './sessions-service.js';
import type { SessionsFeedOptions } from './sessions-service.js';

const STUB = fileURLToPath(new URL('../../test/stub-agent.mjs', import.meta.url));
const runGit = promisify(execFile);

/** Репозиторий с одним коммитом на ветке `main` — общая точка отсчёта тестов worktree. */
async function initGitProject(dir: string): Promise<void> {
  await runGit('git', ['init', '-b', 'main', dir]);
  await runGit('git', ['-C', dir, 'config', 'user.email', 'тест@parley']);
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
  project = await mkdtemp(path.join(tmpdir(), 'parley-sessions-project-'));
  broadcasts = [];
  // Настоящий бинарь в автотестах не запускается никогда — заглушка стоит
  // под именем claude через тот же оверрайд, что и в проде (`findRunnerBinary`).
  setEnv('PARLEY_CLAUDE_BIN', STUB);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of extraEnv) delete process.env[key];
  extraEnv = [];
  await Promise.all(worksServices.map((service) => service.stop()));
  worksServices = [];
  await rm(project, { recursive: true, force: true });
});

async function tempArgsFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'parley-sessions-args-'));
  return path.join(dir, 'args.json');
}

/** Корень worktree отдельно от `project`: `<root>/<проект>-<хеш6>/…` не должен жить внутри самого репозитория. */
async function tempWorktreeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'parley-sessions-worktrees-'));
}

interface StubArgs {
  argv: string[];
  cwd: string;
  env: {
    PARLEY_WORK_DIR: string | null;
    PARLEY_SESSION_ID: string | null;
    HARNAS_WORK_DIR: string | null;
    HARNAS_SESSION_ID: string | null;
    CLAUDE_CODE_SESSION_ID: string | null;
    PARLEY_HOOK_TOKEN: string | null;
  };
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

  it('окружение процесса: оба набора PARLEY_* и HARNAS_* (R3) есть, CLAUDE_CODE_SESSION_ID — нет, даже если задан у хоста', async () => {
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
    expect(args.env.PARLEY_WORK_DIR).toBe(workPaths(project, work.work.id).dir);
    expect(args.env.PARLEY_SESSION_ID).toBe(ref.sessionId);
    // Прежние имена — для старых скриптов и сборок: значения те же.
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
      label: NEW_LABEL,
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
    setEnv('PARLEY_CODEX_BIN', STUB);
    const argv = await launched('codex', { model: 'gpt-6.1-sol', effort: 'medium' });

    expect(argv[argv.indexOf('--model') + 1]).toBe('gpt-6.1-sol');
    expect(argv).toContain('model_reasoning_effort="medium"');
  });

  it('codex: итоговые флаги запуска — свои настройки харнесса, без обходов', async () => {
    setEnv('PARLEY_CODEX_BIN', STUB);
    const argv = await launched('codex', {});

    // Не считая бинаря и скрипта заглушки: то, что получил бы настоящий codex.
    const args = argv.slice(2);
    expect(args.slice(0, 3)).toEqual(['--no-daemon', '-a', 'on-request']);
    const overrides = args.flatMap((arg, index) => (args[index - 1] === '-c' ? [arg] : []));
    expect(overrides.map((override) => override.split('=')[0])).toEqual([
      'mcp_servers.parley',
      'developer_instructions',
      'project_doc_fallback_filenames',
      'tui.terminal_title',
      'tui.notifications',
      'tui.notification_method',
      'tui.notification_condition',
      'notify',
    ]);
    expect(args.join(' ')).not.toMatch(/never|dangerous|yolo|full-auto|danger-full|projects|hooks/);
  });

  it('процесс стартует с provider из карты: codex — для разбора терминала, claude — без него', async () => {
    setEnv('PARLEY_CODEX_BIN', STUB);
    setEnv('STUB_ARGS_FILE', await tempArgsFile());
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const pty = createPtyManager(fakeHost());
    const service = createSessionsService(fakeHost(), fakeWorks(), pty, fakeActivity());
    const create = (provider: string) =>
      service.create({ projectPath: project, workId: work.work.id, provider, label: '', task: '', parent: null });

    const codex = await create('codex');
    const claude = await create('claude');
    expect(pty.get(codex)?.provider).toBe('codex');
    expect(pty.get(claude)?.provider).toBe('claude');

    await service.stop(codex);
    await service.stop(claude);
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
    setEnv('PARLEY_CODEX_BIN', STUB);
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const worksDir = path.join(project, '.parley', 'works');
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
      setEnv('PARLEY_HOME', home);
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
      setEnv('PARLEY_SMART_BIN', STUB);

      const argv = await launched('smart', { model: 'что-то-своё' });
      expect(argv[argv.indexOf('--m') + 1]).toBe('что-то-своё');
    });
  });

  it('провайдер без флагов (glm) выбор не получает: поле отбрасывается', async () => {
    setEnv('PARLEY_GLM_BIN', STUB);
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

describe('launch(): лента вида «Chat» — адрес приёмника и токен по версии claude (Task 2c)', () => {
  const HOOK_URL = 'http://127.0.0.1:4321/hooks';

  /** Заглушка приёмника: выдаёт токены по порядку и пишет, кого зарегистрировали и сняли. */
  function fakeHooks() {
    const registered: Array<{ ref: SessionRef; providerSessionId: string | null; token: string }> = [];
    const unregistered: SessionRef[] = [];
    const hooks: NonNullable<SessionsFeedOptions['hooks']> = {
      url: () => HOOK_URL,
      register(ref, providerSessionId) {
        const token = `токен-${registered.length + 1}`;
        registered.push({ ref, providerSessionId, token });
        return token;
      },
      unregister(ref) {
        unregistered.push(ref);
      },
    };
    return { hooks, registered, unregistered };
  }

  /** Версии CLI по команде; `ready` — свой промис, чтобы проверить, что запуск его ждёт. */
  function fakeVersions(versions: Record<string, string | null>, ready: Promise<void> = Promise.resolve()): ProviderVersions {
    return { ready, get: (command) => versions[command] ?? null };
  }

  interface Launched {
    args: StubArgs;
    settings: { hooks: Record<string, Array<{ hooks: Array<{ type: string; url?: string }> }>> } | null;
    ref: SessionRef;
    stop: () => Promise<void>;
  }

  /** Создаёт и запускает сессию; файл настроек — по `--settings` из argv, если он там есть. */
  async function launchWith(provider: string, feed: SessionsFeedOptions, extra: Partial<Record<string, string>> = {}): Promise<Launched> {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    for (const [key, value] of Object.entries(extra)) if (value !== undefined) setEnv(key, value);
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity(), feed);
    const ref = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider,
      label: 'бэкенд',
      task: '',
      parent: null,
    });
    const args = await readArgs(argsFile);
    const index = args.argv.indexOf('--settings');
    const settings =
      index === -1 ? null : (JSON.parse(await readFile(args.argv[index + 1] as string, 'utf8')) as Launched['settings']);
    return { args, settings, ref, stop: () => service.stop(ref) };
  }

  /** HTTP-хуки ленты в файле настроек: адреса всех `type: 'http'`. */
  function httpHookUrls(settings: Launched['settings']): string[] {
    if (settings === null) return [];
    return Object.values(settings.hooks).flatMap((groups) =>
      groups.flatMap((group) => group.hooks.filter((hook) => hook.type === 'http').map((hook) => hook.url ?? '')),
    );
  }

  it('claude 2.1.286: токен приёмника в окружении процесса, HTTP-хуки на адрес приёмника в файле настроек', async () => {
    const { hooks, registered } = fakeHooks();
    const launched = await launchWith('claude', { hooks, providerVersions: fakeVersions({ claude: '2.1.286' }) });

    expect(registered).toHaveLength(1);
    expect(registered[0]?.ref).toEqual(launched.ref);
    // providerSessionId — тот, что план передал в `--session-id`, и он же лёг в карту.
    const map = await readMap(project, launched.ref.workId);
    const session = map.sessions.find((candidate) => candidate.id === launched.ref.sessionId);
    expect(registered[0]?.providerSessionId).toBe(session?.providerSessionId);
    expect(registered[0]?.providerSessionId).not.toBeNull();
    expect(launched.args.env.PARLEY_HOOK_TOKEN).toBe(registered[0]?.token);

    const urls = httpHookUrls(launched.settings);
    expect(urls.length).toBeGreaterThan(0);
    expect(new Set(urls)).toEqual(new Set([HOOK_URL]));
    expect(launched.settings?.hooks.PermissionRequest).toBeDefined();

    await launched.stop();
  });

  it('claude 2.1.280 (ниже порога): ни токена, ни HTTP-хуков, прежние хуки на месте', async () => {
    const { hooks, registered } = fakeHooks();
    const launched = await launchWith('claude', { hooks, providerVersions: fakeVersions({ claude: '2.1.280' }) });

    expect(registered).toEqual([]);
    expect(launched.args.env.PARLEY_HOOK_TOKEN).toBeNull();
    expect(httpHookUrls(launched.settings)).toEqual([]);
    expect(launched.settings?.hooks.Stop).toBeDefined();

    await launched.stop();
  });

  it('версия claude не узнана (null): без токена и без HTTP-хуков', async () => {
    const { hooks, registered } = fakeHooks();
    const launched = await launchWith('claude', { hooks, providerVersions: fakeVersions({ claude: null }) });

    expect(registered).toEqual([]);
    expect(launched.args.env.PARLEY_HOOK_TOKEN).toBeNull();
    expect(httpHookUrls(launched.settings)).toEqual([]);

    await launched.stop();
  });

  it('codex — даже при «подходящей» версии своей команды — без токена', async () => {
    const { hooks, registered } = fakeHooks();
    const launched = await launchWith(
      'codex',
      { hooks, providerVersions: fakeVersions({ claude: '2.1.286', codex: '9.9.999' }) },
      { PARLEY_CODEX_BIN: STUB },
    );

    expect(registered).toEqual([]);
    expect(launched.args.env.PARLEY_HOOK_TOKEN).toBeNull();
    expect(launched.args.argv).not.toContain('--settings');

    await launched.stop();
  });

  it('без приёмника и версий (как в старых тестах) или приёмник не слушает — запуск прежний', async () => {
    const plain = await launchWith('claude', {});
    expect(plain.args.env.PARLEY_HOOK_TOKEN).toBeNull();
    expect(httpHookUrls(plain.settings)).toEqual([]);
    await plain.stop();

    const { hooks, registered } = fakeHooks();
    const closed = await launchWith('claude', {
      hooks: { ...hooks, url: () => null },
      providerVersions: fakeVersions({ claude: '2.1.286' }),
    });
    expect(registered).toEqual([]);
    expect(closed.args.env.PARLEY_HOOK_TOKEN).toBeNull();
    expect(httpHookUrls(closed.settings)).toEqual([]);
    await closed.stop();
  });

  it('запуск ждёт пробу версий (ready): версия, пришедшая позже, всё равно включает ленту', async () => {
    const { hooks, registered } = fakeHooks();
    const versions: Record<string, string | null> = {};
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    setTimeout(() => {
      versions.claude = '2.1.286';
      markReady();
    }, 100);
    const launched = await launchWith('claude', { hooks, providerVersions: fakeVersions(versions, ready) });

    expect(registered).toHaveLength(1);
    expect(launched.args.env.PARLEY_HOOK_TOKEN).toBe(registered[0]?.token);

    await launched.stop();
  });

  it('токен снимается по выходу процесса', async () => {
    const { hooks, registered, unregistered } = fakeHooks();
    const launched = await launchWith(
      'claude',
      { hooks, providerVersions: fakeVersions({ claude: '2.1.286' }) },
      { STUB_EXIT_AFTER_MS: '100' },
    );

    expect(registered).toHaveLength(1);
    await waitFor(() => unregistered.length > 0);
    expect(unregistered).toEqual([launched.ref]);
  });

  it('pty.start бросил — выданный токен снимается, ошибка доходит до вызывающего', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const { hooks, registered, unregistered } = fakeHooks();
    const pty = createPtyManager(fakeHost());
    const failing = {
      ...pty,
      start: () => {
        throw new Error('spawn не удался');
      },
    };
    const service = createSessionsService(fakeHost(), fakeWorks(), failing, fakeActivity(), {
      hooks,
      providerVersions: fakeVersions({ claude: '2.1.286' }),
    });

    await expect(
      service.create({ projectPath: project, workId: work.work.id, provider: 'claude', label: '', task: '', parent: null }),
    ).rejects.toThrow('spawn не удался');
    expect(registered).toHaveLength(1);
    expect(unregistered).toEqual([registered[0]?.ref]);
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
    expect(existsSync(path.join(project, 'PARLEY.md'))).toBe(true);

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
    setEnv('PARLEY_CLAUDE_BIN', '/несуществующий/путь/до/claude');
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

    const notice = broadcasts.find((b) => b.event === 'host.notice' && (b.data as { kind: string }).kind === 'launch-failed');
    expect(notice).toBeDefined();
    expect(notice?.data).toMatchObject({
      kind: 'launch-failed',
      text: expect.stringMatching(/^session s-\d+ failed to launch: /),
    });

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
  it('0: sessions.create({ worktree: true }) в проекте без git — bad_request с понятным текстом, записей нет', async () => {
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
        worktree: true,
      }),
    ).rejects.toMatchObject({
      code: 'bad_request',
      message: 'the project has no git — a worktree cannot be created',
    });
    expect((await readMap(project, work.work.id)).sessions).toEqual([]);
  });

  it('1: sessions.create({ worktree: true }) — cwd стаба и createdAt в карте', async () => {
    await initGitProject(project);
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    setEnv('PARLEY_WORKTREE_ROOT', await tempWorktreeRoot());

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
    setEnv('PARLEY_WORKTREE_ROOT', await tempWorktreeRoot());

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
    expect(brief).toContain(`Worktree: branch \`${worktree?.branch}\` off base \`${worktree?.base}\``);

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
    expect(letter?.text).toMatch(/^worktree for S\d+ was not created: /);
    // Человеку — тот же текст уведомлением: письмо родителю и уведомление окна не расходятся.
    expect((notice?.data as { text: string }).text).toBe(letter?.text);
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

describe('скилл parley при запуске сессии (кусок 10 плана комнат)', () => {
  const skillIn = (dir: string): string => path.join(dir, '.agents', 'skills', 'parley', 'SKILL.md');
  const aliasIn = (dir: string): string => path.join(dir, '.claude', 'skills', 'parley');
  const porcelain = async (dir: string): Promise<string> =>
    (await runGit('git', ['-C', dir, 'status', '--porcelain', '-uall'])).stdout;

  it('создание сессии кладёт скилл в проект: канонная копия, симлинк для Claude Code, строки в info/exclude', async () => {
    await initGitProject(project);
    const work = await createWork(project, { title: 'Работа', goal: '' });
    setEnv('STUB_ARGS_FILE', await tempArgsFile());

    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const ref = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: 'бэкенд',
      task: '',
      parent: null,
    });

    expect(await readFile(skillIn(project), 'utf8')).toBe(SKILL_MD);
    expect((await lstat(aliasIn(project))).isSymbolicLink()).toBe(true);
    expect(await readlink(aliasIn(project))).toBe(path.join('..', '..', '.agents', 'skills', 'parley'));
    const status = await porcelain(project);
    expect(status).not.toContain('.agents');
    expect(status).not.toContain('.claude');

    await service.stop(ref);
  });

  it('прежняя установка под именем harnas (учёт в .harnas) при запуске убирается, новый скилл встаёт на её место', async () => {
    await initGitProject(project);
    // Проект, каким его оставила прошлая сборка: каталог состояния `.harnas`, в нём учёт, на диске — папка и симлинк.
    const oldStub = 'заглушка прежней сборки\n';
    const legacyDir = path.join(project, '.agents', 'skills', 'harnas');
    const legacyLink = path.join(project, '.claude', 'skills', 'harnas');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(path.join(legacyDir, 'SKILL.md'), oldStub, 'utf8');
    await mkdir(path.dirname(legacyLink), { recursive: true });
    await symlink(path.join('..', '..', '.agents', 'skills', 'harnas'), legacyLink);
    await mkdir(path.join(project, '.harnas'));
    await writeFile(
      path.join(project, '.harnas', 'skills-receipt.json'),
      JSON.stringify({
        version: 1,
        entries: {
          [legacyDir]: { kind: 'dir', sha256: createHash('sha256').update(oldStub).digest('hex') },
          [legacyLink]: { kind: 'symlink', target: '../../.agents/skills/harnas' },
        },
      }),
      'utf8',
    );
    const work = await createWork(project, { title: 'Работа', goal: '' });
    setEnv('STUB_ARGS_FILE', await tempArgsFile());

    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const ref = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: 'бэкенд',
      task: '',
      parent: null,
    });

    expect(existsSync(legacyDir)).toBe(false);
    expect(existsSync(legacyLink)).toBe(false);
    expect(await readFile(skillIn(project), 'utf8')).toBe(SKILL_MD);
    expect((await lstat(aliasIn(project))).isSymbolicLink()).toBe(true);
    // Проект остался при прежнем каталоге состояния: нового `.parley` рядом с `.harnas` не завелось.
    expect(existsSync(path.join(project, '.parley'))).toBe(false);
    const status = await porcelain(project);
    expect(status).not.toContain('.agents');
    expect(status).not.toContain('.claude');

    await service.stop(ref);
  });

  it('сессия со своим worktree: скилл и в worktree, где стартует стаб, и в проекте; git status обоих чист', async () => {
    await initGitProject(project);
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    setEnv('PARLEY_WORKTREE_ROOT', await tempWorktreeRoot());

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
    const worktree = (await readMap(project, work.work.id)).sessions.find((item) => item.id === ref.sessionId)
      ?.worktree?.path as string;
    expect(await realpath(args.cwd)).toBe(await realpath(worktree));
    // Скилл лежит уже к моменту старта процесса: агент видит его с первого хода.
    expect(await readFile(skillIn(worktree), 'utf8')).toBe(SKILL_MD);
    expect((await lstat(aliasIn(worktree))).isSymbolicLink()).toBe(true);
    expect(await readFile(skillIn(project), 'utf8')).toBe(SKILL_MD);
    for (const dir of [project, worktree]) {
      const status = await porcelain(dir);
      expect(status, dir).not.toContain('.agents');
      expect(status, dir).not.toContain('.claude');
    }

    await service.stop(ref);
  });

  it('agentSkills выключена: ни файла, ни учёта, сессия всё равно запускается', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    setEnv('PARLEY_AGENT_SKILLS', '0');

    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const ref = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: 'бэкенд',
      task: 'сделай штуку',
      parent: null,
    });

    await readArgs(argsFile);
    expect(existsSync(path.join(project, '.agents'))).toBe(false);
    expect(existsSync(path.join(project, '.claude'))).toBe(false);
    expect(existsSync(path.join(project, '.parley', 'skills-receipt.json'))).toBe(false);
    expect(existsSync(path.join(project, 'PARLEY.md'))).toBe(true);
    expect(JSON.parse(await readFile(path.join(project, '.parley', 'parley-md-receipt.json'), 'utf8')).created).toBe(true);

    await service.stop(ref);
  });

  it('чужой скилл в проекте не тронут; сессия стартует, окно получает одно host.notice на два запуска', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    await mkdir(path.dirname(skillIn(project)), { recursive: true });
    await writeFile(skillIn(project), 'скилл команды\n', 'utf8');

    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const create = (label: string) =>
      service.create({
        projectPath: project,
        workId: work.work.id,
        provider: 'claude',
        label,
        task: 'сделай штуку',
        parent: null,
      });
    const first = await create('один');
    await readArgs(argsFile);
    const second = await create('два');

    expect(await readFile(skillIn(project), 'utf8')).toBe('скилл команды\n');
    expect(existsSync(aliasIn(project))).toBe(false);
    const notices = broadcasts.filter((item) => item.event === 'host.notice' && (item.data as { kind: string }).kind === 'skill-foreign');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.data).toMatchObject({ kind: 'skill-foreign', ref: null });

    await service.stop(first);
    await service.stop(second);
  });
});

describe('модель и усилие из карты: сессия, заведённая spawn_session', () => {
  it('pending от spawn_session запускается с записанными моделью и усилием: флаги в argv стаба', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    // Так `spawn_session` агента заводит запись: выбор лежит в карте, а поднимает её хост позже и без диалога.
    const sessionId = await createPendingSession(project, work.work.id, {
      provider: 'claude',
      label: 'бэкенд',
      task: 'сделай штуку',
      model: 'opus',
      effort: 'high',
    });
    const ref: SessionRef = { projectPath: project, workId: work.work.id, sessionId };

    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    await service.launch(ref, 'launch');

    const args = await readArgs(argsFile);
    expect(args.argv[args.argv.indexOf('--model') + 1]).toBe('opus');
    expect(args.argv[args.argv.indexOf('--effort') + 1]).toBe('high');

    await service.stop(ref);
  });
});

describe('session layer warnings and final spawn budget', () => {
  const roomy = async () => ({ argMax: 1048576, pointerSize: 8 });
  const makeRef = async (projectPath = project, provider = 'claude'): Promise<SessionRef> => {
    const work = await createWork(projectPath, { title: 'Layer budget', goal: '' });
    const sessionId = await createPendingSession(projectPath, work.work.id, { provider, label: 'fixture', task: 'Use fixtures' });
    return { projectPath, workId: work.work.id, sessionId };
  };

  it('checks the final registered hook token and inherited env, refuses before PTY and unregisters', async () => {
    setEnv('PARLEY_HOME', path.join(project, 'home'));
    setEnv('P09_PRIVATE_ENV', 'private-environment-value'.repeat(3000));
    const host = fakeHost();
    const pty = createPtyManager(host);
    const start = vi.spyOn(pty, 'start');
    const unregister = vi.fn();
    const token = 'private-hook-token'.repeat(3000);
    const registered = vi.fn(() => token);
    const service = createSessionsService(host, fakeWorks(), pty, fakeActivity(), {
      hooks: { url: () => 'http://127.0.0.1:4321/hooks', register: registered, unregister },
      providerVersions: { ready: Promise.resolve(), get: () => '999.0.0' },
      spawnLimits: async () => { expect(registered).toHaveBeenCalledTimes(1); return { argMax: 50000, pointerSize: 8 }; },
    });
    const ref = await makeRef();
    await expect(service.launch(ref, 'launch')).rejects.toThrow('spawn-budget-too-large');
    expect(start).not.toHaveBeenCalled();
    expect(unregister).toHaveBeenCalledWith(ref);
    expect(JSON.stringify(broadcasts)).not.toContain('private-hook-token');
    expect(JSON.stringify(broadcasts)).not.toContain('private-environment-value');
    await service.stopAll();
  });

  it('an unknown native limit fails before PTY, without claiming a guessed budget', async () => {
    setEnv('PARLEY_HOME', path.join(project, 'home'));
    const host = fakeHost();
    const pty = createPtyManager(host);
    const start = vi.spyOn(pty, 'start');
    const service = createSessionsService(host, fakeWorks(), pty, fakeActivity(), { spawnLimits: async () => null });
    await expect(service.launch(await makeRef(), 'launch')).rejects.toThrow('spawn-budget-unavailable');
    expect(start).not.toHaveBeenCalled();
    await service.stopAll();
  });

  it('native E2BIG never forwards the native error text or final environment', async () => {
    setEnv('PARLEY_HOME', path.join(project, 'home'));
    const host = fakeHost();
    const pty = createPtyManager(host);
    vi.spyOn(pty, 'start').mockImplementation(() => { throw Object.assign(new Error('PRIVATE_NATIVE_COMMAND_AND_ENV'), { code: 'E2BIG' }); });
    const service = createSessionsService(host, fakeWorks(), pty, fakeActivity(), { spawnLimits: roomy });
    const error = await service.launch(await makeRef(), 'launch').catch((caught: unknown) => caught);
    expect(String(error)).toContain('spawn-budget-too-large');
    expect(String(error)).not.toContain('PRIVATE_NATIVE_COMMAND_AND_ENV');
    expect(JSON.stringify(broadcasts)).not.toContain('PRIVATE_NATIVE_COMMAND_AND_ENV');
    await service.stopAll();
  });

  it('logs each PARLEY warning attempt but notices once per host/project/code', async () => {
    setEnv('PARLEY_HOME', path.join(project, 'home'));
    await mkdir(path.join(project, 'PARLEY.md'));
    const host = fakeHost();
    const warn = vi.spyOn(host.log, 'warn');
    const pty = createPtyManager(host);
    vi.spyOn(pty, 'start').mockImplementation(() => { throw Object.assign(new Error('fixture'), { code: 'E2BIG' }); });
    const service = createSessionsService(host, fakeWorks(), pty, fakeActivity(), { spawnLimits: roomy });
    const ref = await makeRef();
    for (let i = 0; i < 2; i += 1) await service.launch(ref, 'launch').catch(() => {});
    expect(warn.mock.calls.filter((call) => JSON.stringify(call).includes('parley-md-unreadable'))).toHaveLength(2);
    expect(broadcasts.filter((item) => item.event === 'host.notice' && (item.data as { kind: string }).kind === 'parley-md-unreadable')).toHaveLength(1);
    const otherProject = await mkdtemp(path.join(tmpdir(), 'parley-layer-other-'));
    try {
      await mkdir(path.join(otherProject, 'PARLEY.md'));
      await service.launch(await makeRef(otherProject), 'launch').catch(() => {});
      expect(broadcasts.filter((item) => item.event === 'host.notice' && (item.data as { kind: string }).kind === 'parley-md-unreadable')).toHaveLength(2);
    } finally { await rm(otherProject, { recursive: true, force: true }); }
    await service.stopAll();
  });

  it('override gap notices are global for this host, not repeated per project', async () => {
    const home = path.join(project, 'home');
    setEnv('PARLEY_HOME', home);
    await mkdir(home);
    await writeFile(path.join(home, 'providers.json'), JSON.stringify({ codex: { args: ['{prompt}'] } }));
    setEnv('PARLEY_CODEX_BIN', STUB);
    const host = fakeHost();
    const warn = vi.spyOn(host.log, 'warn');
    const pty = createPtyManager(host);
    vi.spyOn(pty, 'start').mockImplementation(() => { throw Object.assign(new Error('fixture'), { code: 'E2BIG' }); });
    const service = createSessionsService(host, fakeWorks(), pty, fakeActivity(), { spawnLimits: roomy });
    const otherProject = await mkdtemp(path.join(tmpdir(), 'parley-layer-other-'));
    try {
      for (const dir of [project, otherProject]) await service.launch(await makeRef(dir, 'codex'), 'launch').catch(() => {});
      expect(warn.mock.calls.filter((call) => JSON.stringify(call).includes('provider-override-gap'))).toHaveLength(2);
      expect(broadcasts.filter((item) => item.event === 'host.notice' && (item.data as { kind: string }).kind === 'provider-override-gap')).toHaveLength(1);
    } finally { await rm(otherProject, { recursive: true, force: true }); }
    await service.stopAll();
  });
});

describe('PARLEY.md before every host launch', () => {
  it.each(['launch', 'new', 'resume'] as const)('accounts once before %s; deletion is preserved on another attempt', async (mode) => {
    setEnv('PARLEY_AGENT_SKILLS', '0');
    const work = await createWork(project, { title: 'Rules', goal: '' });
    const sessionId = await createPendingSession(project, work.work.id, { provider: 'claude', label: 'fixture', task: '' });
    const ref = { projectPath: project, workId: work.work.id, sessionId };
    const host = fakeHost();
    const pty = createPtyManager(host);
    const start = vi.spyOn(pty, 'start').mockImplementation(() => {
      expect(existsSync(path.join(project, 'PARLEY.md'))).toBe(true);
      throw Object.assign(new Error('fixture'), { code: 'E2BIG' });
    });
    const sessions = createSessionsService(host, fakeWorks(), pty, fakeActivity());
    await expect(sessions.launch(ref, mode)).rejects.toThrow('spawn-budget-too-large');
    expect(start).toHaveBeenCalledOnce();
    expect(broadcasts.filter((item) => item.event === 'host.notice' && (item.data as { kind: string }).kind === 'parley-md-created')).toHaveLength(1);
    await rm(path.join(project, 'PARLEY.md'));
    start.mockImplementation(() => { throw Object.assign(new Error('fixture'), { code: 'E2BIG' }); });
    await expect(sessions.launch(ref, mode)).rejects.toThrow('spawn-budget-too-large');
    expect(existsSync(path.join(project, 'PARLEY.md'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an initial receipt permission failure leaves PARLEY.md absent and still reaches PTY', async () => {
    setEnv('PARLEY_AGENT_SKILLS', '0');
    const work = await createWork(project, { title: 'Rules', goal: '' });
    const sessionId = await createPendingSession(project, work.work.id, { provider: 'claude', label: 'fixture', task: '' });
    const ref = { projectPath: project, workId: work.work.id, sessionId };
    const host = fakeHost();
    const warning = vi.spyOn(host.log, 'warn');
    const pty = createPtyManager(host);
    const start = vi.spyOn(pty, 'start').mockImplementation(() => { throw Object.assign(new Error('fixture'), { code: 'E2BIG' }); });
    const sessions = createSessionsService(host, fakeWorks(), pty, fakeActivity());
    await chmod(path.join(project, '.parley'), 0o500);
    try {
      await expect(sessions.launch(ref, 'new')).rejects.toThrow('spawn-budget-too-large');
      expect(start).toHaveBeenCalledOnce();
      expect(warning.mock.calls.some(([message]) => message.includes('could not create PARLEY.md'))).toBe(true);
      expect(existsSync(path.join(project, 'PARLEY.md'))).toBe(false);
    } finally { await chmod(path.join(project, '.parley'), 0o700); }
  });

  it('broken accounting logs once per host/project and never prevents a PTY launch attempt', async () => {
    setEnv('PARLEY_AGENT_SKILLS', '0');
    const work = await createWork(project, { title: 'Rules', goal: '' });
    const sessionId = await createPendingSession(project, work.work.id, { provider: 'claude', label: 'fixture', task: '' });
    const ref = { projectPath: project, workId: work.work.id, sessionId };
    await mkdir(path.join(project, '.parley', 'parley-md-receipt.json'));
    const host = fakeHost();
    const warning = vi.spyOn(host.log, 'warn');
    const pty = createPtyManager(host);
    const start = vi.spyOn(pty, 'start').mockImplementation(() => { throw Object.assign(new Error('fixture'), { code: 'E2BIG' }); });
    const sessions = createSessionsService(host, fakeWorks(), pty, fakeActivity());
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(sessions.launch(ref, 'new')).rejects.toThrow('spawn-budget-too-large');
    }
    expect(start).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls.filter(([message]) => message.includes('accounting'))).toHaveLength(1);
    expect(existsSync(path.join(project, 'PARLEY.md'))).toBe(false);
  });
});


describe('current role delivery and explicit session choices', () => {
  it.each([{ model: '', cleared: false }, { model: null, cleared: true }])('keeps legacy empty model omitted and exact null explicit ($cleared)', async ({ model, cleared }) => {
    setEnv('PARLEY_HOME', path.join(project, 'home'));
    const { work } = await createWork(project, { title: 'Roles', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const ref = await service.create({ projectPath: project, workId: work.id, provider: 'claude', label: 'Plan', task: 'Plan', parent: null, role: { source: 'builtin', name: 'planner' }, model, ...(cleared ? { effort: null } : {}) });
    try {
      const stored = (await readMap(project, work.id)).sessions.find(item => item.id === ref.sessionId)!;
      expect(stored.role).toEqual({ source: 'builtin', name: 'planner' });
      expect(Object.hasOwn(stored, 'agent')).toBe(false);
      expect(Object.hasOwn(stored, 'model')).toBe(cleared);
      expect(Object.hasOwn(stored, 'effort')).toBe(cleared);
      const args = await readArgs(argsFile);
      expect(args.argv[args.argv.indexOf('--disallowedTools') + 1]).toBe('Edit,Write,NotebookEdit');
      if (cleared) {
        expect(args.argv).not.toContain('--model'); expect(args.argv).not.toContain('--effort');
      } else {
        expect(args.argv[args.argv.indexOf('--model') + 1]).toBe('opus');
        expect(args.argv[args.argv.indexOf('--effort') + 1]).toBe('high');
      }
    } finally { await service.stop(ref); }
  });
  it('rejects mandatory role channel gaps and alias conflicts before map or PTY mutation', async () => {
    const home = path.join(project, 'home'); setEnv('PARLEY_HOME', home);
    const { work } = await createWork(project, { title: 'Roles', goal: '' });
    const pty = createPtyManager(fakeHost()); const start = vi.spyOn(pty, 'start');
    const service = createSessionsService(fakeHost(), fakeWorks(), pty, fakeActivity());
    const input = { projectPath: project, workId: work.id, provider: 'claude', label: 'Plan', task: 'Plan', parent: null, role: { source: 'builtin' as const, name: 'planner' } };
    await expect(service.create({ ...input, agent: 'legacy' })).rejects.toThrow('agent-and-role-conflict');
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, 'providers.json'), JSON.stringify({ claude: { resumeArgs: ['--resume', '{providerSessionId}', '--append-system-prompt', '{systemPrompt}'] } }));
    await expect(service.create(input)).rejects.toThrow('role-permissions-unavailable');
    expect((await readMap(project, work.id)).sessions).toHaveLength(0);
    expect(start).not.toHaveBeenCalled();
  });
});


describe('removed role warning delivery', () => {
  it('logs each attempt but shows the safe warning once for each participant', async () => {
    setEnv('PARLEY_HOME', path.join(project, 'home'));
    const { work } = await createWork(project, { title: 'Roles', goal: '' });
    const host = fakeHost(); const warn = vi.fn(); host.log.warn = warn;
    const service = createSessionsService(host, fakeWorks(), createPtyManager(host), fakeActivity(), { roleCatalog: async () => buildRoleCatalog() });
    const sessionId = await createPendingSession(project, work.id, { provider: 'claude', label: 'Old role', task: 'Continue', role: { source: 'claude', name: 'removed' } });
    const ref = { projectPath: project, workId: work.id, sessionId };
    try {
      await service.launch(ref, 'new'); await service.stop(ref);
      await service.launch(ref, 'new'); await service.stop(ref);
      const notices = broadcasts.filter(item => item.event === 'host.notice' && (item.data as { kind: string }).kind === 'role-missing');
      expect(notices).toHaveLength(1);
      expect(notices[0]?.data).toMatchObject({ kind: 'role-missing', ref });
      expect(JSON.stringify(notices)).not.toContain('removed');
      expect(warn.mock.calls.filter(args => (args[1] as { code?: string } | undefined)?.code === 'role-missing')).toHaveLength(2);
    } finally { await service.stopAll(); }
  });
});

describe('participant native context launch binding', () => {
  it('forwards the actual LaunchPlan revision into the successful PID/start stamp', async () => {
    setEnv('PARLEY_SKILL_NAVIGATOR', '1'); setEnv('PARLEY_CODEX_BIN', STUB);
    const work = await createWork(project, { title: 'Bound native context', goal: '' });
    const argsFile = await tempArgsFile(); setEnv('STUB_ARGS_FILE', argsFile);
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    let ref: SessionRef | undefined;
    try {
      ref = await service.create({ projectPath: project, workId: work.work.id, provider: 'codex', label: 'Context', task: 'Review', parent: null });
      const args = await readArgs(argsFile);
      const value = JSON.parse(await readFile(path.join(project, '.parley/local/native-context', work.work.id, `${ref.sessionId}.json`), 'utf8'));
      const session = (await readMap(project, work.work.id)).sessions.find(item => item.id === ref!.sessionId)!;
      expect(value.process).toEqual({ pid: session.pid, startedAtProcess: session.startedAtProcess });
      expect(value.process.pid).toBeGreaterThan(0); expect(value.process.startedAtProcess).toBeTypeOf('string');
      expect(args.argv.find(arg => arg.startsWith('mcp_servers.parley='))).toContain(`PARLEY_NATIVE_CONTEXT_REVISION=${JSON.stringify(value.revision)}`);
      expect(value.configArgs).toEqual([]);
    } finally {
      if (ref) await service.stop(ref);
      await rm(path.dirname(argsFile), { recursive: true, force: true });
    }
  });
});
