/**
 * Журнал событий хуков работы: `events/<session-id>.jsonl`, куда хук дописывает
 * stdin-JSON Claude Code как есть (дизайн TUI v2, раздел 4.2).
 *
 * Читатель помнит смещение по каждому файлу: первое чтение — целиком, дальше
 * только новые байты. Логики состояния здесь нет — её выводит `activityOf`.
 */

import { watch, type FSWatcher } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';

/** Одна строка журнала: что произошло и когда журнал это получил. */
export interface EventRecord {
  /**
   * Момент появления события в журнале. Хук пишет stdin Claude Code как есть, и
   * своего времени в нём нет, поэтому берётся mtime журнала на момент чтения.
   */
  at: string;
  /** `hook_event_name`: `Stop`, `Notification`, `SubagentStart`… */
  name: string;
  /** `notification_type` у `Notification`; у остальных событий его нет. */
  notificationType: string | null;
}

/** Состояние чтения одного журнала: докуда дочитали и что уже разобрали. */
interface Journal {
  offset: number;
  /** Хвост без перевода строки: строку дописывают не за одну операцию. */
  tail: Buffer;
  events: EventRecord[];
}

export interface EventsLog {
  /**
   * Все события сессии в порядке файла. `null` — каталога `events/` нет: хуков
   * не будет совсем, состояние ведёт одна страховка (раздел 4.3).
   *
   * Каждое чтение отдаёт СВОЙ массив: подписчик сравнивает его по ссылке
   * (`useMemo`, `React.memo` — раздел 8.2), а внутренний растёт на месте.
   */
  read(sessionId: string): Promise<readonly EventRecord[] | null>;
}

const NEWLINE = 0x0a;

/** Разбирает строку журнала. `null` — битая строка или строка не про событие. */
function parseEvent(line: string, at: string): EventRecord | null {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;

  const record = data as Record<string, unknown>;
  const name = record.hook_event_name;
  if (typeof name !== 'string' || name === '') return null;
  const type = record.notification_type;
  return { at, name, notificationType: typeof type === 'string' ? type : null };
}

const isDirectory = async (dir: string): Promise<boolean> => {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Читатель журналов одной работы. Состояние живёт в замыкании по сессиям,
 * поэтому один читатель обслуживает всю работу и не перечитывает старые байты.
 */
export function openEvents(eventsDir: string): EventsLog {
  const journals = new Map<string, Journal>();
  /**
   * Чтения одной сессии идут по очереди (fix-tests2): состояние журнала общее, и чтение,
   * снявшее размер до дописанной строки, но закончившее после соседнего, приняло бы его
   * смещение за «журнал переписали» и отдало пустой список последним — потребитель
   * откатил бы состояние сессии до следующего хука.
   */
  const queues = new Map<string, Promise<unknown>>();

  const readOnce = async (sessionId: string): Promise<readonly EventRecord[] | null> => {
    const file = path.join(eventsDir, `${sessionId}.jsonl`);
    let handle;
    try {
      handle = await open(file, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Файла нет: либо хуки ещё не срабатывали, либо каталога нет вовсе.
      journals.delete(sessionId);
      return (await isDirectory(eventsDir)) ? [] : null;
    }

    try {
      const info = await handle.stat();
      let journal = journals.get(sessionId);
      // Файл короче прочитанного — журнал переписали, читаем его заново.
      if (journal === undefined || info.size < journal.offset) {
        journal = { offset: 0, tail: Buffer.alloc(0), events: [] };
        journals.set(sessionId, journal);
      }
      if (info.size === journal.offset) return journal.events.slice();

      const chunk = Buffer.alloc(info.size - journal.offset);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, journal.offset);
      journal.offset += bytesRead;

      const data = Buffer.concat([journal.tail, chunk.subarray(0, bytesRead)]);
      const cut = data.lastIndexOf(NEWLINE);
      journal.tail = cut === -1 ? data : data.subarray(cut + 1);
      if (cut === -1) return journal.events.slice();

      const at = info.mtime.toISOString();
      for (const line of data.subarray(0, cut).toString('utf8').split('\n')) {
        if (line.trim() === '') continue;
        const event = parseEvent(line, at);
        if (event !== null) journal.events.push(event);
      }
      return journal.events.slice();
    } finally {
      await handle.close();
    }
  };

  return {
    read(sessionId) {
      const previous = queues.get(sessionId) ?? Promise.resolve();
      const next = previous.then(
        () => readOnce(sessionId),
        () => readOnce(sessionId),
      );
      queues.set(sessionId, next);
      const forget = (): void => {
        if (queues.get(sessionId) === next) queues.delete(sessionId);
      };
      next.then(forget, forget);
      return next;
    },
  };
}

export interface WatchEventsOptions {
  /** Хук дописывает строку не за одну файловую операцию — склеиваем всплеск. */
  debounceMs?: number;
  onError?: (error: unknown) => void;
}

export interface EventsWatcher {
  close(): void;
}

/**
 * Следит за каталогом журналов работы и на каждое изменение называет сессию,
 * чей журнал вырос. Каталог плоский: `<session-id>.jsonl` и ничего больше.
 *
 * Склейка короткая: событий мало, а точка состояния должна успевать за агентом.
 */
export function watchEvents(
  eventsDir: string,
  onSession: (sessionId: string) => void,
  { debounceMs = 100, onError }: WatchEventsOptions = {},
): EventsWatcher {
  const timers = new Map<string, NodeJS.Timeout>();
  let watcher: FSWatcher | null = null;
  let closed = false;

  const schedule = (sessionId: string): void => {
    const pending = timers.get(sessionId);
    if (pending) clearTimeout(pending);
    timers.set(
      sessionId,
      setTimeout(() => {
        timers.delete(sessionId);
        if (!closed) onSession(sessionId);
      }, debounceMs),
    );
  };

  try {
    watcher = watch(eventsDir, (_event, name) => {
      if (name === null) return;
      const file = name.toString();
      if (!file.endsWith('.jsonl')) return;
      schedule(path.basename(file, '.jsonl'));
    });
    watcher.on('error', (error) => onError?.(error));
  } catch (error) {
    // Каталога может не быть: старый Claude Code без `--settings` его не заводит.
    onError?.(error);
  }

  return {
    close(): void {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      watcher?.close();
    },
  };
}
