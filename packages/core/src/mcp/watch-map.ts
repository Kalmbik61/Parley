import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

/** Проба: `null` — условия ещё нет, любое другое значение возвращается вызывающему. */
export type Probe<T> = () => Promise<T | null>;

/**
 * Ждёт, пока проба по карте не даст результат. Сначала проверяет текущее
 * состояние: условие могло выполниться до вызова.
 *
 * Смотрим `fs.watch` на каталоге карты, а не на самом файле: карта появляется
 * атомарным `rename`, и watch на файле остался бы на старом inode, замолчав
 * после первой же записи. Рядом идёт редкий опрос — `fs.watch` работает не на
 * каждой файловой системе, и молчаливый вечный `wait_for` хуже лишнего чтения.
 * Истёк таймаут — `null`, вызывающий отвечает агенту `{state: "running"}`.
 */
export async function waitForMap<T>(
  mapFile: string,
  probe: Probe<T>,
  timeoutMs: number,
  pollMs: number,
): Promise<T | null> {
  const found = await probe();
  if (found !== null) return found;

  return new Promise<T | null>((resolve, reject) => {
    let done = false;
    let watcher: FSWatcher | undefined;

    const stop = (): void => {
      done = true;
      clearInterval(poll);
      clearTimeout(deadline);
      watcher?.close();
    };

    const check = (): void => {
      if (done) return;
      probe().then(
        (result) => {
          if (done || result === null) return;
          stop();
          resolve(result);
        },
        (error: unknown) => {
          if (done) return;
          stop();
          reject(error as Error);
        },
      );
    };

    const poll = setInterval(check, pollMs);
    const deadline = setTimeout(() => {
      stop();
      resolve(null);
    }, timeoutMs);

    try {
      watcher = watch(path.dirname(mapFile), (_event, name) => {
        if (name === null || name === path.basename(mapFile)) check();
      });
      // Сорвавшийся watch не должен ронять ожидание: остаётся опрос.
      watcher.on('error', () => watcher?.close());
    } catch {
      watcher = undefined;
    }
  });
}
