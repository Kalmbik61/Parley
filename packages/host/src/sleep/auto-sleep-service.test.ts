import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PARLEY,
  SYSTEM,
  addSession,
  createWork,
  readStoredMap,
  removeSession,
  sessionTag,
  setResult,
  transitionSession,
  updateMap,
} from '@parley/core';
import type { AutoSleep, LetterTx, SessionActivity, WorkMap, WorkSession } from '@parley/core';
import { refKey } from '@parley/protocol';
import type { SessionRef } from '@parley/protocol';
import type { SessionLive } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import type { PtyHandle } from '../pty/pty-manager.js';
import { ALLOW_WAITER_SLEEP, AUTO_SLEEP_TICK_MS, createAutoSleepService } from './auto-sleep-service.js';
import type { AutoSleepService, AutoSleepServiceDeps } from './auto-sleep-service.js';

const MIN = 60_000;
/** Конец хода всех сессий теста; часы теста (`clock`) уходят от него вперёд. */
const T0 = Date.parse('2026-10-31T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

type LogLevel = 'info' | 'warn' | 'error';

let home = '';
let project = '';
let workId = '';
/** Часы сервиса: тест двигает их сам, настоящее время идёт только для записей карты. */
let clock = T0;
let sleepAfterMinutes = 60;
/** Живые PTY хоста; выход процесса убирает ручку отсюда. */
let live: PtyHandle[] = [];
let lives = new Map<string, SessionLive>();
let listeners: Array<(ref: SessionRef, value: SessionLive) => void> = [];
/** Подписчики на снимок работ: служба работ зовёт их после каждой публикации. */
let worksListeners: Array<Parameters<AutoSleepServiceDeps['works']['onChange']>[0]> = [];
/** Вызовы `sessions.stop` и то, какая отметка стояла в карте в этот миг. */
let stops: Array<{ sessionId: string; pending: AutoSleep | null }> = [];
/** Вызовы `wake.retry` и то, в каком состоянии была сессия в карте в этот миг. */
let retries: Array<{ ref: SessionRef; lifecycle: WorkSession['lifecycle'] }> = [];
let drafts = new Set<string>();
let pointers = new Set<string>();
let compacting = new Set<string>();
let logs: Array<{ level: LogLevel; msg: string; data: Record<string, unknown> }> = [];
let stoppers: Array<() => void> = [];

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-sleep-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-sleep-project-'));
  process.env['PARLEY_HOME'] = home;
  workId = '';
  clock = T0;
  sleepAfterMinutes = 60;
  live = [];
  lives = new Map();
  listeners = [];
  worksListeners = [];
  stops = [];
  retries = [];
  drafts = new Set();
  pointers = new Set();
  compacting = new Set();
  logs = [];
  stoppers = [];
  stopImpl = defaultStop;
  // Таймеры фальшивые, диск настоящий: `setImmediate` остаётся живым. Время решений — через `now` сервиса.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(async () => {
  for (const stop of stoppers) stop();
  vi.useRealTimers();
  delete process.env['PARLEY_HOME'];
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------------------------
// Стенд
// ---------------------------------------------------------------------------------------------

const realTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Дать сервису дописать то, что он начал: настоящие I/O, фальшивые таймеры. */
async function quiet(ms = 60): Promise<void> {
  const end = performance.now() + ms;
  do {
    await realTick();
  } while (performance.now() < end);
}

/** Сдвинуть таймеры на `ms` (один проход сервиса — `AUTO_SLEEP_TICK_MS`) и дать сервису закончить. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await quiet();
}

const fakeHost = (): HostContext => {
  const write =
    (level: LogLevel) =>
    (msg: string, data?: object): void => {
      logs.push({ level, msg, data: { ...data } });
    };
  return { log: { info: write('info'), warn: write('warn'), error: write('error') } } as unknown as HostContext;
};

/** Снимок работ хоста: карта всегда свежая с диска. */
const works = {
  snapshot: () => ({ entries: [{ projectPath: project, map: readStoredMap(project, workId) }], branches: {} }),
  onChange: (listener: (typeof worksListeners)[number]) => {
    worksListeners.push(listener);
    return () => {
      worksListeners = worksListeners.filter((item) => item !== listener);
    };
  },
} as unknown as AutoSleepServiceDeps['works'];

const activity: AutoSleepServiceDeps['activity'] = {
  get: (ref) => lives.get(refKey(ref)),
  onChange: (listener) => {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((item) => item !== listener);
    };
  },
};

const pty: AutoSleepServiceDeps['pty'] = {
  list: () => live,
  get: (ref) => live.find((handle) => refKey(handle.ref) === refKey(ref)),
};

/** Что делает `stop` хоста: по умолчанию записывает вызов и ведёт процесс к выходу, как `pty.exit` + `finishExited`. */
async function defaultStop(ref: SessionRef): Promise<void> {
  recordStop(ref);
  await exitProcess(ref);
}
let stopImpl: (ref: SessionRef) => Promise<void> = defaultStop;

const sessions: AutoSleepServiceDeps['sessions'] = { stop: (ref) => stopImpl(ref) };

function recordStop(ref: SessionRef): void {
  stops.push({ sessionId: ref.sessionId, pending: sessionOf(ref).autoSleepPending ?? null });
}

/** Процесс вышел: ручки нет, сессия в `sleeping`, отметка «засыпает» стала `autoSleep` — настоящий `transitionSession`. */
async function exitProcess(ref: SessionRef): Promise<void> {
  live = live.filter((handle) => handle.ref.sessionId !== ref.sessionId);
  await updateMap(ref.projectPath, ref.workId, (map) => {
    transitionSession(map, ref.sessionId, 'sleeping', { exitCode: 0 });
  });
}

function boot(over: Partial<AutoSleepServiceDeps> = {}): AutoSleepService {
  const service = createAutoSleepService(fakeHost(), {
    works,
    activity,
    pty,
    sessions,
    wake: {
      inFlight: (ref) => pointers.has(ref.sessionId),
      retry: (ref) => {
        retries.push({ ref, lifecycle: sessionOf(ref).lifecycle });
      },
    },
    compacting: (ref) => compacting.has(ref.sessionId),
    config: async () => ({ sleepAfterMinutes }),
    now: () => clock,
    ...over,
  });
  service.start();
  stoppers.push(() => service.stop());
  return service;
}

/** Активность сессии с оконченным ходом: хуки были, ничего её не держит. */
const idleActivity = (endedAt: number, patch: Partial<SessionActivity> = {}): SessionActivity => ({
  activity: 'idle',
  subagents: 0,
  tasks: [],
  waitingFor: null,
  heldByBackground: false,
  runningBackground: [],
  turnEndedAt: iso(endedAt),
  turnBoundaryAt: iso(endedAt),
  lastEventAt: iso(endedAt),
  source: 'hooks',
  hooksMissing: false,
  need: null,
  ...patch,
});

const workingActivity = (patch: Partial<SessionActivity> = {}): SessionActivity =>
  idleActivity(T0, { activity: 'working', turnEndedAt: null, ...patch });

/** Агент внутри `wait_for`: сессия `working`, цель ожидания — `inbox` или id сессии. */
const waitingActivity = (target: string): SessionActivity => workingActivity({ waitingFor: target });

function handleOf(ref: SessionRef, startedAt: number): PtyHandle {
  return {
    ref,
    pid: 4242,
    startedAt,
    cols: 120,
    rows: 40,
    provider: 'claude',
    hasDraft: () => drafts.has(ref.sessionId),
    bracketedPaste: () => false,
  };
}

/** Активная сессия со своим PTY; по умолчанию ход окончен в `T0`. */
async function startSession(
  options: {
    provider?: string;
    activity?: SessionActivity;
    /** Когда хост поднял процесс (мс); по умолчанию — за 10 минут до первого события хуков. */
    startedAt?: number;
    patch?: (session: WorkSession) => void;
  } = {},
): Promise<SessionRef> {
  if (workId === '') workId = (await createWork(project, { title: 'Работа' })).work.id;
  let sessionId = '';
  await updateMap(project, workId, (map) => {
    const session = addSession(map, { provider: options.provider ?? 'claude', label: 'сессия', task: 'сделать' });
    transitionSession(map, session.id, 'active');
    options.patch?.(session);
    sessionId = session.id;
  });
  const ref: SessionRef = { projectPath: project, workId, sessionId };
  live.push(handleOf(ref, options.startedAt ?? T0 - 10 * MIN));
  lives.set(refKey(ref), { activity: options.activity ?? idleActivity(T0), metrics: null });
  return ref;
}

/** Хост опубликовал новую активность: сервис узнаёт об этом через `onChange`. */
function publish(ref: SessionRef, value: SessionActivity): void {
  const next: SessionLive = { activity: value, metrics: null };
  lives.set(refKey(ref), next);
  for (const listener of listeners) listener(ref, next);
}

/** Служба работ опубликовала снимок: сервис узнаёт об этом через `onChange`, как будильник. */
function publishWorks(): void {
  const view = works.snapshot();
  for (const listener of worksListeners) listener(view, view);
}

const sessionOf = (ref: SessionRef): WorkSession => {
  const found = readStoredMap(project, workId).sessions.find((session) => session.id === ref.sessionId);
  if (found === undefined) throw new Error(`нет сессии ${ref.sessionId}`);
  return found;
};

/** Ключа отметки в сессии нет вовсе: её снимают удалением, а не записью `null`. */
const hasMarkKey = (ref: SessionRef): boolean => Object.keys(sessionOf(ref)).includes('autoSleepPending');

/** Письмо сессии; `readAt` — когда его выдали (`check_inbox`, `wait_for`): без этого оно непрочитанное. */
async function sendLetter(ref: SessionRef, readAt?: number): Promise<void> {
  await updateMap(project, workId, (_map, letters) => {
    const letter = letters.add({ roomId: null, kind: 'note', from: PARLEY, to: [ref.sessionId], text: 'письмо' });
    if (readAt !== undefined) letters.markRead(ref.sessionId, [letter.id], iso(readAt));
  });
}

/**
 * Усыплённая хостом сессия без процесса, какой её оставляет `exitProcess`: `sleeping` и `autoSleep`. `waitTarget` — что она
 * ждала в `wait_for(<id>)` перед сном. Ручки PTY у неё нет: сервис видит её только в снимке работ.
 */
async function startSleeper(waitTarget: string | null): Promise<SessionRef> {
  if (workId === '') workId = (await createWork(project, { title: 'Работа' })).work.id;
  let sessionId = '';
  await updateMap(project, workId, (map) => {
    const session = addSession(map, { provider: 'claude', label: 'лид', task: 'ждать помощника' });
    transitionSession(map, session.id, 'active');
    session.autoSleepPending = { reason: 'idle', at: iso(T0), waitTarget };
    transitionSession(map, session.id, 'sleeping', { exitCode: 0 });
    sessionId = session.id;
  });
  return { projectPath: project, workId, sessionId };
}

/** Системные письма работы в порядке записи. */
const systemLetters = () => readStoredMap(project, workId).messages.filter((message) => message.from === SYSTEM);

const messagesOf = (level: LogLevel): string[] => logs.filter((entry) => entry.level === level).map((entry) => entry.msg);
const slept = (): string[] => stops.map((stop) => stop.sessionId);

// ---------------------------------------------------------------------------------------------
// Тесты
// ---------------------------------------------------------------------------------------------

describe('сервис сна агентов', () => {
  it('простаивающая дольше порога засыпает: отметка, stop, autoSleep после выхода', async () => {
    const ref = await startSession();
    boot();
    clock = T0 + 61 * MIN;
    await advance(AUTO_SLEEP_TICK_MS);

    const mark: AutoSleep = { reason: 'idle', at: iso(clock), waitTarget: null };
    // К моменту stop отметка уже стоит: письма за ней не выдаются.
    expect(stops).toEqual([{ sessionId: ref.sessionId, pending: mark }]);
    const session = sessionOf(ref);
    expect(session.lifecycle).toBe('sleeping');
    expect(session.autoSleep).toEqual(mark);
    expect(hasMarkKey(ref)).toBe(false);
    expect(session.history.at(-1)).toMatchObject({ event: 'sleeping', reason: 'idle' });
    expect(logs).toContainEqual({ level: 'info', msg: 'агент усыплён', data: { ref, reason: 'idle', idleMin: 61 } });
  });

  it('после сна будильнику велено перепроверить письма сессии: retry зван один раз, когда она уже спит', async () => {
    const ref = await startSession();
    boot();
    clock = T0 + 61 * MIN;
    await advance(AUTO_SLEEP_TICK_MS);

    expect(slept()).toEqual([ref.sessionId]);
    // Не до остановки и не раньше записи перехода: будильник пересчитывает уже спящую сессию.
    expect(retries).toEqual([{ ref, lifecycle: 'sleeping' }]);
  });

  it('порог 0 в настройке — никто не засыпает', async () => {
    sleepAfterMinutes = 0;
    const ref = await startSession();
    boot();
    clock = T0 + 10 * 60 * MIN;
    await advance(AUTO_SLEEP_TICK_MS);

    expect(stops).toEqual([]);
    expect(sessionOf(ref).lifecycle).toBe('active');
    expect(hasMarkKey(ref)).toBe(false);
  });

  it('порог берётся из настройки на каждом проходе', async () => {
    const ref = await startSession();
    boot();
    sleepAfterMinutes = 120;
    clock = T0 + 61 * MIN;
    await advance(AUTO_SLEEP_TICK_MS);
    expect(stops).toEqual([]);

    sleepAfterMinutes = 60;
    await advance(AUTO_SLEEP_TICK_MS);
    expect(slept()).toEqual([ref.sessionId]);
  });

  it('до порога не засыпает, ровно на пороге уже спит', async () => {
    const ref = await startSession();
    boot();
    clock = T0 + 60 * MIN - 1;
    await advance(AUTO_SLEEP_TICK_MS);
    expect(stops).toEqual([]);

    clock = T0 + 60 * MIN;
    await advance(AUTO_SLEEP_TICK_MS);
    expect(slept()).toEqual([ref.sessionId]);
  });

  it('только что поднятая сессия не засыпает по концу хода из прошлого процесса', async () => {
    // Ход кончился в T0 (`Stop`), сессия спала, и через 3 часа её подняли (Resume): `SessionStart` конец хода не обновляет.
    const startedAt = T0 + 180 * MIN;
    const ref = await startSession({ startedAt, activity: idleActivity(T0, { lastEventAt: iso(startedAt + 1_000) }) });
    boot();
    clock = startedAt + 10 * MIN;
    await advance(AUTO_SLEEP_TICK_MS);
    expect(stops).toEqual([]);

    // Часы идут от запуска нынешнего процесса.
    clock = startedAt + 61 * MIN;
    await advance(AUTO_SLEEP_TICK_MS);
    expect(slept()).toEqual([ref.sessionId]);
    expect(logs).toContainEqual({ level: 'info', msg: 'агент усыплён', data: { ref, reason: 'idle', idleMin: 61 } });
  });

  it('письмо, выданное после начала простоя, отменяет сон', async () => {
    // Review Focus 1. Ход окончен в T0, а в T0 + 30 мин сессии выдали письмо (check_inbox): непрочитанным оно уже не
    // числится, но модель его ещё не видела, а активность в хосте всё ещё «idle с T0».
    const ref = await startSession();
    await sendLetter(ref, T0 + 30 * MIN);
    boot();
    clock = T0 + 61 * MIN;
    await advance(AUTO_SLEEP_TICK_MS);

    expect(stops).toEqual([]);
    expect(retries).toEqual([]);
    expect(sessionOf(ref).lifecycle).toBe('active');
    expect(hasMarkKey(ref)).toBe(false);
    expect(logs).toContainEqual({
      level: 'info',
      msg: 'сон отменён под замком карты',
      data: { ref, reason: 'idle', why: 'delivered' },
    });
  });

  it('письмо, выданное до конца хода, сну не мешает', async () => {
    const ref = await startSession();
    await sendLetter(ref, T0 - 5 * MIN);
    boot();
    clock = T0 + 61 * MIN;
    await advance(AUTO_SLEEP_TICK_MS);

    expect(slept()).toEqual([ref.sessionId]);
  });

  it('под замком карты перепроверка: Keep awake, поставленный после снимка, отменяет сон', async () => {
    const ref = await startSession();
    // Снимок работ хоста отстал от базы: Keep awake в нём ещё нет, а в базе уже есть.
    const stale = readStoredMap(project, workId);
    await updateMap(project, workId, (map) => {
      map.sessions.find((session) => session.id === ref.sessionId)!.keepAwake = true;
    });
    boot({ works: { ...works, snapshot: () => ({ entries: [{ projectPath: project, map: stale }], branches: {} }) } });
    clock = T0 + 61 * MIN;
    await advance(AUTO_SLEEP_TICK_MS);

    expect(stops).toEqual([]);
    expect(retries).toEqual([]);
    expect(hasMarkKey(ref)).toBe(false);
    expect(logs).toContainEqual({
      level: 'info',
      msg: 'сон отменён под замком карты',
      data: { ref, reason: 'idle', why: 'keep-awake' },
    });
  });

  it.skipIf(ALLOW_WAITER_SLEEP)('ждущая в wait_for не засыпает, пока ALLOW_WAITER_SLEEP выключен', async () => {
    const ref = await startSession({ activity: workingActivity() });
    boot();
    // Начало ожидания хост видит по onChange, так что от знания о нём сон не зависит.
    publish(ref, waitingActivity('inbox'));
    clock = T0 + 10 * 60 * MIN;
    await advance(AUTO_SLEEP_TICK_MS);

    expect(stops).toEqual([]);
    expect(sessionOf(ref).lifecycle).toBe('active');
  });

  // Включается вместе с ALLOW_WAITER_SLEEP, когда спайк (задача 0) пройден: пока константа выключена, тест пропускается.
  it.skipIf(!ALLOW_WAITER_SLEEP)('ждущая в wait_for: часы идут от увиденного начала ожидания', async () => {
    const ref = await startSession({ activity: workingActivity() });
    boot();
    const at = async (minutes: number, next?: SessionActivity): Promise<void> => {
      clock = T0 + minutes * MIN;
      if (next !== undefined) publish(ref, next);
      await advance(AUTO_SLEEP_TICK_MS);
    };

    // Ждёт письма с минуты 0, но ожидание кончилось (`wait_for` вернул `running`) и началось снова в минуту 55.
    await at(0, waitingActivity('inbox'));
    await at(50, workingActivity());
    await at(55, waitingActivity('inbox'));
    await at(61);
    expect(stops).toEqual([]);

    // Другой `wait_for` без паузы между вызовами — новое ожидание, часы идут заново с минуты 100.
    await at(100, waitingActivity('s-07'));
    await at(116);
    expect(stops).toEqual([]);

    await at(161);
    expect(slept()).toEqual([ref.sessionId]);
    expect(sessionOf(ref).autoSleep).toEqual({ reason: 'idle', at: iso(clock), waitTarget: 's-07' });
  });

  it('requestSleep усыпляет без порога при первом простое', async () => {
    const queen = await startSession({ activity: workingActivity() });
    // Простаивает с T0, но порог в 60 мин ещё не прошёл и просьбы нет.
    const other = await startSession();
    const service = boot();

    service.requestSleep(queen, 'swarm-done');
    service.requestSleep(queen, 'swarm-done');
    await quiet();
    // Королева ещё работает.
    expect(stops).toEqual([]);

    clock = T0 + 5_000;
    publish(queen, idleActivity(clock));
    await quiet();
    expect(slept()).toEqual([queen.sessionId]);
    expect(sessionOf(queen).autoSleep).toEqual({ reason: 'swarm-done', at: iso(clock), waitTarget: null });
    expect(retries).toEqual([{ ref: queen, lifecycle: 'sleeping' }]);
    expect(sessionOf(other).lifecycle).toBe('active');

    // Спящую повтор не трогает.
    service.requestSleep(queen, 'swarm-done');
    await advance(AUTO_SLEEP_TICK_MS);
    expect(slept()).toEqual([queen.sessionId]);
  });

  it('Codex-сессию не трогает', async () => {
    const codex = await startSession({ provider: 'codex' });
    const claude = await startSession();
    boot();
    clock = T0 + 61 * MIN;
    await advance(AUTO_SLEEP_TICK_MS);

    expect(slept()).toEqual([claude.sessionId]);
    expect(sessionOf(codex).lifecycle).toBe('active');
  });

  it('сессию в смене агента (switching) не трогает', async () => {
    const ref = await startSession({
      patch: (session) => {
        session.switching = { id: 'sw-01', to: 'codex', since: iso(T0) };
      },
    });
    boot();
    clock = T0 + 61 * MIN;
    await advance(AUTO_SLEEP_TICK_MS);

    expect(stops).toEqual([]);
    expect(sessionOf(ref).lifecycle).toBe('active');
    expect(hasMarkKey(ref)).toBe(false);
  });

  // Каждая причина — своя зависимость сервиса: сам порядок и полный набор причин проверяет `autoSleepVerdict` в core.
  const blocks: Array<[string, (ref: SessionRef) => void | Promise<void>]> = [
    [
      'черновик человека в терминале',
      (ref) => {
        drafts.add(ref.sessionId);
      },
    ],
    [
      'указатель на письма в полёте',
      (ref) => {
        pointers.add(ref.sessionId);
      },
    ],
    [
      'идёт сжатие контекста',
      (ref) => {
        compacting.add(ref.sessionId);
      },
    ],
    ['непрочитанное письмо', (ref) => sendLetter(ref)],
    [
      'в последнем снимке есть работающая фоновая задача',
      (ref) => {
        lives.set(refKey(ref), { activity: idleActivity(T0, { runningBackground: ['shell'] }), metrics: null });
      },
    ],
    [
      'сессия ждёт одобрения человека',
      (ref) => {
        const need = { kind: 'approval', since: iso(T0), detail: null, resetsAt: null, window: null, account: null } as const;
        lives.set(refKey(ref), { activity: idleActivity(T0, { activity: 'blocked', need }), metrics: null });
      },
    ],
    [
      'с запуска процесса не было ни одного хука',
      (ref) => {
        lives.set(refKey(ref), { activity: idleActivity(T0, { lastEventAt: iso(T0 - 20 * MIN) }), metrics: null });
      },
    ],
    [
      'человек поставил Keep awake',
      async (ref) => {
        await updateMap(project, workId, (map) => {
          map.sessions.find((session) => session.id === ref.sessionId)!.keepAwake = true;
        });
      },
    ],
  ];

  it.each(blocks)('не засыпает: %s', async (_name, block) => {
    const ref = await startSession();
    await block(ref);
    boot();
    clock = T0 + 61 * MIN;
    await advance(AUTO_SLEEP_TICK_MS);

    expect(stops).toEqual([]);
    expect(retries).toEqual([]);
    expect(sessionOf(ref).lifecycle).toBe('active');
    expect(hasMarkKey(ref)).toBe(false);
  });

  const requestBlocks: Array<[string, (ref: SessionRef) => void | Promise<void>]> = [
    [
      'сон выключен в настройках',
      () => {
        sleepAfterMinutes = 0;
      },
    ],
    [
      'черновик человека в терминале',
      (ref) => {
        drafts.add(ref.sessionId);
      },
    ],
    [
      'человек поставил Keep awake',
      async (ref) => {
        await updateMap(project, workId, (map) => {
          map.sessions.find((session) => session.id === ref.sessionId)!.keepAwake = true;
        });
      },
    ],
  ];

  it.each(requestBlocks)('requestSleep не обходит остальные блокировки: %s', async (_name, block) => {
    const ref = await startSession();
    await block(ref);
    const service = boot();
    service.requestSleep(ref, 'swarm-done');
    await advance(AUTO_SLEEP_TICK_MS);

    expect(stops).toEqual([]);
    expect(sessionOf(ref).lifecycle).toBe('active');
  });

  const failedStops: Array<[string, (ref: SessionRef) => Promise<void>]> = [
    [
      'stop вернулся, а процесс жив',
      async (ref) => {
        recordStop(ref);
      },
    ],
    [
      'stop бросил ошибку',
      async (ref) => {
        recordStop(ref);
        throw new Error('процесс не остановился');
      },
    ],
  ];

  it.each(failedStops)('%s: отметка «засыпает» снята, пишется warn', async (_name, failing) => {
    stopImpl = failing;
    const ref = await startSession();
    boot();
    clock = T0 + 61 * MIN;
    await advance(AUTO_SLEEP_TICK_MS);

    expect(slept()).toEqual([ref.sessionId]);
    expect(retries).toEqual([]);
    expect(sessionOf(ref).lifecycle).toBe('active');
    // Письма сессии за оградой больше не застрянут: ключ удалён.
    expect(hasMarkKey(ref)).toBe(false);
    expect(messagesOf('warn')).toContain('агент не уснул: сессия осталась active, отметка «засыпает» снята');
    expect(messagesOf('info')).not.toContain('агент усыплён');
  });

  it('отметка, оставшаяся на живой сессии, снимается на следующей проверке', async () => {
    const ref = await startSession({
      patch: (session) => {
        session.autoSleepPending = { reason: 'idle', at: iso(T0), waitTarget: null };
      },
    });
    boot();
    clock = T0 + 61 * MIN;
    await advance(AUTO_SLEEP_TICK_MS);

    // Первый проход только снимает отметку, оставленную прошлым сбоем, ...
    expect(stops).toEqual([]);
    expect(hasMarkKey(ref)).toBe(false);
    expect(messagesOf('warn')).toContain('отметка «засыпает» осталась на живой сессии, снята');

    // ... а на втором сессия снова обычная и засыпает.
    await advance(AUTO_SLEEP_TICK_MS);
    expect(slept()).toEqual([ref.sessionId]);
  });

  it('пока сессию усыпляют, вторая проверка её не начинается', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stopImpl = async (ref) => {
      recordStop(ref);
      await gate;
      await exitProcess(ref);
    };
    const ref = await startSession();
    const service = boot();
    clock = T0 + 61 * MIN;
    await advance(AUTO_SLEEP_TICK_MS);
    expect(slept()).toEqual([ref.sessionId]);

    // Процесс ещё не вышел: изменение активности, просьба и следующий проход вторую остановку не начинают.
    publish(ref, idleActivity(T0, { lastEventAt: iso(T0 + MIN) }));
    service.requestSleep(ref, 'swarm-done');
    await advance(AUTO_SLEEP_TICK_MS);
    expect(slept()).toEqual([ref.sessionId]);
    expect(retries).toEqual([]);

    release();
    await quiet();
    expect(retries).toEqual([{ ref, lifecycle: 'sleeping' }]);
    expect(sessionOf(ref).lifecycle).toBe('sleeping');
    expect(sessionOf(ref).autoSleep).toMatchObject({ reason: 'idle' });
  });

  it('изменение активности проверяет сессию сразу, а работающую — без чтения настроек', async () => {
    const config = vi.fn(async () => ({ sleepAfterMinutes }));
    const ref = await startSession({ activity: workingActivity() });
    boot({ config });
    clock = T0 + 61 * MIN;

    publish(ref, workingActivity({ lastEventAt: iso(T0 + MIN) }));
    await quiet();
    expect(config).not.toHaveBeenCalled();
    expect(stops).toEqual([]);

    // Ход окончился давно (T0): таймера ждать не надо.
    publish(ref, idleActivity(T0));
    await quiet();
    expect(slept()).toEqual([ref.sessionId]);
  });

  it('после stop сервис не проверяет сессии и не слушает активность', async () => {
    const ref = await startSession();
    const service = boot();
    expect(listeners).toHaveLength(1);

    service.stop();
    expect(listeners).toHaveLength(0);
    clock = T0 + 61 * MIN;
    service.requestSleep(ref, 'swarm-done');
    await advance(AUTO_SLEEP_TICK_MS);

    expect(stops).toEqual([]);
    expect(sessionOf(ref).lifecycle).toBe('active');
  });
});

describe('сервис сна: усыплённый ждал другую сессию', () => {
  /** Как цель кончает: название для теста, слово в письме и запись в карту (как у хоста или агента). */
  const endings: Array<[string, string, (id: string) => (map: WorkMap, letters: LetterTx) => void]> = [
    [
      'сдала итог done',
      'done',
      (id) => (map) => {
        setResult(map, id, 'done');
      },
    ],
    [
      'сдала итог failed',
      'failed',
      (id) => (map) => {
        setResult(map, id, 'failed');
      },
    ],
    [
      'застряла',
      'stuck',
      (id) => (map) => {
        const need = { kind: 'approval', since: iso(T0), detail: null, resetsAt: null, window: null, account: null } as const;
        map.sessions.find((session) => session.id === id)!.stuck = need;
      },
    ],
    [
      'закрыта',
      'closed',
      (id) => (map) => {
        transitionSession(map, id, 'closed');
      },
    ],
    [
      'удалена',
      'deleted',
      (id) => (map, letters) => {
        removeSession(map, letters, id);
      },
    ],
  ];

  it.each(endings)('цель %s — спящему одно системное письмо, цель ожидания снята', async (_name, state, end) => {
    const target = await startSession({ activity: workingActivity() });
    const sleeper = await startSleeper(target.sessionId);
    boot();
    await updateMap(project, workId, end(target.sessionId));
    publishWorks();
    await quiet();

    const letters = systemLetters();
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({
      roomId: null,
      to: [sleeper.sessionId],
      kind: 'note',
      text: `${sessionTag(target.sessionId)} finished: ${state}`,
    });
    // Причина и время сна остаются, снимается только цель ожидания; письмо поднимет сессию будильником, она пока спит.
    expect(sessionOf(sleeper).lifecycle).toBe('sleeping');
    expect(sessionOf(sleeper).autoSleep).toEqual({ reason: 'idle', at: iso(T0), waitTarget: null });
    expect(logs).toContainEqual({
      level: 'info',
      msg: 'цель ожидания усыплённого закончила, ему записано письмо',
      data: { ref: sleeper, target: target.sessionId, state },
    });
  });

  it('проверка идёт и на таймере: снимок работ не приходил, а цель уже сдала итог', async () => {
    const target = await startSession({ activity: workingActivity() });
    const sleeper = await startSleeper(target.sessionId);
    boot();
    await updateMap(project, workId, (map) => {
      setResult(map, target.sessionId, 'done');
    });
    await advance(AUTO_SLEEP_TICK_MS);

    expect(systemLetters().map((letter) => letter.text)).toEqual([`${sessionTag(target.sessionId)} finished: done`]);
    expect(sessionOf(sleeper).autoSleep?.waitTarget).toBeNull();
  });

  it('повторная проверка второго письма не пишет', async () => {
    const target = await startSession({ activity: workingActivity() });
    await startSleeper(target.sessionId);
    boot();
    await updateMap(project, workId, (map) => {
      setResult(map, target.sessionId, 'done');
    });
    publishWorks();
    await quiet();
    expect(systemLetters()).toHaveLength(1);

    // И новый снимок, и два прохода таймера видят уже снятую цель ожидания.
    publishWorks();
    await advance(AUTO_SLEEP_TICK_MS);
    await advance(AUTO_SLEEP_TICK_MS);
    expect(systemLetters()).toHaveLength(1);
  });

  it('цель ещё работает — письма нет, цель ожидания остаётся', async () => {
    const target = await startSession({ activity: workingActivity() });
    const sleeper = await startSleeper(target.sessionId);
    boot();
    publishWorks();
    await advance(AUTO_SLEEP_TICK_MS);

    expect(systemLetters()).toEqual([]);
    expect(sessionOf(sleeper).autoSleep).toEqual({ reason: 'idle', at: iso(T0), waitTarget: target.sessionId });
  });

  it('спящий, который ждал письма, а не сессию, о чужом итоге не узнаёт', async () => {
    const other = await startSession({ activity: workingActivity() });
    const sleeper = await startSleeper(null);
    boot();
    await updateMap(project, workId, (map) => {
      setResult(map, other.sessionId, 'done');
    });
    publishWorks();
    await advance(AUTO_SLEEP_TICK_MS);

    expect(systemLetters()).toEqual([]);
    expect(sessionOf(sleeper).autoSleep).toEqual({ reason: 'idle', at: iso(T0), waitTarget: null });
  });

  it('двое ждали одну цель — каждому по письму', async () => {
    const target = await startSession({ activity: workingActivity() });
    const first = await startSleeper(target.sessionId);
    const second = await startSleeper(target.sessionId);
    boot();
    await updateMap(project, workId, (map) => {
      setResult(map, target.sessionId, 'done');
    });
    publishWorks();
    await quiet();

    expect(systemLetters().map((letter) => letter.to)).toEqual([[first.sessionId], [second.sessionId]]);
    expect(sessionOf(first).autoSleep?.waitTarget).toBeNull();
    expect(sessionOf(second).autoSleep?.waitTarget).toBeNull();
  });

  // Снимок работ хоста отстаёт от базы, поэтому решает проверка под замком карты.
  const staleCases: Array<[string, (sleeper: string) => (map: WorkMap, letters: LetterTx) => void]> = [
    [
      'то же письмо уже записала другая проверка',
      (sleeper) => (map, letters) => {
        letters.add({ roomId: null, from: SYSTEM, to: [sleeper], text: 'S01 finished: done', kind: 'note' });
        const session = map.sessions.find((candidate) => candidate.id === sleeper)!;
        session.autoSleep = { ...session.autoSleep!, waitTarget: null };
      },
    ],
    [
      'сессию уже подняли',
      (sleeper) => (map) => {
        transitionSession(map, sleeper, 'active');
      },
    ],
  ];

  it.each(staleCases)('снимок отстал от базы: %s — письма сверх записанного нет', async (_name, change) => {
    const target = await startSession({ activity: workingActivity() });
    const sleeper = await startSleeper(target.sessionId);
    await updateMap(project, workId, (map) => {
      setResult(map, target.sessionId, 'done');
    });
    // В снимке цель сдала итог, а спящий ещё ждёт её; в базе уже иначе.
    const stale = readStoredMap(project, workId);
    await updateMap(project, workId, change(sleeper.sessionId));
    const before = systemLetters().length;
    boot({ works: { ...works, snapshot: () => ({ entries: [{ projectPath: project, map: stale }], branches: {} }) } });
    publishWorks();
    await advance(AUTO_SLEEP_TICK_MS);

    expect(systemLetters()).toHaveLength(before);
  });

  it('после stop сервис не слушает снимок работ и писем не пишет', async () => {
    const target = await startSession({ activity: workingActivity() });
    await startSleeper(target.sessionId);
    const service = boot();
    expect(worksListeners).toHaveLength(1);

    service.stop();
    expect(worksListeners).toHaveLength(0);
    await updateMap(project, workId, (map) => {
      setResult(map, target.sessionId, 'done');
    });
    publishWorks();
    await advance(AUTO_SLEEP_TICK_MS);

    expect(systemLetters()).toEqual([]);
  });
});
