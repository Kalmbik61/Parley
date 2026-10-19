import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assistantCwd } from '@parley/core';
import { createReminderStore, isLastCheck, REMINDERS_MAX, type Reminder, type ReminderStore } from './reminders.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);

let home = '';
let clock = T0;
let store: ReminderStore;
const log = vi.fn();
const file = (): string => path.join(assistantCwd(home), 'reminders.json');
const read = async (): Promise<{ version: number; reminders: Reminder[] }> => JSON.parse(await readFile(file(), 'utf8')) as { version: number; reminders: Reminder[] };
const advance = async (ms: number): Promise<void> => {
  clock += ms;
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(async () => {
  vi.useFakeTimers();
  home = await mkdtemp(path.join(tmpdir(), 'parley-reminders-'));
  clock = T0;
  log.mockClear();
  store = createReminderStore({ home, now: () => clock, log });
});
afterEach(async () => {
  store.stop();
  vi.useRealTimers();
  await rm(home, { recursive: true, force: true });
});

const added = (result: ReturnType<ReminderStore['add']>): Reminder => {
  if ('error' in result) throw new Error(result.error);
  return result;
};

describe('reminders: add', () => {
  it('разовое через 5 минут — at = now + 5 мин, файл 0600 и без .tmp', async () => {
    const reminder = added(store.add({ what: 'check the release room', inMinutes: 5, now: clock }));
    expect(reminder).toMatchObject({ id: 'r1', every: null, at: new Date(T0 + 5 * MIN).toISOString() });
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect((await read()).reminders).toEqual([reminder]);
    await expect(stat(`${file()}.tmp`)).rejects.toThrow();
  });
  it('at: ISO и HH:mm принимаются, мусор, прошлое и дальше суток — нет', () => {
    expect('error' in store.add({ what: 'x', at: new Date(T0 + 30 * MIN).toISOString(), now: clock })).toBe(false);
    const local = new Date(T0 + 2 * 60 * MIN);
    const hhmm = `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`;
    const parsed = added(store.add({ what: 'x', at: hhmm, now: clock }));
    expect(Date.parse(parsed.at)).toBe(local.getTime());
    expect('error' in store.add({ what: 'x', at: 'tomorrow', now: clock })).toBe(true);
    expect('error' in store.add({ what: 'x', at: new Date(T0 - MIN).toISOString(), now: clock })).toBe(true);
    expect('error' in store.add({ what: 'x', at: new Date(T0 + 25 * 60 * MIN).toISOString(), now: clock })).toBe(true);
  });
  it('HH:mm, который уже прошёл, — завтра', () => {
    const past = new Date(T0 - 2 * 60 * MIN);
    const hhmm = `${String(past.getHours()).padStart(2, '0')}:${String(past.getMinutes()).padStart(2, '0')}`;
    const reminder = added(store.add({ what: 'x', at: hhmm, now: clock }));
    expect(Date.parse(reminder.at)).toBeGreaterThan(T0);
    expect(Date.parse(reminder.at) - T0).toBeLessThanOrEqual(24 * 60 * MIN);
  });
  it('границы: ровно одно из in_minutes/at, in_minutes 1…1440, every 5…1440, what 1…500', () => {
    expect('error' in store.add({ what: 'x', now: clock })).toBe(true);
    expect('error' in store.add({ what: 'x', inMinutes: 5, at: '23:59', now: clock })).toBe(true);
    expect('error' in store.add({ what: 'x', inMinutes: 0, now: clock })).toBe(true);
    expect('error' in store.add({ what: 'x', inMinutes: 1441, now: clock })).toBe(true);
    expect('error' in store.add({ what: 'x', inMinutes: 5, everyMinutes: 4, now: clock })).toBe(true);
    expect('error' in store.add({ what: 'x', inMinutes: 5, everyMinutes: 1441, now: clock })).toBe(true);
    expect('error' in store.add({ what: '  ', inMinutes: 5, now: clock })).toBe(true);
    expect('error' in store.add({ what: 'x'.repeat(501), inMinutes: 5, now: clock })).toBe(true);
    expect('error' in store.add({ what: 'x'.repeat(500), inMinutes: 1440, everyMinutes: 5, now: clock })).toBe(false);
  });
  it('одиннадцатое активное — ошибка', () => {
    for (let index = 0; index < REMINDERS_MAX; index += 1) added(store.add({ what: `n${index}`, inMinutes: 5, now: clock }));
    expect(store.add({ what: 'one more', inMinutes: 5, now: clock })).toEqual({ error: 'Too many reminders (10 at most)' });
  });
  it('cancel по id и «*»; файл пустеет', async () => {
    added(store.add({ what: 'a', inMinutes: 5, now: clock }));
    added(store.add({ what: 'b', inMinutes: 6, now: clock }));
    added(store.add({ what: 'c', inMinutes: 7, now: clock }));
    expect(store.cancel('r2')).toBe(1);
    expect(store.cancel('r9')).toBe(0);
    expect(store.list().map((item) => item.id)).toEqual(['r1', 'r3']);
    expect(store.cancel('*')).toBe(2);
    expect((await read()).reminders).toEqual([]);
  });
});

describe('reminders: срабатывание', () => {
  it('таймер зовёт onDue в срок, разовое снимается', async () => {
    const onDue = vi.fn().mockResolvedValue('fired');
    store.start(onDue);
    added(store.add({ what: 'later', inMinutes: 5, now: clock }));
    await advance(4 * MIN);
    expect(onDue).not.toHaveBeenCalled();
    await advance(MIN);
    expect(onDue).toHaveBeenCalledTimes(1);
    expect(onDue.mock.calls[0]?.[1]).toBe(false);
    expect(store.list()).toEqual([]);
    expect((await read()).reminders).toEqual([]);
  });
  it('просроченное при старте — один вызов с late = true и удаление', async () => {
    const old: Reminder = { id: 'r4', what: 'overdue', at: new Date(T0 - 30 * MIN).toISOString(), every: null, createdAt: new Date(T0 - 60 * MIN).toISOString(), askedAt: new Date(T0 - 60 * MIN).toISOString() };
    await mkdir(path.dirname(file()), { recursive: true });
    await writeFile(file(), JSON.stringify({ version: 1, reminders: [old] }));
    const onDue = vi.fn().mockResolvedValue('fired');
    store.start(onDue);
    await advance(0);
    await advance(10 * MIN);
    expect(onDue).toHaveBeenCalledTimes(1);
    expect(onDue).toHaveBeenCalledWith(old, true);
    expect(store.list()).toEqual([]);
    expect(added(store.add({ what: 'next', inMinutes: 5, now: clock })).id).toBe('r5');
  });
  it('повторяющееся каждые 10 минут: at сдвигается, через сутки от создания — удаляется', async () => {
    const onDue = vi.fn().mockResolvedValue('fired');
    store.start(onDue);
    const created = added(store.add({ what: 'poll', inMinutes: 600, everyMinutes: 600, now: clock }));
    await advance(600 * MIN);
    expect(onDue).toHaveBeenCalledTimes(1);
    expect(isLastCheck(onDue.mock.calls[0]?.[0] as Reminder, T0 + 600 * MIN)).toBe(false);
    expect(store.list()[0]?.at).toBe(new Date(T0 + 1200 * MIN).toISOString());
    await advance(600 * MIN);
    expect(onDue).toHaveBeenCalledTimes(2);
    expect(isLastCheck(onDue.mock.calls[1]?.[0] as Reminder, T0 + 1200 * MIN)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(created.every).toBe(600);
  });
  it('повторяющееся каждые 10 минут сдвигается на период', async () => {
    const onDue = vi.fn().mockResolvedValue('fired');
    store.start(onDue);
    added(store.add({ what: 'poll', inMinutes: 10, everyMinutes: 10, now: clock }));
    await advance(10 * MIN);
    expect(store.list()[0]?.at).toBe(new Date(T0 + 20 * MIN).toISOString());
    await advance(10 * MIN);
    expect(onDue).toHaveBeenCalledTimes(2);
  });
  it('skipped: разовое удалено с записью в лог', async () => {
    const onDue = vi.fn().mockResolvedValue('skipped');
    store.start(onDue);
    added(store.add({ what: 'x', inMinutes: 1, now: clock }));
    await advance(MIN);
    expect(store.list()).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('r1 skipped'));
  });
  it('stop гасит таймер', async () => {
    const onDue = vi.fn().mockResolvedValue('fired');
    store.start(onDue);
    added(store.add({ what: 'x', inMinutes: 1, now: clock }));
    store.stop();
    await advance(5 * MIN);
    expect(onDue).not.toHaveBeenCalled();
  });
});

describe('reminders: ревью', () => {
  const overdue = (id: string, minutesAgo: number): Reminder => ({
    id,
    what: id,
    at: new Date(T0 - minutesAgo * MIN).toISOString(),
    every: null,
    createdAt: new Date(T0 - 120 * MIN).toISOString(),
    askedAt: new Date(T0 - 120 * MIN).toISOString(),
  });
  const seed = async (content: unknown): Promise<void> => {
    await mkdir(path.dirname(file()), { recursive: true });
    await writeFile(file(), JSON.stringify(content));
  };

  it('три просроченных при старте срабатывают по порядку at', async () => {
    await seed({ version: 1, reminders: [overdue('r2', 10), overdue('r1', 30), overdue('r3', 5)] });
    const order: string[] = [];
    store.start(async (reminder) => {
      order.push(reminder.id);
      return 'fired';
    });
    await advance(0);
    expect(order).toEqual(['r1', 'r2', 'r3']);
    expect(store.list()).toEqual([]);
  });
  it("'later' оставляет напоминание и файл как есть и не крутит таймер", async () => {
    await seed({ version: 1, counter: 1, reminders: [overdue('r1', 5)] });
    const before = await readFile(file(), 'utf8');
    const onDue = vi.fn().mockResolvedValue('later');
    store.start(onDue);
    await advance(0);
    await advance(10 * MIN);
    expect(onDue).toHaveBeenCalledTimes(1);
    expect(await readFile(file(), 'utf8')).toBe(before);
    expect(store.list().map((item) => item.id)).toEqual(['r1']);
  });
  it('счётчик id хранится в файле: после пустого списка id не повторяется; старый файл без counter читается', async () => {
    added(store.add({ what: 'a', inMinutes: 5, now: clock }));
    store.cancel('*');
    expect((await read()) as unknown as { counter: number }).toMatchObject({ counter: 1, reminders: [] });
    const again = createReminderStore({ home, now: () => clock, log });
    expect(added(again.add({ what: 'b', inMinutes: 5, now: clock })).id).toBe('r2');
    await seed({ version: 1, reminders: [overdue('r7', 5)] });
    const old = createReminderStore({ home, now: () => clock, log });
    expect(added(old.add({ what: 'c', inMinutes: 5, now: clock })).id).toBe('r8');
  });
});
