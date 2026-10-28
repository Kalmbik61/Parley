import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PARLEY,
  addRoom,
  addSession,
  archiveRoom,
  createWork,
  deleteWorkFiles,
  readStoredMap,
  removeSession,
  setResult,
  transitionSession,
  updateMap,
  workVersion,
  HUMAN,
} from '@parley/core';
import type { Message, SessionLifecycle, WorkMap, WorkSession, WorkSwarm, WorkSwarmMember, SwarmCreator } from '@parley/core';
import type { EventData, EventName, SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';
import { swarmsCancel, swarmsSeen } from '../methods/swarms.js';
import type { WorksService } from '../works/works-service.js';
import { SWARM_EXPIRY_GRACE_MS, SWARM_TICK_MS, createSwarmsService } from './swarms-service.js';
import type { SwarmsService, SwarmsServiceOptions } from './swarms-service.js';

const START = '2026-10-28T12:00:00.000Z';
const MIN = 60_000;

let home = '';
let project = '';
let workId = '';
let listeners: Array<() => void> = [];
let stoppers: Array<() => Promise<void>> = [];
let notices: Array<{ event: EventName; data: EventData<EventName> }> = [];
let closeCalls: string[] = [];
let logErrors: string[] = [];

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-swarms-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-swarms-project-'));
  process.env['PARLEY_HOME'] = home;
  listeners = [];
  stoppers = [];
  notices = [];
  closeCalls = [];
  logErrors = [];
  // Часы и таймеры фальшивые, диск настоящий: `setImmediate` остаётся живым.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date(START));
});

afterEach(async () => {
  for (const stop of stoppers) await stop();
  vi.useRealTimers();
  delete process.env['PARLEY_HOME'];
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------------------------
// Стенд
// ---------------------------------------------------------------------------------------------

const realTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Дать службе дописать то, что она начала: настоящие I/O, фальшивые таймеры. */
async function quiet(ms = 80): Promise<void> {
  const end = performance.now() + ms;
  do {
    await realTick();
  } while (performance.now() < end);
}

/** Сдвинуть часы и таймеры на `ms`; службе остаётся время дописать карту. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await quiet();
}

const fakeHost = (): HostContext =>
  ({
    log: { info: () => {}, warn: () => {}, error: (message: string) => logErrors.push(message) },
    broadcast: (event: EventName, data: EventData<EventName>) => notices.push({ event, data }),
  }) as unknown as HostContext;

/** Снимок работ хоста: карта всегда свежая с диска, подписчики зовутся по `emit`. */
const fakeWorks = {
  snapshot: () => ({ entries: [{ projectPath: project, map: readStoredMap(project, workId) }], branches: {} }),
  onChange(listener: () => void) {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((item) => item !== listener);
    };
  },
} as unknown as WorksService;

/** `sessions.close` хоста: остановка и `closed` в карте. */
const fakeSessions = {
  async close(ref: SessionRef): Promise<void> {
    closeCalls.push(ref.sessionId);
    await updateMap(ref.projectPath, ref.workId, (map) => {
      const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
      if (session !== undefined && session.lifecycle !== 'closed') transitionSession(map, ref.sessionId, 'closed');
    });
  },
};

async function emit(): Promise<void> {
  for (const listener of listeners) listener();
  await quiet();
}

function boot(options: SwarmsServiceOptions = { limits: async () => ({ swarmMinutes: 0 }) }): SwarmsService {
  const service = createSwarmsService(fakeHost(), fakeWorks, fakeSessions, options);
  service.start();
  stoppers.push(() => service.stop());
  return service;
}

const refOf = (sessionId: string): SessionRef => ({ projectPath: project, workId, sessionId });
const stored = (): WorkMap => readStoredMap(project, workId);
const sessionOf = (id: string): WorkSession => {
  const found = stored().sessions.find((session) => session.id === id);
  if (found === undefined) throw new Error(`нет сессии ${id}`);
  return found;
};
const swarmOf = (): WorkSwarm => {
  const found = stored().swarms?.[0];
  if (found === undefined) throw new Error('нет роя');
  return found;
};
const memberOf = (id: string): WorkSwarmMember => {
  const found = swarmOf().members.find((candidate) => candidate.sessionId === id);
  if (found === undefined) throw new Error(`нет участника ${id}`);
  return found;
};
const lettersTo = (id: string): Message[] =>
  readStoredMap(project, workId).messages.filter((message) => message.from === PARLEY && message.to.includes(id));

interface Made {
  queen: string;
  drones: string[];
  verifiers: string[];
}

/** Работа с роем sw-01: королева, `drones` трутней, `verifiers` проверяющих; все активны, рой идёт. */
async function makeSwarm(
  options: {
    drones?: number;
    verifiers?: number;
    creator?: SwarmCreator;
    patch?: Partial<WorkSwarm>;
    extra?: (map: WorkMap, made: Made) => void;
  } = {},
): Promise<Made> {
  const created = await createWork(project, { title: 'Работа' });
  workId = created.work.id;
  const made: Made = { queen: '', drones: [], verifiers: [] };
  await updateMap(project, workId, (map) => {
    const add = (label: string): string => {
      const session = addSession(map, { provider: 'claude', label, task: 'исследовать' });
      transitionSession(map, session.id, 'active');
      return session.id;
    };
    made.queen = add('Королева');
    for (let n = 0; n < (options.drones ?? 2); n += 1) made.drones.push(add(`Трутень ${n + 1}`));
    for (let n = 0; n < (options.verifiers ?? 0); n += 1) made.verifiers.push(add(`Проверяющий ${n + 1}`));
    const member = (sessionId: string, role: WorkSwarmMember['role'], n: number): WorkSwarmMember => ({
      sessionId,
      role,
      n,
      addedAt: START,
      handedAt: null,
    });
    map.swarms = [
      {
        id: 'sw-01',
        tag: 'Research',
        creator: options.creator ?? { kind: 'human' },
        objective: 'Audit the repository',
        queen: made.queen,
        members: [
          member(made.queen, 'queen', 1),
          ...made.drones.map((id, index) => member(id, 'drone', index + 1)),
          ...made.verifiers.map((id, index) => member(id, 'verifier', index + 1)),
        ],
        status: 'running',
        createdAt: START,
        endedAt: null,
        result: null,
        failure: null,
        seenAt: null,
        expiredAt: null,
        ...options.patch,
      },
    ];
    options.extra?.(map, made);
  });
  return made;
}

/** Сессия сдаёт `report`: резюме и итог, процесс не закрыт (как делает инструмент `report`). */
async function report(id: string, result: 'done' | 'failed', summary: string): Promise<void> {
  await updateMap(project, workId, (map) => {
    const session = map.sessions.find((candidate) => candidate.id === id)!;
    session.summary = summary;
    setResult(map, id, result);
  });
}

async function setLifecycle(id: string, to: SessionLifecycle): Promise<void> {
  await updateMap(project, workId, (map) => {
    transitionSession(map, id, to);
  });
}

// ---------------------------------------------------------------------------------------------
// Сдача трутня и автозакрытие (3.2)
// ---------------------------------------------------------------------------------------------

describe('сдача участника', () => {
  it('done: handedAt = resultAt, затем сессия закрыта, остальные живы', async () => {
    const { drones } = await makeSwarm({ drones: 2 });
    boot();
    await report(drones[0]!, 'done', 'всё прочитано');
    await emit();

    expect(memberOf(drones[0]!).handedAt).toBe(sessionOf(drones[0]!).resultAt);
    expect(memberOf(drones[0]!).handedAt).not.toBeNull();
    expect(sessionOf(drones[0]!).lifecycle).toBe('closed');
    expect(sessionOf(drones[1]!).lifecycle).toBe('active');
    expect(memberOf(drones[1]!).handedAt).toBeNull();
  });

  it('перезапуск между записью и закрытием дозакрывает сданного, но живого участника', async () => {
    const { drones } = await makeSwarm({ drones: 2 });
    await report(drones[0]!, 'done', 'готово');
    await updateMap(project, workId, (map) => {
      map.swarms![0]!.members.find((member) => member.sessionId === drones[0])!.handedAt = map.sessions.find(
        (session) => session.id === drones[0],
      )!.resultAt;
    });
    expect(sessionOf(drones[0]!).lifecycle).toBe('active');

    boot();
    await quiet();

    expect(closeCalls).toEqual([drones[0]]);
    expect(sessionOf(drones[0]!).lifecycle).toBe('closed');
  });

  it('failed: участник закрыт без handedAt', async () => {
    const { drones } = await makeSwarm({ drones: 2 });
    boot();
    await report(drones[0]!, 'failed', 'не вышло');
    await emit();

    expect(memberOf(drones[0]!).handedAt).toBeNull();
    expect(sessionOf(drones[0]!).lifecycle).toBe('closed');
    expect(sessionOf(drones[1]!).lifecycle).toBe('active');
  });

  it('progress ничего не делает', async () => {
    const { drones } = await makeSwarm({ drones: 1 });
    boot();
    await updateMap(project, workId, (map) => {
      map.sessions.find((session) => session.id === drones[0])!.summary = 'пока половина';
    });
    await emit();

    expect(memberOf(drones[0]!).handedAt).toBeNull();
    expect(sessionOf(drones[0]!).lifecycle).toBe('active');
    expect(closeCalls).toEqual([]);
  });

  it('повторный report закрытой сессии отвергается ядром', async () => {
    const { drones } = await makeSwarm({ drones: 1 });
    await report(drones[0]!, 'done', 'готово');
    await setLifecycle(drones[0]!, 'closed');

    await expect(report(drones[0]!, 'done', 'переписать')).rejects.toThrow(/closed/);
  });
});

// ---------------------------------------------------------------------------------------------
// Переходы (3)
// ---------------------------------------------------------------------------------------------

describe('переходы', () => {
  it('running → collecting, когда все трутни и проверяющие терминальны; письмо королеве в той же записи', async () => {
    const { queen, drones, verifiers } = await makeSwarm({ drones: 2, verifiers: 1 });
    boot();
    await report(drones[0]!, 'done', 'a');
    await report(drones[1]!, 'failed', 'b');
    await emit();
    expect(swarmOf().status).toBe('running');
    expect(lettersTo(queen)).toHaveLength(0);

    await report(verifiers[0]!, 'done', 'c');
    await emit();

    expect(swarmOf().status).toBe('collecting');
    const letters = lettersTo(queen);
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({ from: PARLEY, roomId: null, kind: 'note' });
    expect(letters[0]!.text).toContain('sw-01');
  });

  it('письмо «все сдали» доходит и до уснувшей королевы (её поднимет будильник)', async () => {
    const { queen, drones } = await makeSwarm({ drones: 1 });
    await setLifecycle(queen, 'sleeping');
    boot();
    await report(drones[0]!, 'done', 'a');
    await emit();

    expect(swarmOf().status).toBe('collecting');
    expect(sessionOf(queen).lifecycle).toBe('sleeping');
    expect(lettersTo(queen)).toHaveLength(1);
  });

  it('сданный трутень, чью сессию ещё не закрыли, не держит рой: handedAt терминален сам по себе', async () => {
    const { queen, drones } = await makeSwarm({ drones: 1 });
    await updateMap(project, workId, (map) => {
      map.swarms![0]!.members[1]!.handedAt = START;
    });
    // Закрытие не успевает: хост занят, а рой уже сверен.
    const slow = { close: vi.fn(() => new Promise<void>(() => {})) };
    const service = createSwarmsService(fakeHost(), fakeWorks, slow, { limits: async () => ({ swarmMinutes: 0 }) });
    service.start();
    await quiet();

    expect(slow.close).toHaveBeenCalledTimes(1);
    expect(sessionOf(drones[0]!).lifecycle).toBe('active');
    expect(swarmOf().status).toBe('collecting');
    expect(lettersTo(queen)).toHaveLength(1);
    // Остановка не ждёт повисшее закрытие: тест не должен висеть.
    service.stop().catch(() => undefined);
  });

  it('рой без трутней остаётся running', async () => {
    await makeSwarm({ drones: 0 });
    boot();
    await emit();
    expect(swarmOf().status).toBe('running');
  });

  it('королева сдала done → done, summary из её резюме, endedAt, трутни закрыты, королева жива', async () => {
    const { queen, drones } = await makeSwarm({ drones: 2 });
    boot();
    await report(queen, 'done', 'Итоговая сводка');
    await emit();

    const swarm = swarmOf();
    expect(swarm.status).toBe('done');
    expect(swarm.endedAt).not.toBeNull();
    expect(swarm.result?.summary).toBe('Итоговая сводка');
    for (const id of drones) expect(sessionOf(id).lifecycle).toBe('closed');
    expect(sessionOf(queen).lifecycle).toBe('active');
  });

  it('сводка длиннее предела режется', async () => {
    const { queen } = await makeSwarm({ drones: 0 });
    boot();
    await report(queen, 'done', 'я'.repeat(5000));
    await emit();

    expect(swarmOf().result?.summary).toHaveLength(4096);
  });

  it('королева сдала failed → failed', async () => {
    const { queen } = await makeSwarm({ drones: 1 });
    boot();
    await report(queen, 'failed', 'не вышло');
    await emit();

    expect(swarmOf()).toMatchObject({ status: 'failed', result: { summary: 'не вышло' } });
  });

  it('королева закрыта без сдачи не человеком → failed', async () => {
    const { queen, drones } = await makeSwarm({ drones: 1 });
    boot();
    await setLifecycle(queen, 'closed');
    await emit();

    expect(swarmOf()).toMatchObject({ status: 'failed', failure: 'the queen was closed without a report' });
    expect(sessionOf(drones[0]!).lifecycle).toBe('closed');
  });

  it('королева закрыта человеком (sessions.close) → cancelled', async () => {
    const { queen, drones } = await makeSwarm({ drones: 1 });
    const service = boot();
    service.humanClosed(refOf(queen));
    await setLifecycle(queen, 'closed');
    await emit();

    expect(swarmOf()).toMatchObject({ status: 'cancelled', failure: 'the queen was closed by the human' });
    expect(sessionOf(drones[0]!).lifecycle).toBe('closed');
  });

  it('метка humanClosed живёт в памяти: перезапуск между закрытием королевы человеком и сверкой даёт failed (v1)', async () => {
    const { queen } = await makeSwarm({ drones: 1 });
    const before = boot();
    before.humanClosed(refOf(queen));
    before.stop();
    await setLifecycle(queen, 'closed');

    boot();
    await quiet();

    expect(swarmOf()).toMatchObject({ status: 'failed', failure: 'the queen was closed without a report' });
  });

  it('humanClosed трутня рой не отменяет', async () => {
    const { drones } = await makeSwarm({ drones: 2 });
    const service = boot();
    service.humanClosed(refOf(drones[0]!));
    await setLifecycle(drones[0]!, 'closed');
    await emit();

    expect(swarmOf().status).toBe('running');
  });

  it('королева удалена (core: cancelled) → живые участники закрыты, итог доставлен', async () => {
    const { queen, drones } = await makeSwarm({ drones: 1 });
    boot();
    await updateMap(project, workId, (map, letters) => {
      removeSession(map, letters, queen);
    });
    await emit();

    expect(swarmOf()).toMatchObject({ status: 'cancelled', failure: 'queen deleted' });
    expect(sessionOf(drones[0]!).lifecycle).toBe('closed');
    expect(swarmOf().result?.deliveredAt).not.toBeNull();
  });

  it('участники терминального роя закрыты, королева нет; endedAt ставится один раз', async () => {
    const { queen, drones, verifiers } = await makeSwarm({ drones: 1, verifiers: 1 });
    boot();
    await report(queen, 'done', 'готово');
    await emit();
    const endedAt = swarmOf().endedAt;
    await advance(SWARM_TICK_MS * 3);

    for (const id of [...drones, ...verifiers]) expect(sessionOf(id).lifecycle).toBe('closed');
    expect(sessionOf(queen).lifecycle).toBe('active');
    expect(swarmOf().endedAt).toBe(endedAt);
  });

  it('повторная сверка ничего не меняет и не шлёт второго письма', async () => {
    const { queen, drones } = await makeSwarm({ drones: 1, creator: { kind: 'session', sessionId: 's-99' } });
    const service = boot();
    await report(drones[0]!, 'done', 'a');
    await emit();
    await report(queen, 'done', 'сводка');
    await emit();
    const version = workVersion(project, workId);
    const letters = stored().messages.length;

    await service.reconcile();
    await service.reconcile();
    await advance(SWARM_TICK_MS);

    expect(workVersion(project, workId)).toBe(version);
    expect(stored().messages).toHaveLength(letters);
  });
});

// ---------------------------------------------------------------------------------------------
// Срок жизни (3.0)
// ---------------------------------------------------------------------------------------------

describe('срок жизни', () => {
  const limits = (swarmMinutes: number): SwarmsServiceOptions => ({ limits: async () => ({ swarmMinutes }) });

  it('таймер срабатывает без снимков карты: failed, expiredAt, участники закрыты, письмо королеве', async () => {
    const { queen, drones } = await makeSwarm({ drones: 2 });
    boot(limits(90));
    await advance(89 * MIN);
    expect(swarmOf().status).toBe('running');

    await advance(MIN + SWARM_TICK_MS);

    const swarm = swarmOf();
    expect(swarm).toMatchObject({ status: 'failed', failure: 'time limit: 90 min' });
    expect(swarm.expiredAt).not.toBeNull();
    expect(swarm.endedAt).toBe(swarm.expiredAt);
    for (const id of drones) expect(sessionOf(id).lifecycle).toBe('closed');
    expect(sessionOf(queen).lifecycle).toBe('active');
    const letters = lettersTo(queen);
    expect(letters).toHaveLength(1);
    expect(letters[0]!.text).toContain('sw-01');
    expect(letters[0]!.text).toContain('90 min');
    // Итог ждёт сдачи королевы.
    expect(swarm.result).toBeNull();
    expect(notices).toHaveLength(0);
  });

  it('итог просроченного роя уходит с частичной сводкой после report королевы', async () => {
    const { queen } = await makeSwarm({ drones: 1 });
    boot(limits(90));
    await advance(91 * MIN);
    expect(swarmOf().result).toBeNull();

    await report(queen, 'done', 'покрыто две трети');
    await emit();

    const swarm = swarmOf();
    expect(swarm.status).toBe('failed');
    expect(swarm.result?.summary).toBe('покрыто две трети');
    expect(swarm.result?.deliveredAt).not.toBeNull();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.data).toMatchObject({ kind: 'swarm-failed' });
    expect((notices[0]!.data as { text: string }).text).toContain('покрыто две трети');
    expect((notices[0]!.data as { text: string }).text).toContain('time limit: 90 min');
  });

  it('без report за 10 минут итог уходит без сводки', async () => {
    await makeSwarm({ drones: 1 });
    boot(limits(90));
    await advance(91 * MIN);
    expect(notices).toHaveLength(0);

    await advance(SWARM_EXPIRY_GRACE_MS);

    expect(notices).toHaveLength(1);
    const text = (notices[0]!.data as { text: string }).text;
    expect(text).toContain('queen did not report');
    expect(text).not.toContain('get_map');
    expect(swarmOf().result).toMatchObject({ summary: '' });
    expect(swarmOf().result?.deliveredAt).not.toBeNull();
  });

  it('поздний report королевы после срока ожидания: итог уходит ещё раз со сводкой', async () => {
    const { queen } = await makeSwarm({ drones: 1 });
    boot(limits(90));
    await advance(91 * MIN + SWARM_EXPIRY_GRACE_MS);
    expect(notices).toHaveLength(1);

    await report(queen, 'done', 'успела сдать');
    await emit();

    expect(notices).toHaveLength(2);
    expect((notices[1]!.data as { text: string }).text).toContain('успела сдать');
    expect(swarmOf().result).toMatchObject({ summary: 'успела сдать' });
    await emit();
    await advance(SWARM_TICK_MS);
    expect(notices).toHaveLength(2);
  });

  it('королева закрыта после срока: итог без сводки уходит сразу', async () => {
    const { queen } = await makeSwarm({ drones: 1 });
    boot(limits(90));
    await advance(91 * MIN);
    await setLifecycle(queen, 'closed');
    await emit();

    expect(notices).toHaveLength(1);
  });

  it('swarmMinutes = 0 срок отключает', async () => {
    const { drones } = await makeSwarm({ drones: 1 });
    boot(limits(0));
    await advance(24 * 60 * MIN);

    expect(swarmOf()).toMatchObject({ status: 'running', expiredAt: null });
    expect(sessionOf(drones[0]!).lifecycle).toBe('active');
  });

  it('терминальный рой по сроку не трогают', async () => {
    const { queen } = await makeSwarm({ drones: 0 });
    boot(limits(90));
    await report(queen, 'done', 'в срок');
    await emit();
    await advance(100 * MIN);

    expect(swarmOf()).toMatchObject({ status: 'done', expiredAt: null });
  });
});

// ---------------------------------------------------------------------------------------------
// Доставка (3.3)
// ---------------------------------------------------------------------------------------------

describe('доставка итога', () => {
  it('создатель-сессия: письмо от PARLEY, заголовок, сводка и путь к отчёту; deliveredAt в той же записи', async () => {
    let creator = '';
    const { queen, drones } = await makeSwarm({
      drones: 2,
      extra: (map) => {
        const session = addSession(map, { provider: 'claude', label: 'Создатель', task: 'x' });
        transitionSession(map, session.id, 'active');
        creator = session.id;
      },
    });
    await updateMap(project, workId, (map) => {
      map.swarms![0]!.creator = { kind: 'session', sessionId: creator };
    });
    boot();
    await report(drones[0]!, 'done', 'a');
    await emit();
    await report(queen, 'done', 'Главное: всё хорошо');
    await emit();

    const letters = lettersTo(creator);
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({ from: PARLEY, roomId: null, kind: 'note' });
    expect(letters[0]!.text).toMatch(/^Swarm sw-01 \[Research\] done, 1\/2 handed in, \d+:\d{2}/);
    expect(letters[0]!.text).toContain('Главное: всё хорошо');
    expect(letters[0]!.text).toContain(`get_map {session: "${queen}", field: "summary"}`);
    expect(swarmOf().result?.deliveredAt).not.toBeNull();
    expect(notices).toHaveLength(0);
  });

  it('создатель-комната: письмо в комнату живому ведущему', async () => {
    let roomId = '';
    let lead = '';
    const { queen } = await makeSwarm({
      drones: 0,
      extra: (map) => {
        const session = addSession(map, { provider: 'claude', label: 'Ведущий', task: 'x' });
        transitionSession(map, session.id, 'active');
        lead = session.id;
        roomId = addRoom(map, { title: 'Комната', creator: HUMAN, members: [lead], lead }).id;
      },
    });
    await updateMap(project, workId, (map) => {
      map.swarms![0]!.creator = { kind: 'room', roomId };
    });
    boot();
    await report(queen, 'done', 'итог');
    await emit();

    const letters = lettersTo(lead);
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({ from: PARLEY, roomId });
    expect(notices).toHaveLength(0);
    expect(swarmOf().result?.deliveredAt).not.toBeNull();
  });

  it('комната в архиве или без живого ведущего: путь человека', async () => {
    let roomId = '';
    const { queen } = await makeSwarm({
      drones: 0,
      extra: (map) => {
        const session = addSession(map, { provider: 'claude', label: 'Ведущий', task: 'x' });
        transitionSession(map, session.id, 'active');
        roomId = addRoom(map, { title: 'Комната', creator: HUMAN, members: [session.id], lead: session.id }).id;
      },
    });
    await updateMap(project, workId, (map, letters) => {
      map.swarms![0]!.creator = { kind: 'room', roomId };
      archiveRoom(map, letters, roomId);
    });
    boot();
    await report(queen, 'done', 'итог');
    await emit();

    expect(notices).toHaveLength(1);
    expect(notices[0]!.data).toMatchObject({ kind: 'swarm-done', ref: refOf(queen) });
  });

  it('создатель-сессия закрыта: путь человека', async () => {
    let creator = '';
    const { queen } = await makeSwarm({
      drones: 0,
      extra: (map) => {
        const session = addSession(map, { provider: 'claude', label: 'Создатель', task: 'x' });
        transitionSession(map, session.id, 'active');
        transitionSession(map, session.id, 'closed');
        creator = session.id;
      },
    });
    await updateMap(project, workId, (map) => {
      map.swarms![0]!.creator = { kind: 'session', sessionId: creator };
    });
    boot();
    await report(queen, 'done', 'итог');
    await emit();

    expect(lettersTo(creator)).toHaveLength(0);
    expect(notices).toHaveLength(1);
  });

  it('человек: host.notice swarm-done с королевой в ref, затем deliveredAt', async () => {
    const { queen, drones } = await makeSwarm({ drones: 1 });
    boot();
    await report(drones[0]!, 'done', 'a');
    await emit();
    await report(queen, 'done', 'Сводка для человека');
    await emit();

    expect(notices).toHaveLength(1);
    expect(notices[0]!.event).toBe('host.notice');
    const data = notices[0]!.data as { kind: string; ref: SessionRef; text: string; at: string };
    expect(data.kind).toBe('swarm-done');
    expect(data.ref).toEqual(refOf(queen));
    expect(data.text).toMatch(/^Swarm sw-01 \[Research\] done, 1\/1 handed in, \d+:\d{2}\n\nСводка для человека/);
    expect(swarmOf().result?.deliveredAt).not.toBeNull();
  });

  it('упавший рой: kind swarm-failed, причина в тексте, без сводки нет и пути к отчёту', async () => {
    const { queen } = await makeSwarm({ drones: 0 });
    boot();
    await setLifecycle(queen, 'closed');
    await emit();

    const data = notices[0]!.data as { kind: string; text: string };
    expect(data.kind).toBe('swarm-failed');
    expect(data.text).toContain('failed');
    expect(data.text).toContain('Reason: the queen was closed without a report');
    expect(data.text).not.toContain('get_map');
    expect(swarmOf().result).toMatchObject({ summary: '' });
  });

  it('отменённый рой тоже доставляет, для человека это swarm-failed', async () => {
    const { drones } = await makeSwarm({ drones: 1 });
    boot();
    await swarmsCancel({ projectPath: project, workId, swarmId: 'sw-01' }, {} as never);
    await emit();

    expect(notices).toHaveLength(1);
    expect(notices[0]!.data).toMatchObject({ kind: 'swarm-failed' });
    expect((notices[0]!.data as { text: string }).text).toContain('cancelled');
    expect((notices[0]!.data as { text: string }).text).toContain('Reason: cancelled by the human');
    expect(sessionOf(drones[0]!).lifecycle).toBe('closed');
    expect(swarmOf().result).toMatchObject({ summary: '' });
  });

  it('недоставленный итог после перезапуска отправляется снова; доставленный нет', async () => {
    const { queen } = await makeSwarm({
      drones: 0,
      patch: { status: 'done', endedAt: START, result: { summary: 'итог', at: START, deliveredAt: null } },
    });
    const first = boot();
    await quiet();
    expect(notices).toHaveLength(1);
    await first.stop();

    // «Хост упал» между уведомлением и deliveredAt.
    await updateMap(project, workId, (map) => {
      map.swarms![0]!.result!.deliveredAt = null;
    });
    boot();
    await quiet();
    expect(notices).toHaveLength(2);
    expect(notices[1]!.data).toMatchObject({ ref: refOf(queen) });

    boot();
    await quiet();
    expect(notices).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Методы
// ---------------------------------------------------------------------------------------------

describe('swarms.cancel и swarms.seen', () => {
  it('cancel: идущий рой → cancelled, причина, endedAt; терминальный — без изменений', async () => {
    await makeSwarm({ drones: 1 });
    await expect(swarmsCancel({ projectPath: project, workId, swarmId: 'sw-01' }, {} as never)).resolves.toEqual({ ok: true });
    expect(swarmOf()).toMatchObject({ status: 'cancelled', failure: 'cancelled by the human' });
    const endedAt = swarmOf().endedAt;
    expect(endedAt).not.toBeNull();

    vi.setSystemTime(new Date(Date.parse(START) + MIN));
    await expect(swarmsCancel({ projectPath: project, workId, swarmId: 'sw-01' }, {} as never)).resolves.toEqual({ ok: true });
    expect(swarmOf().endedAt).toBe(endedAt);
  });

  it('cancel терминального done не переписывает его', async () => {
    await makeSwarm({ drones: 0, patch: { status: 'done', endedAt: START } });
    await swarmsCancel({ projectPath: project, workId, swarmId: 'sw-01' }, {} as never);
    expect(swarmOf()).toMatchObject({ status: 'done', failure: null });
  });

  it('seen: seenAt ставится один раз и не двигает updatedAt', async () => {
    await makeSwarm({ drones: 0 });
    const updatedAt = stored().work.updatedAt;
    await swarmsSeen({ projectPath: project, workId, swarmId: 'sw-01' }, {} as never);
    const seenAt = swarmOf().seenAt;
    expect(seenAt).toBe(START);
    vi.setSystemTime(new Date(Date.parse(START) + MIN));
    await swarmsSeen({ projectPath: project, workId, swarmId: 'sw-01' }, {} as never);
    expect(swarmOf().seenAt).toBe(seenAt);
    expect(stored().work.updatedAt).toBe(updatedAt);
  });

  it('неизвестные рой и работа — not_found', async () => {
    await makeSwarm({ drones: 0 });
    await expect(swarmsCancel({ projectPath: project, workId, swarmId: 'sw-09' }, {} as never)).rejects.toMatchObject({ code: 'not_found' });
    await expect(swarmsSeen({ projectPath: project, workId, swarmId: 'sw-09' }, {} as never)).rejects.toMatchObject({ code: 'not_found' });
    await expect(swarmsCancel({ projectPath: project, workId: 'w-9999', swarmId: 'sw-01' }, {} as never)).rejects.toMatchObject({
      code: 'not_found',
    });
    await deleteWorkFiles(project, workId);
  });
});
