/**
 * Единая очередь исходящих Telegram (план B, задача 5): один исполнитель, приоритеты `card` > `notice` > `typing`,
 * внутри приоритета FIFO. Лимиты Bot API соблюдаются здесь, а не в вызывающих: 429 ставит всю очередь на паузу.
 */

import { BotApiError } from './api.js';

export type Priority = 'card' | 'notice' | 'typing';

export interface OutboxJob {
  priority: Priority;
  /** Задание с тем же ключом, уже стоящее в очереди, заменяется (typing, правки одного сообщения). */
  key?: string;
  run(): Promise<void>;
  /** Задание не будет выполнено: очередь выброшена или оно отброшено после повторов. После успеха не зовётся. */
  onDrop?(): void;
}

export interface Outbox {
  enqueue(job: OutboxJob): void;
  /** Выбрасывает очередь (выключение, 409), у каждого стоявшего задания зовётся `onDrop`; текущее задание не повторяется. */
  clear(): void;
  size(): number;
  idle(): Promise<void>;
}

const ORDER: readonly Priority[] = ['card', 'notice', 'typing'];
const NETWORK_RETRIES = 3;
const NETWORK_RETRY_MS = 2_000;

export function createOutbox(deps: { log(line: string): void; now?(): number; setTimeout?: typeof setTimeout }): Outbox {
  const timer = deps.setTimeout ?? setTimeout;
  const queues: Record<Priority, OutboxJob[]> = { card: [], notice: [], typing: [] };
  let running = false;
  /** Растёт при `clear()`: пауза/повтор прерванного задания понимает, что очередь выброшена. */
  let epoch = 0;
  let waiters: Array<() => void> = [];

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => timer(resolve, ms));
  const size = (): number => queues.card.length + queues.notice.length + queues.typing.length;
  const next = (): OutboxJob | undefined => {
    for (const priority of ORDER) {
      const job = queues[priority].shift();
      if (job !== undefined) return job;
    }
    return undefined;
  };

  /** Выполняет задание с повторами; если очередь выброшена во время паузы, повтор не делается. */
  const execute = async (job: OutboxJob): Promise<void> => {
    const startEpoch = epoch;
    let networkFailures = 0;
    for (;;) {
      try {
        await job.run();
        return;
      } catch (error) {
        if (epoch !== startEpoch) return job.onDrop?.();
        if (error instanceof BotApiError && error.status === 429) {
          await sleep(Math.max(1, error.retryAfter ?? 1) * 1000);
          if (epoch !== startEpoch) return job.onDrop?.();
          continue;
        }
        if (error instanceof BotApiError && error.status === 0 && networkFailures < NETWORK_RETRIES) {
          networkFailures += 1;
          await sleep(NETWORK_RETRY_MS);
          if (epoch !== startEpoch) return job.onDrop?.();
          continue;
        }
        const reason = error instanceof Error ? error.message : String(error);
        deps.log(`telegram outbox: job dropped (${job.priority}${job.key === undefined ? '' : ` ${job.key}`}): ${reason}`);
        return job.onDrop?.();
      }
    }
  };

  const pump = async (): Promise<void> => {
    running = true;
    for (let job = next(); job !== undefined; job = next()) await execute(job);
    running = false;
    const done = waiters;
    waiters = [];
    for (const resolve of done) resolve();
  };

  return {
    enqueue(job) {
      const queue = queues[job.priority];
      const index = job.key === undefined ? -1 : queue.findIndex((item) => item.key === job.key);
      if (index >= 0) queue[index] = job;
      else queue.push(job);
      if (!running) void pump();
    },
    clear() {
      epoch += 1;
      const dropped = [...queues.card, ...queues.notice, ...queues.typing];
      queues.card = [];
      queues.notice = [];
      queues.typing = [];
      for (const job of dropped) job.onDrop?.();
    },
    size,
    idle() {
      if (!running && size() === 0) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}
