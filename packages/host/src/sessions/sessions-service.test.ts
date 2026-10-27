import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addSession,
  addRoom,
  buildRoleCatalog,
  codexModelsFile,
  createPendingSession,
  createWork,
  createWorktree,
  grantTrust,
  defaultSessionName,
  NEW_LABEL,
  plannedWorktree,
  readMap,
  readStoredMap,
  saveConfig,
  setWorkStatus,
  SKILL_MD,
  SYSTEM,
  ENGINE,
  startAttempt,
  transitionSession,
  updateMap,
  workPaths,
} from '@parley/core';
import type { RoleCatalog, RoomPlan, WorktreeInfo } from '@parley/core';
import type { EventData, EventName, SessionRef } from '@parley/protocol';
import type { ActivityService, SessionLive } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import type { ProviderVersions } from '../providers/versions.js';
import { createPtyManager } from '../pty/pty-manager.js';
import type { PtyManager } from '../pty/pty-manager.js';
import { createWorksService } from '../works/works-service.js';
import type { WorksService } from '../works/works-service.js';
import { atPrompt, busyError, createSessionsService, createSwitchLock } from './sessions-service.js';
import { createWorktreesService } from '../worktrees/worktrees-service.js';
import type { SessionsFeedOptions, SessionsService } from './sessions-service.js';

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

/**
 * `nudge` — подталкивание для ожидания, которое зависит от fs-наблюдателя: запись карты, сделанная сразу после
 * `works.start()`, уходит раньше, чем наблюдатель проекта включился, и событие теряется (под нагрузкой это
 * случалось). Холостая запись карты раз в секунду даёт сервису новое событие; сам запуск по-прежнему
 * определяется диффом снимков, так что проверяемое поведение то же.
 */
async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  nudge?: () => Promise<unknown>,
): Promise<void> {
  const started = Date.now();
  let nudgedAt = started;
  for (;;) {
    if (await check()) return;
    const now = Date.now();
    if (now - started > timeoutMs) throw new Error('не дождались условия');
    if (nudge !== undefined && now - nudgedAt >= 1000) {
      nudgedAt = now;
      await nudge();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Тесты файла ждут настоящий процесс стаба или автозапуск через наблюдатель карт; под нагрузкой машины (полный
 * прогон рядом с другими наборами) пять секунд по умолчанию — и для ожидания условия, и для самого теста — им
 * хватало не всегда. Это верхняя граница, а не пауза: условие проверяется как и прежде и не ослаблено.
 */
const REAL_PROCESS_WAIT_MS = 20_000;
vi.setConfig({ testTimeout: 30_000 });

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
  // Навигатор включён по умолчанию с 2026-10-06: тесты вне его блока проверяют запуск без него, а блок про навигатор
  // включает его сам.
  setEnv('PARLEY_SKILL_NAVIGATOR', '0');
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of extraEnv) delete process.env[key];
  extraEnv = [];
  await Promise.all(worksServices.map((service) => service.stop()));
  worksServices = [];
  // Процессы стаба после выхода ещё дописывают карту и журнал; повторы убирают гонку «каталог не пуст».
  await rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    PARLEY_HOOK_URL: string | null;
    PARLEY_AGENT_TOKEN: string | null;
  };
}

async function readArgs(file: string): Promise<StubArgs> {
  await waitFor(() => existsSync(file), REAL_PROCESS_WAIT_MS);
  return JSON.parse(await readFile(file, 'utf8')) as StubArgs;
}

describe('Git connectivity after worktree sessions', () => {
  async function fixture(provider = 'codex', role = 'executor', withWorktree = true) {
    await initGitProject(project);
    const { work } = await createWork(project, { title: 'Git connectivity' });
    const sessionId = await createPendingSession(project, work.id, { provider, label: '', task: '', role: { source: 'builtin', name: role } });
    const ref = { projectPath: project, workId: work.id, sessionId };
    const info = plannedWorktree(project, work.id, sessionId, 'main', path.join(project, 'worktrees'));
    if (withWorktree) {
      await createWorktree(project, info);
      info.createdAt = new Date().toISOString();
      await updateMap(project, work.id, map => { map.sessions[0]!.worktree = info; });
    }
    return { ref, info };
  }

  async function withGitStub(info: WorktreeInfo, code: number, task: (marker: string) => Promise<void>) {
    const binary = (await runGit('which', ['git'])).stdout.trim();
    const dir = path.join(project, 'git-bin'); await mkdir(dir);
    const marker = path.join(project, 'fsck.jsonl');
    const stub = path.join(dir, 'git');
    await writeFile(stub, `#!/usr/bin/env node\nconst fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);if(args.includes('fsck')){fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({args,worktreeExists:fs.existsSync(${JSON.stringify(info.path)})})+'\\n');process.exit(${code});}const r=cp.spawnSync(${JSON.stringify(binary)},args,{stdio:'inherit'});process.exit(r.status??1);\n`);
    await chmod(stub, 0o755);
    const original = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${original ?? ''}`;
    try { await task(marker); } finally { process.env.PATH = original; }
  }

  function lifecyclePty(active: boolean): PtyManager {
    let exit: (ref: SessionRef, result: { exitCode: number }) => void;
    return {
      on(event: string, listener: typeof exit) { if (event === 'exit') exit = listener; return () => {}; },
      start(ref: SessionRef, launch: { provider: string }) {
        active = true;
        return { ref, pid: process.pid, startedAt: Date.now(), cols: 120, rows: 40, provider: launch.provider,
          hasDraft: () => false, bracketedPaste: () => false };
      },
      get: () => active ? {} : undefined,
      stop: async (ref: SessionRef) => { active = false; const result = { exitCode: 0 }; exit(ref, result); return result; },
    } as unknown as PtyManager;
  }

  it.each([['exit', 0], ['exit', 1], ['natural-exit', 0], ['natural-exit', 1], ['delete', 0], ['delete', 1], ['discard', 0], ['discard', 1]] as const)('%s waits for Git fsck and warns only on failure (%s)', async (action, code) => {
    const { ref, info } = await fixture();
    await withGitStub(info, code, async marker => {
      const host = fakeHost(); const warning = vi.spyOn(host.log, 'warn');
      const pty = lifecyclePty(action !== 'delete' && action !== 'discard');
      const sessions = createSessionsService(host, fakeWorks(), pty, fakeActivity());
      if (action === 'natural-exit') { await pty.stop(ref); await sessions.stop(ref); }
      else if (action === 'exit') await sessions.stop(ref);
      else if (action === 'discard') await createWorktreesService(sessions).discard(ref, true);
      else await sessions.delete(ref, true);
      const calls = (await readFile(marker, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual(expect.arrayContaining(['fsck', '--connectivity-only']));
      expect(calls[0].worktreeExists).toBe(action !== 'delete' && action !== 'discard');
      const notices = broadcasts.filter(item => item.event === 'host.notice' && (item.data as { kind: string }).kind === 'git-connectivity-failed');
      expect(notices).toHaveLength(code === 0 ? 0 : 1);
      expect(warning.mock.calls.some(([message]) => message === 'Git connectivity check failed')).toBe(code !== 0);
    });
  });

  it.each([['claude', 'executor', true], ['codex', 'executor', false]] as const)('leaves %s/%s worktree=%s unchanged', async (provider, role, withWorktree) => {
    const { ref, info } = await fixture(provider, role, withWorktree);
    await withGitStub(info, 1, async marker => {
      const sessions = createSessionsService(fakeHost(), fakeWorks(), lifecyclePty(true), fakeActivity());
      await sessions.stop(ref);
      expect(existsSync(marker)).toBe(false);
      expect(broadcasts.some(item => item.event === 'host.notice')).toBe(false);
    });
  });

  it.each([['exit', false], ['delete', false], ['exit', true]] as const)('uses the issued native-role grant after %s (initial readOnly=%s)', async (action, initiallyReadOnly) => {
    const { ref, info } = await fixture();
    setEnv('PARLEY_CODEX_BIN', STUB);
    await saveConfig({ codexWriteApprovals: 'terminal' });
    await updateMap(project, ref.workId, map => { map.sessions[0]!.role = { source: 'codex', name: 'changing' }; });
    let readOnly = initiallyReadOnly;
    const roleCatalog = async (): Promise<RoleCatalog> => ({ roles: [{ id: 'codex:changing', source: 'codex', provider: 'codex', name: 'Changing', description: '', path: '/fixture.toml', prompt: 'Role', readOnly, sandboxMode: readOnly ? 'read-only' : 'workspace-write' }], diagnostics: [], partial: false });
    await withGitStub(info, 1, async marker => {
      const sessions = createSessionsService(fakeHost(), fakeWorks(), lifecyclePty(false), fakeActivity(), { roleCatalog });
      expect(await sessions.launch(ref, 'launch')).toBe('started');
      readOnly = true;
      if (action === 'exit') await sessions.stop(ref);
      else await sessions.delete(ref, true);
      expect(existsSync(marker)).toBe(!initiallyReadOnly);
      if (!initiallyReadOnly) {
        const calls = (await readFile(marker, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(calls.at(-1).worktreeExists).toBe(action === 'exit');
        expect(broadcasts.some(item => item.event === 'host.notice' && (item.data as { kind: string }).kind === 'git-connectivity-failed')).toBe(true);
      }
    });
  });

  it('checks historical worktree grants conservatively after host restart, including current read-only roles', async () => {
    const { ref, info } = await fixture('codex', 'critic');
    await withGitStub(info, 1, async marker => {
      const sessions = createSessionsService(fakeHost(), fakeWorks(), lifecyclePty(false), fakeActivity());
      await createWorktreesService(sessions).discard(ref, true);
      const calls = (await readFile(marker, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(calls).toHaveLength(1);
      expect(calls[0].worktreeExists).toBe(false);
    });
  });
});

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

  it('быстрая сессия сохраняет ярлык из диалога; пустой ярлык оставляет имя по умолчанию по номеру', async () => {
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
    expect(map.sessions.find((s) => s.id === unnamed.sessionId)?.label).toBe(defaultSessionName(unnamed.sessionId));

    await service.stop(named);
    await service.stop(unnamed);
  });
});

describe('create(): модель и усилие из диалога (дизайн комнат, 3.2)', () => {
  /** Запускает сессию провайдера и отдаёт argv стаба; `task: ''` — тихий старт, как у комнат. */
  async function launched(
    provider: string,
    choice: { model?: string; effort?: string },
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

  it('codex: итоговые флаги запуска — свои настройки харнесса, без обходов; доверенный проект получает projects', async () => {
    setEnv('PARLEY_CODEX_BIN', STUB);
    // Доверие записано в `trust.json` домашней папки теста: сессия в нём стартует без экрана доверия Codex.
    setEnv('PARLEY_HOME', await mkdtemp(path.join(tmpdir(), 'parley-sessions-home-')));
    await grantTrust(project, 'window');
    const argv = await launched('codex', {});

    // Не считая бинаря и скрипта заглушки: то, что получил бы настоящий codex.
    const args = argv.slice(2);
    // Флага `-a on-request` больше нет: политика одобрений приходит ключами `-c` (`approval_policy`).
    expect(args[0]).toBe('--no-daemon');
    expect(args).not.toContain('-a');
    const overrides = args.flatMap((arg, index) => (args[index - 1] === '-c' ? [arg] : []));
    expect(overrides.map((override) => override.split('=')[0])).toEqual([
      'mcp_servers.parley',
      'developer_instructions',
      'sandbox_mode',
      'approval_policy',
      'projects',
      'project_doc_fallback_filenames',
      'tui.terminal_title',
      'tui.notifications',
      'tui.notification_method',
      'tui.notification_condition',
    ]);
    // Ключ доверия — realpath проекта (на macOS `/var` и `/private/var` — одна папка).
    expect(overrides.find((override) => override.startsWith('projects='))).toContain(await realpath(project));
    expect(args.join(' ')).not.toMatch(/never|dangerous|yolo|full-auto|danger-full|hooks/);
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
    // Каждый вызов — уже под `rejects`: промис, созданный заранее, отклоняется, пока цикл ждёт
    // предыдущий, и vitest считает отказ необработанным (CI на медленном раннере).
    for (const attempt of [
      () => create(work.work.id, 'claude', '', 'gpt-6-sol'),
      () => create(work.work.id, 'claude', 'сделай штуку', 'sonnet[1M]'),
      () => create(null, 'codex', '', 'opus'),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ name: 'HostError', code: 'bad_request' });
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

  it('GLM rejects an unsupported model before launch', async () => {
    await expect(launched('glm', { model: 'glm-4', effort: 'high' })).rejects.toThrow();
  });

  it('уровень сверх прежних трёх доезжает до команды: claude --effort xhigh', async () => {
    const argv = await launched('claude', { model: 'opus', effort: 'xhigh' });

    expect(argv[argv.indexOf('--effort') + 1]).toBe('xhigh');
  });

  it('codex с каталогом из файла хоста: модель и уровень из каталога CLI доезжают до команды', async () => {
    setEnv('PARLEY_CODEX_BIN', STUB);
    // Свой дом: файл каталога не должен достаться другим тестам процесса.
    const home = await mkdtemp(path.join(tmpdir(), 'parley-sessions-home-'));
    setEnv('PARLEY_HOME', home);
    try {
      const models = [{ id: 'gpt-7-nova', label: 'GPT-7-Nova', efforts: [{ id: 'ultra', label: 'Ultra' }] }];
      await writeFile(codexModelsFile(), JSON.stringify({ fetchedAt: '2026-10-06T10:00:00.000Z', models }), 'utf8');

      const argv = await launched('codex', { model: 'gpt-7-nova', effort: 'ultra' });

      expect(argv[argv.indexOf('--model') + 1]).toBe('gpt-7-nova');
      expect(argv).toContain('model_reasoning_effort="ultra"');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('все пути создания пишут разрешённые model и effort в запись сессии (спека нормалайзера, 5.5); без выбора полей нет', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    setEnv('STUB_ARGS_FILE', await tempArgsFile());
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const base = { projectPath: project, provider: 'claude', label: '' };
    const choice = { model: 'opus', effort: 'xhigh' };

    // Тихий старт, новая работа под быструю сессию, `pending` с задачей.
    const refs = [
      await service.create({ ...base, workId: work.work.id, task: '', parent: null, ...choice }),
      await service.create({ ...base, workId: null, task: '', parent: null, ...choice }),
      await service.create({ ...base, workId: work.work.id, task: 'сделай штуку', parent: null, ...choice }),
    ];
    for (const ref of refs) {
      const map = await readMap(ref.projectPath, ref.workId);
      expect(map.sessions.find((candidate) => candidate.id === ref.sessionId), ref.sessionId).toMatchObject(choice);
      await service.stop(ref);
    }

    const plain = await service.create({ ...base, workId: work.work.id, task: '', parent: null });
    const session = (await readMap(project, work.work.id)).sessions.find((candidate) => candidate.id === plain.sessionId);
    expect(session).toBeDefined();
    expect(Object.keys(session ?? {})).not.toContain('model');
    expect(Object.keys(session ?? {})).not.toContain('effort');
    await service.stop(plain);
  });

  it('пара не из каталога — bad_request до первой записи: ни сессии, ни процесса', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const create = (task: string, choice: { model?: string; effort: string }) =>
      service.create({ projectPath: project, workId: work.work.id, provider: 'claude', label: '', task, parent: null, ...choice });

    await expect(create('', { model: 'haiku', effort: 'high' })).rejects.toThrow(/haiku has no effort levels/);
    await expect(create('сделай штуку', { model: 'opus', effort: 'ultra' })).rejects.toThrow(/ultra is not a level of opus/);
    await expect(create('', { effort: 'ultra' })).rejects.toMatchObject({ name: 'HostError', code: 'bad_request' });

    expect(existsSync(argsFile)).toBe(false);
    expect((await readMap(project, work.work.id)).sessions).toEqual([]);
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

describe('время шагов в логе хоста', () => {
  it('create() пишет время шагов создания и запуска', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    setEnv('STUB_ARGS_FILE', await tempArgsFile());
    const info = vi.fn();
    const host = { ...fakeHost(), log: { info, warn: () => {}, error: () => {} } };

    const service = createSessionsService(host, fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const ref = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: 'бэкенд',
      task: 'сделай штуку',
      parent: null,
    });

    const launchLine = info.mock.calls.find(([msg]) => msg === 'запуск сессии: время шагов')?.[1] as
      | { totalMs: number; steps: Record<string, number>; failed?: boolean; provider?: string }
      | undefined;
    expect(launchLine).toBeDefined();
    expect(launchLine?.totalMs).toEqual(expect.any(Number));
    expect(Object.keys(launchLine?.steps ?? {})).toEqual(expect.arrayContaining(['plan', 'spawn', 'startWrite']));
    expect(launchLine?.failed).toBeUndefined();
    expect(launchLine?.provider).toBe('claude');

    const createLine = info.mock.calls.find(([msg]) => msg === 'создание сессии: время шагов')?.[1] as
      | { sessionId?: string; totalMs: number; steps: Record<string, number> }
      | undefined;
    expect(createLine?.sessionId).toBe(ref.sessionId);
    expect(Object.keys(createLine?.steps ?? {})).toEqual(expect.arrayContaining(['record', 'launch']));

    await service.stop(ref);
  });
});

describe('launch(): лента вида «Chat» — адрес приёмника и токен по версии claude (Task 2c)', () => {
  const hookEnv = ['PARLEY_HOOK_TOKEN', 'PARLEY_HOOK_URL', 'PARLEY_HOOK_CAPABILITY'];
  let inheritedHooks: Array<string | undefined>;
  beforeEach(() => {
    inheritedHooks = hookEnv.map(name => process.env[name]);
    for (const name of hookEnv) delete process.env[name];
  });
  afterEach(() => {
    hookEnv.forEach((name, index) => {
      if (inheritedHooks[index] === undefined) delete process.env[name];
      else process.env[name] = inheritedHooks[index];
    });
  });
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
    return { ready, get: (command) => versions[command] ?? null, fresh: async (command) => versions[command] ?? null };
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

  it('codex — вне режима parley и при «подходящей» версии — без токена', async () => {
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

  const hookArgv = (argv: string[]): string[] => argv.filter((arg) => arg.startsWith('hooks.'));
  const codexHookCommand = async (): Promise<string> => '/home/me/.parley/bin/parley-codex-hook';

  it('codex ≥ 0.160 вне режима parley (умолчание auto): ни токена, ни адреса, ни hooks.* в argv', async () => {
    const { hooks, registered } = fakeHooks();
    const launched = await launchWith(
      'codex',
      { hooks, providerVersions: fakeVersions({ codex: '0.160.0' }), codexHookCommand },
      { PARLEY_CODEX_BIN: STUB },
    );

    expect(registered).toEqual([]);
    expect(launched.args.env.PARLEY_HOOK_TOKEN).toBeNull();
    expect(launched.args.env.PARLEY_HOOK_URL).toBeNull();
    expect(hookArgv(launched.args.argv)).toEqual([]);

    await launched.stop();
  });

  it('codex ≥ 0.160 в режиме parley: токен, адрес и 7 пар -c hooks.… в argv', async () => {
    const { hooks, registered } = fakeHooks();
    const launched = await launchWith(
      'codex',
      { hooks, providerVersions: fakeVersions({ codex: '0.160.0' }), codexHookCommand },
      { PARLEY_CODEX_BIN: STUB, PARLEY_CODEX_WRITE_APPROVALS: 'parley' },
    );

    expect(registered).toHaveLength(1);
    expect(launched.args.env.PARLEY_HOOK_TOKEN).toBe(registered[0]?.token);
    expect(launched.args.env.PARLEY_HOOK_URL).toBe(HOOK_URL);
    expect(hookArgv(launched.args.argv)).toHaveLength(7);
    expect(launched.args.argv.join(' ')).toContain('/home/me/.parley/bin/parley-codex-hook');

    await launched.stop();
  });

  it('codex 0.159 (ниже порога) даже в режиме parley — без токена и хуков', async () => {
    const { hooks, registered } = fakeHooks();
    const launched = await launchWith(
      'codex',
      { hooks, providerVersions: fakeVersions({ codex: '0.159.0' }), codexHookCommand },
      { PARLEY_CODEX_BIN: STUB, PARLEY_CODEX_WRITE_APPROVALS: 'parley' },
    );

    expect(registered).toEqual([]);
    expect(launched.args.env.PARLEY_HOOK_TOKEN).toBeNull();
    expect(hookArgv(launched.args.argv)).toEqual([]);

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
    await waitFor(() => unregistered.length > 0, REAL_PROCESS_WAIT_MS);
    expect(unregistered).toEqual([launched.ref]);
    // Обработчик выхода после снятия токена ещё записывает сессию в карту: тест не кончается раньше него.
    await waitFor(async () => {
      const map = await readMap(project, launched.ref.workId);
      return map.sessions.find((candidate) => candidate.id === launched.ref.sessionId)?.lifecycle !== 'active';
    }, REAL_PROCESS_WAIT_MS);
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

describe('launch(): канал агента к браузеру — токен на каждый запуск у всех провайдеров (спека браузера 3.7; этап B2)', () => {
  const AGENT_URL = 'http://127.0.0.1:4321/agent/browser';

  function fakeAgent(url: string | null = AGENT_URL) {
    const registered: SessionRef[] = [];
    const unregistered: SessionRef[] = [];
    const agent: NonNullable<SessionsFeedOptions['agent']> = {
      url: () => url,
      register(ref) {
        registered.push(ref);
        return `${String(registered.length).padStart(2, '0')}${'a'.repeat(62)}`;
      },
      unregister(ref) {
        unregistered.push(ref);
      },
    };
    return { agent, registered, unregistered };
  }

  async function launchWith(provider: string, agent: NonNullable<SessionsFeedOptions['agent']>, extra: Record<string, string> = {}) {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    for (const [key, value] of Object.entries(extra)) setEnv(key, value);
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity(), { agent });
    const ref = await service.create({ projectPath: project, workId: work.work.id, provider, label: 'бэкенд', task: '', parent: null });
    return { args: await readArgs(argsFile), ref, service };
  }

  it('claude: адрес и токен — в env сервера parley файла --mcp-config (0600), не в окружении процесса', async () => {
    const { agent, registered } = fakeAgent();
    const { args, ref, service } = await launchWith('claude', agent);
    expect(registered).toEqual([ref]);
    const file = args.argv[args.argv.indexOf('--mcp-config') + 1] as string;
    const env = (JSON.parse(await readFile(file, 'utf8')) as { mcpServers: { parley: { env: Record<string, string> } } }).mcpServers.parley.env;
    expect(env['PARLEY_AGENT_URL']).toBe(AGENT_URL);
    expect(env['PARLEY_AGENT_TOKEN']).toBe(`01${'a'.repeat(62)}`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(args.env.PARLEY_AGENT_TOKEN).toBeNull();
    expect(args.argv.join('\n')).not.toContain(`01${'a'.repeat(62)}`);
    await service.stop(ref);
  });

  it('codex: тот же канал — в таблице env сервера `-c mcp_servers.parley`', async () => {
    const { agent } = fakeAgent();
    const { args, ref, service } = await launchWith('codex', agent, { PARLEY_CODEX_BIN: STUB });
    const override = args.argv.find((arg) => arg.startsWith('mcp_servers.parley=')) as string;
    expect(override).toContain(`PARLEY_AGENT_URL=${JSON.stringify(AGENT_URL)}`);
    expect(override).toContain(`PARLEY_AGENT_TOKEN=${JSON.stringify(`01${'a'.repeat(62)}`)}`);
    expect(args.env.PARLEY_AGENT_TOKEN).toBeNull();
    await service.stop(ref);
  });

  it('выход процесса снимает токен; эндпоинт не слушает — токена нет и в конфиге пусто', async () => {
    const live = fakeAgent();
    const launched = await launchWith('claude', live.agent);
    await launched.service.stop(launched.ref);
    await waitFor(() => live.unregistered.some((ref) => ref.sessionId === launched.ref.sessionId), REAL_PROCESS_WAIT_MS);

    const closed = fakeAgent(null);
    const plain = await launchWith('claude', closed.agent);
    expect(closed.registered).toEqual([]);
    const file = plain.args.argv[plain.args.argv.indexOf('--mcp-config') + 1] as string;
    expect(await readFile(file, 'utf8')).not.toContain('PARLEY_AGENT');
    await plain.service.stop(plain.ref);
  });

  it('pty.start бросил — выданный токен снимается, ошибка доходит до вызывающего', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const { agent, registered, unregistered } = fakeAgent();
    const pty = createPtyManager(fakeHost());
    const failing = {
      ...pty,
      start: () => {
        throw new Error('spawn не удался');
      },
    };
    const service = createSessionsService(fakeHost(), fakeWorks(), failing, fakeActivity(), { agent });
    await expect(
      service.create({ projectPath: project, workId: work.work.id, provider: 'claude', label: '', task: '', parent: null }),
    ).rejects.toThrow('spawn не удался');
    expect(registered).toHaveLength(1);
    expect(unregistered).toEqual([registered[0]]);
  });

  it('новый запуск той же сессии — новый вызов register: прежний токен реестр отзывает сам', async () => {
    const { agent, registered } = fakeAgent();
    const first = await launchWith('claude', agent);
    await first.service.stop(first.ref);
    await waitFor(async () => {
      const map = await readMap(project, first.ref.workId);
      return map.sessions.find((candidate) => candidate.id === first.ref.sessionId)?.lifecycle !== 'active';
    }, REAL_PROCESS_WAIT_MS);
    await first.service.launch(first.ref, 'resume');
    expect(registered).toHaveLength(2);
    expect(registered[1]).toEqual(first.ref);
    await first.service.stop(first.ref);
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

function service(options: Parameters<typeof createWorksService>[1] = {}): WorksService {
  const created = createWorksService(fakeHost(), options);
  worksServices.push(created);
  return created;
}

describe('legacy pending sessions', () => {
  it('does not auto-launch a stored legacy child when a map changes', async () => {
    await saveConfig({ autoLaunch: true });
    const work = await createWork(project, { title: 'Work', goal: '' });
    const parent = await createPendingSession(project, work.work.id, { provider: 'claude', label: 'Parent', task: '' });
    const works = service({ debounceMs: 30 });
    const pty = createPtyManager(fakeHost());
    const start = vi.spyOn(pty, 'start');
    createSessionsService(fakeHost(), works, pty, fakeActivity());
    await works.start();
    let childId = '';
    await updateMap(project, work.work.id, map => {
      const child = addSession(map, { provider: 'claude', label: 'Legacy child', task: 'Work', parent: null });
      child.parent = parent;
      childId = child.id;
    });
    await waitFor(() => works.entry(project, work.work.id)?.map.sessions.some(session => session.id === childId) === true);
    expect(start).not.toHaveBeenCalled();
    expect((await readMap(project, work.work.id)).sessions.find(session => session.id === childId)?.lifecycle).toBe('pending');
  });

  it.each(['', 'Implement the change'])('rejects nonnull parents before any effects (task=%s)', async task => {
    const work = await createWork(project, { title: 'Work', goal: '' });
    const parent = await createPendingSession(project, work.work.id, { provider: 'claude', label: 'Parent', task: '' });
    const before = await readMap(project, work.work.id);
    const files = await readdir(workPaths(project, work.work.id).dir);
    const pty = createPtyManager(fakeHost());
    const start = vi.spyOn(pty, 'start');
    const sessions = createSessionsService(fakeHost(), fakeWorks(), pty, fakeActivity());
    await expect(sessions.create({ projectPath: project, workId: work.work.id, provider: 'claude', label: 'Child', task, parent })).rejects.toThrow('Child sessions are no longer supported');
    expect(await readMap(project, work.work.id)).toEqual(before);
    expect(await readdir(workPaths(project, work.work.id).dir)).toEqual(files);
    expect(start).not.toHaveBeenCalled();
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

describe('архив работы', () => {
  it('9: работа ушла в archived при живом PTY — процесс получил SIGHUP, сессия спит', async () => {
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

    await setWorkStatus(project, work.work.id, 'archived');

    await waitFor(() => broadcasts.some((b) => b.event === 'pty.exit'), REAL_PROCESS_WAIT_MS);
    const exit = broadcasts.find((b) => b.event === 'pty.exit')?.data as { ref: SessionRef; signal: number | null };
    expect(exit.ref).toEqual(ref);
    expect(exit.signal).toBe(1);
    expect(sessions.live(ref)).toBe(false);

    // Не `closed`: после Reopen сессию поднимает Resume.
    await waitFor(async () => (await readMap(project, work.work.id)).sessions[0]?.lifecycle === 'sleeping');
  });

  it('10: сессию архивной работы не поднять — conflict; после Reopen поднимается', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const ref = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: 'a',
      task: 'т',
      parent: null,
    });
    await service.stop(ref);
    await setWorkStatus(project, work.work.id, 'archived');

    await expect(service.launch(ref, 'resume')).rejects.toMatchObject({ code: 'conflict' });
    expect(service.live(ref)).toBe(false);

    await setWorkStatus(project, work.work.id, 'active');
    await service.launch(ref, 'resume');
    expect(service.live(ref)).toBe(true);
    await service.stop(ref);
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

  it('2: историческая дочерняя сессия со своим worktree, запущенная явно, — каталог заведён до запуска стаба', async () => {
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

    // Сохранённый исторический план worktree:
    // каталог на диске к этому моменту ещё не существует, `createdAt` — `null`.
    let childId = '';
    await updateMap(project, work.work.id, (map) => {
      const child = addSession(map, {
        provider: 'claude',
        label: 'дочерняя',
        task: 'т',
        parent: null,
      });
      child.parent = parentId;
      childId = child.id;
      child.worktree = plannedWorktree(project, work.work.id, child.id, 'main', worktreeRootDir);
    });

    await sessions.launch({ projectPath: project, workId: work.work.id, sessionId: childId }, 'launch');

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
        parent: null,
      });
      child.parent = parentId;
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

    const map = readStoredMap(project, work.work.id);
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

describe('модель и усилие из сохранённой карты', () => {
  it('сохранённая pending запускается с записанными моделью и усилием: флаги в argv стаба', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    // Сохранённые параметры применяются при явном запуске.
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

describe('lean: решение при создании и запуск по записи в карте (часть C, C2.2)', () => {
  const LEAN_FLAG = '--strict-mcp-config';

  it('все пути создания пишут явный lean в запись сессии; окно без поля — ключа нет', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    setEnv('STUB_ARGS_FILE', await tempArgsFile());
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const base = { projectPath: project, provider: 'claude', label: '' };

    for (const lean of [true, false]) {
      // Тихий старт, новая работа под быструю сессию, `pending` с задачей.
      const refs = [
        await service.create({ ...base, workId: work.work.id, task: '', parent: null, lean }),
        await service.create({ ...base, workId: null, task: '', parent: null, lean }),
        await service.create({ ...base, workId: work.work.id, task: 'сделай штуку', parent: null, lean }),
      ];
      for (const ref of refs) {
        const map = await readMap(ref.projectPath, ref.workId);
        expect(map.sessions.find((candidate) => candidate.id === ref.sessionId)?.lean, `${ref.sessionId} lean=${lean}`).toBe(lean);
        await service.stop(ref);
      }
    }

    // Одиночная сессия из окна без поля (и старое окно): lean нет, как до этого куска, — настройка leanAgents
    // её не касается, даже включённая.
    await saveConfig({ leanAgents: true });
    const plain = [
      await service.create({ ...base, workId: work.work.id, task: '', parent: null }),
      await service.create({ ...base, workId: work.work.id, task: 'сделай штуку', parent: null }),
    ];
    for (const ref of plain) {
      const session = (await readMap(ref.projectPath, ref.workId)).sessions.find((candidate) => candidate.id === ref.sessionId);
      expect(session).toBeDefined();
      expect(Object.keys(session ?? {}), ref.sessionId).not.toContain('lean');
      await service.stop(ref);
    }
  });

  it('явный lean: true у одиночной сессии доезжает до argv; без поля и с lean: false — флага нет', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const argvOf = async (lean?: boolean): Promise<string[]> => {
      const argsFile = await tempArgsFile();
      setEnv('STUB_ARGS_FILE', argsFile);
      const ref = await service.create({
        projectPath: project,
        workId: work.work.id,
        provider: 'claude',
        label: '',
        task: '',
        parent: null,
        ...(lean === undefined ? {} : { lean }),
      });
      const { argv } = await readArgs(argsFile);
      await service.stop(ref);
      return argv;
    };

    expect(await argvOf(true)).toContain(LEAN_FLAG);
    expect(await argvOf(false)).not.toContain(LEAN_FLAG);
    expect(await argvOf()).not.toContain(LEAN_FLAG);
  });

  it('resume lean-сессии собирает запуск с теми же lean-флагами, что и первый запуск', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const ref = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: '',
      task: 'сделай штуку',
      parent: null,
      lean: true,
    });
    const first = (await readArgs(argsFile)).argv;
    await service.stop(ref);
    expect(first).toContain(LEAN_FLAG);

    // Второй запуск перезапишет файл стаба: убираем первый, чтобы прочитать именно resume.
    await rm(argsFile);
    await service.launch(ref, 'resume');
    const resumed = (await readArgs(argsFile)).argv;
    await service.stop(ref);

    expect(resumed).toContain('--resume');
    expect(resumed).toContain(LEAN_FLAG);
  });

  it('сессия без lean в записи после resume по-прежнему без lean-флагов, даже при leanAgents: true', async () => {
    await saveConfig({ leanAgents: true });
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const ref = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: '',
      task: 'сделай штуку',
      parent: null,
    });
    await readArgs(argsFile);
    await service.stop(ref);

    await rm(argsFile);
    await service.launch(ref, 'resume');
    const resumed = (await readArgs(argsFile)).argv;
    await service.stop(ref);

    expect(resumed).toContain('--resume');
    expect(resumed).not.toContain(LEAN_FLAG);
  });

  it('pending с lean в записи запускается явно с lean-флагами', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    // Сохранённое решение lean применяется при явном запуске.
    const sessionId = await createPendingSession(project, work.work.id, {
      provider: 'claude',
      label: 'бэкенд',
      task: 'сделай штуку',
      lean: true,
    });
    const ref: SessionRef = { projectPath: project, workId: work.work.id, sessionId };

    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    await service.launch(ref, 'launch');

    expect((await readArgs(argsFile)).argv).toContain(LEAN_FLAG);
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
      const gapWarnings = (): number => warn.mock.calls.filter((call) => JSON.stringify(call).includes('provider-override-gap')).length;
      // В журнал каждый запуск пишет все свои пробелы шаблона (`{developerInstructions}`, `{trust}`/`{approvals}`), второй проект — столько же.
      await service.launch(await makeRef(project, 'codex'), 'launch').catch(() => {});
      const perLaunch = gapWarnings();
      expect(perLaunch).toBeGreaterThan(0);
      await service.launch(await makeRef(otherProject, 'codex'), 'launch').catch(() => {});
      expect(gapWarnings()).toBe(2 * perLaunch);
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
      // Навигатор при запуске читает каталог Codex тем же бинарём (`app-server`): заглушка успевает записать и этот вызов.
      await waitFor(async () => {
        try { return (JSON.parse(await readFile(argsFile, 'utf8')) as StubArgs).argv.some((arg) => arg.startsWith('mcp_servers.parley=')); } catch { return false; }
      }, REAL_PROCESS_WAIT_MS);
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

describe('setChoice(): выбор модели и effort в записи сессии (спека нормалайзера, 5.5)', () => {
  it('значение пишет поле, null пишется как явный Default, undefined оставляет как было', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const sessionId = await createPendingSession(project, work.work.id, {
      provider: 'claude',
      label: 'бэкенд',
      task: 'т',
      model: 'opus',
      effort: 'high',
    });
    const ref: SessionRef = { projectPath: project, workId: work.work.id, sessionId };
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const session = async () =>
      (await readMap(project, work.work.id)).sessions.find((candidate) => candidate.id === sessionId);

    await service.setChoice(ref, { effort: 'xhigh' });
    expect(await session()).toMatchObject({ model: 'opus', effort: 'xhigh' });

    await service.setChoice(ref, { model: 'haiku', effort: null });
    const cleared = await session();
    expect(cleared?.model).toBe('haiku');
    expect(cleared?.effort).toBeNull();

    await service.setChoice(ref, { model: null });
    expect((await session())?.model).toBeNull();
  });

  it('сессии нет в карте — not_found', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());

    await expect(
      service.setChoice({ projectPath: project, workId: work.work.id, sessionId: 's-99' }, { effort: 'low' }),
    ).rejects.toMatchObject({ name: 'HostError', code: 'not_found' });
  });
});

describe('atPrompt и busyError: агент у приглашения (спека нормалайзера, 5.7–5.8)', () => {
  const live = (activity: string): SessionLive =>
    ({ activity: { activity, tasks: [] }, metrics: null }) as unknown as SessionLive;

  it('idle и unseen — у приглашения; working, blocked и нет сведений — занят', () => {
    expect(atPrompt(live('idle'))).toBe(true);
    expect(atPrompt(live('unseen'))).toBe(true);
    expect(atPrompt(live('working'))).toBe(false);
    expect(atPrompt(live('blocked'))).toBe(false);
    expect(atPrompt(undefined)).toBe(false);
  });

  it('отказ «занят» — conflict с причиной busy и текстом для окна', () => {
    expect(busyError('Wait until the agent is idle')).toMatchObject({
      name: 'HostError',
      code: 'conflict',
      message: 'Wait until the agent is idle',
      data: { reason: 'busy' },
    });
  });

  it('createSwitchLock: вторая смена той же сессии, пока идёт первая, — busy; соседняя не ждёт; сбой замок снимает', async () => {
    const lock = createSwitchLock();
    const ref: SessionRef = { projectPath: '/p', workId: 'w-1', sessionId: 's-01' };
    let release: () => void = () => {};
    const first = lock(ref, () => new Promise<string>((resolve) => {
      release = () => resolve('первая');
    }));

    await expect(lock(ref, async () => 'вторая')).rejects.toMatchObject({
      name: 'HostError',
      code: 'conflict',
      data: { reason: 'busy' },
    });
    await expect(lock({ ...ref, sessionId: 's-02' }, async () => 'соседняя')).resolves.toBe('соседняя');
    // `pty.send` по `held` узнаёт, что смена идёт: клавиши смены в PTY, текст среди них не нужен.
    expect(lock.held(ref)).toBe(true);
    expect(lock.held({ ...ref, sessionId: 's-02' })).toBe(false);
    release();
    await expect(first).resolves.toBe('первая');
    expect(lock.held(ref)).toBe(false);
    await expect(lock(ref, async () => {
      throw new Error('сбой');
    })).rejects.toThrow('сбой');
    expect(lock.held(ref)).toBe(false);
    await expect(lock(ref, async () => 'после сбоя')).resolves.toBe('после сбоя');
  });
});

describe('setModel(): смена модели (спека нормалайзера, 5.8)', () => {
  let claudeRoot = '';

  beforeEach(async () => {
    claudeRoot = await mkdtemp(path.join(tmpdir(), 'parley-sessions-claude-'));
    // План resume ищет транскрипт Claude Code во временном корне, а не в ~/.claude.
    setEnv('PARLEY_CLAUDE_PROJECTS_DIR', claudeRoot);
  });

  afterEach(async () => {
    await rm(claudeRoot, { recursive: true, force: true });
  });

  /** Активность-подмена: сессия в заданном состоянии и с заданными субагентами. */
  function activityAt(state: string, tasks: Array<{ background: boolean }> = []): ActivityService {
    return {
      ...fakeActivity(),
      get: () => ({ activity: { activity: state, tasks }, metrics: null }),
    } as unknown as ActivityService;
  }

  /** Живая сессия claude на opus · xhigh; транскрипт разговора есть — resume пойдёт через `--resume`. */
  async function liveSession(
    activity: ActivityService,
  ): Promise<{ service: SessionsService; pty: PtyManager; ref: SessionRef; argsFile: string; uuid: string }> {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    const pty = createPtyManager(fakeHost());
    const service = createSessionsService(fakeHost(), fakeWorks(), pty, activity);
    const ref = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: '',
      task: '',
      parent: null,
      model: 'opus',
      effort: 'xhigh',
    });
    const { argv } = await readArgs(argsFile);
    const uuid = argv[argv.indexOf('--session-id') + 1] as string;
    await mkdir(path.join(claudeRoot, 'project'), { recursive: true });
    await writeFile(path.join(claudeRoot, 'project', `${uuid}.jsonl`), '{"type":"user"}\n', 'utf8');
    await rm(argsFile);
    return { service, pty, ref, argsFile, uuid };
  }

  const sessionOf = async (ref: SessionRef) =>
    (await readMap(ref.projectPath, ref.workId)).sessions.find((candidate) => candidate.id === ref.sessionId);

  it('спящая сессия: только карта, процесс не поднимается; уровень, который есть у новой модели, остаётся', async () => {
    const { service, ref } = await liveSession(activityAt('idle'));
    await service.stop(ref);

    expect(await service.setModel(ref, 'sonnet')).toEqual({ model: 'sonnet', effort: 'xhigh', restarted: false });
    expect(service.live(ref)).toBe(false);
    expect(await sessionOf(ref)).toMatchObject({ model: 'sonnet', effort: 'xhigh', lifecycle: 'sleeping' });
  });

  it('сессия ещё ждёт запуска (pending) — только карта, restarted: false; у GLM своя пара моделей', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const sessionId = await createPendingSession(project, work.work.id, {
      provider: 'glm',
      label: 'бэкенд',
      task: 'сделай штуку',
    });
    const ref: SessionRef = { projectPath: project, workId: work.work.id, sessionId };
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());

    expect(await service.setModel(ref, 'glm-5.3-flash[1m]')).toEqual({
      model: 'glm-5.3-flash[1m]',
      effort: null,
      restarted: false,
    });
    expect(await sessionOf(ref)).toMatchObject({ model: 'glm-5.3-flash[1m]', lifecycle: 'pending' });
    expect(service.live(ref)).toBe(false);
  });

  it('живая сессия у приглашения: карта, остановка и resume с --model и --effort из карты', async () => {
    const { service, ref, argsFile, uuid } = await liveSession(activityAt('idle'));

    expect(await service.setModel(ref, 'sonnet')).toEqual({ model: 'sonnet', effort: 'xhigh', restarted: true });

    const { argv } = await readArgs(argsFile);
    expect(argv[argv.indexOf('--resume') + 1]).toBe(uuid);
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
    expect(argv[argv.indexOf('--effort') + 1]).toBe('xhigh');
    expect(await sessionOf(ref)).toMatchObject({ model: 'sonnet', effort: 'xhigh', lifecycle: 'active' });
    expect(service.live(ref)).toBe(true);
    await service.stop(ref);
  });

  it('у Haiku уровней нет: effort в карте — явный Default (null), resume без --effort; unseen — тоже у приглашения', async () => {
    const { service, ref, argsFile } = await liveSession(activityAt('unseen'));

    expect(await service.setModel(ref, 'haiku')).toEqual({ model: 'haiku', effort: null, restarted: true });

    const { argv } = await readArgs(argsFile);
    expect(argv[argv.indexOf('--model') + 1]).toBe('haiku');
    expect(argv).not.toContain('--effort');
    const session = await sessionOf(ref);
    expect(session?.model).toBe('haiku');
    expect(session?.effort).toBeNull();
    await service.stop(ref);
  });

  it('агент работает, ждёт ответа или идут фоновые задачи — conflict busy: процесс жив, карта прежняя', async () => {
    for (const activity of [activityAt('working'), activityAt('blocked'), activityAt('idle', [{ background: true }])]) {
      const { service, ref } = await liveSession(activity);

      await expect(service.setModel(ref, 'sonnet')).rejects.toMatchObject({
        name: 'HostError',
        code: 'conflict',
        data: { reason: 'busy' },
      });
      expect(service.live(ref)).toBe(true);
      expect(await sessionOf(ref)).toMatchObject({ model: 'opus', effort: 'xhigh' });
      await service.stop(ref);
    }
  });

  it('неотправленный текст в поле ввода (в том числе черновик хоста) — conflict busy: процесс тот же, карта прежняя', async () => {
    const { service, pty, ref } = await liveSession(activityAt('idle'));
    const pid = pty.get(ref)?.pid;
    // Указатель будильника — черновик хоста: `hasDraft` его учитывает, как и ввод человека.
    pty.setHostDraft(ref, true);

    await expect(service.setModel(ref, 'sonnet')).rejects.toMatchObject({
      name: 'HostError',
      code: 'conflict',
      message: 'The input field has unsent text; send or clear it first',
      data: { reason: 'busy' },
    });
    expect(pty.get(ref)?.pid).toBe(pid);
    expect(await sessionOf(ref)).toMatchObject({ model: 'opus', effort: 'xhigh' });
    await service.stop(ref);
  });

  it('сессия сейчас запускается — conflict busy: карта прежняя, а не запись «для неживой»', async () => {
    const { service, pty, ref } = await liveSession(activityAt('idle'));
    await service.stop(ref);

    // launch занимает ключ запуска синхронно; процесса ещё нет, и без проверки setModel счёл бы сессию неживой.
    const starting = service.launch(ref, 'resume');
    await expect(service.setModel(ref, 'sonnet')).rejects.toMatchObject({
      name: 'HostError',
      code: 'conflict',
      data: { reason: 'busy' },
    });
    await starting;
    expect(await sessionOf(ref)).toMatchObject({ model: 'opus', effort: 'xhigh' });
    expect(pty.get(ref)).toBeDefined();
    await service.stop(ref);
  });

  it('resume не поднялся — ошибка уходит вызывающему, а в карте уже новая модель', async () => {
    const { service, ref } = await liveSession(activityAt('idle'));
    setEnv('PARLEY_CLAUDE_BIN', path.join(project, 'нет-такого-claude'));

    await expect(service.setModel(ref, 'sonnet')).rejects.toThrow();
    expect(service.live(ref)).toBe(false);
    expect(await sessionOf(ref)).toMatchObject({ model: 'sonnet', effort: 'xhigh', lifecycle: 'sleeping' });
  });

  it('сессия не Claude Code или модель не из списка — bad_request, карта не меняется', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const codex = await createPendingSession(project, work.work.id, { provider: 'codex', label: 'a', task: 't' });
    const claude = await createPendingSession(project, work.work.id, {
      provider: 'claude',
      label: 'b',
      task: 't',
      model: 'opus',
    });
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const refOf = (sessionId: string): SessionRef => ({ projectPath: project, workId: work.work.id, sessionId });

    await expect(service.setModel(refOf(codex), 'gpt-6-sol')).rejects.toMatchObject({
      name: 'HostError',
      code: 'bad_request',
    });
    await expect(service.setModel(refOf(claude), 'gpt-6-sol')).rejects.toMatchObject({
      name: 'HostError',
      code: 'bad_request',
    });
    expect((await sessionOf(refOf(codex)))?.model).toBeUndefined();
    expect((await sessionOf(refOf(claude)))?.model).toBe('opus');
  });

  it('та же модель, что уже стоит, — без записи и без перезапуска: restarted false, процесс тот же', async () => {
    const { service, pty, ref } = await liveSession(activityAt('idle'));
    const pid = pty.get(ref)?.pid;
    const before = await sessionOf(ref);

    expect(await service.setModel(ref, 'opus')).toEqual({ model: 'opus', effort: 'xhigh', restarted: false });
    expect(pty.get(ref)?.pid).toBe(pid);
    expect(await sessionOf(ref)).toEqual(before);
    await service.stop(ref);
  });

  it('вторая смена, пока идёт первая, — conflict busy: перезапуск один; замок общий с sessions.setEffort', async () => {
    const { service, ref, argsFile } = await liveSession(activityAt('idle'));

    const first = service.setModel(ref, 'sonnet');
    await expect(service.setModel(ref, 'haiku')).rejects.toMatchObject({
      name: 'HostError',
      code: 'conflict',
      data: { reason: 'busy' },
    });
    // Обработчик sessions.setEffort идёт через тот же `exclusive` (Task 10).
    await expect(service.exclusive(ref, async () => 'effort')).rejects.toMatchObject({
      code: 'conflict',
      data: { reason: 'busy' },
    });
    await expect(first).resolves.toEqual({ model: 'sonnet', effort: 'xhigh', restarted: true });

    const { argv } = await readArgs(argsFile);
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
    expect((await sessionOf(ref))?.model).toBe('sonnet');
    await expect(service.exclusive(ref, async () => 'свободно')).resolves.toBe('свободно');
    await service.stop(ref);
  });
});


describe('agent-created workspace peers', () => {
  it.each(['codex', 'claude'] as const)('enforces autonomous %s policy and TMPDIR at the actual spawn', async provider => {
    // The top-level beforeEach already stubs claude; codex needs the same override so the test passes where no Codex CLI is installed (CI).
    setEnv('PARLEY_CODEX_BIN', STUB);
    const work = await createWork(project, { title: 'Autonomous launch', goal: '' });
    const pty = createPtyManager(fakeHost()), spawn = vi.spyOn(pty, 'start');
    const service = createSessionsService(fakeHost(), fakeWorks(), pty, fakeActivity());
    const attempt = path.join(project, 'attempt');
    const clone = path.join(attempt, 'clone'); await mkdir(clone, { recursive: true }); await mkdir(path.join(clone, '.parley-tmp'));
    try {
      const worker = await service.create({ projectPath: project, workId: work.work.id, provider, label: 'Worker', task: 'Implement', parent: null, requestedBy: ENGINE,
        deferLaunch: true, workspace: { kind: 'clone', path: clone, branch: 'attempt', sha: 'a'.repeat(40) } });
      await service.launch(worker, 'launch', { by: ENGINE });
      const options = spawn.mock.calls.at(-1)![1];
      expect(options.cwd).toBe(clone);
      expect(options.env?.TMPDIR).toBe(path.join(clone, '.parley-tmp'));
      expect(options.env?.HOME).toBe(process.env.HOME);
      if (provider === 'claude') {
        expect(options.args).toEqual(expect.arrayContaining(['--permission-mode', 'auto']));
        expect(options.args).not.toContain('acceptEdits');
        const file = options.args[options.args.indexOf('--settings') + 1]!;
        expect(JSON.parse(await readFile(file, 'utf8')).sandbox).toEqual({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true });
        expect(file).toContain(`/settings/${worker.sessionId}.json`);
      } else expect(options.args).toEqual(expect.arrayContaining(['approval_policy="never"', 'sandbox_workspace_write.exclude_slash_tmp=true', 'sandbox_workspace_write.exclude_tmpdir_env_var=true']));
    } finally { await service.stopAll(); }
  });

  it('persists engine clone cwd and rejects ordinary clone assignment', async () => {
    const work = await createWork(project, { title: 'Engine clone', goal: '' });
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const workspace = { kind: 'clone' as const, path: path.join(project, 'clone'), branch: 'attempts/at-0001', sha: 'a'.repeat(40) };
    await mkdir(workspace.path);
    const input = { projectPath: project, workId: work.work.id, provider: 'claude', label: 'Worker', task: 'Implement', parent: null, workspace };
    await expect(service.create(input)).rejects.toMatchObject({ code: 'bad_request' });
    const ref = await service.create({ ...input, requestedBy: ENGINE, deferLaunch: true });
    const session = (await readMap(project, work.work.id)).sessions.find(row => row.id === ref.sessionId)!;
    expect(session.workspace).toEqual(workspace);
    expect(session.worktree).toBeNull();
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    try {
      await service.launch(ref, 'launch', { by: ENGINE });
      expect(await realpath((await readArgs(argsFile)).cwd)).toBe(await realpath(workspace.path));
    } finally { await service.stopAll(); }
  });

  it('charges plan-namespaced engine identities to their own room creation budgets', async () => {
    setEnv('PARLEY_ROOM_NEW_SESSIONS', '1');
    const work = await createWork(project, { title: 'Two engine plans', goal: '' });
    const leads = await Promise.all([1, 2].map(i => createPendingSession(project, work.work.id, { provider: 'claude', label: `Lead ${i}`, task: 'Lead', parent: null, contextFrom: [] })));
    const roomIds: string[] = [];
    await updateMap(project, work.work.id, map => {
      map.plans = leads.map((lead, index) => {
        const room = addRoom(map, { title: `Plan ${index}`, creator: lead, members: [lead], lead, mode: 'autonomous' }); roomIds.push(room.id);
        const at = new Date().toISOString(), sha = 'a'.repeat(40);
        const plan: RoomPlan = {
          id: `pl-0${index + 1}`, roomId: room.id, rev: 1, mode: 'autonomous', status: 'active', goal: 'Implement', backlog: [], acceptedAt: at, completedAt: null, cancelledAt: null, completionSummary: null,
          items: [{ id: 1, title: 'Implement', owner: ENGINE, verifier: ENGINE, scope: 'src', after: [], criteria: ['Works'], status: 'ready', evidence: null, note: null, log: [] }],
          autonomous: { criteriaVersion: { 1: 1 }, checks: [], coverage: { 1: { 0: ['verifier'] } },
            budget: { limits: { attemptsPerItem: 3, repairWaves: 3, minutesPerAttempt: 30, sessions: 10, concurrent: 4 }, spent: { attempts: 0, repairWaves: 0, sessions: 0, verifiers: 0, minutes: 0, launches: 0 }, reservations: [] },
            integration: { branch: `integration/pl-0${index + 1}`, baseSha: sha, verifiedHead: sha, candidateHead: null, queue: [], suspended: null }, attempts: [], ops: [], halted: null, seq: { attempt: 0, receipt: 0, check: 0, op: 0 } },
        };
        return startAttempt(plan, { actor: ENGINE, rev: 1, now: at, item: 1, branch: 'attempt', baseSha: sha });
      });
    });
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const input = { projectPath: project, workId: work.work.id, provider: 'claude', task: 'Implement', parent: null, requestedBy: ENGINE, deferLaunch: true };
    for (const planId of ['pl-01', 'pl-02']) {
      await service.create({ ...input, label: `${planId}/at-0001/worker/op-0001` });
      await expect(service.create({ ...input, label: `${planId}/at-0001/worker/op-0001` })).rejects.toThrow();
    }
    await service.create({ ...input, label: 'pl-unknown/at-0001/worker/op-0001' });
    const map = await readMap(project, work.work.id);
    expect(map.resources?.spawnedByRoom).toEqual(Object.fromEntries(roomIds.map(id => [id, 1])));
    expect(map.resources?.spawned).toBe(3);
  });
  it('defers engine creation until its separately journaled launch', async () => {
    const work = await createWork(project, { title: 'Engine', goal: '' });
    const pty = createPtyManager(fakeHost());
    const start = vi.spyOn(pty, 'start');
    const service = createSessionsService(fakeHost(), fakeWorks(), pty, fakeActivity());
    const input = { projectPath: project, workId: work.work.id, provider: 'claude', label: 'at-0001 worker op-0001', task: 'Implement', parent: null, requestedBy: ENGINE, deferLaunch: true };
    try {
      const ref = await service.create(input);
      const pending = await readMap(project, work.work.id);
      expect(pending.sessions.find(row => row.id === ref.sessionId)?.lifecycle).toBe('pending');
      expect(start).not.toHaveBeenCalled();
      expect(pending.resources?.attempts ?? []).toEqual([]);
      expect(pending.resources?.spawned).toBe(1);
      await service.launch(ref, 'launch', { by: ENGINE });
      expect(start).toHaveBeenCalledTimes(1);
      expect((await readMap(project, work.work.id)).resources?.attempts.find(row => row.session === ref.sessionId)).toMatchObject({ actor: ENGINE, state: 'spent' });
    } finally { await service.stopAll(); }
  });

  it('refuses deferLaunch for ordinary callers and preserves engine creation limits', async () => {
    setEnv('PARLEY_WORK_NEW_SESSIONS', '1');
    const work = await createWork(project, { title: 'Engine', goal: '' });
    const caller = await createPendingSession(project, work.work.id, { provider: 'claude', label: 'Caller', task: 'Coordinate', parent: null, contextFrom: [] });
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const input = { projectPath: project, workId: work.work.id, provider: 'claude', label: 'Engine', task: 'Implement', parent: null, deferLaunch: true };
    await expect(service.create({ ...input, requestedBy: caller })).rejects.toThrow('engine');
    await service.create({ ...input, requestedBy: ENGINE });
    await expect(service.create({ ...input, requestedBy: ENGINE })).rejects.toThrow();
    expect((await readMap(project, work.work.id)).sessions).toHaveLength(2);
  });
  it('identifies the recorded peer after launch failure and releases its reserved slot', async () => {
    const work = await createWork(project, { title: 'Peers', goal: '' });
    const caller = await createPendingSession(project, work.work.id, { provider: 'claude', label: 'Caller', task: 'Coordinate', parent: null, contextFrom: [] });
    const pty = createPtyManager(fakeHost());
    vi.spyOn(pty, 'start').mockRejectedValueOnce(new Error('launch unavailable'));
    const service = createSessionsService(fakeHost(), fakeWorks(), pty, fakeActivity());
    await expect(service.create({ projectPath: project, workId: work.work.id, provider: 'claude', label: 'Peer', task: 'Implement', parent: null, requestedBy: caller }))
      .rejects.toThrow(/s-02.*launch unavailable.*get_map/s);
    const map = await readMap(project, work.work.id);
    expect(map.sessions.find(s => s.id === 's-02')).toMatchObject({ parent: null, lifecycle: 'pending' });
    expect(map.resources?.attempts.find(a => a.session === 's-02')).toMatchObject({ state: 'released' });
    expect(map.resources?.spawned).toBe(1);
  });

  it('charges the caller room creation budget without joining the new peer to it', async () => {
    setEnv('PARLEY_ROOM_NEW_SESSIONS', '1');
    const work = await createWork(project, { title: 'Peers', goal: '' });
    const caller = await createPendingSession(project, work.work.id, { provider: 'claude', label: 'Caller', task: 'Coordinate', parent: null, contextFrom: [] });
    let roomId = '';
    await updateMap(project, work.work.id, map => { roomId = addRoom(map, { title: 'Team', creator: caller, ownerId: caller, members: [caller] }).id; });
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const input = { projectPath: project, workId: work.work.id, provider: 'claude', label: 'Peer', task: 'Implement', parent: null, requestedBy: caller };
    try {
      const peer = await service.create(input);
      await expect(service.create(input)).rejects.toThrow();
      const map = await readMap(project, work.work.id);
      expect(map.resources?.spawnedByRoom[roomId]).toBe(1);
      expect(map.rooms[0]?.members).not.toContain(peer.sessionId);
      expect(map.sessions).toHaveLength(2);
    } finally { await service.stopAll(); }
  });

  it('admits only one concurrent request at the launch cap and writes no rejected peer', async () => {
    setEnv('PARLEY_WORK_LAUNCHES', '1');
    const work = await createWork(project, { title: 'Peers', goal: '' });
    const caller = await createPendingSession(project, work.work.id, { provider: 'claude', label: 'Caller', task: 'Coordinate', parent: null, contextFrom: [] });
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    try {
      const results = await Promise.allSettled([1, 2].map(i => service.create({ projectPath: project, workId: work.work.id, provider: 'claude', label: `Peer ${i}`, task: 'Implement', parent: null, requestedBy: caller })));
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
      const map = await readMap(project, work.work.id);
      expect(map.sessions).toHaveLength(2);
      expect(map.resources?.spawned).toBe(1);
    } finally { await service.stopAll(); }
  });

  it('rejects archived workspaces and exhausted creation budgets atomically', async () => {
    setEnv('PARLEY_WORK_NEW_SESSIONS', '1');
    const work = await createWork(project, { title: 'Peers', goal: '' });
    const caller = await createPendingSession(project, work.work.id, { provider: 'claude', label: 'Caller', task: 'Coordinate', parent: null, contextFrom: [] });
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const input = { projectPath: project, workId: work.work.id, provider: 'claude', label: 'Peer', task: 'Implement', parent: null, requestedBy: caller };
    await updateMap(project, work.work.id, map => { map.work.status = 'archived'; });
    await expect(service.create(input)).rejects.toThrow('archived');
    await updateMap(project, work.work.id, map => { map.work.status = 'active'; map.resources = { seq: 0, spawned: 1, spawnedByRoom: {}, attempts: [] }; });
    await expect(service.create(input)).rejects.toThrow();
    expect((await readMap(project, work.work.id)).sessions).toHaveLength(1);
  });

  it('creates a cross-provider root and attributes its reserved launch to the caller', async () => {
    setEnv('PARLEY_CODEX_BIN', STUB);
    const work = await createWork(project, { title: 'Peers', goal: '' });
    const caller = await createPendingSession(project, work.work.id, { provider: 'claude', label: 'Caller', task: 'Coordinate', parent: null, contextFrom: [] });
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    try {
      const ref = await service.create({ projectPath: project, workId: work.work.id, provider: 'codex', label: 'Peer', task: 'Implement', parent: null, requestedBy: caller });
      const map = await readMap(project, work.work.id);
      expect(map.sessions.find(s => s.id === ref.sessionId)).toMatchObject({ parent: null, provider: 'codex' });
      expect(map.resources?.spawned).toBe(1);
      expect(map.resources?.attempts.find(a => a.session === ref.sessionId)).toMatchObject({ actor: caller, state: 'spent' });
      expect(map.rooms).toHaveLength(0);
    } finally { await service.stopAll(); }
  });

  it('rejects an absent caller without writing a new session', async () => {
    const work = await createWork(project, { title: 'Peers', goal: '' });
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    await expect(service.create({ projectPath: project, workId: work.work.id, provider: 'claude', label: 'Peer', task: 'Implement', parent: null, requestedBy: 's-missing' })).rejects.toThrow('caller');
    expect((await readMap(project, work.work.id)).sessions).toHaveLength(0);
  });
});
