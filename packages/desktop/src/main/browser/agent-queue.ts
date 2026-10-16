/**
 * Очередь страницы агента и срок операции (спека 2026-10-07-browser-devtools-agent-design.md, 3.7): операции к одной
 * странице идут строго по одной; зависшая команда CDP не держит очередь дольше срока.
 */
import { AgentOpError } from './agent-errors.js';

/** Срок операции в main: очередь страницы не ждёт зависшую команду CDP дольше хоста. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AgentOpError('timeout', message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface PageQueue {
  /** Задача в очереди ключа: стартует после предыдущей, отказ предыдущей её не останавливает. */
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
}

export function createPageQueue(): PageQueue {
  /** Хвост очереди каждой страницы. */
  const queues = new Map<string, Promise<void>>();
  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const next = (queues.get(key) ?? Promise.resolve()).then(task);
      const tail = next.then(() => undefined, () => undefined);
      queues.set(key, tail);
      void tail.then(() => {
        if (queues.get(key) === tail) queues.delete(key);
      });
      return next;
    },
  };
}
