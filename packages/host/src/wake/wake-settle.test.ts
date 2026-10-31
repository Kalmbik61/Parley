/**
 * Таймер тишины будильника (план «меньше ходов», C1.2, задача 7): заметка всем без упоминания не будит простаивающего
 * или спящего агента сразу — указатель печатается, когда комната притихла на `SETTLE_MS`, но не позже `SETTLE_MAX_MS` от
 * самого старого письма. Решает `deliveryAction`; здесь — что будильник сам возвращается к сессии по сроку: часы и
 * терминалы фальшивые (`setTimeout`, `clearTimeout`, `Date`), письма — настоящие, в базе работы.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
  addRoom,
  addSession,
  createWork,
  HUMAN,
  readStoredMap,
  sessionMention,
  SETTLE_MAX_MS,
  SETTLE_MS,
  transitionSession,
  updateMap,
  writeLetters,
} from '@parley/core';
import type { MessageKind, SessionActivity } from '@parley/core';
import type { MailWait, SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { SessionsService } from '../sessions/sessions-service.js';
import type { MailNotice, WorksService } from '../works/works-service.js';
import { ResumeLimiter } from './resume-limiter.js';
import { createWakeService } from './wake-service.js';
import type { WakeService, WakeServiceOptions } from './wake-service.js';

const T0 = Date.parse('2026-10-27T10:00:00.000Z');
const ENTER_MS = 30;
/** Запас таймера окна тишины сверх срока (`SETTLE_SLACK_MS` будильника) с поправкой на паузу Enter. */
const PAST = 200;
const SECOND = 1000;
const TITLE = 'Ревью';

const pointerOf = (count: number): string => `New messages (${count}) in r-01 "${TITLE}". Call check_inbox.`;
const isPointer = (chunk: string): boolean => chunk.startsWith('New messages');

let root = '';
let project = '';
let previousHome: string | undefined;
let wakes: WakeService[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-wake-settle-'));
  project = path.join(root, 'project');
  await mkdir(project);
  await mkdir(path.join(root, 'home'));
  previousHome = process.env['PARLEY_HOME'];
  process.env['PARLEY_HOME'] = path.join(root, 'home');
});

afterEach(async () => {
  for (const wake of wakes) wake.stop();
  wakes = [];
  vi.useRealTimers();
  if (previousHome === undefined) delete process.env['PARLEY_HOME'];
  else process.env['PARLEY_HOME'] = previousHome;
  await rm(root, { recursive: true, force: true });
});

interface SettleRig {
  wake: WakeService;
  /** Сессии комнаты `r-01` — все участники; первая — создатель. */
  ids: string[];
  /** Всё, что хост напечатал в терминал сессии `ids[n]`. */
  written: (n: number) => string[];
  /** Из них — указатели. */
  pointers: (n: number) => string[];
  /** Причины ожидания, которые будильник отдал окну для `ids[n]`, по порядку. */
  waiting: (n: number) => Array<MailWait | null>;
  launch: Mock<SessionsService['launch']>;
  limiter: ResumeLimiter;
  /** Письмо в комнату (в базу работы) и событие активности у каждой сессии — пересчёт будильника, как после записи карты. */
  send: (from: string, init?: { kind?: MessageKind; to?: string[]; text?: string; at?: string }) => void;
  /** Письмо только через `onMail`, как запись одних писем после rooms.mail: ни события активности, ни `works.changed`. */
  mail: (from: string, init?: { kind?: MessageKind; to?: string[]; text?: string; at?: string }) => void;
  /** Выход процесса сессии `ids[n]`. */
  exit: (n: number) => void;
  /** Все сессии начинают ход (`working`) или кончают его (простой): событие активности — пересчёт будильника. */
  busy: (on: boolean) => void;
  /** Запуск будильника, если rig заводили с `start: false`. */
  start: () => void;
  advance: (ms: number) => Promise<void>;
  /** Дать завершиться настоящему вводу-выводу (подъём спящей читает реестр и журнал с диска): до условия или короткий срок. */
  flush: (until?: () => boolean) => Promise<void>;
}

const activityOf = (state: SessionActivity['activity'] = 'idle'): SessionActivity => ({
  activity: state,
  subagents: 0,
  tasks: [],
  waitingFor: null,
  heldByBackground: false,
  turnEndedAt: null,
  turnBoundaryAt: null,
  lastEventAt: new Date(T0).toISOString(),
  source: 'hooks',
  hooksMissing: false,
  need: null,
});

/**
 * Комната из `count` сессий в новой работе. `sleeping` — все спят и процессов нет (подъём — мок `launch`), иначе у каждой
 * живой процесс и простой с хуками. Файлы работы готовятся на настоящих часах, дальше отсчёт фальшивый.
 */
async function settleRig(
  count: number,
  options: { sleeping?: boolean; start?: boolean; wake?: WakeServiceOptions } = {},
): Promise<SettleRig> {
  const sleeping = options.sleeping === true;
  const created = await createWork(project, { title: 'Работа' });
  const workId = created.work.id;
  const ids: string[] = [];
  await updateMap(project, workId, (current) => {
    for (let n = 0; n < count; n += 1) {
      const session = addSession(current, { provider: 'claude', label: `агент ${n + 1}`, task: 'сделать' });
      session.launchedBy = 'host';
      if (sleeping) session.providerSessionId = randomUUID();
      transitionSession(current, session.id, 'active');
      if (sleeping) transitionSession(current, session.id, 'sleeping');
      ids.push(session.id);
    }
    addRoom(current, { title: TITLE, creator: ids[0]!, members: ids });
  });
  await mkdir(path.join(project, '.parley', 'works', workId, 'events'), { recursive: true });
  const entry = { projectPath: project, map: readStoredMap(project, workId) };

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);

  const refOf = (sessionId: string): SessionRef => ({ projectPath: project, workId, sessionId });
  const live = { activity: activityOf(), metrics: null };
  const alive = new Set(sleeping ? [] : ids);
  const writes = new Map<string, string[]>(ids.map((id) => [id, []]));
  const waits = new Map<string, Array<MailWait | null>>(ids.map((id) => [id, []]));
  const activityListeners = new Set<(ref: SessionRef, value: typeof live) => void>();
  const ptyListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const mailListeners = new Set<(notice: MailNotice) => void>();

  const pty = {
    get: (ref: SessionRef) =>
      alive.has(ref.sessionId)
        ? { ref, pid: 4000, startedAt: 0, cols: 80, rows: 24, provider: 'claude', hasDraft: () => false, bracketedPaste: () => true }
        : undefined,
    write: (ref: SessionRef, data: string) => writes.get(ref.sessionId)?.push(data),
    screenText: () => ['❯ '],
    setHostDraft: () => {},
    on: (event: string, listener: (...args: unknown[]) => void) => {
      let set = ptyListeners.get(event);
      if (set === undefined) ptyListeners.set(event, (set = new Set()));
      const listeners = set;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as PtyManager;
  const works = {
    entry: () => entry,
    snapshot: () => ({ entries: [entry] }),
    onChange: () => () => {},
    onMail: (listener: (notice: MailNotice) => void) => {
      mailListeners.add(listener);
      return () => mailListeners.delete(listener);
    },
  } as unknown as WorksService;
  const activity = {
    get: () => live,
    onChange: (listener: (ref: SessionRef, value: typeof live) => void) => {
      activityListeners.add(listener);
      return () => activityListeners.delete(listener);
    },
    mailWaiting: (ref: SessionRef, reason: MailWait | null) => waits.get(ref.sessionId)?.push(reason),
  } as unknown as ActivityService;
  const host = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, broadcast: vi.fn() } as unknown as HostContext;
  const launch = vi.fn<SessionsService['launch']>(async () => 'started');
  const limiter = new ResumeLimiter(() => 6);

  const wake = createWakeService(host, works, activity, pty, { launch }, { enterDelayMs: ENTER_MS, limiter, ...options.wake });
  wakes.push(wake);
  if (options.start !== false) wake.start();

  const index = (n: number): string => ids[n]!;
  return {
    wake,
    ids,
    written: (n) => writes.get(index(n)) ?? [],
    pointers: (n) => (writes.get(index(n)) ?? []).filter(isPointer),
    waiting: (n) => waits.get(index(n)) ?? [],
    launch,
    limiter,
    send: (from, init = {}) => {
      writeLetters(project, workId, (letters) =>
        letters.add({
          roomId: 'r-01',
          kind: init.kind ?? 'note',
          from,
          to: init.to ?? [],
          text: init.text ?? 'заметка',
          ...(init.at === undefined ? {} : { at: init.at }),
        }),
      );
      for (const id of ids) for (const listener of [...activityListeners]) listener(refOf(id), live);
    },
    mail: (from, init = {}) => {
      const message = writeLetters(project, workId, (letters) =>
        letters.add({
          roomId: 'r-01',
          kind: init.kind ?? 'note',
          from,
          to: init.to ?? [],
          text: init.text ?? 'заметка',
          ...(init.at === undefined ? {} : { at: init.at }),
        }),
      );
      const notice: MailNotice = {
        projectPath: project,
        workId,
        version: 0,
        prevVersion: 0,
        journal: { added: [message], reads: [], deleted: [], droppedRooms: [], rereadRooms: [] },
        foreign: false,
      };
      for (const listener of [...mailListeners]) listener(notice);
    },
    busy: (on) => {
      live.activity = activityOf(on ? 'working' : 'idle');
      for (const id of ids) for (const listener of [...activityListeners]) listener(refOf(id), live);
    },
    exit: (n) => {
      alive.delete(index(n));
      for (const listener of ptyListeners.get('exit') ?? []) listener(refOf(index(n)), { exitCode: 0 });
    },
    start: () => wake.start(),
    advance: async (ms) => {
      await vi.advanceTimersByTimeAsync(ms);
    },
    flush: async (until) => {
      const started = performance.now();
      do {
        await new Promise<void>((resolve) => setImmediate(resolve));
      } while (until === undefined ? performance.now() - started < 50 : !until() && performance.now() - started < 5000);
    },
  };
}

describe('WakeService: окно тишины несрочных писем', () => {
  it('одна заметка всем: каждый получатель — один указатель после окна, не раньше; отправителю — ничего', async () => {
    const rig = await settleRig(3);
    rig.send(rig.ids[0]!);

    await rig.advance(SETTLE_MS - SECOND);
    expect(rig.written(1)).toEqual([]);
    expect(rig.written(2)).toEqual([]);

    await rig.advance(SECOND + PAST);
    expect(rig.written(1)).toEqual([pointerOf(1), '\r']);
    expect(rig.written(2)).toEqual([pointerOf(1), '\r']);
    expect(rig.written(0)).toEqual([]);
  });

  it('три заметки в окне: один указатель на три, а не три указателя', async () => {
    const rig = await settleRig(3);
    rig.send(rig.ids[0]!);
    await rig.advance(5 * SECOND);
    rig.send(rig.ids[0]!);
    await rig.advance(5 * SECOND);
    rig.send(rig.ids[0]!);

    // Срок — от самой новой заметки (10 с), а не от первой.
    await rig.advance(SETTLE_MS - SECOND);
    expect(rig.pointers(1)).toEqual([]);

    await rig.advance(SECOND + PAST);
    expect(rig.pointers(1)).toEqual([pointerOf(3)]);
    expect(rig.pointers(2)).toEqual([pointerOf(3)]);

    // Старый срок первой заметки тоже прошёл — второго указателя нет.
    await rig.advance(SETTLE_MAX_MS);
    expect(rig.pointers(1)).toHaveLength(1);
    expect(rig.pointers(2)).toHaveLength(1);
  });

  type Letter = { from: string; init: { kind?: MessageKind; to?: string[]; text?: string } };
  const urgent: Array<[string, (ids: string[]) => Letter, number[]]> = [
    ['вопрос (question)', (ids) => ({ from: ids[0]!, init: { kind: 'question' } }), [1, 2]],
    ['решение (decision)', (ids) => ({ from: ids[0]!, init: { kind: 'decision' } }), [1, 2]],
    ['адресное письмо', (ids) => ({ from: ids[0]!, init: { to: [ids[1]!] } }), [1]],
    ['письмо человека всем', () => ({ from: HUMAN, init: {} }), [0, 1, 2]],
    ['заметка с упоминанием получателя', (ids) => ({ from: ids[0]!, init: { text: `посмотри, ${sessionMention(ids[2]!)}` } }), [2]],
  ];

  describe.each(urgent)('%s', (_name, letter, recipients) => {
    it('будит сразу, без окна тишины', async () => {
      const rig = await settleRig(3);
      const { from, init } = letter(rig.ids);
      rig.send(from, init);

      await rig.advance(ENTER_MS + 5);
      for (const n of [0, 1, 2]) {
        expect(rig.pointers(n)).toHaveLength(recipients.includes(n) ? 1 : 0);
      }
    });
  });

  it('срочное письмо в окне берёт раннюю заметку в тот же указатель; второго указателя по сроку нет', async () => {
    const rig = await settleRig(3);
    rig.send(rig.ids[0]!);
    await rig.advance(10 * SECOND);
    expect(rig.pointers(1)).toEqual([]);

    rig.send(rig.ids[0]!, { kind: 'question' });
    await rig.advance(ENTER_MS + 5);
    expect(rig.pointers(1)).toEqual([pointerOf(2)]);
    expect(rig.pointers(2)).toEqual([pointerOf(2)]);

    await rig.advance(SETTLE_MAX_MS);
    expect(rig.pointers(1)).toHaveLength(1);
    expect(rig.pointers(2)).toHaveLength(1);
  });

  it('новая заметка в окне сдвигает срок; таймер на сессию один', async () => {
    const rig = await settleRig(3);
    rig.send(rig.ids[0]!);
    // Два получателя — два таймера.
    expect(vi.getTimerCount()).toBe(2);

    await rig.advance(20 * SECOND);
    rig.send(rig.ids[0]!);
    expect(vi.getTimerCount()).toBe(2);

    // Прежний срок (30 с) прошёл, новый — 50 с.
    await rig.advance(10 * SECOND + PAST);
    expect(rig.pointers(1)).toEqual([]);

    await rig.advance(20 * SECOND);
    expect(rig.pointers(1)).toEqual([pointerOf(2)]);
  });

  it('болтовня раз в 20 с: указатель не позже потолка от первой заметки', async () => {
    const rig = await settleRig(3);
    let at = 0;
    for (const next of [0, 20, 40, 60, 80, 100, 110]) {
      await rig.advance((next - at) * SECOND);
      at = next;
      rig.send(rig.ids[0]!);
    }
    expect(rig.pointers(1)).toEqual([]);

    await rig.advance(SETTLE_MAX_MS - at * SECOND - SECOND);
    expect(rig.pointers(1)).toEqual([]);

    await rig.advance(SECOND + PAST);
    expect(rig.pointers(1)).toEqual([pointerOf(7)]);
    expect(rig.pointers(2)).toEqual([pointerOf(7)]);
  });

  it('мок-комната: три агента, пять заметок — три указателя, а не пятнадцать', async () => {
    const rig = await settleRig(3);
    const [a, b, c] = rig.ids as [string, string, string];
    for (const from of [a, b, c, a, b]) {
      rig.send(from);
      await rig.advance(2 * SECOND);
    }

    await rig.advance(SETTLE_MS + PAST);
    // Каждому — одним указателем на заметки остальных: a получает 3 (b, c, b), b — 3 (a, c, a), c — 4 (a, b, a, b).
    expect(rig.pointers(0)).toEqual([pointerOf(3)]);
    expect(rig.pointers(1)).toEqual([pointerOf(3)]);
    expect(rig.pointers(2)).toEqual([pointerOf(4)]);
  });

  it('в окне письма ждут с причиной settling; после окна — in-flight', async () => {
    const rig = await settleRig(3);
    rig.send(rig.ids[0]!);

    expect(rig.waiting(1)).toEqual(['settling']);
    expect(rig.waiting(2)).toEqual(['settling']);
    // Отправителю писать нечего.
    expect(rig.waiting(0)).toEqual([]);

    await rig.advance(SETTLE_MS + PAST);
    expect(rig.waiting(1)).toEqual(['settling', 'in-flight']);
  });

  it('settleMs из настроек будильника заменяет умолчание', async () => {
    const rig = await settleRig(3, { wake: { settleMs: 2 * SECOND } });
    rig.send(rig.ids[0]!);
    await rig.advance(SECOND);
    expect(rig.pointers(1)).toEqual([]);
    await rig.advance(SECOND + PAST);
    expect(rig.pointers(1)).toEqual([pointerOf(1)]);
  });

  it('settleMaxMs из настроек будильника заменяет умолчание: потолок раньше тишины', async () => {
    const rig = await settleRig(2, { wake: { settleMs: 2 * SECOND, settleMaxMs: 3 * SECOND } });
    rig.send(rig.ids[0]!);
    await rig.advance(SECOND);
    rig.send(rig.ids[0]!);
    await rig.advance(SECOND);
    rig.send(rig.ids[0]!);
    // Тишина кончилась бы на 4-й секунде, но потолок 3 с от первой заметки наступает раньше.
    await rig.advance(0.9 * SECOND);
    expect(rig.pointers(1)).toEqual([]);
    await rig.advance(0.3 * SECOND);
    expect(rig.pointers(1)).toEqual([pointerOf(3)]);
  });
});

describe('WakeService: окно тишины, запись одних писем (onMail)', () => {
  it('запись одних писем (`onMail`, без `works.changed`): заметка всем держится окно тишины и будит живого по сроку', async () => {
    const rig = await settleRig(3);
    rig.mail(rig.ids[0]!);

    // Пересчёт по `onMail` идёт в микрозадаче: таймеры фальшивые, а `queueMicrotask` — нет.
    await rig.advance(0);
    expect(rig.waiting(1)).toContain('settling');

    await rig.advance(SETTLE_MS - SECOND);
    expect(rig.written(1)).toEqual([]);
    expect(rig.written(2)).toEqual([]);

    await rig.advance(SECOND + PAST);
    expect(rig.written(1)).toEqual([pointerOf(1), '\r']);
    expect(rig.written(2)).toEqual([pointerOf(1), '\r']);
    expect(rig.written(0)).toEqual([]);
  });

  it('запись одних писем: спящую поднимает по сроку окна, не раньше', async () => {
    const rig = await settleRig(2, { sleeping: true });
    rig.mail(rig.ids[0]!);

    await rig.advance(SETTLE_MS - SECOND);
    await rig.flush();
    expect(rig.launch).not.toHaveBeenCalled();

    await rig.advance(SECOND + PAST);
    await rig.flush(() => rig.launch.mock.calls.length > 0);
    expect(rig.launch).toHaveBeenCalledTimes(1);
    expect(rig.launch.mock.calls[0]?.[2]).toEqual({ by: 'wake', prompt: pointerOf(1), launchClass: 'mail' });
  });

  it('запись одних писем: адресное письмо будит сразу', async () => {
    const rig = await settleRig(2);
    rig.mail(rig.ids[0]!, { to: [rig.ids[1]!] });

    await rig.advance(ENTER_MS + 5);
    expect(rig.pointers(1)).toEqual([pointerOf(1)]);
  });
});

describe('WakeService: окно тишины и жизнь таймера', () => {
  it('stop() снимает таймеры: после окна ничего не печатается', async () => {
    const rig = await settleRig(3);
    rig.send(rig.ids[0]!);
    expect(vi.getTimerCount()).toBe(2);

    rig.wake.stop();
    expect(vi.getTimerCount()).toBe(0);

    await rig.advance(SETTLE_MAX_MS);
    expect(rig.written(1)).toEqual([]);
    expect(rig.written(2)).toEqual([]);
  });

  it('выход процесса снимает таймер его сессии, у остальных таймер цел', async () => {
    const rig = await settleRig(3);
    rig.send(rig.ids[0]!);
    expect(vi.getTimerCount()).toBe(2);

    rig.exit(1);
    expect(vi.getTimerCount()).toBe(1);

    await rig.advance(SETTLE_MS + PAST);
    expect(rig.written(1)).toEqual([]);
    expect(rig.pointers(2)).toEqual([pointerOf(1)]);
  });

  // Оба «перезапуска хоста» ниже моделируют процессы агентов, переживающие перезапуск: PTY живы, ставится только
  // новый WakeService. В настоящем перезапуске сессии встают спящими, а `ensureKnown` помечает ждущие заметки как
  // уже указанные — принятый предел (см. план); эти тесты его не проверяют.
  it('перезапуск хоста: заметка старше окна — указатель на первом пересчёте, без письма и без таймера', async () => {
    const rig = await settleRig(3, { start: false });
    rig.send(rig.ids[0]!, { at: new Date(T0 - 2 * SETTLE_MS).toISOString() });
    expect(rig.written(1)).toEqual([]);

    rig.start();
    // Окна уже нет: указатель печатается на самом пересчёте при старте, до каких-либо таймеров.
    expect(rig.written(1)).toEqual([pointerOf(1)]);
    expect(rig.written(2)).toEqual([pointerOf(1)]);
    await rig.advance(ENTER_MS + 5);
    expect(rig.written(1)).toEqual([pointerOf(1), '\r']);
  });

  // Тот же приём: процессы агентов живы, перезапускается только WakeService (см. выше).
  it('перезапуск хоста посреди окна: срок считается по метке письма, указатель — через остаток', async () => {
    const rig = await settleRig(3, { start: false });
    rig.send(rig.ids[0]!, { at: new Date(T0 - 10 * SECOND).toISOString() });

    rig.start();
    await rig.advance(20 * SECOND - SECOND);
    expect(rig.pointers(1)).toEqual([]);
    await rig.advance(SECOND + PAST);
    expect(rig.pointers(1)).toEqual([pointerOf(1)]);
    expect(rig.pointers(2)).toEqual([pointerOf(1)]);
  });
});

describe('WakeService: окно тишины, занятая и приостановленная сессия', () => {
  it('заметки пришли, пока получатель работает: срок прошёл — не печатается; простой — один указатель на пачку', async () => {
    const rig = await settleRig(3);
    rig.busy(true);
    rig.send(rig.ids[0]!);
    await rig.advance(5 * SECOND);
    rig.send(rig.ids[0]!);

    await rig.advance(SETTLE_MS + PAST);
    expect(rig.written(1)).toEqual([]);
    expect(rig.written(2)).toEqual([]);

    rig.busy(false);
    expect(rig.pointers(1)).toEqual([pointerOf(2)]);
    expect(rig.pointers(2)).toEqual([pointerOf(2)]);

    // Больше ничего не печатается: письма указаны.
    await rig.advance(SETTLE_MAX_MS);
    expect(rig.pointers(1)).toHaveLength(1);
    expect(rig.pointers(2)).toHaveLength(1);
  });

  it('получатель начал ход в окне: таймер сработал при работе — не печатается; простой — один указатель на пачку', async () => {
    const rig = await settleRig(3);
    rig.send(rig.ids[0]!);
    await rig.advance(5 * SECOND);
    rig.send(rig.ids[0]!);
    expect(rig.waiting(1)).toEqual(['settling']);

    rig.busy(true);
    // Срок второй заметки (35 с) проходит посреди хода.
    await rig.advance(SETTLE_MS + PAST);
    expect(rig.written(1)).toEqual([]);
    expect(rig.written(2)).toEqual([]);
    expect(rig.waiting(1)).toEqual(['settling', 'busy']);

    rig.busy(false);
    expect(rig.pointers(1)).toEqual([pointerOf(2)]);
    expect(rig.pointers(2)).toEqual([pointerOf(2)]);
    expect(rig.waiting(1)).toEqual(['settling', 'busy', 'in-flight']);

    await rig.advance(SETTLE_MAX_MS);
    expect(rig.pointers(1)).toHaveLength(1);
    expect(rig.pointers(2)).toHaveLength(1);
  });

  it('пауза будильника через окно: указателя нет; resume() — один указатель', async () => {
    const rig = await settleRig(3);
    rig.send(rig.ids[0]!);
    rig.wake.pause();

    await rig.advance(SETTLE_MS + PAST);
    expect(rig.written(1)).toEqual([]);
    expect(rig.written(2)).toEqual([]);
    expect(rig.waiting(1)).toEqual(['settling', 'paused']);

    rig.wake.resume();
    expect(rig.pointers(1)).toEqual([pointerOf(1)]);
    expect(rig.pointers(2)).toEqual([pointerOf(1)]);

    await rig.advance(SETTLE_MAX_MS);
    expect(rig.pointers(1)).toHaveLength(1);
    expect(rig.pointers(2)).toHaveLength(1);
  });
});

describe('WakeService: окно тишины у спящей сессии', () => {
  it('заметка: до окна ни подъёма, ни жетона лимита; после окна — подъём с указателем', async () => {
    const rig = await settleRig(2, { sleeping: true });
    const take = vi.spyOn(rig.limiter, 'tryTake');
    rig.send(rig.ids[0]!);

    await rig.advance(SETTLE_MS - SECOND);
    await rig.flush();
    expect(rig.launch).not.toHaveBeenCalled();
    expect(take).not.toHaveBeenCalled();
    expect(rig.waiting(1)).toEqual(['settling']);

    await rig.advance(SECOND + PAST);
    await rig.flush(() => rig.launch.mock.calls.length > 0);
    expect(take).toHaveBeenCalledTimes(1);
    expect(rig.launch).toHaveBeenCalledTimes(1);
    expect(rig.launch.mock.calls[0]?.[2]).toEqual({ by: 'wake', prompt: pointerOf(1), launchClass: 'mail' });
  });

  it('срочное письмо поднимает спящую сразу и берёт раннюю заметку с собой', async () => {
    const rig = await settleRig(2, { sleeping: true });
    rig.send(rig.ids[0]!);
    await rig.advance(5 * SECOND);
    expect(rig.launch).not.toHaveBeenCalled();

    rig.send(rig.ids[0]!, { kind: 'question' });
    await rig.flush(() => rig.launch.mock.calls.length > 0);
    expect(rig.launch).toHaveBeenCalledTimes(1);
    expect(rig.launch.mock.calls[0]?.[2]).toEqual({ by: 'wake', prompt: pointerOf(2), launchClass: 'mail' });
  });

  it('settleMs из настроек будильника доходит и до ветки без процесса', async () => {
    const rig = await settleRig(2, { sleeping: true, wake: { settleMs: 2 * SECOND } });
    rig.send(rig.ids[0]!);

    await rig.advance(SECOND);
    await rig.flush();
    expect(rig.launch).not.toHaveBeenCalled();

    await rig.advance(SECOND + PAST);
    await rig.flush(() => rig.launch.mock.calls.length > 0);
    expect(rig.launch).toHaveBeenCalledTimes(1);
  });
});
