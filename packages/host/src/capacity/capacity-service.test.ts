import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SYSTEM,
  addSession,
  createWork,
  readStoredMap,
  sessionTag,
  setWorkStatus,
  transitionSession,
  updateMap,
} from '@parley/core';
import type { MachineConcurrent, MemoryPressure, QueuedLaunch, WorkSession } from '@parley/core';
import { refKey } from '@parley/protocol';
import type { SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';
import { HostError } from '../errors.js';
import type { PtyHandle } from '../pty/pty-manager.js';
import { BOUNCE_MS, BUDGET_BACKOFF_MS, IN_FLIGHT_MS, createCapacityService } from './capacity-service.js';
import type { CapacityDeps, CapacityService } from './capacity-service.js';

const MIN = 60_000;
/** Время записей очереди тестов отсчитывается от `T0`; часы сервиса стоят позже всех, поэтому новый запуск встаёт за ними. */
const T0 = Date.parse('2026-10-31T10:00:00.000Z');
const START = T0 + 10 * MIN;
const iso = (ms: number): string => new Date(ms).toISOString();

type LogLevel = 'info' | 'warn' | 'error';
type Sleeper = ReturnType<CapacityDeps['sleep']>;
/** Исход `launch()` хоста: запуск идёт, ждёт согласия человека на папку или встал в очередь. */
type Outcome = 'started' | 'held' | 'queued';

let home = '';
let project = '';
/** Работы, чьи карты отдаёт подставной снимок работ. */
let workIds: string[] = [];
/** Часы сервиса: тест двигает их сам. */
let clock = START;
let level: MemoryPressure = 'normal';
let machineConcurrent: MachineConcurrent = 2;
let sleepAfterMinutes = 60;
let configReads = 0;
/** Живые PTY хоста. */
let live: PtyHandle[] = [];
let exitListeners: Array<(ref: SessionRef) => void> = [];
let worksListeners: Array<() => void> = [];
let readingListeners: Array<(reading: { level: MemoryPressure }) => void> = [];
/** Вызовы `launch` и `retry` хоста. */
let launches: Array<{ ref: SessionRef; mode: QueuedLaunch['mode']; by: string }> = [];
let retries: SessionRef[] = [];
/** Те же вызовы в порядке обращения: `launch:<id>` и `retry:<id>`. */
let calls: string[] = [];
/** Что делает `launch` хоста: по умолчанию запуск удаётся. */
let launchImpl: (ref: SessionRef) => Promise<Outcome> = startedLaunch;
let sleeper: Sleeper;
let logs: Array<{ level: LogLevel; msg: string; data: Record<string, unknown> }> = [];
let stoppers: Array<() => void> = [];
let seq = 0;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-capacity-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-capacity-project-'));
  process.env['PARLEY_HOME'] = home;
  workIds = [];
  clock = START;
  level = 'normal';
  machineConcurrent = 2;
  sleepAfterMinutes = 60;
  configReads = 0;
  live = [];
  exitListeners = [];
  worksListeners = [];
  readingListeners = [];
  launches = [];
  retries = [];
  calls = [];
  launchImpl = startedLaunch;
  sleeper = undefined;
  logs = [];
  stoppers = [];
  seq = 0;
});

afterEach(async () => {
  for (const stop of stoppers) stop();
  delete process.env['PARLEY_HOME'];
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------------------------
// Стенд
// ---------------------------------------------------------------------------------------------

const realTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Дать сервису дописать то, что он начал: фальшивого времени нет, у сервиса нет и своих таймеров. */
async function quiet(ms = 40): Promise<void> {
  const end = performance.now() + ms;
  do {
    await realTick();
  } while (performance.now() < end);
}

const fakeHost = (): HostContext => {
  const write =
    (kind: LogLevel) =>
    (msg: string, data?: object): void => {
      logs.push({ level: kind, msg, data: { ...data } });
    };
  return { log: { info: write('info'), warn: write('warn'), error: write('error') } } as unknown as HostContext;
};

/** Снимок работ хоста: карты всегда свежие с диска. */
const works = {
  snapshot: () => ({
    entries: workIds.map((id) => ({ projectPath: project, map: readStoredMap(project, id) })),
    branches: {},
  }),
  onChange: (listener: () => void) => {
    worksListeners.push(listener);
    return () => {
      worksListeners = worksListeners.filter((item) => item !== listener);
    };
  },
} as unknown as CapacityDeps['works'];

const pty = {
  list: () => live,
  get: (ref: SessionRef) => live.find((handle) => refKey(handle.ref) === refKey(ref)),
  on: (event: string, listener: (ref: SessionRef) => void) => {
    if (event !== 'exit') return () => {};
    exitListeners.push(listener);
    return () => {
      exitListeners = exitListeners.filter((item) => item !== listener);
    };
  },
} as unknown as CapacityDeps['pty'];

const pressure: CapacityDeps['pressure'] = {
  current: () => ({ level }),
  onReading: (listener) => {
    readingListeners.push(listener);
    return () => {
      readingListeners = readingListeners.filter((item) => item !== listener);
    };
  },
};

function handleOf(ref: SessionRef): PtyHandle {
  return {
    ref,
    pid: 4242,
    startedAt: START,
    cols: 120,
    rows: 40,
    provider: 'claude',
    hasDraft: () => false,
    bracketedPaste: () => false,
  };
}

/** Запуск удался: процесс есть, сессия `active`, запись очереди снята — как после `launchHeld`. */
async function startedLaunch(ref: SessionRef): Promise<'started'> {
  live.push(handleOf(ref));
  await updateMap(
    ref.projectPath,
    ref.workId,
    (map) => {
      transitionSession(map, ref.sessionId, 'active');
    },
    { touch: false },
  );
  return 'started';
}

function boot(over: Partial<CapacityDeps> = {}): CapacityService {
  const service = createCapacityService(fakeHost(), {
    pty,
    works,
    pressure,
    config: async () => {
      configReads += 1;
      return { machineConcurrent, sleepAfterMinutes };
    },
    launch: async (ref, mode, choice) => {
      calls.push(`launch:${ref.sessionId}`);
      launches.push({ ref, mode, by: choice.by });
      // Предохранитель: насос, который крутит запуск без конца, падает в тесте на счёте запусков, а не вешает прогон.
      if (launches.length > 20) return new Promise<never>(() => {});
      return launchImpl(ref);
    },
    retry: (ref) => {
      calls.push(`retry:${ref.sessionId}`);
      retries.push(ref);
    },
    sleep: () => sleeper,
    totalMemBytes: 16 * 2 ** 30,
    now: () => clock,
    ...over,
  });
  service.start();
  stoppers.push(() => service.stop());
  return service;
}

/** Хост опубликовал новый снимок работ. */
function worksChanged(): void {
  for (const listener of worksListeners) listener();
}

/** Датчик памяти сделал очередное чтение (раз в 10 с). */
function reading(): void {
  for (const listener of readingListeners) listener({ level });
}

/** Занять `count` слотов процессами, которых в карте нет. */
function startLive(count: number): PtyHandle[] {
  const handles: PtyHandle[] = [];
  for (let index = 0; index < count; index += 1) {
    seq += 1;
    handles.push(handleOf({ projectPath: project, workId: 'w-live', sessionId: `live-${seq}` }));
  }
  live.push(...handles);
  return handles;
}

/** Процессы вышли: ручек нет, хост сообщает о каждом выходе. */
function exitPty(...handles: PtyHandle[]): void {
  live = live.filter((handle) => !handles.includes(handle));
  for (const handle of handles) for (const listener of exitListeners) listener(handle.ref);
}

/** Ссылка на запуск, которого в карте нет: новая сессия, пришедшая в `admit`. */
const fresh = (n: number): SessionRef => ({ projectPath: project, workId: 'w-fresh', sessionId: `s-9${n}` });

async function newWork(title = 'Работа'): Promise<string> {
  const id = (await createWork(project, { title })).work.id;
  workIds.push(id);
  return id;
}

interface EnqueueOptions extends Partial<Omit<QueuedLaunch, 'at'>> {
  /** Когда запуск встал в очередь (мс); по умолчанию — позже предыдущей записи теста, но раньше часов сервиса. */
  at?: number;
  createdBy?: string;
  workId?: string;
}

/** Сессия `pending` с записью очереди машины, какой её оставляет `launch` при исходе `queued`. */
async function enqueue(options: EnqueueOptions = {}): Promise<SessionRef> {
  const workId = options.workId ?? workIds[0] ?? (await newWork());
  seq += 1;
  let sessionId = '';
  await updateMap(
    project,
    workId,
    (map) => {
      const session = addSession(map, {
        provider: 'claude',
        label: 'сессия',
        task: 'сделать',
        ...(options.createdBy === undefined ? {} : { createdBy: options.createdBy }),
      });
      session.queued = {
        class: options.class ?? 'agent',
        mode: options.mode ?? 'launch',
        by: options.by ?? 's-01',
        at: iso(options.at ?? T0 + seq),
        reason: options.reason ?? 'machine-limit',
        live: options.live ?? 2,
        limit: options.limit === undefined ? 2 : options.limit,
      };
      sessionId = session.id;
    },
    { touch: false },
  );
  return { projectPath: project, workId, sessionId };
}

/** Живая сессия-создатель: ей идёт письмо о запуске, который не состоялся. */
async function startCreator(workId?: string): Promise<SessionRef> {
  const id = workId ?? workIds[0] ?? (await newWork());
  let sessionId = '';
  await updateMap(project, id, (map) => {
    const session = addSession(map, { provider: 'claude', label: 'лид', task: 'вести' });
    transitionSession(map, session.id, 'active');
    sessionId = session.id;
  });
  return { projectPath: project, workId: id, sessionId };
}

const sessionOf = (ref: SessionRef): WorkSession => {
  const found = readStoredMap(ref.projectPath, ref.workId).sessions.find((session) => session.id === ref.sessionId);
  if (found === undefined) throw new Error(`нет сессии ${ref.sessionId}`);
  return found;
};
const isQueued = (ref: SessionRef): boolean => sessionOf(ref).queued != null;
const systemLetters = (workId: string) => readStoredMap(project, workId).messages.filter((message) => message.from === SYSTEM);
const budgetDenial = (): HostError => new HostError('conflict', 'concurrent limit reached', { code: 'resource-budget' });
const ids = (refs: readonly SessionRef[]): string[] => refs.map((ref) => ref.sessionId);
const messagesOf = (kind: LogLevel): string[] => logs.filter((entry) => entry.level === kind).map((entry) => entry.msg);

/** Сон ради слота, который каждый раз освобождает одну живую сессию, пока они есть. */
function sleeperFreeing(): { freeCalls: () => number } & NonNullable<Sleeper> {
  let freeCalls = 0;
  return {
    freeCalls: () => freeCalls,
    freeSlot: async () => {
      freeCalls += 1;
      if (live.length === 0) return false;
      live.pop();
      return true;
    },
    slotCandidate: () => live.length > 0,
  };
}

/**
 * Как `launchHeld`: допуск, затем старт процесса и settle; при ответе `queue` запись очереди переписывается в карте, то есть
 * работы изменились.
 */
function admittingLaunch(serviceOf: () => CapacityService): typeof launchImpl {
  return async (ref) => {
    const service = serviceOf();
    const ticket = await service.admit({ ref, launchClass: 'agent' });
    if (ticket.kind === 'queue') {
      worksChanged();
      return 'queued';
    }
    await startedLaunch(ref);
    service.settle(ref);
    return 'started';
  };
}

/**
 * Запись, которую насос продвинул, а допуск вернул в очередь: потолок 1 занят, `slotCandidate()` обещает кандидата, а
 * `freeSlot()` под замком карты никого усыпить не может. Возвращается, когда первый запуск уже вернулся с `queued`.
 */
async function bouncedEntry(): Promise<{ service: CapacityService; entry: SessionRef; busy: PtyHandle }> {
  machineConcurrent = 1;
  const [busy] = startLive(1);
  const entry = await enqueue({ class: 'agent', by: 's-01' });
  sleeper = { freeSlot: async () => false, slotCandidate: () => true };
  launchImpl = admittingLaunch(() => service);
  const service = boot();
  await vi.waitFor(() => expect(launches).toHaveLength(1));
  await quiet();
  return { service, entry, busy: busy! };
}

// ---------------------------------------------------------------------------------------------
// Тесты
// ---------------------------------------------------------------------------------------------

describe('сервис ёмкости: допуск', () => {
  it('потолок 2, живых 2: агент — в очередь, человек — сверх потолка дважды, третий — в очередь', async () => {
    machineConcurrent = 2;
    startLive(2);
    const service = boot();

    expect(await service.admit({ ref: fresh(1), launchClass: 'agent' })).toEqual({
      kind: 'queue',
      reason: 'machine-limit',
      live: 2,
      limit: 2,
    });
    expect(await service.admit({ ref: fresh(2), launchClass: 'human' })).toEqual({
      kind: 'overflow',
      reason: 'machine-limit',
      live: 2,
      limit: 2,
    });
    // Первый человек держит резерв: второй видит его среди занятых.
    expect(await service.admit({ ref: fresh(3), launchClass: 'human' })).toMatchObject({
      kind: 'overflow',
      reason: 'machine-limit',
      live: 3,
    });
    // Сверх потолка уже двое: третий человек встаёт в очередь.
    expect(await service.admit({ ref: fresh(4), launchClass: 'human' })).toMatchObject({
      kind: 'queue',
      reason: 'machine-limit',
      live: 4,
    });
  });

  it('critical при свободных слотах: агент — memory-critical; человек — сверх потолка дважды, затем в очередь', async () => {
    level = 'critical';
    machineConcurrent = 18;
    const service = boot();

    expect(await service.admit({ ref: fresh(1), launchClass: 'agent' })).toEqual({
      kind: 'queue',
      reason: 'memory-critical',
      live: 0,
      limit: 18,
    });
    expect(await service.admit({ ref: fresh(2), launchClass: 'human' })).toMatchObject({
      kind: 'overflow',
      reason: 'memory-critical',
    });
    expect(await service.admit({ ref: fresh(3), launchClass: 'human' })).toMatchObject({
      kind: 'overflow',
      reason: 'memory-critical',
    });
    expect(await service.admit({ ref: fresh(4), launchClass: 'human' })).toMatchObject({
      kind: 'queue',
      reason: 'memory-critical',
    });
  });

  it('движок стартует всегда, даже при полном потолке и critical', async () => {
    level = 'critical';
    machineConcurrent = 2;
    startLive(5);
    const service = boot();

    expect(await service.admit({ ref: fresh(1), launchClass: 'engine' })).toEqual({ kind: 'start', live: 5, limit: 2 });
  });

  it('движок сам считается в потолке: его резерв отнимает место у агентов', async () => {
    machineConcurrent = 2;
    const service = boot();

    expect(await service.admit({ ref: fresh(1), launchClass: 'engine' })).toMatchObject({ kind: 'start' });
    expect(await service.admit({ ref: fresh(2), launchClass: 'agent' })).toMatchObject({ kind: 'start' });
    expect(await service.admit({ ref: fresh(3), launchClass: 'agent' })).toMatchObject({ kind: 'queue' });
  });

  it('потолок off: допуска нет, давление тоже', async () => {
    machineConcurrent = 'off';
    level = 'critical';
    startLive(30);
    const service = boot();

    expect(await service.admit({ ref: fresh(1), launchClass: 'agent' })).toEqual({ kind: 'start', live: 30, limit: null });
  });

  it('потолок auto — три четверти памяти машины', async () => {
    machineConcurrent = 'auto';
    startLive(5);
    // 8 ГиБ × 0,75 = 6.
    const service = boot({ totalMemBytes: 8 * 2 ** 30 });

    expect(await service.admit({ ref: fresh(1), launchClass: 'agent' })).toEqual({ kind: 'start', live: 5, limit: 6 });
    expect(await service.admit({ ref: fresh(2), launchClass: 'agent' })).toEqual({
      kind: 'queue',
      reason: 'machine-limit',
      live: 6,
      limit: 6,
    });
  });

  it('freeSlot освободил слот — старт; сон не освободил — решает класс', async () => {
    machineConcurrent = 2;
    startLive(2);
    const freeing = sleeperFreeing();
    sleeper = freeing;
    const service = boot();

    // Занято было 2 из 2; после сна — 1, и запуск встаёт на освободившееся место.
    expect(await service.admit({ ref: fresh(1), launchClass: 'agent' })).toEqual({ kind: 'start', live: 1, limit: 2 });
    expect(freeing.freeCalls()).toBe(1);

    // Резерв взят: ещё один агент видит 2 из 2, сон усыпляет следующую живую сессию — и снова старт.
    expect(await service.admit({ ref: fresh(2), launchClass: 'agent' })).toMatchObject({ kind: 'start', live: 1 });
    expect(freeing.freeCalls()).toBe(2);

    // Живых больше нет, спать некому: агент — в очередь, человек — сверх потолка.
    expect(await service.admit({ ref: fresh(3), launchClass: 'agent' })).toEqual({
      kind: 'queue',
      reason: 'machine-limit',
      live: 2,
      limit: 2,
    });
    expect(await service.admit({ ref: fresh(4), launchClass: 'human' })).toMatchObject({ kind: 'overflow' });
    expect(freeing.freeCalls()).toBe(4);
  });

  it('человек при полном потолке сначала пробует освободить слот сном и идёт сверх потолка, только если не вышло', async () => {
    machineConcurrent = 1;
    startLive(1);
    const freeing = sleeperFreeing();
    sleeper = freeing;
    const service = boot();

    expect(await service.admit({ ref: fresh(1), launchClass: 'human' })).toMatchObject({ kind: 'start' });
    expect(await service.admit({ ref: fresh(2), launchClass: 'human' })).toMatchObject({ kind: 'overflow' });
  });

  it('сон ради слота не зовут: сон выключен, потолка нет или впереди в очереди ждут', async () => {
    machineConcurrent = 1;
    startLive(1);
    const freeing = sleeperFreeing();
    sleeper = freeing;
    const service = boot();

    // Сон выключен (`sleepAfterMinutes = 0`): освобождать слот нечем.
    sleepAfterMinutes = 0;
    expect(await service.admit({ ref: fresh(1), launchClass: 'agent' })).toMatchObject({ kind: 'queue' });
    expect(freeing.freeCalls()).toBe(0);

    // Сон включён, но впереди ждёт другой агент: освободившееся место принадлежит ему, а не этому запуску.
    sleepAfterMinutes = 60;
    await enqueue({ at: T0 });
    expect(await service.admit({ ref: fresh(2), launchClass: 'agent' })).toMatchObject({ kind: 'queue' });
    expect(freeing.freeCalls()).toBe(0);

    // Потолок выключен: слот есть всегда, сон не нужен.
    machineConcurrent = 'off';
    expect(await service.admit({ ref: fresh(3), launchClass: 'agent' })).toMatchObject({ kind: 'start' });
    expect(freeing.freeCalls()).toBe(0);
  });

  it('сон ради слота, который не удался, не ломает запуск: он решается по классу', async () => {
    machineConcurrent = 1;
    startLive(1);
    sleeper = {
      freeSlot: async () => {
        throw new Error('stop упал');
      },
      slotCandidate: () => true,
    };
    const service = boot();

    expect(await service.admit({ ref: fresh(1), launchClass: 'agent' })).toMatchObject({ kind: 'queue' });
    expect(messagesOf('error')).toHaveLength(1);
  });
});

describe('сервис ёмкости: резерв слота (Review Focus 1)', () => {
  it('два admit подряд при одном свободном слоте: первый start, второй queue', async () => {
    machineConcurrent = 2;
    startLive(1);
    const service = boot();

    const first = await service.admit({ ref: fresh(1), launchClass: 'agent' });
    const second = await service.admit({ ref: fresh(2), launchClass: 'agent' });
    expect(first).toMatchObject({ kind: 'start', live: 1 });
    expect(second).toMatchObject({ kind: 'queue', reason: 'machine-limit', live: 2 });
  });

  it('и когда они идут одновременно: проверка и резерв — одним синхронным участком', async () => {
    machineConcurrent = 3;
    startLive(1);
    const service = boot();

    // Обоим предстоит `await` настроек: между проверкой и резервом он не должен вклиниться.
    const results = await Promise.all([
      service.admit({ ref: fresh(1), launchClass: 'agent' }),
      service.admit({ ref: fresh(2), launchClass: 'agent' }),
      service.admit({ ref: fresh(3), launchClass: 'agent' }),
    ]);
    expect(results.map((ticket) => ticket.kind)).toEqual(['start', 'start', 'queue']);
  });

  it('и «сверх потолка» не больше двух, как бы одновременно ни пришли люди', async () => {
    machineConcurrent = 1;
    startLive(1);
    const service = boot();

    const results = await Promise.all(
      [1, 2, 3].map((n) => service.admit({ ref: fresh(n), launchClass: 'human' })),
    );
    expect(results.map((ticket) => ticket.kind)).toEqual(['overflow', 'overflow', 'queue']);
  });

  it('последний слот после сна: один освободившийся слот достаётся одному запуску', async () => {
    machineConcurrent = 1;
    startLive(1);
    let freeCalls = 0;
    sleeper = {
      // Усыпить удаётся одну сессию, второй вызов остаётся ни с чем.
      freeSlot: async () => {
        freeCalls += 1;
        if (freeCalls > 1) return false;
        live.pop();
        return true;
      },
      slotCandidate: () => false,
    };
    const service = boot();

    const results = await Promise.all([
      service.admit({ ref: fresh(1), launchClass: 'agent' }),
      service.admit({ ref: fresh(2), launchClass: 'agent' }),
    ]);
    expect(results.filter((ticket) => ticket.kind === 'start')).toHaveLength(1);
    expect(results.filter((ticket) => ticket.kind === 'queue')).toHaveLength(1);
    // Резерв один: третий запуск видит потолок полным.
    expect(await service.admit({ ref: fresh(3), launchClass: 'agent' })).toMatchObject({ kind: 'queue' });
  });

  it('слот, освобождённый сном для допуска, насос чужой записи не отдаёт', async () => {
    machineConcurrent = 1;
    const [busy] = startLive(1);
    // Агент ждёт в очереди, но насос о нём не знает: записи нет в событии, а слотов и кандидатов нет.
    await enqueue({ class: 'agent', by: 's-01' });
    sleeper = {
      // Сон идёт: процесс вышел (хост сообщил о выходе, насос прошёл), а допуск человека ещё не вернулся.
      freeSlot: async () => {
        exitPty(busy!);
        await quiet();
        return true;
      },
      slotCandidate: () => false,
    };
    const service = boot();
    await quiet();

    expect(await service.admit({ ref: fresh(1), launchClass: 'human' })).toMatchObject({ kind: 'start', live: 0 });
    expect(launches).toEqual([]);
  });

  it('слот, освобождённый сном ради записи очереди, достаётся ей, а не следующей за ней', async () => {
    machineConcurrent = 1;
    const [busy] = startLive(1);
    const first = await enqueue({ class: 'agent', by: 's-01', at: T0 + 1 });
    const second = await enqueue({ class: 'agent', by: 's-01', at: T0 + 2 });
    let candidate = true;
    sleeper = {
      // Единственный кандидат: его сон освобождает слот, но допуск первой записи вернётся не сразу.
      freeSlot: async () => {
        candidate = false;
        exitPty(busy!);
        await quiet();
        return true;
      },
      slotCandidate: () => candidate,
    };
    // Как `launchHeld`: допуск, затем старт процесса и settle.
    launchImpl = async (ref) => {
      const ticket = await service.admit({ ref, launchClass: 'agent' });
      if (ticket.kind === 'queue') return 'queued';
      await startedLaunch(ref);
      service.settle(ref);
      return 'started';
    };
    const service = boot();

    await vi.waitFor(() => expect(isQueued(first)).toBe(false));
    await quiet();
    // Вторая запись ждёт: слот достался первой, насос не успел отдать его второй.
    expect(launches).toEqual([{ ref: first, mode: 'launch', by: 's-01' }]);
    expect(isQueued(second)).toBe(true);
  });
});

describe('сервис ёмкости: новый запуск не обгоняет очередь (Review Focus 2)', () => {
  it('при свободном слоте и ждущем агенте новый агент встаёт за ним, а новый человек — обгоняет', async () => {
    machineConcurrent = 3;
    startLive(1);
    // Очередь пуста: насос ничего не продвигает, а запись ниже появляется без события — как записи, что насос ещё не видел.
    const service = boot();
    await enqueue({ class: 'agent', at: T0 });

    expect(await service.admit({ ref: fresh(1), launchClass: 'agent' })).toEqual({
      kind: 'queue',
      reason: 'machine-limit',
      live: 1,
      limit: 3,
    });
    // Письмо идёт раньше агента.
    expect(await service.admit({ ref: fresh(2), launchClass: 'mail' })).toMatchObject({ kind: 'start' });
    expect(await service.admit({ ref: fresh(3), launchClass: 'human' })).toMatchObject({ kind: 'start' });
  });

  it('ждущий человек стоит впереди письма и агента: письмо встаёт за ним', async () => {
    machineConcurrent = 3;
    startLive(1);
    const service = boot();
    await enqueue({ class: 'human', by: 'human', at: T0 });

    expect(await service.admit({ ref: fresh(1), launchClass: 'mail' })).toMatchObject({ kind: 'queue' });
    expect(await service.admit({ ref: fresh(2), launchClass: 'agent' })).toMatchObject({ kind: 'queue' });
    // Человек среди людей — по времени: тот, кто пришёл позже, стоит за ждущим.
    expect(await service.admit({ ref: fresh(3), launchClass: 'human' })).toMatchObject({ kind: 'queue' });
  });

  it('запись, уже стоящая в очереди, считает тех, кто впереди, по своему времени из карты', async () => {
    machineConcurrent = 3;
    startLive(1);
    const service = boot();
    const early = await enqueue({ class: 'agent', at: T0 });
    const late = await enqueue({ class: 'agent', at: T0 + 1_000 });

    expect(await service.admit({ ref: late, launchClass: 'agent' })).toMatchObject({ kind: 'queue' });
    expect(await service.admit({ ref: early, launchClass: 'agent' })).toMatchObject({ kind: 'start' });
  });
});

describe('сервис ёмкости: settle и выход процесса', () => {
  it('settle снимает резерв: место снова свободно; повтор безвреден', async () => {
    machineConcurrent = 1;
    const service = boot();

    const first = fresh(1);
    expect((await service.admit({ ref: first, launchClass: 'agent' })).kind).toBe('start');
    expect((await service.admit({ ref: fresh(2), launchClass: 'agent' })).kind).toBe('queue');

    // Запуск отказал до старта процесса.
    service.settle(first);
    service.settle(first);
    expect((await service.admit({ ref: fresh(3), launchClass: 'agent' })).kind).toBe('start');
  });

  it('выход процесса снимает «сверх потолка»; settle без процесса — тоже', async () => {
    machineConcurrent = 1;
    startLive(1);
    const service = boot();

    const failed = fresh(1);
    const started = fresh(2);
    expect((await service.admit({ ref: failed, launchClass: 'human' })).kind).toBe('overflow');
    expect((await service.admit({ ref: started, launchClass: 'human' })).kind).toBe('overflow');
    expect((await service.admit({ ref: fresh(3), launchClass: 'human' })).kind).toBe('queue');

    // Один запуск отказал до старта: его место сверх потолка свободно.
    service.settle(failed);
    const second = handleOf(started);
    live.push(second);
    // Другой стартовал: резерв снят, но сверх потолка он остаётся, пока жив.
    service.settle(started);
    expect((await service.admit({ ref: fresh(4), launchClass: 'human' })).kind).toBe('overflow');
    expect((await service.admit({ ref: fresh(5), launchClass: 'human' })).kind).toBe('queue');

    exitPty(second);
    expect((await service.admit({ ref: fresh(6), launchClass: 'human' })).kind).toBe('overflow');
  });

  it('выход процесса продвигает очередь', async () => {
    machineConcurrent = 1;
    const [busy] = startLive(1);
    const queued = await enqueue({ class: 'agent', by: 's-01' });
    boot();
    await quiet();
    expect(launches).toEqual([]);

    exitPty(busy!);
    await vi.waitFor(() => expect(launches).toEqual([{ ref: queued, mode: 'launch', by: 's-01' }]));
  });
});

describe('сервис ёмкости: продвижение очереди', () => {
  it('при одном освободившемся слоте первой идёт запись человека, потом письма, потом агента', async () => {
    machineConcurrent = 1;
    const [busy] = startLive(1);
    // Встали в обратном порядке: сначала агент, затем письмо, затем человек.
    const agent = await enqueue({ class: 'agent', by: 's-01' });
    const mail = await enqueue({ class: 'mail', mode: 'resume', by: 'wake' });
    const human = await enqueue({ class: 'human', by: 'human' });
    boot();
    await quiet();
    expect(calls).toEqual([]);

    exitPty(busy!);
    await vi.waitFor(() => expect(calls).toEqual([`launch:${human.sessionId}`]));
    // Человек занял место: ни письму, ни агенту его не хватает.
    await quiet();
    expect(calls).toEqual([`launch:${human.sessionId}`]);
    expect(isQueued(agent)).toBe(true);
    expect(isQueued(mail)).toBe(true);
  });

  it('если освободилось несколько слотов, записи идут по порядку очереди', async () => {
    machineConcurrent = 3;
    const handles = startLive(3);
    const agent = await enqueue({ class: 'agent', by: 's-01' });
    const mail = await enqueue({ class: 'mail', mode: 'resume', by: 'wake' });
    const human = await enqueue({ class: 'human', by: 'human' });
    const service = boot();
    await quiet();
    expect(calls).toEqual([]);
    expect(service.queue().map((entry) => entry.ref.sessionId)).toEqual(ids([human, mail, agent]));

    exitPty(...handles);
    await vi.waitFor(() =>
      expect(calls).toEqual([`launch:${human.sessionId}`, `retry:${mail.sessionId}`, `launch:${agent.sessionId}`]),
    );
  });

  it('запись письма продвигается через retry, остальные — через launch(ref, mode, { by })', async () => {
    machineConcurrent = 'off';
    const mailResume = await enqueue({ class: 'mail', mode: 'resume', by: 'wake', at: T0 + 10 });
    const mailLaunch = await enqueue({ class: 'mail', mode: 'launch', by: 'wake', at: T0 + 20 });
    const agentResume = await enqueue({ class: 'agent', mode: 'resume', by: 's-02', at: T0 + 30 });
    const humanNew = await enqueue({ class: 'human', mode: 'new', by: 'human', at: T0 + 40 });
    boot();

    await vi.waitFor(() => expect(launches).toHaveLength(3));
    // Подъём письмом — только `retry`: указатель на письма соберёт будильник.
    expect(retries).toEqual([mailResume]);
    expect(launches).toEqual([
      { ref: humanNew, mode: 'new', by: 'human' },
      { ref: mailLaunch, mode: 'launch', by: 'wake' },
      { ref: agentResume, mode: 'resume', by: 's-02' },
    ]);
  });

  it('полный потолок: одна запись продвигается только при slotCandidate()', async () => {
    machineConcurrent = 1;
    startLive(1);
    const first = await enqueue({ class: 'agent', at: T0 + 1 });
    await enqueue({ class: 'agent', at: T0 + 2 });
    let candidate = false;
    sleeper = { freeSlot: async () => false, slotCandidate: () => candidate };
    // Запуск не заканчивается: первая запись остаётся в продвижении.
    launchImpl = () => new Promise<never>(() => {});
    boot();
    await quiet();
    expect(launches).toEqual([]);

    // Спать некому — вторая и третья пробы ничего не продвигают.
    reading();
    worksChanged();
    await quiet();
    expect(launches).toEqual([]);

    // Есть кого усыпить: в проходе продвигается одна, первая в очереди; её допуск сам усыпит кандидата.
    candidate = true;
    reading();
    await vi.waitFor(() => expect(ids(launches.map((launch) => launch.ref))).toEqual([first.sessionId]));
    await quiet();
    expect(launches).toHaveLength(1);
  });

  it('сон выключен — кандидат слота не нужен: полному потолку ждать', async () => {
    machineConcurrent = 1;
    startLive(1);
    await enqueue({ class: 'agent' });
    sleepAfterMinutes = 0;
    sleeper = { freeSlot: async () => true, slotCandidate: () => true };
    boot();

    reading();
    await quiet();
    expect(launches).toEqual([]);
  });

  it('critical: свободных слотов нет, как бы ни был велик потолок', async () => {
    machineConcurrent = 18;
    level = 'critical';
    await enqueue({ class: 'agent' });
    boot();
    await quiet();
    expect(launches).toEqual([]);

    // Давление спало — запись идёт.
    level = 'normal';
    reading();
    await vi.waitFor(() => expect(launches).toHaveLength(1));
  });

  it('старт хоста: записи из снимка продвигаются сами, по свободным слотам и по порядку', async () => {
    machineConcurrent = 2;
    const first = await enqueue({ class: 'agent', at: T0 + 1 });
    const second = await enqueue({ class: 'agent', at: T0 + 2 });
    const third = await enqueue({ class: 'agent', at: T0 + 3 });
    boot();

    await vi.waitFor(() => expect(launches).toHaveLength(2));
    await quiet();
    // Два слота — две записи; третья ждёт: потолок полон.
    expect(ids(launches.map((launch) => launch.ref))).toEqual([first.sessionId, second.sessionId]);
    expect(isQueued(first)).toBe(false);
    expect(isQueued(third)).toBe(true);
  });

  it('архивная работа пропускается и в queue(), и в насосе', async () => {
    machineConcurrent = 'off';
    const archivedWork = await newWork('в архиве');
    const activeWork = await newWork('в работе');
    const hidden = await enqueue({ workId: archivedWork });
    const shown = await enqueue({ workId: activeWork });
    await setWorkStatus(project, archivedWork, 'archived');
    const service = boot();

    expect(service.queue().map((entry) => entry.ref)).toEqual([shown]);
    await vi.waitFor(() => expect(launches.map((launch) => launch.ref)).toEqual([shown]));
    await quiet();
    expect(launches).toHaveLength(1);
    expect(isQueued(hidden)).toBe(true);
  });

  it('queue() — записи по порядку: человек, письмо, агент; внутри класса по времени', async () => {
    machineConcurrent = 1;
    startLive(1);
    const lateAgent = await enqueue({ class: 'agent', at: T0 + 50 });
    const earlyAgent = await enqueue({ class: 'agent', at: T0 + 10 });
    const mail = await enqueue({ class: 'mail', mode: 'resume', by: 'wake', at: T0 + 40 });
    const human = await enqueue({ class: 'human', by: 'human', at: T0 + 60 });
    const service = boot();

    expect(service.queue().map((entry) => entry.ref)).toEqual([human, mail, earlyAgent, lateAgent]);
    expect(service.queue().map((entry) => entry.queued.class)).toEqual(['human', 'mail', 'agent', 'agent']);
  });

  it('пустая очередь — настройки не читаются: насос зовут на каждое изменение работ', async () => {
    const service = boot();
    for (let index = 0; index < 3; index += 1) {
      worksChanged();
      reading();
    }
    await quiet();
    expect(configReads).toBe(0);
    expect(service.queue()).toEqual([]);
  });

  it('запись, чей процесс уже стартовал, а снимок ещё несёт queued, не продвигается второй раз', async () => {
    machineConcurrent = 'off';
    const started = await enqueue({ class: 'agent' });
    // Процесс есть, а запись в снимке осталась: снимок работ отстаёт от записи карты.
    live.push(handleOf(started));
    boot();
    await quiet();
    expect(launches).toEqual([]);
    expect(retries).toEqual([]);
  });

  it('stop() снимает подписки: выход процесса больше ничего не продвигает', async () => {
    machineConcurrent = 1;
    const [busy] = startLive(1);
    await enqueue({ class: 'agent' });
    const service = boot();
    await quiet();

    service.stop();
    expect(exitListeners).toEqual([]);
    expect(worksListeners).toEqual([]);
    expect(readingListeners).toEqual([]);
    exitPty(busy!);
    await quiet();
    expect(launches).toEqual([]);
  });
});

describe('сервис ёмкости: запись, которая не держит очередь', () => {
  it('подъём письмом в продвижении: запись не держит запуски позади; ответ queue возвращает её в очередь', async () => {
    machineConcurrent = 3;
    startLive(1);
    const mail = await enqueue({ class: 'mail', mode: 'resume', by: 'wake', at: T0 });
    const service = boot();
    await vi.waitFor(() => expect(retries).toEqual([mail]));

    // `retry` ушёл, будильник ещё не дошёл до `launch`: запись в продвижении и очередь не держит.
    expect(await service.admit({ ref: fresh(1), launchClass: 'agent' })).toMatchObject({ kind: 'start' });
    service.settle(fresh(1));
    // Пока запись в продвижении, насос её не трогает.
    worksChanged();
    await quiet();
    expect(retries).toHaveLength(1);

    // Будильник дошёл до `launch`, а места нет: ответ queue снимает запись с продвижения, она ждёт своей очереди.
    startLive(2);
    expect(await service.admit({ ref: mail, launchClass: 'mail' })).toMatchObject({ kind: 'queue' });
    expect(await service.admit({ ref: fresh(2), launchClass: 'agent' })).toMatchObject({ kind: 'queue' });
    // Освободился слот — запись идёт заново.
    exitPty(live[0]!);
    await vi.waitFor(() => expect(retries).toEqual([mail, mail]));
  });

  it('подъём письмом, который не дошёл до admit за IN_FLIGHT_MS, не держит очередь', async () => {
    machineConcurrent = 3;
    startLive(1);
    const mail = await enqueue({ class: 'mail', mode: 'resume', by: 'wake', at: T0 });
    const service = boot();
    await vi.waitFor(() => expect(retries).toEqual([mail]));

    // За срок будильник так и не поднял сессию (лимит часа, пауза, нет провайдера): запись `stale`, ей сразу повтор.
    clock = START + IN_FLIGHT_MS;
    reading();
    await vi.waitFor(() => expect(retries).toEqual([mail, mail]));
    expect(launches).toEqual([]);

    // Она больше не стоит впереди: агент стартует, хотя письмо старше.
    expect(await service.admit({ ref: fresh(1), launchClass: 'agent' })).toMatchObject({ kind: 'start' });
    expect(await service.admit({ ref: fresh(2), launchClass: 'agent' })).toMatchObject({ kind: 'start' });
  });

  it('до срока подъём письмом ещё в продвижении, а допуск самой записи снимает stale', async () => {
    machineConcurrent = 2;
    startLive(1);
    const mail = await enqueue({ class: 'mail', mode: 'resume', by: 'wake', at: T0 });
    const service = boot();
    await vi.waitFor(() => expect(retries).toEqual([mail]));

    // За миллисекунду до срока — повторов нет.
    clock = START + IN_FLIGHT_MS - 1;
    reading();
    await quiet();
    expect(retries).toHaveLength(1);

    // Срок вышел — запись `stale`: повтор. Затем будильник поднимает её: первый admit снимает отметку.
    clock = START + IN_FLIGHT_MS;
    reading();
    await vi.waitFor(() => expect(retries).toHaveLength(2));
    expect(await service.admit({ ref: mail, launchClass: 'mail' })).toMatchObject({ kind: 'start' });
    worksChanged();
    await quiet();
    // Запуск идёт: резерв взят, запись больше не повторяется.
    expect(retries).toHaveLength(2);
    service.settle(mail);
  });

  it('stale-запись получает retry не чаще раза в BUDGET_BACKOFF_MS', async () => {
    machineConcurrent = 3;
    startLive(1);
    const mail = await enqueue({ class: 'mail', mode: 'resume', by: 'wake', at: T0 });
    boot();
    await vi.waitFor(() => expect(retries).toEqual([mail]));

    // Срок вышел: запись `stale`, первый повтор — сразу.
    clock = START + IN_FLIGHT_MS;
    reading();
    await vi.waitFor(() => expect(retries).toHaveLength(2));

    // Проходы через 10 с повтора не дают: `retry` снимает у будильника паузу бюджета, и отказанный запуск шёл бы заново.
    clock += 10_000;
    reading();
    worksChanged();
    clock += 10_000;
    reading();
    await quiet();
    expect(retries).toHaveLength(2);

    // Через BUDGET_BACKOFF_MS после прошлого повтора — даёт.
    clock = START + IN_FLIGHT_MS + BUDGET_BACKOFF_MS - 1;
    reading();
    await quiet();
    expect(retries).toHaveLength(2);
    clock = START + IN_FLIGHT_MS + BUDGET_BACKOFF_MS;
    reading();
    await vi.waitFor(() => expect(retries).toHaveLength(3));
  });
});

describe('сервис ёмкости: отказ продвижения (Review Focus 3)', () => {
  it('отказ бюджета работы: запись остаётся, повтор не раньше BUDGET_BACKOFF_MS', async () => {
    machineConcurrent = 2;
    const queued = await enqueue({ class: 'agent', by: 's-01' });
    launchImpl = async () => {
      throw budgetDenial();
    };
    boot();
    await vi.waitFor(() => expect(launches).toHaveLength(1));
    await quiet();

    // Запись цела, письма нет, ошибки в журнале тоже.
    expect(isQueued(queued)).toBe(true);
    expect(systemLetters(queued.workId)).toEqual([]);
    expect(messagesOf('error')).toEqual([]);

    clock = START + BUDGET_BACKOFF_MS - 1;
    reading();
    worksChanged();
    await quiet();
    expect(launches).toHaveLength(1);

    clock = START + BUDGET_BACKOFF_MS;
    reading();
    await vi.waitFor(() => expect(launches).toHaveLength(2));
    expect(isQueued(queued)).toBe(true);
  });

  it('и на паузе она не держит запуски позади себя', async () => {
    machineConcurrent = 1;
    await enqueue({ class: 'agent', by: 's-01', at: T0 });
    launchImpl = async () => {
      throw budgetDenial();
    };
    const service = boot();
    await vi.waitFor(() => expect(launches).toHaveLength(1));
    await quiet();

    clock = START + 1_000;
    // Слот свободен, запись старше и стоит в очереди, но она на паузе: новый агент стартует.
    expect(await service.admit({ ref: fresh(1), launchClass: 'agent' })).toMatchObject({ kind: 'start' });
  });

  it('отказ насовсем: queued снят, создателю-агенту письмо, очередь не крутится', async () => {
    machineConcurrent = 1;
    const creator = await startCreator();
    const queued = await enqueue({ class: 'agent', by: creator.sessionId, createdBy: creator.sessionId });
    launchImpl = async () => {
      throw new Error('provider "codex" is not installed');
    };
    boot();

    await vi.waitFor(() => expect(isQueued(queued)).toBe(false));
    // Ключ удалён, а не записан как `null`.
    expect('queued' in sessionOf(queued)).toBe(false);
    const letters = systemLetters(queued.workId);
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({
      from: SYSTEM,
      to: [creator.sessionId],
      kind: 'note',
      text: `${sessionTag(queued.sessionId)} was not started: provider "codex" is not installed`,
    });

    // Запись снята — повторов нет, сколько ни зови насос.
    for (let index = 0; index < 3; index += 1) {
      reading();
      worksChanged();
    }
    clock = START + 10 * MIN;
    reading();
    await quiet();
    expect(launches).toHaveLength(1);
    expect(systemLetters(queued.workId)).toHaveLength(1);
    expect(messagesOf('error')).toEqual([]);
  });

  it.each([
    ['человек', { class: 'human' as const, by: 'human' }],
    ['письмо', { class: 'mail' as const, mode: 'launch' as const, by: 'wake' }],
  ])('отказ насовсем у класса «%s»: запись снята, письма нет', async (_name, options) => {
    machineConcurrent = 1;
    const creator = await startCreator();
    // Создатель у сессии есть, но письмо получает только создатель запуска агента.
    const queued = await enqueue({ ...options, createdBy: creator.sessionId });
    launchImpl = async () => {
      throw new Error('session is closed');
    };
    boot();

    await vi.waitFor(() => expect(isQueued(queued)).toBe(false));
    expect(systemLetters(queued.workId)).toEqual([]);
  });

  it('создатель закрыт или его нет в карте — письма нет, запись снята', async () => {
    machineConcurrent = 'off';
    const closed = await startCreator();
    await updateMap(closed.projectPath, closed.workId, (map) => {
      transitionSession(map, closed.sessionId, 'closed');
    });
    const withClosedCreator = await enqueue({ class: 'agent', createdBy: closed.sessionId, at: T0 + 1 });
    const withGhostCreator = await enqueue({ class: 'agent', createdBy: 's-77', at: T0 + 2 });
    const withoutCreator = await enqueue({ class: 'agent', at: T0 + 3 });
    launchImpl = async () => {
      throw new Error('workspace is archived');
    };
    boot();

    await vi.waitFor(() => {
      expect(isQueued(withClosedCreator)).toBe(false);
      expect(isQueued(withGhostCreator)).toBe(false);
      expect(isQueued(withoutCreator)).toBe(false);
    });
    expect(systemLetters(closed.workId)).toEqual([]);
  });

  it('launch вернул held (Codex ждёт согласия на папку): запись снята без письма, насос её больше не берёт', async () => {
    machineConcurrent = 1;
    const creator = await startCreator();
    // Класс агента и живой создатель: при отказе письмо ушло бы, но запуск не отказан, а передан пути согласия.
    const queued = await enqueue({ class: 'agent', by: creator.sessionId, createdBy: creator.sessionId });
    launchImpl = async () => 'held';
    boot();

    await vi.waitFor(() => expect(isQueued(queued)).toBe(false));
    expect('queued' in sessionOf(queued)).toBe(false);
    for (let index = 0; index < 3; index += 1) {
      reading();
      worksChanged();
    }
    clock = START + 10 * MIN;
    reading();
    await quiet();
    expect(launches).toHaveLength(1);
    expect(systemLetters(queued.workId)).toEqual([]);
    expect(messagesOf('error')).toEqual([]);
  });

  it.each([
    [
      'отказ насовсем',
      async (): Promise<Outcome> => {
        throw new Error('session is closed');
      },
    ],
    ['held', async (): Promise<Outcome> => 'held'],
  ])('%s, а запись не снялась (карта недоступна): повтор не сразу, запуск не крутится', async (_name, impl) => {
    machineConcurrent = 'off';
    const real = await enqueue({ class: 'agent' });
    // Снимок работ несёт работу, которой в базе уже нет: `updateMap` ей откажет.
    const map = readStoredMap(project, real.workId);
    const ghostMap = { ...map, work: { ...map.work, id: 'w-9999' } };
    const ghost = { ...real, workId: 'w-9999' };
    launchImpl = impl;
    boot({
      works: {
        snapshot: () => ({ entries: [{ projectPath: project, map: ghostMap }], branches: {} }),
        onChange: works.onChange,
      } as unknown as CapacityDeps['works'],
    });
    await vi.waitFor(() => expect(messagesOf('error')).toHaveLength(1));

    // Запись цела, и сколько ни зови насос, запуск до конца паузы не повторяется.
    for (let index = 0; index < 3; index += 1) {
      reading();
      worksChanged();
    }
    clock = START + BUDGET_BACKOFF_MS - 1;
    reading();
    await quiet();
    expect(launches).toEqual([{ ref: ghost, mode: 'launch', by: 's-01' }]);
    expect(messagesOf('error')).toHaveLength(1);

    clock = START + BUDGET_BACKOFF_MS;
    reading();
    await vi.waitFor(() => expect(launches).toHaveLength(2));
  });
});

describe('сервис ёмкости: запись, которую допуск вернул в очередь', () => {
  it('насос не берёт её заново ни по записи, которую запуск сам переписал, ни по чтению датчика того же уровня', async () => {
    const { entry } = await bouncedEntry();

    // Запись очереди переписана (`worksChanged()` в запуске), а чтения датчика идут с прежним уровнем.
    for (let index = 0; index < 3; index += 1) {
      worksChanged();
      reading();
    }
    await quiet();
    expect(launches).toEqual([{ ref: entry, mode: 'launch', by: 's-01' }]);
    expect(isQueued(entry)).toBe(true);
  });

  it('берёт её снова, когда прошло BOUNCE_MS', async () => {
    await bouncedEntry();

    clock = START + BOUNCE_MS - 1;
    reading();
    await quiet();
    expect(launches).toHaveLength(1);

    clock = START + BOUNCE_MS;
    reading();
    await vi.waitFor(() => expect(launches).toHaveLength(2));
  });

  it('берёт её сразу после выхода процесса: слот освободился на самом деле', async () => {
    const { entry, busy } = await bouncedEntry();

    exitPty(busy);
    await vi.waitFor(() => expect(isQueued(entry)).toBe(false));
    expect(launches).toHaveLength(2);
  });

  it('берёт её сразу, когда датчик сообщил другой уровень давления; тот же уровень отметок не снимает', async () => {
    await bouncedEntry();

    level = 'warn';
    reading();
    await vi.waitFor(() => expect(launches).toHaveLength(2));

    // Запись отскочила снова; чтения того же уровня её не будят.
    reading();
    reading();
    await quiet();
    expect(launches).toHaveLength(2);
  });

  it('settle без процесса снимает отметки: слот освободился; settle без резерва их не трогает', async () => {
    const { service } = await bouncedEntry();

    // За этим ключом резерва не было: ничего не освободилось.
    service.settle(fresh(7));
    worksChanged();
    await quiet();
    expect(launches).toHaveLength(1);

    // Потолок подняли (события нет). Человек встаёт впереди ждущего агента и берёт резерв, но запуск отказал до старта
    // процесса: резерв снят, место свободно.
    machineConcurrent = 3;
    const human = fresh(8);
    expect(await service.admit({ ref: human, launchClass: 'human' })).toMatchObject({ kind: 'start' });
    service.settle(human);
    await vi.waitFor(() => expect(launches).toHaveLength(2));
  });

  it('пока запись отскочила, она держит запуски позади себя: новый агент её не обгоняет', async () => {
    const { service } = await bouncedEntry();

    // Место появилось (потолок подняли), а событий нет и отметка стоит: запись ждёт по-настоящему.
    machineConcurrent = 3;
    expect(await service.admit({ ref: fresh(1), launchClass: 'agent' })).toMatchObject({ kind: 'queue' });
    expect(await service.admit({ ref: fresh(2), launchClass: 'human' })).toMatchObject({ kind: 'start' });
  });
});

describe('сервис ёмкости: потолок выключили (Review Focus 5)', () => {
  it('в очереди есть записи, потолок выключен — все записи стартуют сами, без человека', async () => {
    machineConcurrent = 1;
    startLive(1);
    const agent = await enqueue({ class: 'agent', by: 's-01', at: T0 + 1 });
    const mail = await enqueue({ class: 'mail', mode: 'resume', by: 'wake', at: T0 + 2 });
    const human = await enqueue({ class: 'human', by: 'human', at: T0 + 3 });
    boot();
    await quiet();
    expect(calls).toEqual([]);

    // Человек выключил потолок в настройках; хост узнаёт об этом на ближайшем чтении датчика.
    machineConcurrent = 'off';
    reading();
    await vi.waitFor(() =>
      expect(calls).toEqual([`launch:${human.sessionId}`, `retry:${mail.sessionId}`, `launch:${agent.sessionId}`]),
    );
    expect(launches.map((launch) => launch.by)).toEqual(['human', 's-01']);
  });
});

describe('сервис ёмкости: сквозной ход допуска и продвижения', () => {
  it('запуск из очереди проходит настоящий допуск и стартует, как только слот освободился', async () => {
    machineConcurrent = 1;
    const [busy] = startLive(1);
    const queued = await enqueue({ class: 'agent', by: 's-01' });
    // Как `launchHeld`: допуск, затем старт процесса и settle.
    launchImpl = async (ref) => {
      const ticket = await service.admit({ ref, launchClass: 'agent' });
      if (ticket.kind === 'queue') return 'queued';
      await startedLaunch(ref);
      service.settle(ref);
      return 'started';
    };
    const service = boot();
    await quiet();
    expect(launches).toEqual([]);

    exitPty(busy!);
    await vi.waitFor(() => expect(isQueued(queued)).toBe(false));
    expect(launches).toEqual([{ ref: queued, mode: 'launch', by: 's-01' }]);
    // Новый агент теперь видит полный потолок.
    expect(await service.admit({ ref: fresh(1), launchClass: 'agent' })).toMatchObject({ kind: 'queue', live: 1 });
  });
});
