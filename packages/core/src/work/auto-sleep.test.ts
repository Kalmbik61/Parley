import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionActivity } from './activity.js';
import { autoSleepVerdict, deliveredSince, type AutoSleepBlock, type AutoSleepInput } from './auto-sleep.js';
import { closeWorkDb } from './db.js';
import { mapLetterTx, writeLetters } from './letter-store.js';
import { addRoom } from './rooms.js';
import { createWork, updateMap } from './store.js';
import type { SessionNeed } from './stuck.js';
import type { AutoSleep, WindowWorkMap } from './types.js';

const MIN = 60_000;
const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** Активность живой сессии: ход окончен 61 минуту назад и просмотрен (`idle`), ничего её не держит. */
const idleActivity = (patch: Partial<SessionActivity> = {}): SessionActivity => ({
  activity: 'idle',
  subagents: 0,
  tasks: [],
  waitingFor: null,
  heldByBackground: false,
  runningBackground: [],
  turnEndedAt: iso(NOW - 61 * MIN),
  turnBoundaryAt: null,
  lastEventAt: null,
  source: 'hooks',
  hooksMissing: false,
  need: null,
  ...patch,
});

/** Агент внутри `wait_for`: сессия `working`, хода без конца нет, цель ожидания — `inbox` или id сессии. */
const waiting = (target: string): SessionActivity =>
  idleActivity({ activity: 'working', waitingFor: target, turnEndedAt: null });

const needOf = (kind: SessionNeed['kind']): SessionNeed => ({
  kind,
  since: iso(NOW - 70 * MIN),
  detail: null,
  resetsAt: null,
  window: null,
  account: null,
});

const MARK: AutoSleep = { reason: 'idle', at: iso(NOW - MIN), waitTarget: null };

/** Вход, который проходит: ход окончен 61 минуту назад при пороге 60. Каждый тест портит одно поле. */
const base: AutoSleepInput = {
  session: { id: 's-01', lifecycle: 'active' },
  claudeCode: true,
  activity: idleActivity(),
  hooked: true,
  hasDraft: false,
  pointerInFlight: false,
  unread: 0,
  compacting: false,
  waitStartedAt: null,
  now: NOW,
  enabled: true,
  thresholdMs: 60 * MIN,
  allowWaiters: true,
};

const blocked = (block: AutoSleepBlock): { sleep: false; block: AutoSleepBlock } => ({ sleep: false, block });

describe('autoSleepVerdict: сессия простаивает — спит', () => {
  it('ход окончен дольше порога назад: спит, часы — от turnEndedAt, цели ожидания нет', () => {
    expect(autoSleepVerdict(base)).toEqual({ sleep: true, idleSince: NOW - 61 * MIN, waitTarget: null });
  });

  it('ход окончен и не просмотрен (unseen): спит так же', () => {
    const verdict = autoSleepVerdict({ ...base, activity: idleActivity({ activity: 'unseen' }) });
    expect(verdict).toEqual({ sleep: true, idleSince: NOW - 61 * MIN, waitTarget: null });
  });

  it('ровно на пороге уже спит, на миллисекунду раньше — ещё нет', () => {
    const at = (ago: number): AutoSleepInput => ({ ...base, activity: idleActivity({ turnEndedAt: iso(NOW - ago) }) });
    expect(autoSleepVerdict(at(60 * MIN))).toMatchObject({ sleep: true });
    expect(autoSleepVerdict(at(60 * MIN - 1))).toEqual(blocked('too-soon'));
  });

  it('ждёт письма (inbox) дольше порога: спит, часы — от начала ожидания, цели нет', () => {
    const verdict = autoSleepVerdict({ ...base, activity: waiting('inbox'), waitStartedAt: NOW - 61 * MIN });
    expect(verdict).toEqual({ sleep: true, idleSince: NOW - 61 * MIN, waitTarget: null });
  });

  it('ждёт другую сессию дольше порога: спит, цель ожидания запомнена', () => {
    const verdict = autoSleepVerdict({ ...base, activity: waiting('s-07'), waitStartedAt: NOW - 61 * MIN });
    expect(verdict).toEqual({ sleep: true, idleSince: NOW - 61 * MIN, waitTarget: 's-07' });
  });

  it('королева: порог 0 — спит, как только ход окончен', () => {
    const justNow = idleActivity({ turnEndedAt: iso(NOW) });
    expect(autoSleepVerdict({ ...base, thresholdMs: 0, activity: justNow })).toEqual({
      sleep: true,
      idleSince: NOW,
      waitTarget: null,
    });
    // Метка конца хода чуть впереди часов хоста: без порога она «рано» не даёт.
    const ahead = idleActivity({ turnEndedAt: iso(NOW + 5) });
    expect(autoSleepVerdict({ ...base, thresholdMs: 0, activity: ahead })).toMatchObject({ sleep: true });
  });

  it('порог 0 не отменяет остальные причины: королева с фоновой командой не спит', () => {
    const activity = idleActivity({ turnEndedAt: iso(NOW), runningBackground: ['shell'] });
    expect(autoSleepVerdict({ ...base, thresholdMs: 0, activity })).toEqual(blocked('background'));
  });
});

describe('autoSleepVerdict: причины не спать — по одной на каждую', () => {
  it('off: сон выключен', () => {
    expect(autoSleepVerdict({ ...base, enabled: false })).toEqual(blocked('off'));
  });

  it('not-claude: провайдер не на Claude Code', () => {
    expect(autoSleepVerdict({ ...base, claudeCode: false })).toEqual(blocked('not-claude'));
  });

  it('not-active: спящая и закрытая сессии усыплять нечего', () => {
    for (const lifecycle of ['sleeping', 'closed', 'pending'] as const) {
      expect(autoSleepVerdict({ ...base, session: { id: 's-01', lifecycle } })).toEqual(blocked('not-active'));
    }
  });

  it('keep-awake: человек запретил сон', () => {
    const session = { id: 's-01', lifecycle: 'active', keepAwake: true } as const;
    expect(autoSleepVerdict({ ...base, session })).toEqual(blocked('keep-awake'));
  });

  it('pending: отметка «засыпает» уже стоит', () => {
    const session = { id: 's-01', lifecycle: 'active', autoSleepPending: MARK } as const;
    expect(autoSleepVerdict({ ...base, session })).toEqual(blocked('pending'));
  });

  it('pending: пустая отметка (null) — не отметка', () => {
    const session = { id: 's-01', lifecycle: 'active', autoSleepPending: null, keepAwake: false } as const;
    expect(autoSleepVerdict({ ...base, session })).toMatchObject({ sleep: true });
  });

  it('no-hooks: с запуска не было хуков — хост не знает, что на экране', () => {
    expect(autoSleepVerdict({ ...base, hooked: false })).toEqual(blocked('no-hooks'));
  });

  it('need: сессия ждёт человека, сброса лимита или входа', () => {
    for (const kind of ['approval', 'limit', 'sign-in'] as const) {
      const activity = idleActivity({ need: needOf(kind) });
      expect(autoSleepVerdict({ ...base, activity })).toEqual(blocked('need'));
    }
  });

  it('background: фоновая команда после конца хода не даёт уснуть, сколько бы ни прошло', () => {
    // Десять часов тишины против порога в час: срока давности у фоновой команды нет.
    const activity = idleActivity({ turnEndedAt: iso(NOW - 600 * MIN), runningBackground: ['shell'] });
    expect(autoSleepVerdict({ ...base, activity })).toEqual(blocked('background'));
  });

  it('background: так же держат монитор, субагент и workflow', () => {
    for (const kind of ['monitor', 'subagent', 'workflow']) {
      const activity = idleActivity({ runningBackground: [kind] });
      expect(autoSleepVerdict({ ...base, activity })).toEqual(blocked('background'));
    }
  });

  it('background: ждущая в wait_for сессия с фоновой командой тоже не спит', () => {
    const activity = { ...waiting('inbox'), runningBackground: ['shell'] };
    expect(autoSleepVerdict({ ...base, activity, waitStartedAt: NOW - 600 * MIN })).toEqual(blocked('background'));
  });

  it('draft: человек печатает в терминале агента — черновик не даёт уснуть', () => {
    expect(autoSleepVerdict({ ...base, hasDraft: true })).toEqual(blocked('draft'));
  });

  it('draft: черновик держит и ждущую в wait_for сессию', () => {
    const input = { ...base, activity: waiting('inbox'), waitStartedAt: NOW - 600 * MIN, hasDraft: true };
    expect(autoSleepVerdict(input)).toEqual(blocked('draft'));
  });

  it('pointer: указатель на письма в полёте', () => {
    expect(autoSleepVerdict({ ...base, pointerInFlight: true })).toEqual(blocked('pointer'));
  });

  it('unread: есть непрочитанные письма', () => {
    expect(autoSleepVerdict({ ...base, unread: 1 })).toEqual(blocked('unread'));
  });

  it('compacting: идёт сжатие контекста', () => {
    expect(autoSleepVerdict({ ...base, compacting: true })).toEqual(blocked('compacting'));
  });

  it('working: агент работает', () => {
    const activity = idleActivity({ activity: 'working', turnEndedAt: null });
    expect(autoSleepVerdict({ ...base, activity })).toEqual(blocked('working'));
  });

  it('working: активности нет — о конце хода ничего не известно', () => {
    expect(autoSleepVerdict({ ...base, activity: null })).toEqual(blocked('working'));
  });

  it('working: ход «окончен», а времени конца нет или оно нечитаемо — часов нет, спать нельзя', () => {
    for (const turnEndedAt of [null, 'не дата']) {
      const activity = idleActivity({ turnEndedAt });
      expect(autoSleepVerdict({ ...base, activity })).toEqual(blocked('working'));
    }
  });

  it('waiter-start-unknown: ждёт в wait_for, а начала ожидания хост не видел', () => {
    const verdict = autoSleepVerdict({ ...base, activity: waiting('inbox'), waitStartedAt: null });
    expect(verdict).toEqual(blocked('waiter-start-unknown'));
  });

  it('waiters-off: ждущих в wait_for не усыпляют (итог спайка)', () => {
    const input = { ...base, activity: waiting('inbox'), waitStartedAt: NOW - 61 * MIN, allowWaiters: false };
    expect(autoSleepVerdict(input)).toEqual(blocked('waiters-off'));
  });

  it('too-soon: ход окончен меньше порога назад', () => {
    const activity = idleActivity({ turnEndedAt: iso(NOW - 59 * MIN) });
    expect(autoSleepVerdict({ ...base, activity })).toEqual(blocked('too-soon'));
  });

  it('too-soon: ждёт в wait_for меньше порога', () => {
    const input = { ...base, activity: waiting('s-07'), waitStartedAt: NOW - 59 * MIN };
    expect(autoSleepVerdict(input)).toEqual(blocked('too-soon'));
  });
});

describe('autoSleepVerdict: порядок проверок', () => {
  it('первая сработавшая причина — ответ: общие причины идут по списку, «working» после них', () => {
    // Все причины сразу; чиним по одной в порядке списка — на каждом шаге ответом остаётся следующая.
    let input: AutoSleepInput = {
      ...base,
      enabled: false,
      claudeCode: false,
      session: { id: 's-01', lifecycle: 'sleeping', keepAwake: true, autoSleepPending: MARK },
      hooked: false,
      activity: idleActivity({ activity: 'working', need: needOf('limit'), runningBackground: ['shell'], turnEndedAt: null }),
      hasDraft: true,
      pointerInFlight: true,
      unread: 2,
      compacting: true,
    };
    const steps: Array<[AutoSleepBlock, Partial<AutoSleepInput>]> = [
      ['off', { enabled: true }],
      ['not-claude', { claudeCode: true }],
      ['not-active', { session: { id: 's-01', lifecycle: 'active', keepAwake: true, autoSleepPending: MARK } }],
      ['keep-awake', { session: { id: 's-01', lifecycle: 'active', autoSleepPending: MARK } }],
      ['pending', { session: { id: 's-01', lifecycle: 'active' } }],
      ['no-hooks', { hooked: true }],
      ['need', { activity: idleActivity({ activity: 'working', runningBackground: ['shell'], turnEndedAt: null }) }],
      ['background', { activity: idleActivity({ activity: 'working', turnEndedAt: null }) }],
      ['draft', { hasDraft: false }],
      ['pointer', { pointerInFlight: false }],
      ['unread', { unread: 0 }],
      ['compacting', { compacting: false }],
      ['working', { activity: idleActivity() }],
    ];
    for (const [block, fix] of steps) {
      expect(autoSleepVerdict(input)).toEqual(blocked(block));
      input = { ...input, ...fix };
    }
    expect(autoSleepVerdict(input)).toEqual({ sleep: true, idleSince: NOW - 61 * MIN, waitTarget: null });
  });

  it('«working» раньше причин ожидания, а общие причины — раньше «too-soon»', () => {
    const working = idleActivity({ activity: 'working', turnEndedAt: null });
    expect(autoSleepVerdict({ ...base, activity: working, waitStartedAt: null, allowWaiters: false })).toEqual(blocked('working'));
    const fresh = idleActivity({ turnEndedAt: iso(NOW - MIN) });
    expect(autoSleepVerdict({ ...base, activity: fresh, unread: 1 })).toEqual(blocked('unread'));
  });

  it('ожидание: начало неизвестно → ожидание выключено → рано → спит', () => {
    const input = { ...base, activity: waiting('inbox'), waitStartedAt: null, allowWaiters: false };
    expect(autoSleepVerdict(input)).toEqual(blocked('waiter-start-unknown'));
    const started = { ...input, waitStartedAt: NOW - MIN };
    expect(autoSleepVerdict(started)).toEqual(blocked('waiters-off'));
    expect(autoSleepVerdict({ ...started, allowWaiters: true })).toEqual(blocked('too-soon'));
    expect(autoSleepVerdict({ ...started, allowWaiters: true, waitStartedAt: NOW - 61 * MIN })).toMatchObject({ sleep: true });
  });
});

describe('deliveredSince: письмо выдано сессии после метки', () => {
  const SINCE = iso(NOW - 10 * MIN);

  const emptyMap = (): WindowWorkMap => ({
    schemaVersion: 2,
    work: { id: 'w-0001', title: 'сон', goal: '', status: 'active', createdAt: iso(NOW), updatedAt: iso(NOW) },
    sessions: [],
    messages: [],
    rooms: [],
  });

  /** Письмо в карте с отметками прочтения `readBy`; `to` пуст у рассылки комнаты. */
  const mailOf = (patch: { from?: string; to?: string[]; roomId?: string | null; readBy?: Record<string, string> }) => {
    const { letters } = mapLetterTx(emptyMap());
    letters.add({
      roomId: patch.roomId ?? null,
      from: patch.from ?? 's-02',
      to: patch.to ?? ['s-01'],
      text: 'привет',
      kind: 'note',
      readBy: patch.readBy ?? {},
      at: iso(NOW - 30 * MIN),
    });
    return letters;
  };

  it('true, когда отметка прочтения сессии позже since', () => {
    const letters = mailOf({ readBy: { 's-01': iso(NOW - 5 * MIN) } });
    expect(deliveredSince(letters, 's-01', SINCE)).toBe(true);
  });

  it('false, когда отметка раньше since', () => {
    const letters = mailOf({ readBy: { 's-01': iso(NOW - 20 * MIN) } });
    expect(deliveredSince(letters, 's-01', SINCE)).toBe(false);
  });

  it('false, когда отметки нет: письмо ещё не выдано', () => {
    expect(deliveredSince(mailOf({}), 's-01', SINCE)).toBe(false);
  });

  it('false, когда отметка ровно в since: «позже» строгое', () => {
    expect(deliveredSince(mailOf({ readBy: { 's-01': SINCE } }), 's-01', SINCE)).toBe(false);
  });

  it('отметка другого читателя не в счёт', () => {
    const letters = mailOf({ to: ['s-01', 's-03'], readBy: { 's-03': iso(NOW - 5 * MIN) } });
    expect(deliveredSince(letters, 's-01', SINCE)).toBe(false);
  });

  it('письмо от самой сессии, выданное адресату, её не касается', () => {
    const letters = mailOf({ from: 's-01', to: ['s-02'], readBy: { 's-02': iso(NOW - 5 * MIN) } });
    expect(deliveredSince(letters, 's-01', SINCE)).toBe(false);
  });

  it('рассылка комнаты (to пуст) тоже: она выдана сессии, а модель её ещё не видела', () => {
    const letters = mailOf({ roomId: 'r-01', to: [], readBy: { 's-01': iso(NOW - 5 * MIN) } });
    expect(deliveredSince(letters, 's-01', SINCE)).toBe(true);
  });

  it('рассылка комнаты, выданная до since, не считается', () => {
    const letters = mailOf({ roomId: 'r-01', to: [], readBy: { 's-01': iso(NOW - 20 * MIN) } });
    expect(deliveredSince(letters, 's-01', SINCE)).toBe(false);
  });
});

describe('deliveredSince: письма в настоящем хранилище', () => {
  const WORK = 'w-0001';
  let home = '';
  let project = '';

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
    project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
    process.env.PARLEY_HOME = home;
  });

  afterEach(async () => {
    closeWorkDb();
    delete process.env.PARLEY_HOME;
    await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('прямое письмо и рассылка комнаты находятся по отметке прочтения, а не по адресу', async () => {
    await createWork(project, { title: 'сон' });
    await updateMap(project, WORK, (map, letters) => {
      addRoom(map, { title: 'комната', creator: 's-01', members: ['s-02'] }, iso(NOW - 60 * MIN));
      // Прямое письмо выдано давно, рассылка комнаты — пять минут назад.
      const note = { kind: 'note', at: iso(NOW - 30 * MIN) } as const;
      letters.add({ ...note, roomId: null, from: 's-02', to: ['s-01'], text: 'прямое', readBy: { 's-01': iso(NOW - 20 * MIN) } });
      letters.add({ ...note, roomId: 'r-01', from: 's-02', to: [], text: 'всем', readBy: { 's-01': iso(NOW - 5 * MIN) } });
    });

    const [afterBoth, afterBroadcast, afterAll] = writeLetters(project, WORK, (letters) => [
      deliveredSince(letters, 's-01', iso(NOW - 25 * MIN)),
      deliveredSince(letters, 's-01', iso(NOW - 10 * MIN)),
      deliveredSince(letters, 's-01', iso(NOW - MIN)),
    ]);
    expect([afterBoth, afterBroadcast, afterAll]).toEqual([true, true, false]);
  });
});
