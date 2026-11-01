/**
 * Допуск запуска под потолок машины (спека сна агентов и ёмкости 2026-10-30, 4.2; план 2, задача 7): `launch()` спрашивает
 * сервис ёмкости после бюджета работы и до worktree, скилла и процесса. Сервис ёмкости здесь — подделка: она отдаёт заданный
 * билет и пишет вызовы (настоящее решение и очередь проверяет `capacity-service.test.ts`). Сессии, карта и процессы
 * настоящие, вместо `claude` и `codex` — заглушка.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addSession, createWork, ENGINE, readMap, readStoredMap, saveConfig, updateMap } from '@parley/core';
import type { LaunchClass, MachineTicket, WorkSession } from '@parley/core';
import type { EventData, EventName, SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import { createPtyManager } from '../pty/pty-manager.js';
import type { WorksService } from '../works/works-service.js';
import { createSessionsService } from './sessions-service.js';
import type { SessionsFeedOptions } from './sessions-service.js';

const STUB = fileURLToPath(new URL('../../test/stub-agent.mjs', import.meta.url));
const runGit = promisify(execFile);

vi.setConfig({ testTimeout: 30_000 });

type Capacity = NonNullable<SessionsFeedOptions['capacity']>;

let broadcasts: Array<{ event: EventName; data: unknown }> = [];
let logged: Array<{ line: string; fields: Record<string, unknown> }> = [];
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
    log: {
      info: (line, fields) => logged.push({ line, fields: (fields ?? {}) as Record<string, unknown> }),
      warn: () => {},
      error: () => {},
    },
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

const QUEUE: MachineTicket = { kind: 'queue', reason: 'machine-limit', live: 2, limit: 2 };
const START: MachineTicket = { kind: 'start', live: 0, limit: 2 };

/** Подделка сервиса ёмкости: отдаёт билет из `state` и пишет вызовы. */
function fakeCapacity(ticket: MachineTicket) {
  const state = { ticket };
  const admit = vi.fn<Capacity['admit']>(async () => state.ticket);
  const settle = vi.fn<Capacity['settle']>();
  const pump = vi.fn<Capacity['pump']>();
  const capacity: Capacity = { admit, settle, pump };
  return { state, admit, settle, pump, capacity };
}

/** Сервис сессий с настоящим PTY и подделкой ёмкости. */
function rig(capacity: Capacity, feed: SessionsFeedOptions = {}) {
  const pty = createPtyManager(fakeHost());
  const sessions = createSessionsService(fakeHost(), fakeWorks(), pty, fakeActivity(), { capacity, ...feed });
  cleanup.push(() => sessions.stopAll());
  return { sessions, pty };
}

/** Работа с `count` сессиями в `pending`: s-01, s-02, … */
async function workWith(count: number): Promise<{ workId: string; ref: (n: number) => SessionRef }> {
  const { work } = await createWork(project, { title: 'Работа', goal: '' });
  await updateMap(project, work.id, (map) => {
    for (let i = 0; i < count; i += 1) addSession(map, { provider: 'claude', label: `s${i + 1}`, task: 'т' });
  });
  return { workId: work.id, ref: (n) => ({ projectPath: project, workId: work.id, sessionId: `s-0${n}` }) };
}

const sessionOf = async (ref: SessionRef): Promise<WorkSession> =>
  (await readMap(ref.projectPath, ref.workId)).sessions.find((candidate) => candidate.id === ref.sessionId)!;

const attemptsOf = async (ref: SessionRef) =>
  (await readMap(ref.projectPath, ref.workId)).resources?.attempts.filter((attempt) => attempt.session === ref.sessionId) ?? [];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const notices = (kind: string) =>
  broadcasts.filter((item) => item.event === 'host.notice' && (item.data as { kind: string }).kind === kind).map((item) => item.data as { ref: SessionRef; text: string });

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'parley-sessions-queue-'));
  broadcasts = [];
  logged = [];
  setEnv('PARLEY_CLAUDE_BIN', STUB);
  setEnv('PARLEY_CODEX_BIN', STUB);
  setEnv('PARLEY_SKILL_NAVIGATOR', '0');
  // Настройки и доверие — в своей домашней папке теста, не в общей песочнице процесса.
  setEnv('PARLEY_HOME', await mkdtemp(path.join(tmpdir(), 'parley-sessions-queue-home-')));
});

afterEach(async () => {
  for (const run of cleanup.splice(0)) await run();
  for (const key of extraEnv) delete process.env[key];
  extraEnv = [];
  await rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('launch(): ответ queue', () => {
  it('процесса нет, резерв работы снят, запись очереди в карте, насос позван, шаги не дошли до worktree', async () => {
    const { ref } = await workWith(2);
    const { capacity, admit, settle, pump } = fakeCapacity(QUEUE);
    const { sessions, pty } = rig(capacity);
    const target = ref(2);

    expect(await sessions.launch(target, 'launch', { by: 's-01' })).toBe('queued');

    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledWith({ ref: target, launchClass: 'agent' });
    expect(pty.get(target)).toBeUndefined();
    // Билет `queue` слота не берёт: снимать нечего.
    expect(settle).not.toHaveBeenCalled();
    expect(pump).toHaveBeenCalledTimes(1);
    const session = await sessionOf(target);
    expect(session.lifecycle).toBe('pending');
    expect(session.queued).toEqual({
      class: 'agent', mode: 'launch', by: 's-01', at: expect.any(String), reason: 'machine-limit', live: 2, limit: 2,
    });
    expect(await attemptsOf(target)).toEqual([expect.objectContaining({ kind: 'launch', actor: 's-01', state: 'released' })]);
    // PARLEY.md заводится после worktree: допуск стоит раньше.
    expect(existsSync(path.join(project, 'PARLEY.md'))).toBe(false);
    // Время шагов: запуск в очереди — не отказ.
    const timing = logged.find((entry) => entry.line === 'запуск сессии: время шагов');
    expect(timing?.fields).toMatchObject({ queued: true });
    expect(timing?.fields).not.toHaveProperty('failed');
  });

  it('насос зовётся, когда резерв работы уже снят и запись очереди уже в карте', async () => {
    const { ref } = await workWith(1);
    const { capacity, pump } = fakeCapacity(QUEUE);
    const { sessions } = rig(capacity);
    const target = ref(1);
    let atPump: { reserved: number; queued: boolean } | undefined;
    // После вызова насоса `launch` ничего не ждёт и сразу снимает ключ `launching`: иначе продвинутый насосом запуск
    // этой же сессии упёрся бы в этот ключ и ничего не сделал.
    pump.mockImplementation(() => {
      const map = readStoredMap(target.projectPath, target.workId);
      atPump = {
        reserved: map.resources?.attempts.filter((attempt) => attempt.state === 'reserved').length ?? 0,
        queued: map.sessions.find((candidate) => candidate.id === target.sessionId)?.queued != null,
      };
    });

    await sessions.launch(target, 'launch');

    expect(atPump).toEqual({ reserved: 0, queued: true });
  });

  it('повторная постановка сохраняет время и поднимает класс, но не понижает', async () => {
    const { ref } = await workWith(2);
    const { capacity, admit } = fakeCapacity(QUEUE);
    const { sessions } = rig(capacity);
    const target = ref(2);

    await sessions.launch(target, 'launch', { by: 's-01' });
    const first = (await sessionOf(target)).queued!;
    expect(first).toMatchObject({ class: 'agent', by: 's-01' });
    await sleep(5);

    // Человек нажал Resume: класс старше, время прежнее.
    expect(await sessions.launch(target, 'resume', { by: 'human' })).toBe('queued');
    const raised = (await sessionOf(target)).queued!;
    expect(raised).toMatchObject({ class: 'human', mode: 'resume', by: 'human', at: first.at });
    expect(admit).toHaveBeenLastCalledWith({ ref: target, launchClass: 'human' });
    await sleep(5);

    // Агент снова просит запуск: класс человека не понижается.
    await sessions.launch(target, 'launch', { by: 's-01' });
    expect((await sessionOf(target)).queued).toMatchObject({ class: 'human', mode: 'resume', by: 'human', at: first.at });
  });

  it('вид запуска в записи — тот, что просили: подъём письмом новому агенту после замены остаётся resume, а не launch', async () => {
    const { ref } = await workWith(1);
    // Агент заменён, но ещё не стартовал: внутри `launch()` запуск станет `launch` с пакетом передачи, очередь же должна
    // помнить, что просили `resume` от будильника — такой подъём насос продолжает через `retry`, а не через `launch`.
    await updateMap(project, ref(1).workId, (map) => {
      const session = map.sessions[0]!;
      session.providerSessionId = null;
      session.previousAgents = [{
        provider: 'claude', model: null, effort: null, providerSessionId: 'old-conversation', startedAt: '2026-10-31T10:00:00.000Z',
        endedAt: '2026-10-31T11:00:00.000Z', reason: 'manual', requestedBy: 'human', carried: 'handover',
      }];
    });
    const { capacity } = fakeCapacity(QUEUE);
    const { sessions } = rig(capacity, { takeover: { handover: (async () => ({ text: 'HANDOVER-PACKAGE', tailFile: null })) as never } });

    expect(await sessions.launch(ref(1), 'resume', { by: 'wake' })).toBe('queued');

    expect((await sessionOf(ref(1))).queued).toMatchObject({ class: 'mail', mode: 'resume', by: 'wake' });
  });

  it('причина и числа берутся из билета последней постановки', async () => {
    const { ref } = await workWith(1);
    const { capacity, state } = fakeCapacity(QUEUE);
    const { sessions } = rig(capacity);
    const target = ref(1);

    await sessions.launch(target, 'launch', { by: 'human' });
    expect((await sessionOf(target)).queued).toMatchObject({ reason: 'machine-limit', live: 2, limit: 2 });

    state.ticket = { kind: 'queue', reason: 'memory-critical', live: 7, limit: 18 };
    await sessions.launch(target, 'launch', { by: 'human' });
    expect((await sessionOf(target)).queued).toMatchObject({ reason: 'memory-critical', live: 7, limit: 18 });
  });

  it('закрытая за время допуска сессия очередь не получает: записи нет', async () => {
    const { ref } = await workWith(1);
    const { capacity, admit } = fakeCapacity(QUEUE);
    const { sessions } = rig(capacity);
    const target = ref(1);
    admit.mockImplementationOnce(async () => {
      await updateMap(target.projectPath, target.workId, (map) => {
        map.sessions.find((candidate) => candidate.id === target.sessionId)!.lifecycle = 'closed';
      });
      return QUEUE;
    });

    expect(await sessions.launch(target, 'launch')).toBe('queued');

    const session = await sessionOf(target);
    expect(session.lifecycle).toBe('closed');
    expect(session.queued ?? null).toBeNull();
  });

  it('Codex без согласия на папку: удержание раньше допуска, ёмкость не спрашивают', async () => {
    const { ref } = await workWith(1);
    await updateMap(project, ref(1).workId, (map) => {
      map.sessions[0]!.provider = 'codex';
    });
    const { capacity, admit } = fakeCapacity(QUEUE);
    const request = vi.fn(() => ({}) as never);
    const { sessions } = rig(capacity, { consents: { request } });

    expect(await sessions.launch(ref(1), 'launch', { by: 'auto' })).toBe('held');

    expect(request).toHaveBeenCalledTimes(1);
    expect(admit).not.toHaveBeenCalled();
    expect((await sessionOf(ref(1))).queued ?? null).toBeNull();
  });
});

describe('launch(): ответ start и overflow', () => {
  it('start: процесс идёт, резерв снят сразу за стартом, уведомления о потолке нет', async () => {
    const { ref } = await workWith(1);
    const { capacity, admit, settle } = fakeCapacity(START);
    const { sessions, pty } = rig(capacity);
    const target = ref(1);
    const aliveAtSettle: boolean[] = [];
    settle.mockImplementation((settled) => {
      aliveAtSettle.push(pty.get(settled) !== undefined);
    });

    expect(await sessions.launch(target, 'launch')).toBe('started');

    expect(admit).toHaveBeenCalledWith({ ref: target, launchClass: 'human' });
    // Резерв машины снимается тогда, когда слот уже держит процесс; и один раз.
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(target);
    expect(aliveAtSettle).toEqual([true]);
    expect(pty.get(target)).toBeDefined();
    expect((await sessionOf(target)).queued ?? null).toBeNull();
    expect(notices('machine-over-limit')).toEqual([]);
    expect(existsSync(path.join(project, 'PARLEY.md'))).toBe(true);
    expect(logged.find((entry) => entry.line === 'запуск сессии: время шагов')?.fields).not.toHaveProperty('queued');
  });

  it('overflow по потолку: процесс идёт, человеку уведомление machine-over-limit с числом «живые + этот / потолок»', async () => {
    const { ref } = await workWith(1);
    const { capacity } = fakeCapacity({ kind: 'overflow', reason: 'machine-limit', live: 18, limit: 18 });
    const { sessions, pty } = rig(capacity);

    expect(await sessions.launch(ref(1), 'launch')).toBe('started');

    expect(pty.get(ref(1))).toBeDefined();
    expect(notices('machine-over-limit')).toEqual([expect.objectContaining({ ref: ref(1), text: 'S01 started over the machine limit (19/18)' })]);
  });

  it('overflow по памяти: уведомление без чисел', async () => {
    const { ref } = await workWith(1);
    const { capacity } = fakeCapacity({ kind: 'overflow', reason: 'memory-critical', live: 3, limit: 18 });
    const { sessions } = rig(capacity);

    expect(await sessions.launch(ref(1), 'launch')).toBe('started');

    expect(notices('machine-over-limit')).toEqual([expect.objectContaining({ ref: ref(1), text: 'S01 started while memory is critical' })]);
  });

  it('overflow, чей запуск отказал до старта: уведомления нет, резерв снят', async () => {
    const { ref } = await workWith(1);
    const { capacity, settle } = fakeCapacity({ kind: 'overflow', reason: 'machine-limit', live: 18, limit: 18 });
    const { sessions } = rig(capacity, { spawnLimits: async () => null });

    await expect(sessions.launch(ref(1), 'launch')).rejects.toThrow('spawn-budget-unavailable');

    expect(settle).toHaveBeenCalledTimes(1);
    expect(notices('machine-over-limit')).toEqual([]);
  });
});

describe('launch(): резерв машины снимается на любом исходе', () => {
  it('сбой до старта процесса: settle в finally, резерв работы released', async () => {
    const { ref } = await workWith(1);
    const { capacity, admit, settle } = fakeCapacity(START);
    // Предел длины запуска не определён: запуск падает после допуска и резерва, до `pty.start`.
    const { sessions, pty } = rig(capacity, { spawnLimits: async () => null });
    const target = ref(1);

    await expect(sessions.launch(target, 'launch')).rejects.toThrow('spawn-budget-unavailable');

    expect(admit).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(target);
    expect(pty.get(target)).toBeUndefined();
    expect(await attemptsOf(target)).toEqual([expect.objectContaining({ state: 'released' })]);
  });

  it('отказ до допуска (провайдера нет в реестре): ёмкость не спрашивают и не снимают', async () => {
    const { ref } = await workWith(1);
    await updateMap(project, ref(1).workId, (map) => {
      map.sessions[0]!.provider = 'removed-provider';
    });
    const { capacity, admit, settle, pump } = fakeCapacity(START);
    const { sessions } = rig(capacity);

    await expect(sessions.launch(ref(1), 'launch')).rejects.toThrow('removed-provider');

    expect(admit).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(pump).not.toHaveBeenCalled();
  });

  it('отказ бюджета работы: допуск машины стоит после него, поэтому ёмкость не спрашивают', async () => {
    await saveConfig({ workConcurrent: 1 });
    const { ref } = await workWith(2);
    const { capacity, admit, settle } = fakeCapacity(START);
    const { sessions } = rig(capacity);
    await sessions.launch(ref(1), 'launch');
    admit.mockClear();
    settle.mockClear();

    await expect(sessions.launch(ref(2), 'launch')).rejects.toMatchObject({ data: { code: 'resource-budget' } });

    expect(admit).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
});

describe('launch(): класс запуска', () => {
  it('из by: нет by — человек, wake — письмо, id сессии — агент, engine — движок', async () => {
    const { ref } = await workWith(5);
    const { capacity, admit, state } = fakeCapacity(QUEUE);
    const { sessions } = rig(capacity);
    const classOf = (n: number): LaunchClass | undefined => admit.mock.calls.find(([request]) => request.ref.sessionId === ref(n).sessionId)?.[0].launchClass;

    await sessions.launch(ref(1), 'launch');
    await sessions.launch(ref(2), 'launch', { by: 'human' });
    await sessions.launch(ref(3), 'resume', { by: 'wake' });
    await sessions.launch(ref(4), 'launch', { by: 's-01' });
    // Движок в очередь не встаёт: допуск отвечает ему `start`.
    state.ticket = START;
    await sessions.launch(ref(5), 'launch', { by: ENGINE });

    expect([1, 2, 3, 4, 5].map(classOf)).toEqual(['human', 'human', 'mail', 'agent', 'engine']);
    expect((await sessionOf(ref(3))).queued).toMatchObject({ class: 'mail', mode: 'resume', by: 'wake' });
  });

  it('явный launchClass перекрывает класс из by: письмо человека будит как человек', async () => {
    const { ref } = await workWith(1);
    const { capacity, admit } = fakeCapacity(QUEUE);
    const { sessions } = rig(capacity);

    await sessions.launch(ref(1), 'resume', { by: 'wake', launchClass: 'human' });

    expect(admit).toHaveBeenCalledWith({ ref: ref(1), launchClass: 'human' });
    expect((await sessionOf(ref(1))).queued).toMatchObject({ class: 'human', mode: 'resume', by: 'wake' });
  });

  it('без сервиса ёмкости допуска нет: запуск идёт как раньше', async () => {
    const { ref } = await workWith(1);
    const pty = createPtyManager(fakeHost());
    const sessions = createSessionsService(fakeHost(), fakeWorks(), pty, fakeActivity());
    cleanup.push(() => sessions.stopAll());

    expect(await sessions.launch(ref(1), 'launch')).toBe('started');

    expect(pty.get(ref(1))).toBeDefined();
  });
});

describe('create(): сессия в очереди', () => {
  it('агент: ответ с queued и причиной, сессия pending, процесса нет, ни одного резерва в ожидании', async () => {
    const { workId, ref } = await workWith(1);
    const { capacity } = fakeCapacity(QUEUE);
    const { sessions, pty } = rig(capacity);

    const created = await sessions.create({
      projectPath: project, workId, provider: 'claude', label: 'Peer', task: 'Implement', parent: null, requestedBy: ref(1).sessionId,
    });

    expect(created).toEqual({ projectPath: project, workId, sessionId: 's-02', queued: 'machine-limit' });
    expect(pty.get(created)).toBeUndefined();
    const session = await sessionOf(created);
    expect(session.lifecycle).toBe('pending');
    expect(session.queued).toMatchObject({ class: 'agent', mode: 'launch', by: 's-01', reason: 'machine-limit' });
    const map = await readMap(project, workId);
    expect(map.resources?.spawned).toBe(1);
    expect(await attemptsOf(created)).toEqual([expect.objectContaining({ state: 'released' })]);
    expect(map.resources?.attempts.filter((attempt) => attempt.state === 'reserved')).toEqual([]);
  });

  it('причина памяти доходит до ответа агенту', async () => {
    const { workId, ref } = await workWith(1);
    const { capacity } = fakeCapacity({ kind: 'queue', reason: 'memory-critical', live: 5, limit: 18 });
    const { sessions } = rig(capacity);

    const created = await sessions.create({
      projectPath: project, workId, provider: 'claude', label: 'Peer', task: 'Implement', parent: null, requestedBy: ref(1).sessionId,
    });

    expect(created.queued).toBe('memory-critical');
  });

  it('быстрая сессия человека (пустое задание): очередь первым классом, mode new', async () => {
    const { workId } = await workWith(0);
    const { capacity, admit } = fakeCapacity(QUEUE);
    const { sessions } = rig(capacity);

    const created = await sessions.create({ projectPath: project, workId, provider: 'claude', label: 'quick', task: '', parent: null });

    expect(created.queued).toBe('machine-limit');
    expect(admit).toHaveBeenCalledWith({ ref: { projectPath: project, workId, sessionId: created.sessionId }, launchClass: 'human' });
    expect((await sessionOf(created)).queued).toMatchObject({ class: 'human', mode: 'new', by: 'human' });
  });

  it('запись очереди не нашлась в карте: в ответе потолок машины', async () => {
    const { workId, ref } = await workWith(1);
    const { capacity, admit } = fakeCapacity(QUEUE);
    const { sessions } = rig(capacity);
    // Сессию уже подняли другим путём, пока `create` ждал ответа: записи очереди в карте нет.
    admit.mockImplementationOnce(async (request) => {
      await updateMap(project, workId, (map) => {
        map.sessions.find((candidate) => candidate.id === request.ref.sessionId)!.lifecycle = 'active';
      });
      return { kind: 'queue', reason: 'memory-critical', live: 5, limit: 18 };
    });

    const created = await sessions.create({
      projectPath: project, workId, provider: 'claude', label: 'Peer', task: 'Implement', parent: null, requestedBy: ref(1).sessionId,
    });

    expect(created.queued).toBe('machine-limit');
  });

  it('сессия с worktree в очереди: план записан, каталог не создан', async () => {
    await runGit('git', ['init', '-b', 'main', project]);
    await runGit('git', ['-C', project, 'config', 'user.email', 'тест@parley']);
    await runGit('git', ['-C', project, 'config', 'user.name', 'тест']);
    await writeFile(path.join(project, 'README.md'), 'старт\n', 'utf8');
    await runGit('git', ['-C', project, 'add', 'README.md']);
    await runGit('git', ['-C', project, 'commit', '-m', 'первый']);
    setEnv('PARLEY_WORKTREE_ROOT', await mkdtemp(path.join(tmpdir(), 'parley-sessions-queue-wt-')));
    const { workId, ref } = await workWith(1);
    const { capacity } = fakeCapacity(QUEUE);
    const { sessions } = rig(capacity);

    const created = await sessions.create({
      projectPath: project, workId, provider: 'claude', label: 'Peer', task: 'Implement', parent: null, requestedBy: ref(1).sessionId, worktree: true,
    });

    expect(created.queued).toBe('machine-limit');
    const session = await sessionOf(created);
    expect(session.worktree?.createdAt).toBeNull();
    expect(existsSync(session.worktree?.path as string)).toBe(false);
  });
});

describe('switchAgent(): замена при полном потолке', () => {
  it('queued проходит до ответа: switching остаётся, запись очереди есть, процесса нет', async () => {
    const { ref } = await workWith(1);
    const { capacity, state, admit } = fakeCapacity(START);
    const { sessions, pty } = rig(capacity, {
      takeover: { handover: (async () => ({ text: 'HANDOVER-PACKAGE', tailFile: null })) as never },
    });
    const target = ref(1);
    await sessions.launch(target, 'launch');
    expect(pty.get(target)).toBeDefined();
    // Потолок заполнился, пока агент жил: новому агенту места нет.
    state.ticket = QUEUE;
    admit.mockClear();
    const requestId = '00000000-0000-4000-8000-000000000001';

    // Заглушка не отдаёт хуков, поэтому «у приглашения» не видно: замена живой сессии — с force.
    const result = await sessions.switchAgent(target, { requestId, provider: 'codex', force: true });

    expect(result).toEqual({ outcome: 'queued', carried: 'handover' });
    expect(admit).toHaveBeenCalledWith({ ref: target, launchClass: 'human' });
    expect(pty.get(target)).toBeUndefined();
    const session = await sessionOf(target);
    expect(session).toMatchObject({ provider: 'codex', lifecycle: 'sleeping', switching: { id: requestId, to: 'codex' } });
    expect(session.queued).toMatchObject({ class: 'human', mode: 'launch', by: 'human', reason: 'machine-limit' });
    // Повтор того же запроса — тот же ответ, без второй замены.
    expect(await sessions.switchAgent(target, { requestId, provider: 'codex', force: true })).toEqual(result);
    expect((await sessionOf(target)).previousAgents).toHaveLength(1);
  });
});
