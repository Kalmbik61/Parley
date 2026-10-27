import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../config.js';
import { addSession } from '../work/map.js';
import { createWork, readStoredMap, updateMap, workPaths } from '../work/store.js';
import { writeLetters } from '../work/letter-store.js';
import { createToolRunner, type ToolRunner } from './tools.js';

/**
 * Порядок внутри `wait_for("inbox")`: письма забираются и отмечаются прочитанными ПОСЛЕ записи `ParleyWaitEnd` в журнал, а не
 * внутри ожидания. Пока шла эта запись, клиент мог отменить вызов — хост выбрасывает ответ отменённого вызова, и письма,
 * помеченные раньше, пропали бы вместе с ним. Журнал пишет `appendFile`: тест вклинивается перед строкой в журнал — в то самое
 * окно, где вызов уже нашёл письмо, но ещё не закончился. Остальные вызовы `appendFile` проходят насквозь.
 */
const journal = vi.hoisted(() => ({ beforeLine: null as ((line: string) => Promise<void> | void) | null }));
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
