import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../config.js';
import { addSession } from '../work/map.js';
import { addRoom } from '../work/rooms.js';
import { asleepHint } from '../work/session-state.js';
import { createWork, readStoredMap, updateMap, workPaths } from '../work/store.js';
import { unreadLetters, writeLetters, type NewLetter } from '../work/letter-store.js';
import { HUMAN, type QueuedLaunch, type WorkSession } from '../work/types.js';
import type { McpContext } from './context.js';
import { createToolRunner, finishedState, type ToolRunner } from './tools.js';

/**
 * Порядок внутри `wait_for("inbox")`: письма забираются и отмечаются прочитанными ПОСЛЕ записи `ParleyWaitEnd` в журнал, а не
 * внутри ожидания. Пока шла эта запись, клиент мог отменить вызов — хост выбрасывает ответ отменённого вызова, и письма,
 * помеченные раньше, пропали бы вместе с ним. Журнал пишет `appendFile`: тест вклинивается перед строкой в журнал — в то самое
 * окно, где вызов уже нашёл письмо, но ещё не закончился. Остальные вызовы `appendFile` проходят насквозь.
 */
const journal = vi.hoisted(() => ({ beforeLine: null as ((line: string) => Promise<void> | void) | null }));
/** Вызовы `unreadLetters` считает тест «без вращения»: цикл ожидания не должен читать ящик в горячем цикле. */
vi.mock('../work/letter-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../work/letter-store.js')>();
  return { ...actual, unreadLetters: vi.fn(actual.unreadLetters) };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    appendFile: (async (...args: Parameters<typeof actual.appendFile>) => {
      const [, data] = args;
      if (journal.beforeLine !== null && typeof data === 'string' && data.includes('ParleyWait')) await journal.beforeLine(data);
      return actual.appendFile(...args);
    }) as typeof actual.appendFile,
  };
});

let home = '';
let project = '';
let workId = '';
let runner: ToolRunner;

const textOf = (result: Awaited<ReturnType<ToolRunner['call']>>): string => (result.content[0] as { text: string }).text;
const body = (result: Awaited<ReturnType<ToolRunner['call']>>): Record<string, unknown> => JSON.parse(textOf(result)) as Record<string, unknown>;
const textsOf = (answer: Record<string, unknown>): string[] => ((answer['messages'] ?? []) as { text: string }[]).map((item) => item.text);
const journalFile = (): string => path.join(workPaths(project, workId).events, 's-01.jsonl');
const journalLines = async (): Promise<Record<string, unknown>[]> =>
  (await readFile(journalFile(), 'utf8').catch(() => ''))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const addLetter = (text: string): Promise<void> =>
  updateMap(project, workId, (_map, letters) => { letters.add({ roomId: null, kind: 'note', from: 's-02', to: ['s-01'], text }); });
/** Письма `s-01`, ещё не отмеченные им прочитанными. */
const unreadTexts = (): string[] => readStoredMap(project, workId).messages.filter((message) => message.readBy['s-01'] === undefined).map((message) => message.text);
/** Параллельный `check_inbox`: забирает всё непрочитанное в одной записи. */
const stealInbox = (): string[] =>
  writeLetters(project, workId, (letters) => {
    const inbox = letters.unreadFor('s-01');
    letters.markRead('s-01', inbox.map((message) => message.id), new Date().toISOString());
    return inbox.map((message) => message.text);
  });

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
  workId = (await createWork(project, { title: 'Работа', goal: '' })).work.id;
  await updateMap(project, workId, (map) => {
    addSession(map, { provider: 'claude', label: 'план', task: 'составить план' });
    addSession(map, { provider: 'claude', label: 'бэк', task: 'делать' });
  });
  await mkdir(workPaths(project, workId).events, { recursive: true });
  runner = createToolRunner({ projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false, messageRate: DEFAULT_CONFIG.messageRate, pollMs: 40 });
});

afterEach(async () => {
  journal.beforeLine = null;
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('wait_for("inbox"): письма забираются после записи конца в журнал', () => {
  it('в момент записи ParleyWaitEnd письмо ещё не отмечено; после ответа — отмечено', async () => {
    const seen: { atEnd: string[] | null } = { atEnd: null };
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => { started = resolve; });
    journal.beforeLine = (line) => {
      if (line.includes('ParleyWaitStart')) started();
      if (line.includes('ParleyWaitEnd')) seen.atEnd = unreadTexts();
    };

    const waiting = runner.call('wait_for', { target: 'inbox', timeoutSec: 30 }, undefined);
    await hasStarted;
    await addLetter('письмо');
    const answer = body(await waiting);

    expect(seen.atEnd).toEqual(['письмо']);
    expect(textsOf(answer)).toEqual(['письмо']);
    expect(unreadTexts()).toEqual([]);
    const lines = await journalLines();
    expect(lines.map((line) => line['hook_event_name'])).toEqual(['ParleyWaitStart', 'ParleyWaitEnd']);
    expect(lines[1]?.['parley_wait_id']).toBe(lines[0]?.['parley_wait_id']);
  });

  it('отмена во время записи ParleyWaitEnd: письмо не отмечено, следующий check_inbox его отдаёт', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => { started = resolve; });
    journal.beforeLine = (line) => {
      if (line.includes('ParleyWaitStart')) started();
      if (line.includes('ParleyWaitEnd')) controller.abort();
    };

    const waiting = runner.call('wait_for', { target: 'inbox', timeoutSec: 30 }, undefined, controller.signal);
    await hasStarted;
    await addLetter('письмо');

    expect(body(await waiting)).toEqual({ state: 'running' });
    expect(unreadTexts()).toEqual(['письмо']);
    expect(textsOf(body(await runner.call('check_inbox', {}, undefined)))).toEqual(['письмо']);
    // Начало и конец остались парой.
    expect((await journalLines()).map((line) => line['hook_event_name'])).toEqual(['ParleyWaitStart', 'ParleyWaitEnd']);
  });

  it('письма забрал параллельный check_inbox во время записи конца: wait_for ждёт дальше новой парой Start/End и отдаёт следующее письмо', async () => {
    const stolen: { texts: string[] | null } = { texts: null };
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => { started = resolve; });
    journal.beforeLine = (line) => {
      if (line.includes('ParleyWaitStart')) started();
      if (line.includes('ParleyWaitEnd') && stolen.texts === null) stolen.texts = stealInbox();
    };

    const waiting = runner.call('wait_for', { target: 'inbox', timeoutSec: 30 }, undefined);
    await hasStarted;
    await addLetter('первое');
    await vi.waitFor(() => expect(stolen.texts).toEqual(['первое']), { timeout: 2000, interval: 10 });
    // Второе ожидание заводит свою пару: ждём его начала в журнале (три строки: Start, End, Start).
    await vi.waitFor(async () => expect(await journalLines()).toHaveLength(3), { timeout: 2000, interval: 10 });
    await addLetter('второе');
    const answer = body(await waiting);

    expect(answer['state']).toBe('message');
    expect(textsOf(answer)).toEqual(['второе']);
    const lines = await journalLines();
    expect(lines.map((line) => line['hook_event_name'])).toEqual(['ParleyWaitStart', 'ParleyWaitEnd', 'ParleyWaitStart', 'ParleyWaitEnd']);
    // Пары: id первого начала = id первого конца, второго = второго, и они разные.
    expect(lines[1]?.['parley_wait_id']).toBe(lines[0]?.['parley_wait_id']);
    expect(lines[3]?.['parley_wait_id']).toBe(lines[2]?.['parley_wait_id']);
    expect(lines[2]?.['parley_wait_id']).not.toBe(lines[0]?.['parley_wait_id']);
  });

  it('пауза после пустого забора прерывается отменой: ответ running сразу, ничего не отмечено', async () => {
    // Пауза — pollMs, здесь 60 с: если бы отмена её не прерывала, вызов провисел бы до таймаута.
    const subscribed = { listener: null as (() => void) | null };
    runner = createToolRunner({ projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false, messageRate: DEFAULT_CONFIG.messageRate, pollMs: 60_000, mapChanges: (onChange) => {
      subscribed.listener = onChange;
      return () => { subscribed.listener = null; };
    } });
    const controller = new AbortController();
    const stolen: { texts: string[] | null } = { texts: null };
    journal.beforeLine = (line) => {
      if (line.includes('ParleyWaitEnd') && stolen.texts === null) stolen.texts = stealInbox();
    };

    const waiting = runner.call('wait_for', { target: 'inbox', timeoutSec: 30 }, undefined, controller.signal);
    await vi.waitFor(() => expect(subscribed.listener).not.toBeNull(), { timeout: 2000, interval: 10 });
    await addLetter('первое');
    subscribed.listener!();
    await vi.waitFor(() => expect(stolen.texts).toEqual(['первое']), { timeout: 2000, interval: 10 });
    // Вызов не отвечает пустым message и не крутится: он в паузе. Отмена прерывает её — результат не зависит от того,
    // успела ли пауза начаться к этому мигу (в обоих случаях ответ сразу и running).
    const started = Date.now();
    controller.abort();

    expect(body(await waiting)).toEqual({ state: 'running' });
    expect(Date.now() - started).toBeLessThan(2000);
    await addLetter('после отмены');
    expect(textsOf(body(await runner.call('check_inbox', {}, undefined)))).toEqual(['после отмены']);
  });
});

describe('wait_for("inbox"): брошенный вызов — ход сессии кончился или начался заново после его старта (turnBoundarySince)', () => {
  /** Раннер хоста: к обычному контексту добавлен вопрос «была ли граница хода после `sinceMs`». */
  const runnerWith = (turnBoundarySince: (sinceMs: number) => boolean): ToolRunner =>
    createToolRunner({ projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false, messageRate: DEFAULT_CONFIG.messageRate, pollMs: 40, turnBoundarySince });
  /** Ждёт начала ожидания (`ParleyWaitStart` в журнале), чтобы письмо пришло уже во время него. */
  const waitStarted = (): Promise<void> =>
    new Promise<void>((resolve) => {
      journal.beforeLine = (line) => {
        if (line.includes('ParleyWaitStart')) resolve();
      };
    });

  it('граница была: письмо пришло, ответ running, письмо осталось непрочитанным и check_inbox его отдаёт', async () => {
    runner = runnerWith(() => true);
    const hasStarted = waitStarted();

    const waiting = runner.call('wait_for', { target: 'inbox', timeoutSec: 30 }, undefined);
    await hasStarted;
    await addLetter('письмо');

    expect(body(await waiting)).toEqual({ state: 'running' });
    expect(unreadTexts()).toEqual(['письмо']);
    // Ожидание закончено как положено: Start и End остались парой.
    expect((await journalLines()).map((line) => line['hook_event_name'])).toEqual(['ParleyWaitStart', 'ParleyWaitEnd']);
    expect(textsOf(body(await runner.call('check_inbox', {}, undefined)))).toEqual(['письмо']);
    expect(unreadTexts()).toEqual([]);
  });

  it('границы не было: обычный message, письмо отмечено прочитанным', async () => {
    runner = runnerWith(() => false);
    const hasStarted = waitStarted();

    const waiting = runner.call('wait_for', { target: 'inbox', timeoutSec: 30 }, undefined);
    await hasStarted;
    await addLetter('письмо');
    const answer = body(await waiting);

    expect(answer['state']).toBe('message');
    expect(textsOf(answer)).toEqual(['письмо']);
    expect(unreadTexts()).toEqual([]);
  });

  it('вопрос получает время старта вызова: не позже прихода письма и не раньше вызова', async () => {
    const asked: number[] = [];
    runner = runnerWith((sinceMs) => {
      asked.push(sinceMs);
      return false;
    });
    const hasStarted = waitStarted();

    const before = Date.now();
    const waiting = runner.call('wait_for', { target: 'inbox', timeoutSec: 30 }, undefined);
    await hasStarted;
    // Пауза, чтобы время прихода письма заведомо отличалось от времени старта вызова.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const letterAt = Date.now();
    await addLetter('письмо');
    await waiting;

    expect(asked).toHaveLength(1);
    expect(asked[0]).toBeGreaterThanOrEqual(before);
    expect(asked[0]).toBeLessThan(letterAt);
  });

  it('target — id сессии: вопрос о границе не задаётся, итог сессии отдаётся как раньше', async () => {
    const asked: number[] = [];
    runner = runnerWith((sinceMs) => {
      asked.push(sinceMs);
      return true;
    });
    await updateMap(project, workId, (map) => {
      const found = map.sessions.find((session) => session.id === 's-02');
      if (found !== undefined) found.result = 'done';
    });

    const answer = body(await runner.call('wait_for', { target: 's-02', timeoutSec: 30 }, undefined));

    expect(answer['state']).toBe('done');
    expect(asked).toEqual([]);
  });
});

describe('wait_for("inbox"): окно тишины — несрочные письма отдаются пачкой, срочные сразу', () => {
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  /** Исполнитель `s-01` с коротким окном и потолком вместо боевых 30 с и 120 с. */
  const runnerSettle = (settleMs: number, settleMaxMs: number, extra: Partial<McpContext> = {}): ToolRunner =>
    createToolRunner({ projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false, messageRate: DEFAULT_CONFIG.messageRate, pollMs: 40, settleMs, settleMaxMs, ...extra });
  /** Письмо в комнате от `s-02`: по умолчанию заметка всем без упоминания — несрочная. */
  const roomLetter = async (text: string, extra: Partial<NewLetter> = {}): Promise<void> => {
    await updateMap(project, workId, (_map, letters) => { letters.add({ roomId: 'r-01', kind: 'note', from: 's-02', to: [], text, ...extra }); });
  };
  const waitInbox = (timeoutSec: number, signal?: AbortSignal): Promise<Awaited<ReturnType<ToolRunner['call']>>> =>
    runner.call('wait_for', { target: 'inbox', timeoutSec }, undefined, signal);
  /** Ждёт начала ожидания (`ParleyWaitStart` в журнале): письмо тогда придёт уже во время него. */
  const waitStarted = (): Promise<void> =>
    new Promise<void>((resolve) => {
      journal.beforeLine = (line) => {
        if (line.includes('ParleyWaitStart')) resolve();
      };
    });

  beforeEach(async () => {
    await updateMap(project, workId, (map) => { addRoom(map, { title: 'комната', creator: 's-02', members: ['s-01', 's-02'] }); });
  });

  it('заметка всем без упоминания лежала до вызова: ответ не раньше конца окна, с заметкой, без вращения цикла', async () => {
    runner = runnerSettle(600, 2000);
    const startedAt = Date.now();
    await roomLetter('заметка');
    vi.mocked(unreadLetters).mockClear();

    const answer = body(await waitInbox(20));
    const reads = vi.mocked(unreadLetters).mock.calls.length;

    expect(answer['state']).toBe('message');
    expect(textsOf(answer)).toEqual(['заметка']);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(600);
    expect(unreadTexts()).toEqual([]);
    // Одно ожидание до срока и забор: без охраны пробы (`wakeOnPending`) цикл читал бы ящик без пауз до конца окна.
    expect(reads).toBeLessThanOrEqual(15);
    expect((await journalLines()).length).toBeLessThanOrEqual(8);
  });

  it('заметка пришла во время ожидания: ответ не раньше конца её окна, Start и End парами, без вращения цикла', async () => {
    runner = runnerSettle(600, 2000);
    const hasStarted = waitStarted();
    const waiting = waitInbox(20);
    await hasStarted;
    vi.mocked(unreadLetters).mockClear();
    const startedAt = Date.now();
    await roomLetter('заметка');

    const answer = body(await waiting);
    const reads = vi.mocked(unreadLetters).mock.calls.length;

    expect(textsOf(answer)).toEqual(['заметка']);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(600);
    // Ожидание без писем отдало управление циклу, а тот ждал окно новым ожиданием: каждое — своя пара.
    const lines = await journalLines();
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(lines.length % 2).toBe(0);
    for (let index = 0; index < lines.length; index += 2) {
      expect(lines[index]?.['hook_event_name']).toBe('ParleyWaitStart');
      expect(lines[index + 1]?.['hook_event_name']).toBe('ParleyWaitEnd');
      expect(lines[index + 1]?.['parley_wait_id']).toBe(lines[index]?.['parley_wait_id']);
    }
    // Ожидание, уже ограниченное окном, на неустоявшиеся письма не возвращает управление (иначе цикл вращался бы до конца окна
    // без единой строки в журнале — потому журнал этого не ловит, а число чтений ящика ловит).
    expect(reads).toBeLessThanOrEqual(15);
  });

  const urgent: [string, Partial<NewLetter>][] = [
    ['вопрос', { kind: 'question' }],
    ['адресное письмо', { to: ['s-01'] }],
    ['письмо человека', { from: HUMAN }],
    ['упоминание @s01', { text: '@s01 глянь' }],
  ];
  it.each(urgent)('%s будит сразу, не дожидаясь окна', async (_name, extra) => {
    runner = runnerSettle(30_000, 120_000);
    const startedAt = Date.now();
    await roomLetter('срочное', extra);

    const answer = body(await waitInbox(20));

    expect(answer['state']).toBe('message');
    expect(textsOf(answer)).toEqual([extra.text ?? 'срочное']);
    expect(Date.now() - startedAt).toBeLessThan(4000);
  });

  it('срочное письмо во время окна уходит вместе с ранней заметкой', async () => {
    runner = runnerSettle(3000, 10_000);
    const startedAt = Date.now();
    await roomLetter('ранняя заметка');
    const waiting = waitInbox(20);
    await delay(100);
    await roomLetter('вопрос', { kind: 'question' });

    const answer = body(await waiting);

    expect(textsOf(answer)).toEqual(['ранняя заметка', 'вопрос']);
    // Окно — 3 с: ответ намного раньше него, значит ушёл по срочному письму, а не по тишине.
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it('заметки чаще окна: ответ на потолке от самой старой, а не после тишины', async () => {
    runner = runnerSettle(600, 2000);
    const startedAt = Date.now();
    let sending = true;
    const sender = (async () => {
      for (let number = 1; sending; number += 1) {
        await roomLetter(`заметка ${number}`);
        await delay(100);
      }
    })();

    let answer: Record<string, unknown>;
    try {
      answer = body(await waitInbox(20));
    } finally {
      sending = false;
      await sender;
    }

    expect(answer['state']).toBe('message');
    expect(textsOf(answer)[0]).toBe('заметка 1');
    expect(textsOf(answer).length).toBeGreaterThanOrEqual(3);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2000);
  }, 15_000);

  it('таймаут вызова короче окна: лежавшая заметка отдаётся по таймауту, а не running', async () => {
    runner = runnerSettle(5000, 20_000);
    await roomLetter('заметка');
    const startedAt = Date.now();

    const answer = body(await waitInbox(0.4));

    expect(answer['state']).toBe('message');
    expect(textsOf(answer)).toEqual(['заметка']);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(350);
    expect(unreadTexts()).toEqual([]);
  });

  it('таймаут вызова короче окна: пришедшая во время ожидания заметка тоже отдаётся по таймауту', async () => {
    runner = runnerSettle(5000, 20_000);
    const hasStarted = waitStarted();
    const startedAt = Date.now();
    const waiting = waitInbox(0.5);
    await hasStarted;
    await roomLetter('заметка');

    const answer = body(await waiting);

    expect(answer['state']).toBe('message');
    expect(textsOf(answer)).toEqual(['заметка']);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(450);
  });

  it('таймаут вызова при пустом ящике по-прежнему running', async () => {
    runner = runnerSettle(200, 600);

    expect(body(await waitInbox(0.3))).toEqual({ state: 'running' });
  });

  it('отмена посреди окна ничего не помечает: заметка остаётся, check_inbox её отдаёт', async () => {
    runner = runnerSettle(5000, 20_000);
    await roomLetter('заметка');
    const controller = new AbortController();
    const hasStarted = waitStarted();
    const waiting = waitInbox(20, controller.signal);
    await hasStarted;

    controller.abort();

    expect(body(await waiting)).toEqual({ state: 'running' });
    expect(unreadTexts()).toEqual(['заметка']);
    expect(textsOf(body(await runner.call('check_inbox', {}, undefined)))).toEqual(['заметка']);
  });

  it('брошенный вызов: после окна страж не даёт забрать заметку', async () => {
    runner = runnerSettle(100, 600, { turnBoundarySince: () => true });
    await roomLetter('заметка');

    expect(body(await waitInbox(20))).toEqual({ state: 'running' });
    expect(unreadTexts()).toEqual(['заметка']);
  });

  it('брошенный вызов: по таймауту короче окна страж тоже не даёт забрать заметку', async () => {
    runner = runnerSettle(5000, 20_000, { turnBoundarySince: () => true });
    await roomLetter('заметка');

    expect(body(await waitInbox(0.4))).toEqual({ state: 'running' });
    expect(unreadTexts()).toEqual(['заметка']);
  });
});

describe('отметка «засыпает»: письма не выдаются — они поднимут сессию после сна', () => {
  const MARK = { reason: 'idle', at: '2026-10-31T12:00:00.000Z', waitTarget: null } as const;
  /** Меняет `s-01` в карте так, как это делает хост: отметка сна, жизненный цикл, итог сна. */
  const patchSession = (patch: (session: WorkSession) => void): Promise<unknown> =>
    updateMap(project, workId, (map) => { patch(map.sessions.find((session) => session.id === 's-01')!); });
  const markPending = (): Promise<unknown> => patchSession((session) => { session.autoSleepPending = { ...MARK }; });

  it('check_inbox при отметке сна отдаёт пусто и не помечает письма', async () => {
    await addLetter('письмо');
    await markPending();

    expect(body(await runner.call('check_inbox', {}, undefined))).toEqual({ messages: [] });
    expect(unreadTexts()).toEqual(['письмо']);
  });

  it('wait_for("inbox") при отметке сна сразу отвечает running и не помечает письма', async () => {
    await addLetter('письмо');
    await markPending();
    const startedAt = Date.now();

    expect(body(await runner.call('wait_for', { target: 'inbox', timeoutSec: 30 }, undefined))).toEqual({ state: 'running' });

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(unreadTexts()).toEqual(['письмо']);
    // Ожидание не начиналось: в журнале нет ни одной строки.
    expect(await journalLines()).toEqual([]);
  });

  it('wait_for("inbox") при отметке сна и пустом ящике тоже отвечает running сразу, не дожидаясь таймаута', async () => {
    await markPending();
    const startedAt = Date.now();

    expect(body(await runner.call('wait_for', { target: 'inbox', timeoutSec: 30 }, undefined))).toEqual({ state: 'running' });

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(await journalLines()).toEqual([]);
  });

  it('отметка поставлена посреди ожидания: пришедшее письмо не выдаётся, ответ running сразу, Start и End парой', async () => {
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => { started = resolve; });
    journal.beforeLine = (line) => {
      if (line.includes('ParleyWaitStart')) started();
    };

    const waiting = runner.call('wait_for', { target: 'inbox', timeoutSec: 30 }, undefined);
    await hasStarted;
    await markPending();
    await addLetter('письмо');
    const startedAt = Date.now();

    expect(body(await waiting)).toEqual({ state: 'running' });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(unreadTexts()).toEqual(['письмо']);
    expect((await journalLines()).map((line) => line['hook_event_name'])).toEqual(['ParleyWaitStart', 'ParleyWaitEnd']);
  });

  it('отметка поставлена в окне между находкой письма и забором: письмо не помечается, ответ running сразу', async () => {
    // `ParleyWaitEnd` пишется после находки письма и до `takeInbox`: хост успевает поставить отметку именно здесь. Опрос карты —
    // минута, будит ожидание только сигнал: без проверки перед забором пустой забор ушёл бы в паузу на `pollMs` и вызов провисел бы.
    const subscribed = { listener: null as (() => void) | null };
    runner = createToolRunner({ projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false, messageRate: DEFAULT_CONFIG.messageRate, pollMs: 60_000, mapChanges: (onChange) => {
      subscribed.listener = onChange;
      return () => { subscribed.listener = null; };
    } });
    journal.beforeLine = async (line) => {
      if (line.includes('ParleyWaitEnd')) await markPending();
    };

    const waiting = runner.call('wait_for', { target: 'inbox', timeoutSec: 30 }, undefined);
    await vi.waitFor(() => expect(subscribed.listener).not.toBeNull(), { timeout: 2000, interval: 10 });
    await addLetter('письмо');
    subscribed.listener!();
    const startedAt = Date.now();

    expect(body(await waiting)).toEqual({ state: 'running' });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(unreadTexts()).toEqual(['письмо']);
  });

  it('wait_for(<id>) огороженной сессии тоже сразу отвечает running, даже если у цели есть итог', async () => {
    await updateMap(project, workId, (map) => {
      map.sessions.find((session) => session.id === 's-02')!.result = 'done';
    });
    await markPending();

    expect(body(await runner.call('wait_for', { target: 's-02', timeoutSec: 30 }, undefined))).toEqual({ state: 'running' });
  });

  it('усыплённую хостом (sleeping и autoSleep) поздний вызов оборванного процесса тоже не обслуживает', async () => {
    await addLetter('письмо');
    await patchSession((session) => {
      session.lifecycle = 'sleeping';
      session.autoSleep = { ...MARK };
    });

    expect(body(await runner.call('check_inbox', {}, undefined))).toEqual({ messages: [] });
    expect(unreadTexts()).toEqual(['письмо']);
  });

  it('остановленная человеком (sleeping без autoSleep) не огорожена: выдача прежняя', async () => {
    await addLetter('письмо');
    await patchSession((session) => { session.lifecycle = 'sleeping'; });

    expect(textsOf(body(await runner.call('check_inbox', {}, undefined)))).toEqual(['письмо']);
    expect(unreadTexts()).toEqual([]);
  });

  it('без отметки выдача прежняя: пустые ключи сна не огораживают', async () => {
    await addLetter('письмо');
    await patchSession((session) => {
      session.autoSleepPending = null;
      session.autoSleep = null;
    });

    expect(textsOf(body(await runner.call('check_inbox', {}, undefined)))).toEqual(['письмо']);
    expect(unreadTexts()).toEqual([]);
  });

  it('wait_for("inbox") без отметки отдаёт письмо и помечает его, как раньше', async () => {
    await addLetter('письмо');

    const answer = body(await runner.call('wait_for', { target: 'inbox', timeoutSec: 30 }, undefined));

    expect(answer['state']).toBe('message');
    expect(textsOf(answer)).toEqual(['письмо']);
    expect(unreadTexts()).toEqual([]);
  });

  it('хост отменил сон и снял отметку: письмо, которое ждало, выдаётся', async () => {
    await addLetter('письмо');
    await markPending();
    expect(body(await runner.call('check_inbox', {}, undefined))).toEqual({ messages: [] });

    await patchSession((session) => { delete session.autoSleepPending; });

    expect(textsOf(body(await runner.call('check_inbox', {}, undefined)))).toEqual(['письмо']);
    expect(unreadTexts()).toEqual([]);
  });
});

describe('усыплённая хостом сессия в ответах инструментов: asleep, а не exited; wait_for(<id>) отвечает сразу, с подсказкой', () => {
  const SLEPT = { reason: 'idle', at: '2026-10-31T12:00:00.000Z', waitTarget: null } as const;
  /** Меняет сессию в карте так, как это делает хост: жизненный цикл, итог сна. По умолчанию — цель ожидания `s-02`. */
  const patch = (patcher: (session: WorkSession) => void, id = 's-02'): Promise<unknown> =>
    updateMap(project, workId, (map) => { patcher(map.sessions.find((session) => session.id === id)!); });
  const sleepTarget = (): Promise<unknown> =>
    patch((session) => {
      session.lifecycle = 'sleeping';
      session.autoSleep = { ...SLEPT };
    });
  const waitForTarget = async (): Promise<Record<string, unknown>> => body(await runner.call('wait_for', { target: 's-02', timeoutSec: 30 }, undefined));

  it('wait_for(<id>) на усыплённую хостом цель сразу отвечает asleep с подсказкой, без резюме и артефактов', async () => {
    await sleepTarget();
    const startedAt = Date.now();

    expect(await waitForTarget()).toEqual({ state: 'asleep', sessionId: 's-02', hint: asleepHint('s-02') });

    expect(Date.now() - startedAt).toBeLessThan(1000);
    // Ожидание не начиналось: в журнале нет ни одной строки.
    expect(await journalLines()).toEqual([]);
  });

  it('цель заснула посреди ожидания: ожидание просыпается ответом asleep, а не таймаутом', async () => {
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => { started = resolve; });
    journal.beforeLine = (line) => {
      if (line.includes('ParleyWaitStart')) started();
    };

    const waiting = runner.call('wait_for', { target: 's-02', timeoutSec: 30 }, undefined);
    await hasStarted;
    const startedAt = Date.now();
    await sleepTarget();

    expect(body(await waiting)).toEqual({ state: 'asleep', sessionId: 's-02', hint: asleepHint('s-02') });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect((await journalLines()).map((line) => line['hook_event_name'])).toEqual(['ParleyWaitStart', 'ParleyWaitEnd']);
  });

  it('итог цели важнее сна: done с резюме и артефактами', async () => {
    await patch((session) => {
      session.lifecycle = 'sleeping';
      session.autoSleep = { ...SLEPT };
      session.result = 'done';
      session.summary = 'готово';
    });

    expect(await waitForTarget()).toEqual({ state: 'done', sessionId: 's-02', summary: 'готово', artifacts: [] });
  });

  it('застрявшая цель важнее сна: stuck с подсказкой', async () => {
    await patch((session) => {
      session.lifecycle = 'sleeping';
      session.autoSleep = { ...SLEPT };
      session.stuck = { kind: 'limit', since: '2026-10-31T11:00:00.000Z', detail: null, resetsAt: null, window: null, account: null };
    });

    const answer = await waitForTarget();

    expect(answer).toMatchObject({ state: 'stuck', sessionId: 's-02' });
    expect(answer['hint']).toEqual(expect.any(String));
  });

  it('остановленная человеком цель (sleeping без autoSleep) отвечает sleeping, как раньше', async () => {
    await patch((session) => { session.lifecycle = 'sleeping'; });

    expect(await waitForTarget()).toEqual({ state: 'sleeping', sessionId: 's-02', summary: null, artifacts: [] });
  });

  it('finishedState: замена агента первая, затем итог, stuck, сон по решению хоста и прежние sleeping/closed', () => {
    const base = { result: null, stuck: null, lifecycle: 'sleeping', autoSleep: SLEPT } as unknown as WorkSession;
    const switching = { id: 'req', to: 'custom-claude-2', since: '2026-10-31T12:00:00.000Z' };

    // Между остановкой прежнего агента и стартом нового сессия sleeping, но работа не кончилась.
    expect(finishedState({ ...base, switching })).toBeNull();
    expect(finishedState({ ...base, switching, result: 'done' })).toBeNull();
    expect(finishedState({ ...base, result: 'failed' })).toBe('failed');
    expect(finishedState({ ...base, stuck: { kind: 'limit' } } as unknown as WorkSession)).toBe('stuck');
    expect(finishedState(base)).toBe('asleep');
    expect(finishedState({ ...base, autoSleep: null })).toBe('sleeping');
    expect(finishedState({ ...base, lifecycle: 'closed' } as WorkSession)).toBe('closed');
    expect(finishedState({ ...base, lifecycle: 'active' } as WorkSession)).toBeNull();
  });

  it('get_map summaries: статус усыплённой хостом сессии — asleep, остановленной человеком — exited', async () => {
    await patch((session) => {
      session.summary = 'план готов';
      session.lifecycle = 'sleeping';
    }, 's-01');
    await patch((session) => {
      session.summary = 'бэк готов';
      session.lifecycle = 'sleeping';
      session.autoSleep = { ...SLEPT };
    });

    const summaries = body(await runner.call('get_map', { field: 'summaries' }, undefined))['summaries'] as { id: string; status: string }[];

    expect(summaries.map((row) => [row.id, row.status])).toEqual([['s-01', 'exited'], ['s-02', 'asleep']]);
  });

  it('report позднего вызова усыплённой хостом сессии называет статус asleep, а не exited', async () => {
    await patch((session) => {
      session.lifecycle = 'sleeping';
      session.autoSleep = { ...SLEPT };
    }, 's-01');

    const answer = body(await runner.call('report', { status: 'progress', summary: 'ещё работаю' }, undefined));

    expect(answer['status']).toBe('asleep');
  });
});

describe('ждущая слота машины сессия в ответах инструментов: queued, а не exited или asleep; wait_for(<id>) ждёт её как работающую', () => {
  const QUEUED: QueuedLaunch = {
    class: 'agent', mode: 'resume', by: 's-01', at: '2026-10-31T12:00:00.000Z', reason: 'machine-limit', live: 18, limit: 18,
  };
  const SLEPT = { reason: 'idle', at: '2026-10-31T11:00:00.000Z', waitTarget: null } as const;
  const patch = (patcher: (session: WorkSession) => void, id = 's-02'): Promise<unknown> =>
    updateMap(project, workId, (map) => { patcher(map.sessions.find((session) => session.id === id)!); });

  it('finishedState: запись очереди у ожидающей и спящей сессии — работает (null), итог отвечает сразу, закрытая — closed', () => {
    const base = { result: null, stuck: null, autoSleep: null, queued: QUEUED } as unknown as WorkSession;

    expect(finishedState({ ...base, lifecycle: 'pending' } as WorkSession)).toBeNull();
    expect(finishedState({ ...base, lifecycle: 'sleeping' } as WorkSession)).toBeNull();
    // Усыплённая хостом и поставленная в очередь на подъём: слово `asleep` уже не про неё.
    expect(finishedState({ ...base, lifecycle: 'sleeping', autoSleep: SLEPT } as WorkSession)).toBeNull();
    expect(finishedState({ ...base, lifecycle: 'sleeping', result: 'done' } as WorkSession)).toBe('done');
    expect(finishedState({ ...base, lifecycle: 'sleeping', result: 'failed' } as WorkSession)).toBe('failed');
    expect(finishedState({ ...base, lifecycle: 'closed' } as WorkSession)).toBe('closed');
  });

  it('finishedState: застрявшая сессия в очереди остаётся stuck, пустая запись очереди ничего не меняет', () => {
    const base = { result: null, stuck: null, autoSleep: SLEPT, lifecycle: 'sleeping' } as unknown as WorkSession;

    expect(finishedState({ ...base, queued: QUEUED, stuck: { kind: 'limit' } } as unknown as WorkSession)).toBe('stuck');
    expect(finishedState({ ...base, queued: null })).toBe('asleep');
    expect(finishedState({ ...base, autoSleep: null, queued: null })).toBe('sleeping');
  });

  it('wait_for(<id>) на ждущую слота цель не отвечает сразу, а ждёт: по таймауту running', async () => {
    await patch((session) => { session.lifecycle = 'sleeping'; session.queued = { ...QUEUED }; });
    const startedAt = Date.now();

    expect(body(await runner.call('wait_for', { target: 's-02', timeoutSec: 0.3 }, undefined))).toEqual({ state: 'running' });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
    // Ожидание началось по-настоящему: в журнале пара Start/End.
    expect((await journalLines()).map((line) => line['hook_event_name'])).toEqual(['ParleyWaitStart', 'ParleyWaitEnd']);
  });

  it('wait_for(<id>) на ждущую слота цель ждёт, а когда очередь её подняла и она сдала итог, отвечает итогом', async () => {
    // Усыплённая хостом, письмо подняло её, а машина полна: sleeping, autoSleep и запись очереди.
    await patch((session) => { session.lifecycle = 'sleeping'; session.autoSleep = { ...SLEPT }; session.queued = { ...QUEUED }; });
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => { started = resolve; });
    journal.beforeLine = (line) => {
      if (line.includes('ParleyWaitStart')) started();
    };

    const waiting = runner.call('wait_for', { target: 's-02', timeoutSec: 30 }, undefined);
    // Ждёт, а не отвечает сразу: началась запись ожидания в журнал, ответа ещё нет.
    expect(await Promise.race([hasStarted.then(() => 'waiting'), waiting.then(() => 'answered')])).toBe('waiting');
    await patch((session) => {
      session.lifecycle = 'active';
      delete session.autoSleep;
      delete session.queued;
      session.result = 'done';
      session.summary = 'готово';
    });

    expect(body(await waiting)).toEqual({ state: 'done', sessionId: 's-02', summary: 'готово', artifacts: [] });
  });

  it('get_map summaries: статус ждущей слота сессии — queued, даже если её усыпил хост', async () => {
    await patch((session) => {
      session.summary = 'бэк готов';
      session.lifecycle = 'sleeping';
      session.autoSleep = { ...SLEPT };
      session.queued = { ...QUEUED };
    });

    const summaries = body(await runner.call('get_map', { field: 'summaries' }, undefined))['summaries'] as { id: string; status: string }[];

    expect(summaries.map((row) => [row.id, row.status])).toEqual([['s-02', 'queued']]);
  });

  it('report позднего вызова ждущей слота сессии называет статус queued', async () => {
    await patch((session) => { session.lifecycle = 'sleeping'; session.queued = { ...QUEUED }; }, 's-01');

    const answer = body(await runner.call('report', { status: 'progress', summary: 'ещё работаю' }, undefined));

    expect(answer['status']).toBe('queued');
  });
});
