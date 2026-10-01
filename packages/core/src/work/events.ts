/**
 * Журнал событий хуков работы: `events/<session-id>.jsonl`, куда хук дописывает
 * stdin-JSON Claude Code как есть (дизайн TUI v2, раздел 4.2). Строки со своим
 * `hook_event_name` дописывает и MCP-сервер сессии — начало и конец `wait_for`
 * (`ParleyWaitStart`, `ParleyWaitEnd`).
 *
 * Читатель помнит смещение по каждому файлу: первое чтение — целиком, дальше
 * только новые байты. Логики состояния здесь нет — её выводит `activityOf`; из
 * строки берутся лишь поля, которые ему нужны.
 */

import { watch, type FSWatcher } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Фоновая задача из `background_tasks` хука — снимок на момент события. Claude Code
 * кладёт его в КАЖДОЕ событие: `Stop`, `SubagentStop`, `Notification`… `id` совпадает
 * с `agent_id` из `SubagentStart`.
 */
export interface BackgroundTask {
  id: string;
  /** Вид задачи: `subagent`; у других видов (фоновая команда…) своя семантика. */
  type: string;
  /** `running`, `completed`… */
  status: string;
  /** `agent_type` задачи; пустая строка и отсутствие — `null`. */
  agentType: string | null;
  /** Короткое описание задачи; пустая строка и отсутствие — `null`. */
  description: string | null;
}

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
  /** `agent_id` у `SubagentStart` и `SubagentStop`; у остальных событий его нет. */
  agentId: string | null;
  /** `agent_type`; пустая строка (у `SubagentStop` она частая) — `null`. */
  agentType: string | null;
  /** `transcript_path` — транскрипт родителя; субагенты лежат рядом с ним. */
  transcriptPath: string | null;
  /**
   * `background_tasks` — снимок фоновых задач. `null` — поля в строке нет (или оно не
   * список): сведений нет, прежний снимок остаётся; `[]` — поле есть, задач нет.
   */
  backgroundTasks: BackgroundTask[] | null;
  /** `parley_wait_target` у `ParleyWaitStart`: на что ждёт `wait_for` (id сессии или `inbox`). */
  waitTarget: string | null;
  /**
   * `parley_wait_id` у `ParleyWaitStart` и `ParleyWaitEnd`: случайный id одного вызова `wait_for`. Вызовов
   * бывает несколько сразу, и конец снимает только своё ожидание. Строк прежних версий без него — `null`.
   */
  waitId: string | null;
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

/**
 * Кадр спиннера терминала Codex: агент работает. Хост записывает его в свёртку вместо журнала (хуков у Codex
 * нет). Как `UserPromptSubmit`, оно начинает ход, но ожидания `wait_for` не снимает: время сигнала
 * обновляется на каждом кадре и всегда новее строки `ParleyWaitStart`, а новым ходом кадр не является.
 */
export const TERMINAL_WORKING_EVENT = 'TerminalWorking';

/**
 * Событие без полей хука: все необязательные поля пусты. Так записывается событие, которого в
 * журнале нет, — хост выводит его из сигнала терминала Codex.
 */
export const bareEvent = (at: string, name: string): EventRecord => ({
  at,
  name,
  notificationType: null,
  agentId: null,
  agentType: null,
  transcriptPath: null,
  backgroundTasks: null,
  waitTarget: null,
  waitId: null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Непустая строка или `null`: Claude Code шлёт пустую строку вместо отсутствующего значения. */
const textOf = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/**
 * Разбирает `background_tasks`. Кривой элемент (не объект, нет `id`, `type` или `status`)
 * пропускается, остальные и сама строка живут. Не список — `null`: прочитать нечего.
 */
function parseTasks(value: unknown): BackgroundTask[] | null {
  if (!Array.isArray(value)) return null;
  const tasks: BackgroundTask[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = textOf(item.id);
    const type = textOf(item.type);
    const status = textOf(item.status);
    if (id === null || type === null || status === null) continue;
    tasks.push({
      id,
      type,
      status,
      agentType: textOf(item.agent_type),
      description: textOf(item.description),
    });
  }
  return tasks;
}

/** Разбирает строку журнала. `null` — битая строка или строка не про событие. */
function parseEvent(line: string, at: string): EventRecord | null {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;

  const name = data.hook_event_name;
  if (typeof name !== 'string' || name === '') return null;
  return {
    ...bareEvent(at, name),
    notificationType: typeof data.notification_type === 'string' ? data.notification_type : null,
    agentId: textOf(data.agent_id),
    agentType: textOf(data.agent_type),
    transcriptPath: textOf(data.transcript_path),
    backgroundTasks: parseTasks(data.background_tasks),
    waitTarget: textOf(data.parley_wait_target),
    waitId: textOf(data.parley_wait_id),
  };
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
