/** Путь создания роя (спека роя v1, 3–5): `create_swarm` / `swarm_add` на хосте — карта, права, пороги, одна запись. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addRoom, createPendingSession, createWork, ENGINE, readMap, updateMap } from '@parley/core';
import type { WorkMap } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import { HostError } from '../errors.js';
import { createPtyManager } from '../pty/pty-manager.js';
import type { WorksService } from '../works/works-service.js';
import { createSessionsService } from './sessions-service.js';
import type { SessionsService } from './sessions-service.js';

const STUB = fileURLToPath(new URL('../../test/stub-agent.mjs', import.meta.url));
vi.setConfig({ testTimeout: 30_000 });

const fakeHost = (): HostContext => ({
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
});
const fakeWorks = (): WorksService => ({
  start: async () => {}, snapshot: () => ({ entries: [], branches: {} }), entry: () => undefined,
  firstReadDone: () => false, onChange: () => () => {}, stop: async () => {},
});
const fakeActivity = (): ActivityService => ({
  start: async () => {}, get: () => undefined, markSeen: () => {}, onChange: () => () => {}, stop: async () => {},
});

let project = '';
let extraEnv: string[] = [];
let sessions: SessionsService;
let workId = '';
let caller = '';

const setEnv = (key: string, value: string): void => { process.env[key] = value; extraEnv.push(key); };

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'parley-swarm-spawn-'));
  setEnv('PARLEY_CLAUDE_BIN', STUB);
  setEnv('PARLEY_SKILL_NAVIGATOR', '0');
  const work = await createWork(project, { title: 'Swarm', goal: '' });
  workId = work.work.id;
  caller = await createPendingSession(project, workId, { provider: 'claude', label: 'Caller', task: 'Coordinate', parent: null, contextFrom: [] });
  sessions = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
});

afterEach(async () => {
  await sessions.stopAll().catch(() => {});
  for (const key of extraEnv) delete process.env[key];
  extraEnv = [];
  await rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const map = (): Promise<WorkMap> => readMap(project, workId);
const base = { provider: 'claude', parent: null } as const;

const createSwarm = (by: string | null = caller, tag = 'Research', objective = 'Audit everything'): Promise<SessionRef> =>
  sessions.create({
    projectPath: project, workId, ...base, label: '', task: objective,
    ...(by === null ? {} : { requestedBy: by }),
    swarm: { kind: 'create', tag, objective },
  });

const addMember = (by: string, role: 'drone' | 'verifier' = 'drone', label = '', task = 'Read packages/core'): Promise<SessionRef> =>
  sessions.create({ projectPath: project, workId, ...base, label, task, requestedBy: by, swarm: { kind: 'add', role } });

async function refusal(run: Promise<unknown>): Promise<HostError> {
  try { await run; } catch (error) { expect(error).toBeInstanceOf(HostError); return error as HostError; }
  throw new Error('отказа не было');
}

/** Отказ ничего не пишет: те же сессии, те же рои, те же счётчики. */
async function unchanged(run: () => Promise<unknown>): Promise<HostError> {
  const before = await map();
  const error = await refusal(run());
  const after = await map();
  expect(after.sessions.map((session) => session.id)).toEqual(before.sessions.map((session) => session.id));
  expect(after.swarms).toEqual(before.swarms);
  expect(after.resources).toEqual(before.resources);
  expect(after.work.swarmSeq).toEqual(before.work.swarmSeq);
  return error;
}

const reason = (error: HostError): unknown => error.data?.['reason'];

describe('create_swarm', () => {
  it('одна запись: рой и королева; ярлык «Queen sw-NN», без createdBy, бриф с задачей и сроком', async () => {
    const queen = await createSwarm();
    const after = await map();
    expect(after.work.swarmSeq).toBe(1);
    expect(after.swarms).toHaveLength(1);
    expect(after.swarms![0]).toMatchObject({
      id: 'sw-01', tag: 'Research', objective: 'Audit everything', queen: queen.sessionId, status: 'running',
      creator: { kind: 'session', sessionId: caller }, endedAt: null, expiredAt: null, result: null, failure: null, seenAt: null,
      members: [{ sessionId: queen.sessionId, role: 'queen', n: 1, handedAt: null }],
    });
    const session = after.sessions.find((candidate) => candidate.id === queen.sessionId)!;
    expect(session.label).toBe('Queen sw-01');
    expect(session.createdBy).toBeUndefined();
    expect(session.task).toContain('Audit everything');
    expect(session.task).toContain('sw-01');
    expect(session.task).toContain('swarm_add');
    expect(session.task).toContain('90 minutes');
    expect(session.task).toContain('Wait for the Parley letter that all members have handed in');
    expect(after.resources).toMatchObject({ swarmsCreated: 1, swarmSpawned: 1, spawned: 0 });
  });

  it('id не переиспользуется: второй рой — sw-02', async () => {
    const other = await createPendingSession(project, workId, { provider: 'claude', label: 'Other', task: 'x', parent: null, contextFrom: [] });
    await createSwarm();
    await createSwarm(other);
    expect((await map()).swarms!.map((swarm) => swarm.id)).toEqual(['sw-01', 'sw-02']);
  });

  it('ведущий живой комнаты — создатель-комната; сессия вне комнаты — создатель-сессия', async () => {
    let roomId = '';
    await updateMap(project, workId, (current) => { roomId = addRoom(current, { title: 'Team', creator: caller, ownerId: caller, members: [caller] }).id; });
    await createSwarm();
    expect((await map()).swarms![0]!.creator).toEqual({ kind: 'room', roomId });
  });

  it('человек: создатель human, лимиты агентов не тратятся, запуск человеческий', async () => {
    const queen = await createSwarm(null, 'Audit', 'Human objective');
    const after = await map();
    expect(after.swarms![0]).toMatchObject({ creator: { kind: 'human' }, tag: 'Audit', queen: queen.sessionId });
    expect(after.sessions.find((session) => session.id === queen.sessionId)).toMatchObject({ label: 'Queen sw-01' });
    expect(after.resources?.swarmsCreated ?? 0).toBe(0);
    expect(after.resources?.swarmSpawned ?? 0).toBe(0);
    expect(after.resources?.spawned ?? 0).toBe(0);
    expect(after.resources?.attempts[0]).toMatchObject({ actor: 'human', session: queen.sessionId });
  });

  it('человеку нельзя swarm_add, движку — рой', async () => {
    await createSwarm();
    const noCaller = await refusal(sessions.create({ projectPath: project, workId, ...base, label: '', task: 'x', swarm: { kind: 'add', role: 'drone' } }));
    expect(noCaller.code).toBe('bad_request');
    const engine = await refusal(sessions.create({ projectPath: project, workId, ...base, label: '', task: 'x', requestedBy: ENGINE, swarm: { kind: 'create', tag: 'T', objective: 'x' } }));
    expect(engine.code).toBe('bad_request');
  });
});

describe('swarm_add', () => {
  it('королева добавляет трутней и проверяющих: номера по ролям, ярлыки по умолчанию, свой ярлык, без createdBy', async () => {
    const queen = await createSwarm();
    const first = await addMember(queen.sessionId);
    const verifier = await addMember(queen.sessionId, 'verifier');
    const second = await addMember(queen.sessionId, 'drone', 'Docs reader');
    const third = await addMember(queen.sessionId);
    const after = await map();
    expect(after.swarms![0]!.members.map((member) => [member.role, member.n])).toEqual([['queen', 1], ['drone', 1], ['verifier', 1], ['drone', 2], ['drone', 3]]);
    const label = (ref: SessionRef): string | undefined => after.sessions.find((session) => session.id === ref.sessionId)?.label;
    expect([label(first), label(verifier), label(second), label(third)]).toEqual(['Drone 1', 'Verifier 1', 'Docs reader', 'Drone 3']);
    const member = after.sessions.find((session) => session.id === first.sessionId)!;
    expect(member.createdBy).toBeUndefined();
    expect(member.task).toContain('Read packages/core');
    expect(member.task).toContain('Read only');
    expect(member.task).toContain('report done');
    expect(after.resources).toMatchObject({ swarmSpawned: 5, swarmsCreated: 1 });
  });

  it('не королева (посторонний, трутень) — not-queen, ничего не пишется', async () => {
    const queen = await createSwarm();
    const drone = await addMember(queen.sessionId);
    const outsider = await unchanged(() => addMember(caller));
    expect(outsider.code).toBe('conflict');
    expect(reason(outsider)).toBe('not-queen');
    expect(reason(await unchanged(() => addMember(drone.sessionId)))).toBe('not-queen');
  });

  it('рой в терминальном состоянии — swarm-closed, ничего не пишется', async () => {
    const queen = await createSwarm();
    for (const status of ['done', 'failed', 'cancelled'] as const) {
      await updateMap(project, workId, (current) => { current.swarms![0]!.status = status; });
      expect(reason(await unchanged(() => addMember(queen.sessionId)))).toBe('swarm-closed');
    }
  });

  it('collecting возвращается в running той же записью', async () => {
    const queen = await createSwarm();
    await updateMap(project, workId, (current) => { current.swarms![0]!.status = 'collecting'; });
    await addMember(queen.sessionId, 'verifier');
    expect((await map()).swarms![0]!.status).toBe('running');
  });
});

describe('участник роя не создаёт сессий, роёв и не входит в комнаты', () => {
  it('create_session и create_swarm королевы и трутня — swarm-member, ничего не пишется', async () => {
    const queen = await createSwarm();
    const drone = await addMember(queen.sessionId);
    for (const member of [queen.sessionId, drone.sessionId]) {
      const peer = await unchanged(() => sessions.create({ projectPath: project, workId, ...base, label: 'Peer', task: 'x', requestedBy: member }));
      expect(peer.code).toBe('conflict');
      expect(reason(peer)).toBe('swarm-member');
      expect(reason(await unchanged(() => createSwarm(member)))).toBe('swarm-member');
    }
  });

  it('обычная сессия create_session по-прежнему работает и считает spawned', async () => {
    await sessions.create({ projectPath: project, workId, ...base, label: 'Peer', task: 'x', requestedBy: caller });
    expect((await map()).resources).toMatchObject({ spawned: 1 });
  });
});

describe('пределы: ветка роя обходит workNewSessions и roomNewSessions', () => {
  it('spawned == workNewSessions: рой и участники создаются, spawned и spawnedByRoom не растут, swarmSpawned растёт', async () => {
    setEnv('PARLEY_WORK_NEW_SESSIONS', '1');
    setEnv('PARLEY_ROOM_NEW_SESSIONS', '1');
    let roomId = '';
    await updateMap(project, workId, (current) => {
      roomId = addRoom(current, { title: 'Team', creator: caller, ownerId: caller, members: [caller] }).id;
      current.resources = { seq: 0, spawned: 1, spawnedByRoom: { [roomId]: 1 }, attempts: [] };
    });
    // Обычная сессия отказана: бюджет исчерпан.
    await expect(sessions.create({ projectPath: project, workId, ...base, label: 'Peer', task: 'x', requestedBy: caller })).rejects.toThrow();
    const queen = await createSwarm();
    await addMember(queen.sessionId);
    const after = await map();
    expect(after.resources).toMatchObject({ spawned: 1, spawnedByRoom: { [roomId]: 1 }, swarmSpawned: 2, swarmsCreated: 1 });
    expect(after.swarms![0]!.members).toHaveLength(2);
  });

  it('swarms: workSwarms исчерпан (и 0 запрещает рои агентам)', async () => {
    setEnv('PARLEY_WORK_SWARMS', '1');
    await createSwarm();
    const other = await createPendingSession(project, workId, { provider: 'claude', label: 'Other', task: 'x', parent: null, contextFrom: [] });
    const denied = await unchanged(() => createSwarm(other));
    expect(denied.code).toBe('conflict');
    expect(reason(denied)).toBe('swarms');
    expect(denied.data).toMatchObject({ scope: 'swarm', limit: 1, used: 1 });
    expect(denied.data).not.toHaveProperty('code');
    // Человек лимит workSwarms не тратит и не упирается в него.
    await createSwarm(null, 'Human', 'x');
    setEnv('PARLEY_WORK_SWARMS', '0');
    expect(reason(await unchanged(() => createSwarm(other)))).toBe('swarms');
  });

  it('swarm-sessions: рой не больше swarmSessions участников, королева считается', async () => {
    setEnv('PARLEY_SWARM_SESSIONS', '2');
    const queen = await createSwarm();
    await addMember(queen.sessionId);
    expect(reason(await unchanged(() => addMember(queen.sessionId)))).toBe('swarm-sessions');
  });

  it('swarm-total: workSwarmSessions не больше за всё время работы', async () => {
    setEnv('PARLEY_WORK_SWARM_SESSIONS', '2');
    const queen = await createSwarm();
    await addMember(queen.sessionId);
    expect(reason(await unchanged(() => addMember(queen.sessionId)))).toBe('swarm-total');
  });

  it('swarm-concurrent: живых и заказанных участников не больше swarmConcurrent', async () => {
    setEnv('PARLEY_SWARM_CONCURRENT', '2');
    const queen = await createSwarm();
    await addMember(queen.sessionId);
    expect(reason(await unchanged(() => addMember(queen.sessionId)))).toBe('swarm-concurrent');
  });
});

describe('общие пределы запуска рой соблюдает', () => {
  it('workConcurrent: участник отказан как запуск (resource-budget), ничего не пишется', async () => {
    setEnv('PARLEY_WORK_CONCURRENT', '1');
    const queen = await createSwarm();
    const denied = await unchanged(() => addMember(queen.sessionId));
    expect(denied.data).toMatchObject({ code: 'resource-budget', reason: 'concurrent', scope: 'work', limit: 1 });
  });

  it('workLaunches: участник отказан окном запусков, ничего не пишется', async () => {
    setEnv('PARLEY_WORK_LAUNCHES', '1');
    const queen = await createSwarm();
    const denied = await unchanged(() => addMember(queen.sessionId));
    expect(denied.data).toMatchObject({ code: 'resource-budget', reason: 'launches', limit: 1 });
  });

  it('workConcurrent: королева нового роя тоже отказана без записи роя', async () => {
    setEnv('PARLEY_WORK_CONCURRENT', '1');
    await sessions.create({ projectPath: project, workId, ...base, label: 'Peer', task: 'x', requestedBy: caller });
    const denied = await unchanged(() => createSwarm());
    expect(denied.data).toMatchObject({ code: 'resource-budget', reason: 'concurrent' });
    expect((await map()).swarms ?? []).toEqual([]);
  });
});
