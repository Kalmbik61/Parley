/**
 * Повтор вызова файлового API при `files:denied` (кусок 7.2). Реестр корней main пересобирается
 * по `works.changed` асинхронно — через `realpath` (`main/roots.ts`), а окно получает то же
 * событие раньше: первый `list`, `watch` или `gitStatus` новой работы или нового worktree
 * получает отказ, хотя корень законный. Без повтора дерево осталось бы пустым до следующего
 * события, которого может и не быть.
 */

import { decodeIpcError } from '../../shared/ipc-error.js';

/** Паузы перед повторами, мс: всего около 3 с — дольше реестр не пересобирается. */
export const DENIED_RETRY_DELAYS_MS: readonly number[] = [200, 400, 800, 1600];

/** `call` до успеха или до исчерпания пауз; прочие отказы и `alive() === false` — сразу наружу. */
export async function retryWhileDenied<T>(call: () => Promise<T>, alive: () => boolean): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      const delay = DENIED_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !alive() || decodeIpcError(error).code !== 'files:denied') throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (!alive()) throw error;
    }
  }
}
