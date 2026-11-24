import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addSession,
  createWork,
  nudgeText,
  PARLEY,
  readMap,
  readStoredMap,
  transitionSession,
  updateMap,
  type Message,
  type WorkMap,
} from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { ActivityService, SessionLive } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { WorksService } from '../works/works-service.js';
import { createSilentEndings, EARLY_EXIT_MS, SILENT_TURN_MS, type SilentEndings } from './silent-endings.js';

let home = '';
let project = '';
let workId = '';
let cached: WorkMap;
let clock = 0;
let draft = false;
let alive = true;
let stoppers: Array<() => void> = [];
let listeners: Array<(ref: SessionRef, value: SessionLive) => void> = [];
let logErrors: string[] = [];

/** Процесс «запущен» в этот момент: конец хода не может быть раньше. */
const STARTED = Date.parse('2026-11-10T12:00:00.000Z');

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-endings-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-endings-project-'));
  process.env['PARLEY_HOME'] = home;
  stoppers = [];
  listeners = [];
  logErrors = [];
  clock = STARTED;
  draft = false;
  alive = true;
});

afterEach(async () => {
  for (const stop of stoppers) stop();
  delete process.env['PARLEY_HOME'];
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

const refOf = (sessionId: string): SessionRef => ({ projectPath: project, workId, sessionId });

const host = {
  log: { info: () => {}, warn: () => {}, error: (message: string) => logErrors.push(message) },
} as unknown as HostContext;

const works = { entry: (projectPath: string) => ({ projectPath, map: cached }) } as unknown as Pick<WorksService, 'entry'>;

/** Активность, которую «видит» служба: подставляется тестом перед `fire`. */
let lastActivity: Partial<SessionLive['activity']> = {};

const activity = {
  get: () => ({ activity: lastActivity, metrics: null }) as unknown as SessionLive,
  onChange(listener: (ref: SessionRef, value: SessionLive) => void) {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((item) => item !== listener);
    };
  },
} as unknown as Pick<ActivityService, 'get' | 'onChange'>;

const pty = {
  get: () => (alive ? { startedAt: STARTED, hasDraft: () => draft } : undefined),
} as unknown as Pick<PtyManager, 'get'>;

function boot(): SilentEndings {
  const service = createSilentEndings(host, { works, activity, pty, now: () => clock, tickMs: 3_600_000 });
  service.start();
  stoppers.push(() => service.stop());
  return service;
}

/** Работа с тремя активными сессиями: s-02 создана s-01, значит единственный получатель письма о s-02 — s-01. */
async function makeWork(): Promise<void> {
  const created = await createWork(project, { title: 'Работа' });
  workId = created.work.id;
  await updateMap(project, workId, (map) => {
    for (const index of [1, 2, 3]) {
      const session = addSession(map, { provider: 'claude', label: `сессия ${index}`, task: 'сделать', ...(index === 2 ? { createdBy: 's-01' } : {}) });
      transitionSession(map, session.id, 'active');
    }
  });
  cached = await readMap(project, workId);
}

/** s-02 в нужном состоянии жизненного цикла. */
async function setLifecycle(state: 'sleeping' | 'closed'): Promise<void> {
  await updateMap(project, workId, (map) => {
    transitionSession(map, 's-02', state);
  });
  cached = await readMap(project, workId);
}

const parleyLetters = (): Message[] => readStoredMap(project, workId).messages.filter((letter) => letter.from === PARLEY);

/** Конец хода: `idle`, хуки были после запуска, конец хода через секунду после запуска. */
const idleAt = (endMs: number, extra: Partial<SessionLive['activity']> = {}): Partial<SessionLive['activity']> => ({
  activity: 'idle',
  lastEventAt: new Date(endMs).toISOString(),
  turnEndedAt: new Date(endMs).toISOString(),
  waitingFor: null,
  need: null,
  tasks: [],
  runningBackground: [],
  ...extra,
});

function fire(sessionId: string, value: Partial<SessionLive['activity']>): void {
  lastActivity = value;
  const live = { activity: value, metrics: null } as unknown as SessionLive;
  for (const listener of listeners) listener(refOf(sessionId), live);
}

const END = STARTED + 1_000;

describe('служба тихих концовок — выход, Stop, Close', () => {
  it('exited: одно письмо давшему задание; второй вызов в том же задании — нет', async () => {
    await makeWork();
    await setLifecycle('sleeping');
    const service = boot();
    await service.exited(refOf('s-02'), { exitCode: 3 }, null);
    let sent = parleyLetters();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: PARLEY,
      to: ['s-01'],
      roomId: null,
      kind: 'note',
      text: 's-02 stopped (exit code 3) without a result. A letter to s-02 resumes it.',
    });
    await service.exited(refOf('s-02'), { exitCode: 3 }, null);
    sent = parleyLetters();
    expect(sent).toHaveLength(1);
  });

  it('exited: сигнал называется в письме вместо кода', async () => {
    await makeWork();
    await setLifecycle('sleeping');
    const service = boot();
    await service.exited(refOf('s-02'), { exitCode: 0, signal: 9 }, null);
    expect(parleyLetters()[0]?.text).toBe('s-02 stopped (signal 9) without a result. A letter to s-02 resumes it.');
  });

  it('подъём будильником: выход раньше EARLY_EXIT_MS молчит, с EARLY_EXIT_MS — пишет; человек и 0 мс — пишет', async () => {
    expect(EARLY_EXIT_MS).toBe(5_000);
    const cases: Array<{ by: string; runMs: number; letter: boolean }> = [
      { by: 'wake', runMs: 0, letter: false },
      { by: 'wake', runMs: 1_000, letter: false },
      { by: 'wake', runMs: 4_999, letter: false },
      { by: 'wake', runMs: 5_000, letter: true },
      { by: 'wake', runMs: 60_000, letter: true },
      { by: 'human', runMs: 0, letter: true },
    ];
    for (const item of cases) {
      await makeWork();
      await setLifecycle('sleeping');
      const service = boot();
      await service.exited(refOf('s-02'), { exitCode: 1 }, { by: item.by, runMs: item.runMs });
      expect(parleyLetters(), `${item.by} ${item.runMs}`).toHaveLength(item.letter ? 1 : 0);
      stoppers.pop()?.();
      listeners = [];
    }
  });

  it('stoppedByHuman и closedByHuman: тексты решения 2', async () => {
    await makeWork();
    await setLifecycle('sleeping');
    const service = boot();
    await service.stoppedByHuman(refOf('s-02'));
    expect(parleyLetters().map((letter) => letter.text)).toEqual(['s-02 was stopped by the human without a result.']);
    await setLifecycle('closed');
    await service.closedByHuman(refOf('s-02'));
    expect(parleyLetters().map((letter) => letter.text)).toEqual([
      's-02 was stopped by the human without a result.',
      's-02 was closed by the human without a result.',
    ]);
    expect(parleyLetters().every((letter) => letter.to.length === 1 && letter.to[0] === 's-01')).toBe(true);
  });

  it('после stop() exited молчит, подписка на активность снята', async () => {
    await makeWork();
    await setLifecycle('sleeping');
    const service = boot();
    service.stop();
    expect(listeners).toHaveLength(0);
    await service.exited(refOf('s-02'), { exitCode: 1 }, null);
    await service.stoppedByHuman(refOf('s-02'));
    expect(parleyLetters()).toHaveLength(0);
    expect(logErrors).toEqual([]);
  });
});

describe('служба тихих концовок — конец хода без report', () => {
  it('на 4:59 письма нет и сон ждёт; на 5:00 напоминание самой сессии, сон не ждёт', async () => {
    expect(SILENT_TURN_MS).toBe(300_000);
    await makeWork();
    const service = boot();
    fire('s-02', idleAt(END));
    expect(service.holdsSleep(refOf('s-02'))).toBe(true);

    clock = END + SILENT_TURN_MS - 1_000;
    await service.checkTurns();
    expect(parleyLetters()).toHaveLength(0);
    expect(service.holdsSleep(refOf('s-02'))).toBe(true);

    clock = END + SILENT_TURN_MS;
    await service.checkTurns();
    expect(service.holdsSleep(refOf('s-02'))).toBe(false);
    const sent = parleyLetters();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: PARLEY, to: ['s-02'], roomId: null, kind: 'note', text: nudgeText(['s-01']) });

    // Тот же конец хода больше не проверяется, сколько бы раз активность его ни повторила.
    fire('s-02', idleAt(END));
    expect(service.holdsSleep(refOf('s-02'))).toBe(false);
    clock = END + 2 * SILENT_TURN_MS;
    await service.checkTurns();
    expect(parleyLetters()).toHaveLength(1);
  });

  it('quietTurn, waitingFor и черновик человека — напоминания нет', async () => {
    const cases: Array<{ name: string; value: Partial<SessionLive['activity']>; hold: boolean; hasDraft: boolean }> = [
      { name: 'quietTurn', value: idleAt(END, { quietTurn: true }), hold: false, hasDraft: false },
      { name: 'waitingFor', value: idleAt(END, { waitingFor: 'inbox' }), hold: false, hasDraft: false },
      { name: 'черновик', value: idleAt(END), hold: true, hasDraft: true },
    ];
    for (const item of cases) {
      await makeWork();
      draft = item.hasDraft;
      const service = boot();
      fire('s-02', item.value);
      expect(service.holdsSleep(refOf('s-02')), item.name).toBe(item.hold);
      clock = END + SILENT_TURN_MS;
      await service.checkTurns();
      expect(parleyLetters(), item.name).toHaveLength(0);
      expect(service.holdsSleep(refOf('s-02')), item.name).toBe(false);
      stoppers.pop()?.();
      listeners = [];
    }
  });

  it('ход начался до проверки — конец забыт, письма нет', async () => {
    await makeWork();
    const service = boot();
    fire('s-02', idleAt(END));
    fire('s-02', { ...idleAt(END), activity: 'working' });
    expect(service.holdsSleep(refOf('s-02'))).toBe(false);
    clock = END + SILENT_TURN_MS;
    await service.checkTurns();
    expect(parleyLetters()).toHaveLength(0);
  });
});
