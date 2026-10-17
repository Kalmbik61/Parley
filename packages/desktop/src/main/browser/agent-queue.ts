/**
 * Очередь страницы агента и срок операции (спека 2026-10-07-browser-devtools-agent-design.md, 3.7): операции к одной
 * странице идут строго по одной; срок считается с постановки в очередь, а очередь освобождается по факту конца задачи.
 */
import { AgentOpError } from './agent-errors.js';

export interface PageQueue {
  /**
   * Задача в очереди ключа: стартует после предыдущей, отказ предыдущей её не останавливает. `deadline` — момент (`Date.now()`),
   * к которому вызывающий получает `timeout`; задача к этому моменту получает отмену (`signal`), но хвост очереди ждёт её
   * настоящего конца, а не таймера. Задача, чей срок вышел до старта, не запускается.
   */
  run<T>(key: string, deadline: number, task: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

export function createPageQueue(): PageQueue {
  /** Хвост очереди каждой страницы. */
  const queues = new Map<string, Promise<void>>();
  return {
    run<T>(key: string, deadline: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const controller = new AbortController();
      const total = Math.max(0, deadline - Date.now());
      let begun = false;
      const finished = (queues.get(key) ?? Promise.resolve()).then(() => {
        if (Date.now() >= deadline) throw new AgentOpError('timeout', 'The operation waited too long behind other operations on this page.');
        begun = true;
        return task(controller.signal);
      });
      const tail = finished.then(() => undefined, () => undefined);
      queues.set(key, tail);
      void tail.then(() => {
        if (queues.get(key) === tail) queues.delete(key);
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new AgentOpError(
              'timeout',
              begun ? `The operation took longer than ${Math.round(total / 1000)} s.` : 'The operation waited too long behind other operations on this page.',
            ),
          );
        }, total);
      });
      return Promise.race([finished, expired]).finally(() => clearTimeout(timer));
    },
  };
}
