/**
 * Согласие на папку при запуске Codex (спека 2026-10-21, 4.2 и 5.2): удержание до бюджета и worktree, ключи доверия
 * и режим одобрений в плане запуска. Файл отдельный от `sessions-service.test.ts`: план запуска здесь шпионится
 * (`planLaunch` и родня обёрнуты `vi.fn` поверх настоящих), и этот приём не должен задевать остальные тесты сервиса.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPendingSession,
  createWork,
  createWorktree,
  grantTrust,
  planLaunch,
  planResume,
  plannedWorktree,
  readMap,
  updateMap,
} from '@parley/core';
import type { EventData, EventName, SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { ConsentsService } from '../consents/consents-service.js';
import type { HostContext } from '../context.js';
import type { ProviderVersions } from '../providers/versions.js';
import { createPtyManager } from '../pty/pty-manager.js';
import type { WorksService } from '../works/works-service.js';
import { createSessionsService, effectiveCodexWriteApprovals } from './sessions-service.js';
import type { SessionsFeedOptions } from './sessions-service.js';

vi.mock('@parley/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parley/core')>();
  return {
    ...actual,
    planLaunch: vi.fn(actual.planLaunch),
    planResume: vi.fn(actual.planResume),
    planNew: vi.fn(actual.planNew),
  };
});

const STUB = fileURLToPath(new URL('../../test/stub-agent.mjs', import.meta.url));
const runGit = promisify(execFile);

vi.setConfig({ testTimeout: 30_000 });

let broadcasts: Array<{ event: EventName; data: unknown }> = [];
let project = '';
let extraEnv: string[] = [];
const cleanup: Array<() => Promise<unknown>> = [];

function setEnv(key: string, value: string): void {
  process.env[key] = value;
  extraEnv.push(key);
}

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

function fakeActivity(): ActivityService {
  return {
    start: async () => {},
    get: () => undefined,
    markSeen: () => {},
    onChange: () => () => {},
    stop: async () => {},
  };
}

function fakeVersions(versions: Record<string, string | null>): ProviderVersions {
  return { ready: Promise.resolve(), get: (command) => versions[command] ?? null, fresh: async (command) => versions[command] ?? null };
}

function fakeConsents() {
  const request = vi.fn<ConsentsService['request']>((input) => ({
    id: 'c-01',
    kind: 'folder-trust',
    folder: input.folder,
    projectPath: input.projectPath,
    requestedBy: input.requestedBy,
    at: '2026-10-21T10:00:00.000Z',
    state: 'pending',
  }));
  return { request };
}

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'parley-sessions-consent-'));
  broadcasts = [];
  setEnv('PARLEY_CLAUDE_BIN', STUB);
  setEnv('PARLEY_CODEX_BIN', STUB);
  setEnv('PARLEY_SKILL_NAVIGATOR', '0');
  // Доверие и настройки — в своей домашней папке теста, не в общей песочнице процесса.
  setEnv('PARLEY_HOME', await mkdtemp(path.join(tmpdir(), 'parley-sessions-consent-home-')));
  vi.mocked(planLaunch).mockClear();
  vi.mocked(planResume).mockClear();
});

afterEach(async () => {
  for (const key of extraEnv) delete process.env[key];
  extraEnv = [];
  for (const run of cleanup.splice(0)) await run();
  await rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Работа с вызывающей сессией Claude и сессией Codex в `pending`: то, что видит `launch()` у созданного агентом пира. */
async function pendingPeer(provider = 'codex'): Promise<{ workId: string; caller: string; ref: SessionRef }> {
  const work = await createWork(project, { title: 'Работа', goal: '' });
  const caller = await createPendingSession(project, work.work.id, {
    provider: 'claude', label: 'Caller', task: 'Coordinate', parent: null, contextFrom: [],
  });
  const peer = await createPendingSession(project, work.work.id, {
    provider, label: 'Peer', task: 'Implement', parent: null, contextFrom: [],
  });
  return { workId: work.work.id, caller, ref: { projectPath: project, workId: work.work.id, sessionId: peer } };
}

describe('launch(): согласие на папку у Codex', () => {
  it('Codex без записи в trust.json: held, бюджет не занят, план не строится, процесса нет, сессия pending', async () => {
    const { workId, ref } = await pendingPeer();
    const consents = fakeConsents();
    const pty = createPtyManager(fakeHost());
    const service = createSessionsService(fakeHost(), fakeWorks(), pty, fakeActivity(), { consents });

    expect(await service.launch(ref, 'launch', { by: 'auto' })).toBe('held');

    expect(consents.request).toHaveBeenCalledTimes(1);
    expect(consents.request).toHaveBeenCalledWith(
      {
        projectPath: project,
        folder: await realpath(project),
        requestedBy: { source: 'agent', workId, label: 'Peer' },
      },
      { ref, mode: 'launch', by: 'auto' },
    );
    const map = await readMap(project, workId);
    expect(map.sessions.find((session) => session.id === ref.sessionId)?.lifecycle).toBe('pending');
    expect(map.resources?.attempts ?? []).toEqual([]);
    expect(vi.mocked(planLaunch)).not.toHaveBeenCalled();
    expect(pty.get(ref)).toBeUndefined();
  });

  it('источник карточки: сессия-автор — agent с её id, человек — launch, подъём — resume', async () => {
    const { workId, caller, ref } = await pendingPeer();
    const consents = fakeConsents();
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity(), { consents });
    const requestedBy = (): unknown => consents.request.mock.calls.at(-1)?.[0].requestedBy;

    await service.launch(ref, 'launch', { by: caller });
    expect(requestedBy()).toEqual({ source: 'agent', sessionId: caller, workId, label: 'Peer' });

    await service.launch(ref, 'launch');
    expect(requestedBy()).toEqual({ source: 'launch', workId, label: 'Peer' });

    await service.launch(ref, 'resume', { by: 'wake' });
    expect(requestedBy()).toEqual({ source: 'resume', workId, label: 'Peer' });
    expect(consents.request.mock.calls.at(-1)?.[1]).toEqual({ ref, mode: 'resume', by: 'wake' });
  });

  it('удержанный запуск не создаёт worktree: запись плана есть, каталога нет', async () => {
    await runGit('git', ['init', '-b', 'main', project]);
    await runGit('git', ['-C', project, 'config', 'user.email', 'тест@parley']);
    await runGit('git', ['-C', project, 'config', 'user.name', 'тест']);
    await writeFile(path.join(project, 'README.md'), 'старт\n', 'utf8');
    await runGit('git', ['-C', project, 'add', 'README.md']);
    await runGit('git', ['-C', project, 'commit', '-m', 'первый']);
    setEnv('PARLEY_WORKTREE_ROOT', await mkdtemp(path.join(tmpdir(), 'parley-sessions-consent-wt-')));
    const { workId, caller } = await pendingPeer('claude');
    const consents = fakeConsents();
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity(), { consents });

    const created = await service.create({
      projectPath: project, workId, provider: 'codex', label: 'Peer', task: 'Implement', parent: null,
      requestedBy: caller, worktree: true,
    });

    expect(created.held).toBe('folder-trust');
    const session = (await readMap(project, workId)).sessions.find((candidate) => candidate.id === created.sessionId);
    expect(session?.worktree?.createdAt).toBeNull();
    expect(existsSync(session?.worktree?.path as string)).toBe(false);
  });

  it('create() агента: ответ с held, запись pending в карте, резерв не взят, счётчик созданных вырос', async () => {
    const { workId, caller } = await pendingPeer('claude');
    const consents = fakeConsents();
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity(), { consents });

    const created = await service.create({
      projectPath: project, workId, provider: 'codex', label: 'Peer', task: 'Implement', parent: null, requestedBy: caller,
    });

    expect(created).toMatchObject({ projectPath: project, workId, held: 'folder-trust' });
    const map = await readMap(project, workId);
    expect(map.sessions.find((candidate) => candidate.id === created.sessionId)).toMatchObject({ lifecycle: 'pending', provider: 'codex' });
    expect(map.resources?.spawned).toBe(1);
    expect(map.resources?.attempts.filter((attempt) => attempt.session === created.sessionId)).toEqual([]);
    expect(consents.request).toHaveBeenCalledWith(
      expect.objectContaining({ requestedBy: expect.objectContaining({ source: 'agent', sessionId: caller }) }),
      { ref: { projectPath: project, workId, sessionId: created.sessionId }, mode: 'launch', by: caller },
    );
  });

  it('Codex с записью в trust.json: started, план получил ключи доверия по realpath', async () => {
    await grantTrust(project, 'window');
    const { ref } = await pendingPeer();
    setEnv('STUB_ARGS_FILE', path.join(await mkdtemp(path.join(tmpdir(), 'parley-sessions-consent-args-')), 'args.json'));
    const consents = fakeConsents();
    const pty = createPtyManager(fakeHost());
    const service = createSessionsService(fakeHost(), fakeWorks(), pty, fakeActivity(), { consents });
    cleanup.push(() => service.stopAll());

    expect(await service.launch(ref, 'launch', { by: 'auto' })).toBe('started');

    expect(consents.request).not.toHaveBeenCalled();
    const real = await realpath(project);
    expect(vi.mocked(planLaunch).mock.calls.at(-1)?.[3]).toMatchObject({ trust: { project: real, cwd: real } });
    expect(pty.get(ref)).toBeDefined();
  });

  it('Codex в доверенном проекте с worktree: cwd в ключах — realpath каталога worktree', async () => {
    await grantTrust(project, 'window');
    const { workId, ref } = await pendingPeer();
    const worktreePath = await mkdtemp(path.join(tmpdir(), 'parley-sessions-consent-tree-'));
    cleanup.push(() => rm(worktreePath, { recursive: true, force: true }));
    await runGit('git', ['init', '-b', 'main', project]);
    await runGit('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'Initialize consent fixture']);
    const info = { ...plannedWorktree(project, workId, ref.sessionId, 'main', path.dirname(worktreePath)), path: worktreePath };
    await createWorktree(project, info);
    info.createdAt = '2026-10-21T10:00:00.000Z';
    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((candidate) => candidate.id === ref.sessionId)!;
      session.worktree = info;
    });
    setEnv('STUB_ARGS_FILE', path.join(await mkdtemp(path.join(tmpdir(), 'parley-sessions-consent-args-')), 'args.json'));
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity(), { consents: fakeConsents() });
    cleanup.push(() => service.stopAll());

    expect(await service.launch(ref, 'launch')).toBe('started');

    expect(vi.mocked(planLaunch).mock.calls.at(-1)?.[3]).toMatchObject({
      trust: { project: await realpath(project), cwd: await realpath(worktreePath) },
    });
  });

  it('Codex с worktree, созданным этим же запуском: ключ cwd считается по realpath уже созданного каталога', async () => {
    await runGit('git', ['init', '-b', 'main', project]);
    await runGit('git', ['-C', project, 'config', 'user.email', 'тест@parley']);
    await runGit('git', ['-C', project, 'config', 'user.name', 'тест']);
    await writeFile(path.join(project, 'README.md'), 'старт\n', 'utf8');
    await runGit('git', ['-C', project, 'add', 'README.md']);
    await runGit('git', ['-C', project, 'commit', '-m', 'первый']);
    setEnv('PARLEY_WORKTREE_ROOT', await mkdtemp(path.join(tmpdir(), 'parley-sessions-consent-wt-')));
    setEnv('STUB_ARGS_FILE', path.join(await mkdtemp(path.join(tmpdir(), 'parley-sessions-consent-args-')), 'args.json'));
    await grantTrust(project, 'window');
    const { workId, caller } = await pendingPeer('claude');
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity(), { consents: fakeConsents() });
    cleanup.push(() => service.stopAll());

    const created = await service.create({
      projectPath: project, workId, provider: 'codex', label: 'Peer', task: 'Implement', parent: null,
      requestedBy: caller, worktree: true,
    });

    expect(created.held).toBeUndefined();
    const session = (await readMap(project, workId)).sessions.find((candidate) => candidate.id === created.sessionId);
    const worktreePath = session?.worktree?.path as string;
    expect(existsSync(worktreePath)).toBe(true);
    expect(vi.mocked(planLaunch).mock.calls.at(-1)?.[3]).toMatchObject({
      trust: { project: await realpath(project), cwd: await realpath(worktreePath) },
    });
  });

  it('Claude без записи в trust.json: started, согласие не спрашивается, ключей доверия и режима одобрений в плане нет', async () => {
    const { ref } = await pendingPeer('claude');
    setEnv('STUB_ARGS_FILE', path.join(await mkdtemp(path.join(tmpdir(), 'parley-sessions-consent-args-')), 'args.json'));
    const consents = fakeConsents();
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity(), { consents });
    cleanup.push(() => service.stopAll());

    expect(await service.launch(ref, 'launch', { by: 'auto' })).toBe('started');

    expect(consents.request).not.toHaveBeenCalled();
    const options = vi.mocked(planLaunch).mock.calls.at(-1)?.[3] as Record<string, unknown>;
    expect(options).not.toHaveProperty('trust');
    expect(options).not.toHaveProperty('codexWriteApprovals');
  });

  it('без службы согласий (изолированный сервис) Codex не удерживается и доверия не передаёт', async () => {
    const { ref } = await pendingPeer();
    setEnv('STUB_ARGS_FILE', path.join(await mkdtemp(path.join(tmpdir(), 'parley-sessions-consent-args-')), 'args.json'));
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    cleanup.push(() => service.stopAll());

    expect(await service.launch(ref, 'launch')).toBe('started');

    expect(vi.mocked(planLaunch).mock.calls.at(-1)?.[3]).not.toHaveProperty('trust');
  });
});

describe('launch(): режим одобрений Codex и версия CLI', () => {
  async function launchCodex(
    feed: SessionsFeedOptions,
    mode: 'launch' | 'resume' = 'launch',
  ): Promise<{ options: Record<string, unknown>; notices: string[] }> {
    await grantTrust(project, 'window');
    const { ref } = await pendingPeer();
    setEnv('STUB_ARGS_FILE', path.join(await mkdtemp(path.join(tmpdir(), 'parley-sessions-consent-args-')), 'args.json'));
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity(), feed);
    cleanup.push(() => service.stopAll());
    await service.launch(ref, mode);
    const plan = mode === 'resume' ? planResume : planLaunch;
    return {
      options: vi.mocked(plan).mock.calls.at(-1)?.[3] as Record<string, unknown>,
      notices: broadcasts
        .filter((item) => item.event === 'host.notice')
        .map((item) => (item.data as { kind: string }).kind),
    };
  }

  it('Codex 0.160.0 при auto (умолчание): план получил terminal и ушло одно уведомление codex-auto-unsupported', async () => {
    const { options, notices } = await launchCodex({ providerVersions: fakeVersions({ codex: '0.160.0' }) });

    expect(options['codexWriteApprovals']).toBe('terminal');
    expect(notices.filter((kind) => kind === 'codex-auto-unsupported')).toHaveLength(1);
  });

  it('уведомление — раз на процесс хоста: второй запуск того же сервиса его не повторяет', async () => {
    await grantTrust(project, 'window');
    const { workId, ref } = await pendingPeer();
    const second = await createPendingSession(project, workId, {
      provider: 'codex', label: 'Peer 2', task: 'Implement', parent: null, contextFrom: [],
    });
    setEnv('STUB_ARGS_FILE', path.join(await mkdtemp(path.join(tmpdir(), 'parley-sessions-consent-args-')), 'args.json'));
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity(), {
      providerVersions: fakeVersions({ codex: '0.160.0' }),
    });
    cleanup.push(() => service.stopAll());

    await service.launch(ref, 'launch');
    await service.launch({ ...ref, sessionId: second }, 'launch');

    expect(
      broadcasts.filter((item) => item.event === 'host.notice' && (item.data as { kind: string }).kind === 'codex-auto-unsupported'),
    ).toHaveLength(1);
  });

  it('Codex 0.162.0 при auto: план получил auto, уведомления нет', async () => {
    const { options, notices } = await launchCodex({ providerVersions: fakeVersions({ codex: '0.162.0' }) });

    expect(options['codexWriteApprovals']).toBe('auto');
    expect(notices).not.toContain('codex-auto-unsupported');
  });

  it('resume получает тот же режим: версия 0.160.0 при auto — terminal', async () => {
    const { options } = await launchCodex({ providerVersions: fakeVersions({ codex: '0.160.0' }) }, 'resume');

    expect(options['codexWriteApprovals']).toBe('terminal');
  });

  it('версия не узнана (нет проб): auto не включается — terminal, а уведомления нет', async () => {
    const { options, notices } = await launchCodex({});

    expect(options['codexWriteApprovals']).toBe('terminal');
    expect(notices).not.toContain('codex-auto-unsupported');
  });

  it('режим parley не зависит от версии: 0.160.0 остаётся parley и уведомления нет', async () => {
    setEnv('PARLEY_CODEX_WRITE_APPROVALS', 'parley');
    const { options, notices } = await launchCodex({ providerVersions: fakeVersions({ codex: '0.160.0' }) });

    expect(options['codexWriteApprovals']).toBe('parley');
    expect(notices).not.toContain('codex-auto-unsupported');
  });

  it('режим terminal остаётся terminal без уведомления', async () => {
    setEnv('PARLEY_CODEX_WRITE_APPROVALS', 'terminal');
    const { options, notices } = await launchCodex({ providerVersions: fakeVersions({ codex: '0.170.0' }) });

    expect(options['codexWriteApprovals']).toBe('terminal');
    expect(notices).not.toContain('codex-auto-unsupported');
  });
});

describe('effectiveCodexWriteApprovals', () => {
  it('auto требует Codex не ниже 0.162.0: ниже и неизвестная версия — terminal', () => {
    expect(effectiveCodexWriteApprovals({ codexWriteApprovals: 'auto' }, '0.162.0')).toBe('auto');
    expect(effectiveCodexWriteApprovals({ codexWriteApprovals: 'auto' }, '0.163.2')).toBe('auto');
    expect(effectiveCodexWriteApprovals({ codexWriteApprovals: 'auto' }, 'codex-cli 0.162.1')).toBe('auto');
    expect(effectiveCodexWriteApprovals({ codexWriteApprovals: 'auto' }, '0.161.9')).toBe('terminal');
    expect(effectiveCodexWriteApprovals({ codexWriteApprovals: 'auto' }, 'не версия')).toBe('terminal');
    expect(effectiveCodexWriteApprovals({ codexWriteApprovals: 'auto' }, null)).toBe('terminal');
  });

  it('parley и terminal от версии не зависят', () => {
    for (const version of [null, '0.100.0', '0.162.0']) {
      expect(effectiveCodexWriteApprovals({ codexWriteApprovals: 'parley' }, version)).toBe('parley');
      expect(effectiveCodexWriteApprovals({ codexWriteApprovals: 'terminal' }, version)).toBe('terminal');
    }
  });
});

describe('resume', () => {
  it('resume доверенного проекта: те же ключи доверия, что и у первого запуска', async () => {
    await grantTrust(project, 'window');
    const { ref } = await pendingPeer();
    setEnv('STUB_ARGS_FILE', path.join(await mkdtemp(path.join(tmpdir(), 'parley-sessions-consent-args-')), 'args.json'));
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    cleanup.push(() => service.stopAll());

    await service.launch(ref, 'resume');

    const real = await realpath(project);
    expect(vi.mocked(planResume).mock.calls.at(-1)?.[3]).toMatchObject({ trust: { project: real, cwd: real } });
  });
});
