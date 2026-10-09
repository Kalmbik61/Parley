import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import type { WorksService } from '../works/works-service.js';

/**
 * Отдельный файл: здесь `startSession` подменён, чтобы запись старта в карту падала уже после `pty.start`. Так
 * было 2026-10-09: хост после перезапуска поднимал разом всю работу, `map.lock` не освободился за 3 с, процесс
 * остался жить, а карта — `sleeping`. Окно показывало Resume, и `launch` на живом PTY молча выходил.
 */
let failStarts = 0;
let failWith: () => Error = () => new Error('сбой записи');
/** Задерживает запись старта до шага теста: так выход процесса гарантированно приходит посреди записи. */
let startGate: Promise<void> | null = null;

vi.mock('@parley/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@parley/core')>();
  return {
    ...core,
    startSession: async (...args: Parameters<typeof core.startSession>) => {
      if (startGate !== null) await startGate;
      if (failStarts > 0) {
        failStarts -= 1;
        throw failWith();
      }
      return core.startSession(...args);
    },
  };
});

const { createWork, MapLockTimeoutError, readMap, transitionSession, updateMap, workPaths } = await import('@parley/core');
const { createPtyManager } = await import('../pty/pty-manager.js');
const { createSessionsService } = await import('./sessions-service.js');

const STUB = fileURLToPath(new URL('../../test/stub-agent.mjs', import.meta.url));
vi.setConfig({ testTimeout: 30_000 });

function fakeHost(): HostContext {
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    clients: () => [],
    liveSessions: () => 0,
    broadcast: () => {},
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

let project = '';
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'parley-start-write-'));
  failStarts = 0;
  startGate = null;
  for (const [key, value] of Object.entries({ PARLEY_CLAUDE_BIN: STUB, PARLEY_SKILL_NAVIGATOR: '0' })) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Сессия, поднятая и остановленная: в карте `sleeping`, процесса нет — с неё начинается Resume. */
async function sleepingSession() {
  const work = await createWork(project, { title: 'Работа', goal: '' });
  const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
  const ref = await service.create({
    projectPath: project,
    workId: work.work.id,
    provider: 'claude',
    label: 'реализатор',
    task: 'сделай штуку',
    parent: null,
  });
  await service.stop(ref);
  return { service, ref, lifecycle: async () => (await readMap(project, work.work.id)).sessions[0] };
}

describe('launch(): запись старта в карту не удалась после pty.start', () => {
  it('map.lock занят один раз — запись повторяется: процесс жив, в карте active', async () => {
    const { service, ref, lifecycle } = await sleepingSession();
    failWith = () => new MapLockTimeoutError(workPaths(project, ref.workId).lock, 3000);
    failStarts = 1;

    await service.launch(ref, 'resume');

    expect(service.live(ref)).toBe(true);
    expect((await lifecycle())?.lifecycle).toBe('active');
    await service.stop(ref);
  });

  it('map.lock занят дольше повторов — процесс остановлен, карта sleeping; следующий Resume поднимает', async () => {
    const { service, ref, lifecycle } = await sleepingSession();
    failWith = () => new MapLockTimeoutError(workPaths(project, ref.workId).lock, 3000);
    failStarts = Number.POSITIVE_INFINITY;

    await expect(service.launch(ref, 'resume')).rejects.toBeInstanceOf(MapLockTimeoutError);

    expect(service.live(ref)).toBe(false);
    expect((await lifecycle())?.lifecycle).toBe('sleeping');

    failStarts = 0;
    await service.launch(ref, 'resume');
    expect(service.live(ref)).toBe(true);
    expect((await lifecycle())?.lifecycle).toBe('active');
    await service.stop(ref);
  });

  it('прочий сбой записи не повторяется: процесс остановлен, ошибка уходит вызывающему', async () => {
    const { service, ref, lifecycle } = await sleepingSession();
    failWith = () => new Error('сбой записи');
    // Один сбой: повтор прошёл бы, значит отказ доказывает, что повтора не было.
    failStarts = 1;

    await expect(service.launch(ref, 'resume')).rejects.toThrow('сбой записи');

    expect(service.live(ref)).toBe(false);
    expect((await lifecycle())?.lifecycle).toBe('sleeping');
  });
});

describe('launch() на живом PTY при sleeping в карте', () => {
  it('Resume дописывает active с приметами того же процесса, а не выходит молча', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
    const ref = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: 'реализатор',
      task: 'сделай штуку',
      parent: null,
    });
    const pid = (await readMap(project, work.work.id)).sessions[0]?.pid;
    expect(pid).toEqual(expect.any(Number));
    // Рассинхрон: процесс жив, а карта о нём забыла.
    await updateMap(project, work.work.id, (map) => {
      transitionSession(map, ref.sessionId, 'sleeping');
    });

    await service.launch(ref, 'resume');

    const session = (await readMap(project, work.work.id)).sessions[0];
    expect(session?.lifecycle).toBe('active');
    expect(session?.pid).toBe(pid);
    expect(service.live(ref)).toBe(true);
    await service.stop(ref);
  });

  it('процесс вышел посреди починки — карта в итоге sleeping, а не active с мёртвым pid', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const pty = createPtyManager(fakeHost());
    const service = createSessionsService(fakeHost(), fakeWorks(), pty, fakeActivity());
    const ref = await service.create({
      projectPath: project,
      workId: work.work.id,
      provider: 'claude',
      label: 'реализатор',
      task: 'сделай штуку',
      parent: null,
    });
    await updateMap(project, work.work.id, (map) => {
      transitionSession(map, ref.sessionId, 'sleeping');
    });
    let openGate = (): void => {};
    startGate = new Promise((resolve) => {
      openGate = resolve;
    });

    const repairing = service.launch(ref, 'resume');
    await pty.stop(ref);
    openGate();
    await repairing;

    const deadline = Date.now() + 3000;
    let lifecycle = (await readMap(project, work.work.id)).sessions[0]?.lifecycle;
    while (lifecycle !== 'sleeping' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      lifecycle = (await readMap(project, work.work.id)).sessions[0]?.lifecycle;
    }
    expect(lifecycle).toBe('sleeping');
    expect(service.live(ref)).toBe(false);
  });
});
