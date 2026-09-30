import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config.js';
import { checkSession, isAlive, processStartedAt, reconcileMap } from './liveness.js';
import { addSession, removeSession, transitionSession } from './map.js';
import { createWork, readMap, updateMap } from './store.js';
import type { WorkSession } from './types.js';

/** Сколько живёт сессия без pid после последнего признака жизни (спецификация, 5.4). */
const DEAD_MS = DEFAULT_CONFIG.silenceThresholdMs * 10;

let home = '';
let project = '';
const children: ChildProcess[] = [];

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.HARNAS_HOME = home;
});

afterEach(async () => {
  for (const child of children.splice(0)) await stop(child);
  delete process.env.HARNAS_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Настоящий дочерний процесс: живость проверяется на нём, а не на моке. */
function start(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

/** Убивает процесс и ждёт `exit`: до него pid ещё занят зомби. */
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

const sessionOf = (patch: Partial<WorkSession>): WorkSession => ({
  id: 's-01',
  provider: 'claude',
  label: 'сессия',
  task: '',
  parent: null,
  contextFrom: [],
  lifecycle: 'active',
  result: null,
  resultAt: null,
  closedAt: null,
  history: [],
  startedAt: null,
  endedAt: null,
  pid: null,
  startedAtProcess: null,
  launchedBy: 'tui',
  providerSessionId: null,
  metrics: null,
  summary: null,
  summarySource: null,
  artifacts: [],
  ...patch,
});

describe('processStartedAt и isAlive (чек-лист 15)', () => {
  it('время старта живого процесса близко к моменту запуска', async () => {
    const before = Date.now();
    const child = start();
    const at = await processStartedAt(child.pid ?? 0);

    expect(at).not.toBeNull();
    // Секундная точность `ps` — отсюда допуск в обе стороны.
    expect(Date.parse(at ?? '')).toBeGreaterThanOrEqual(before - 2000);
    expect(Date.parse(at ?? '')).toBeLessThanOrEqual(Date.now() + 2000);
  });

  it('процесс жив, пока не убит', async () => {
    const child = start();
    const pid = child.pid ?? 0;
    expect(isAlive(pid)).toBe(true);

    await stop(child);
    expect(isAlive(pid)).toBe(false);
    expect(await processStartedAt(pid)).toBeNull();
  });
});

describe('checkSession (чек-лист 15)', () => {
  it('живой процесс с совпавшим временем старта — сессия жива', async () => {
    const child = start();
    const startedAtProcess = await processStartedAt(child.pid ?? 0);

    expect(await checkSession(sessionOf({ pid: child.pid ?? 0, startedAtProcess }))).toEqual({
      alive: true,
    });
  });

  it('убитый процесс — сессия мертва', async () => {
    const child = start();
    const startedAtProcess = await processStartedAt(child.pid ?? 0);
    await stop(child);

    expect(await checkSession(sessionOf({ pid: child.pid ?? 0, startedAtProcess }))).toEqual({
      alive: false,
    });
  });

  it('расхождение startedAtProcess — pid переиспользован, сессия мертва', async () => {
    const child = start();
    const actual = Date.parse((await processStartedAt(child.pid ?? 0)) ?? '');
    const session = (shiftMs: number): WorkSession =>
      sessionOf({
        pid: child.pid ?? 0,
        startedAtProcess: new Date(actual + shiftMs).toISOString(),
      });

    expect(await checkSession(session(-10_000))).toEqual({ alive: false });
    // Допуск 2 с: округление тиков ядра расхождением не считается.
    expect(await checkSession(session(1500))).toEqual({ alive: true });
  });

  it('время старта в карте не записано — сравнивать не с чем, процесс решает сам', async () => {
    const child = start();

    expect(await checkSession(sessionOf({ pid: child.pid ?? 0 }))).toEqual({ alive: true });
  });

  it('pid: null — живость по тишине лога', async () => {
    const now = Date.parse('2026-09-05T12:00:00.000Z');
    const at = (agoMs: number): string => new Date(now - agoMs).toISOString();

    expect(await checkSession(sessionOf({}), { now, lastRecordAt: at(DEAD_MS - 1000) })).toEqual({
      alive: true,
    });
    expect(await checkSession(sessionOf({}), { now, lastRecordAt: at(DEAD_MS + 1000) })).toEqual({
      alive: false,
    });
    // Записей лога нет вовсе: тишину считаем от старта сессии.
    expect(await checkSession(sessionOf({ startedAt: at(DEAD_MS + 1000) }), { now })).toEqual({
      alive: false,
    });
    expect(await checkSession(sessionOf({ startedAt: at(1000) }), { now })).toEqual({
      alive: true,
    });
  });
});

describe('reconcileMap (чек-лист 15)', () => {
  /** Заводит в карте `active` сессию с полями процесса. */
  async function seed(workId: string, patch: Partial<WorkSession>): Promise<string> {
    let id = '';
    await updateMap(project, workId, (map) => {
      const session = addSession(map, { provider: 'claude', label: 'сессия', task: '' });
      id = session.id;
      transitionSession(map, id, 'active');
      Object.assign(session, patch);
    });
    return id;
  }

  it('мёртвая active уходит в sleeping, живая остаётся', async () => {
    const { work } = await createWork(project, { title: 'работа' });
    const alive = start();
    const dead = start();
    const deadStartedAt = await processStartedAt(dead.pid ?? 0);
    await stop(dead);

    const aliveId = await seed(work.id, {
      pid: alive.pid ?? 0,
      startedAtProcess: await processStartedAt(alive.pid ?? 0),
    });
    const deadId = await seed(work.id, { pid: dead.pid ?? 0, startedAtProcess: deadStartedAt });

    expect(await reconcileMap(project, work.id)).toEqual([deadId]);

    const map = await readMap(project, work.id);
    expect(map.sessions.find((session) => session.id === aliveId)?.lifecycle).toBe('active');
    const exited = map.sessions.find((session) => session.id === deadId);
    expect(exited?.lifecycle).toBe('sleeping');
    // Код выхода неизвестен: харнесс процесс не ждал — в записи стоит `null`,
    // и это не то же самое, что «поле забыли» (чек-лист 15).
    expect(exited?.history.at(-1)).toEqual({
      event: 'sleeping',
      at: expect.any(String),
      exitCode: null,
    });
    expect(exited?.endedAt).not.toBeNull();
  });

  it('второй проход мёртвых не находит: сессия уже sleeping', async () => {
    const { work } = await createWork(project, { title: 'работа' });
    const dead = start();
    const startedAtProcess = await processStartedAt(dead.pid ?? 0);
    await stop(dead);
    await seed(work.id, { pid: dead.pid ?? 0, startedAtProcess });

    expect((await reconcileMap(project, work.id)).length).toBe(1);
    expect(await reconcileMap(project, work.id)).toEqual([]);
  });

  it('34: удалённая сессия сверкой живости не возвращается', async () => {
    const { work } = await createWork(project, { title: 'работа' });
    const dead = start();
    const startedAtProcess = await processStartedAt(dead.pid ?? 0);
    await stop(dead);
    const id = await seed(work.id, { pid: dead.pid ?? 0, startedAtProcess });
    await updateMap(project, work.id, (map) => {
      removeSession(map, id);
    });

    // Мёртвый процесс в карте больше не значится: переводить некого, и записи
    // из следа удаления не появляется (план от 2026-09-06, раздел C).
    expect(await reconcileMap(project, work.id)).toEqual([]);
    const map = await readMap(project, work.id);
    expect(map.sessions).toEqual([]);
    expect(map.work.deletedSessions).toEqual([id]);
  });

  it('сессия без pid: молчащая уходит в sleeping', async () => {
    const { work } = await createWork(project, { title: 'работа' });
    const now = Date.now();
    const id = await seed(work.id, {
      launchedBy: 'cli',
      startedAt: new Date(now - DEAD_MS - 1000).toISOString(),
    });

    expect(await reconcileMap(project, work.id, { now })).toEqual([id]);
    expect((await readMap(project, work.id)).sessions[0]?.lifecycle).toBe('sleeping');
  });

  it('sleeping с живым своим процессом возвращается в active, с чужим — нет', async () => {
    const { work } = await createWork(project, { title: 'работа' });
    const alive = start();
    const startedAtProcess = await processStartedAt(alive.pid ?? 0);
    // Так миграция v1 оставляет бывшую `done`: спит с итогом, а процесс жив.
    const ownId = await seed(work.id, {
      lifecycle: 'sleeping',
      result: 'done',
      pid: alive.pid ?? 0,
      startedAtProcess,
    });
    // Тот же pid, но время старта другое — pid переиспользован чужим процессом.
    const reusedId = await seed(work.id, {
      lifecycle: 'sleeping',
      pid: alive.pid ?? 0,
      startedAtProcess: '2020-01-01T00:00:00.000Z',
    });
    // Время старта не записано — угадывать не беремся.
    const unknownId = await seed(work.id, {
      lifecycle: 'sleeping',
      pid: alive.pid ?? 0,
      startedAtProcess: null,
    });

    expect(await reconcileMap(project, work.id)).toEqual([]);

    const map = await readMap(project, work.id);
    const own = map.sessions.find((session) => session.id === ownId);
    expect(own?.lifecycle).toBe('active');
    expect(own?.result).toBe('done');
    expect(own?.history.at(-1)).toMatchObject({ event: 'active' });
    expect(map.sessions.find((session) => session.id === reusedId)?.lifecycle).toBe('sleeping');
    expect(map.sessions.find((session) => session.id === unknownId)?.lifecycle).toBe('sleeping');
  });
});
