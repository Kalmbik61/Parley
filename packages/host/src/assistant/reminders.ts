/**
 * Напоминания помощника (план A, задача 7): модель просит «проверь позже», хост хранит просьбу в файле
 * `<parleyHome>/assistant/reminders.json` и в срок сам запускает новый ход. Напоминание ничего не решает — оно
 * только запускает ход; что делать, решает модель, а любое действие по-прежнему идёт карточкой.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assistantCwd } from '@parley/core';

export interface Reminder {
  id: string;
  what: string;
  /** Когда сработает (ISO). У повторяющегося сдвигается после каждого срабатывания. */
  at: string;
  /** Период повтора в минутах; `null` — разовое. */
  every: number | null;
  createdAt: string;
  /** Когда модель его поставила (ISO) — попадает в текст хода. */
  askedAt: string;
}

export const REMINDERS_MAX = 10;
export const REMINDER_HORIZON_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;
const MAX_WHAT = 500;
/** Потолок `setTimeout` — 2^31−1 мс; горизонт короче, но подстрахуемся. */
const MAX_DELAY_MS = 2 ** 31 - 1;
/** Таймер взводится не дальше чем на минуту: после сна Mac напоминание срабатывает в пределах минуты после пробуждения. */
const REARM_MS = 60_000;
/** Пауза перед повтором, когда помощник сейчас не может взять ход (`'retry'`). */
const RETRY_MS = 5_000;
/** Сколько раз подряд повторяем одно напоминание (12 × 5 с = минута), потом оно снимается: хост может так и не стать готовым. */
const MAX_RETRIES = 12;

type DueResult = 'fired' | 'skipped' | 'later' | 'retry';

export interface ReminderStore {
  add(input: { what: string; inMinutes?: number; at?: string; everyMinutes?: number; now: number }): Reminder | { error: string };
  list(): Reminder[];
  /** `'*'` — все; возвращает, сколько снято. */
  cancel(id: string): number;
  /**
   * Таймер до ближайшего; просроченные при старте срабатывают по одному с `late = true`. `'later'` — хост останавливается,
   * напоминание остаётся в файле как есть; `'retry'` — помощник сейчас не может взять ход: напоминание остаётся, повтор через 5 с.
   */
  start(onDue: (reminder: Reminder, late: boolean) => Promise<DueResult>): void;
  stop(): void;
}

/**
 * Когда повторяющееся напоминание сработает в следующий раз (мс): на период позже, пропущенные повторения не
 * догоняются. `null` — у разового нет следующего, а у повторяющегося оно вышло бы за сутки от создания.
 */
export function nextDueAt(reminder: Reminder, now: number): number | null {
  if (reminder.every === null) return null;
  const step = reminder.every * MINUTE_MS;
  let next = Date.parse(reminder.at) + step;
  while (next <= now) next += step;
  return next - Date.parse(reminder.createdAt) > REMINDER_HORIZON_MS ? null : next;
}

/** Срабатывание последнее: у повторяющегося нет следующего (то же вычисление, что при сдвиге). */
export const isLastCheck = (reminder: Reminder, now: number): boolean => reminder.every !== null && nextDueAt(reminder, now) === null;

/** `HH:mm` (24 ч, местное время): ближайшее такое время — сегодня, если оно впереди, иначе завтра. */
function nextLocalTime(text: string, now: number): number | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (match === null) return null;
  const date = new Date(now);
  date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (date.getTime() <= now) date.setDate(date.getDate() + 1);
  return date.getTime();
}

const isReminder = (value: unknown): value is Reminder => {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item['id'] === 'string' &&
    typeof item['what'] === 'string' &&
    typeof item['at'] === 'string' &&
    !Number.isNaN(Date.parse(item['at'])) &&
    (item['every'] === null || (typeof item['every'] === 'number' && Number.isInteger(item['every']) && item['every'] >= 1 && item['every'] <= 1440)) &&
    typeof item['createdAt'] === 'string' &&
    !Number.isNaN(Date.parse(item['createdAt'])) &&
    typeof item['askedAt'] === 'string' &&
    !Number.isNaN(Date.parse(item['askedAt']))
  );
};

export function createReminderStore(deps: { home: string; now?(): number; log(line: string): void }): ReminderStore {
  const now = deps.now ?? Date.now;
  const file = path.join(assistantCwd(deps.home), 'reminders.json');
  let items: Reminder[] = [];
  let loaded = false;
  let counter = 0; // хранится в файле: id не повторяются, даже когда список опустел
  let onDue: ((reminder: Reminder, late: boolean) => Promise<DueResult>) | null = null;
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;
  let stopped = false;
  let retryId: string | null = null; // напоминание, которое повторяем подряд
  let retries = 0;

  function save(): void {
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, counter, reminders: items })}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } catch (error) {
      deps.log(`assistant: reminders not saved: ${(error as Error).message}`);
    }
  }

  function load(): void {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { reminders?: unknown; counter?: unknown };
      if (Array.isArray(parsed.reminders)) {
        items = parsed.reminders.filter(isReminder);
        const dropped = parsed.reminders.length - items.length;
        if (dropped > 0) deps.log(`assistant: ${dropped} invalid reminder(s) dropped from the file`);
      }
      if (typeof parsed.counter === 'number' && Number.isFinite(parsed.counter)) counter = parsed.counter;
    } catch {
      // файла нет или он битый — начинаем с пустого
    }
    for (const item of items) counter = Math.max(counter, Number(/^r(\d+)$/.exec(item.id)?.[1] ?? 0));
  }

  const dueTime = (item: Reminder): number => Date.parse(item.at);

  function arm(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (onDue === null || stopped || ticking || items.length === 0) return;
    const soonest = Math.min(...items.map(dueTime));
    // Срок ещё не пришёл — тик просто взведёт таймер снова (после сна часы идут вперёд, а таймер нет).
    timer = setTimeout(() => void tick(), Math.min(Math.max(soonest - now(), 0), MAX_DELAY_MS, REARM_MS));
    timer.unref?.();
  }

  /** Снимает сработавшее напоминание: разовое удаляется, повторяющееся сдвигается или (после суток) тоже удаляется. */
  function advance(item: Reminder): void {
    if (!items.some((candidate) => candidate.id === item.id)) return; // пока ход шёл, напоминание отменили
    items = items.filter((candidate) => candidate.id !== item.id);
    const next = nextDueAt(item, now());
    if (next !== null) items.push({ ...item, at: new Date(next).toISOString() });
  }

  async function tick(): Promise<void> {
    if (ticking || onDue === null) return;
    ticking = true;
    let retry = false;
    try {
      for (;;) {
        const due = items.filter((item) => dueTime(item) <= now()).sort((a, b) => dueTime(a) - dueTime(b))[0];
        if (due === undefined || stopped || onDue === null) break;
        const late = now() - dueTime(due) > MINUTE_MS;
        // Снимаем и записываем уже ПОСЛЕ ответа: остановка хоста посреди ожидания не теряет напоминание.
        // Цена — упавший хост во время хода может сработать по нему ещё раз.
        let result: DueResult = 'skipped';
        try {
          result = await onDue(due, late);
        } catch (error) {
          deps.log(`assistant: reminder ${due.id} failed: ${(error as Error).message}`);
        }
        if (result === 'later') {
          stopped = true; // хост останавливается: файл не трогаем и таймер не взводим, иначе просроченное крутилось бы по кругу
          break;
        }
        if (result === 'retry') {
          retries = retryId === due.id ? retries + 1 : 1;
          retryId = due.id;
        } else {
          retryId = null;
          retries = 0;
        }
        if (result === 'retry' && retries > MAX_RETRIES) {
          deps.log(`assistant: reminder ${due.id} dropped after ${MAX_RETRIES} retries (the assistant could not start)`);
          retryId = null;
          retries = 0;
          advance(due);
          save();
          continue;
        }
        if (result === 'retry') {
          // Напоминание остаётся как есть; повтор не через `arm()`: он сработал бы тут же, раз срок уже вышел.
          deps.log(`assistant: reminder ${due.id} postponed (the assistant is busy or not ready), retry in ${RETRY_MS / 1000} s`);
          retry = true;
          break;
        }
        advance(due);
        save();
        if (result === 'skipped') deps.log(`assistant: reminder ${due.id} skipped (the assistant cannot run now)`);
      }
    } finally {
      ticking = false;
      if (retry && !stopped) {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => void tick(), RETRY_MS);
        timer.unref?.();
      } else {
        arm();
      }
    }
  }

  return {
    add(input) {
      load();
      const what = input.what.trim();
      if (what.length < 1 || what.length > MAX_WHAT) return { error: `what must be 1–${MAX_WHAT} characters` };
      if ((input.inMinutes === undefined) === (input.at === undefined)) return { error: 'Give exactly one of in_minutes or at' };
      let at: number;
      if (input.inMinutes !== undefined) {
        if (!Number.isFinite(input.inMinutes) || input.inMinutes < 1 || input.inMinutes > 1440) return { error: 'in_minutes must be between 1 and 1440' };
        at = input.now + input.inMinutes * MINUTE_MS;
      } else {
        const text = (input.at ?? '').trim();
        const parsed = /^\d{4}-\d{2}-\d{2}T/.test(text) ? Date.parse(text) : nextLocalTime(text, input.now);
        if (parsed === null || Number.isNaN(parsed)) return { error: 'at must be an ISO 8601 time or a local HH:mm, for example 15:30' };
        if (parsed <= input.now) return { error: 'at is in the past' };
        if (parsed - input.now > REMINDER_HORIZON_MS) return { error: 'at is more than 24 hours ahead' };
        at = parsed;
      }
      if (input.everyMinutes !== undefined && (!Number.isFinite(input.everyMinutes) || input.everyMinutes < 5 || input.everyMinutes > 1440)) {
        return { error: 'every_minutes must be between 5 and 1440' };
      }
      if (items.length >= REMINDERS_MAX) return { error: `Too many reminders (${REMINDERS_MAX} at most)` };
      counter += 1;
      const stamp = new Date(input.now).toISOString();
      const reminder: Reminder = { id: `r${counter}`, what, at: new Date(at).toISOString(), every: input.everyMinutes ?? null, createdAt: stamp, askedAt: stamp };
      items.push(reminder);
      save();
      arm();
      return reminder;
    },
    list() {
      load();
      return [...items].sort((a, b) => dueTime(a) - dueTime(b));
    },
    cancel(id) {
      load();
      const before = items.length;
      items = id === '*' ? [] : items.filter((item) => item.id !== id);
      const removed = before - items.length;
      if (removed > 0) save();
      arm();
      return removed;
    },
    start(callback) {
      load();
      onDue = callback;
      stopped = false;
      void tick(); // просроченные уходят сразу, остальным — таймер
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
