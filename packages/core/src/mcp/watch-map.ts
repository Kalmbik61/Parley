import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

/** Проба: `null` — условия ещё нет, любое другое значение возвращается вызывающему. */
export type Probe<T> = () => Promise<T | null>;

/**
 * Внешний источник «карта изменилась» вместо `fs.watch` (спека хранилища 6.9, этап 1). Хост сам знает о каждой записи
 * карты, и ожидание в его процессе не заводит файловый наблюдатель. Принимает обратный вызов и возвращает отписку:
 * `waitForMap` снимает подписку при любом исходе ожидания. Сигнал должен приходить ПОСЛЕ того, как `map.json` встал на
 * место (`rename`): по каждому сигналу ожидание сначала сверяет `stat`, и сигнал, пришедший раньше записи, видит прежнюю
 * личность файла и отбрасывается — пробуждение тогда дожидается тика опроса.
 */
export type MapChanges = (onChange: () => void) => () => void;

/**
 * Личность файла карты между пробами: `ino:size:mtimeNs`. Запись идёт атомарным `rename` (новый inode), правка на
 * месте меняет размер и время. `stat` не удался (карты нет) — `null`: личности нет, и проба зовётся, как и раньше.
 */
async function mapIdentity(mapFile: string): Promise<string | null> {
  try {
    const info = await stat(mapFile, { bigint: true });
    return [info.ino, info.size, info.mtimeNs].join(':');
  } catch {
    return null;
  }
}

/**
 * Ждёт, пока проба по карте не даст результат. Сначала проверяет текущее
 * состояние: условие могло выполниться до вызова.
 *
 * Смотрим `fs.watch` на каталоге карты, а не на самом файле: карта появляется
 * атомарным `rename`, и watch на файле остался бы на старом inode, замолчав
 * после первой же записи. Рядом идёт редкий опрос — `fs.watch` работает не на
 * каждой файловой системе, и молчаливый вечный `wait_for` хуже лишнего чтения.
 * Истёк таймаут — `null`, вызывающий отвечает агенту `{state: "running"}`.
 *
 * `changes` заменяет `fs.watch`: сигнал приходит снаружи, файловый наблюдатель не заводится. Опрос остаётся и
 * тогда — запасным на случай пропущенного сигнала.
 *
 * Повод позвать пробу — не то же, что запись карты: одна запись даёт несколько событий `fs.watch`, а тик опроса
 * приходит, пока карта стоит. Проба разбирает карту целиком, и на каждый повод она слишком дорога (спека
 * хранилища 6.9). Поэтому по любому поводу сначала `stat`, и проба зовётся, только если личность файла не та, что
 * при прошлой пробе. Личность берётся ДО пробы: запись, пришедшая посреди неё, оставит другую личность и вызовет
 * пробу ещё раз, а снятая после пробы затёрла бы эту запись. Отсюда условие к пробе: она должна зависеть только от
 * карты. Перемену чего-то другого (флаг остановки, своё состояние) ожидание не заметит, пока карта стоит, —
 * такую перемену будят через `signal`.
 *
 * `signal` — отмена вызова клиентом (агент прервал ход): ждать больше некого, ожидание
 * прекращается сразу и тоже даёт `null` — ответ на отменённый вызов всё равно отбросят.
 */
export async function waitForMap<T>(
  mapFile: string,
  probe: Probe<T>,
  timeoutMs: number,
  pollMs: number,
  signal?: AbortSignal,
  changes?: MapChanges,
): Promise<T | null> {
  if (signal?.aborted) return null;
  // Личность снимается до первой пробы, а не после: см. выше.
  let probed = await mapIdentity(mapFile);
  const found = await probe();
  if (found !== null) return found;
  if (signal?.aborted) return null;

  return new Promise<T | null>((resolve, reject) => {
    let done = false;
    let watcher: FSWatcher | undefined;
    let unsubscribe: (() => void) | undefined;

    const stop = (): void => {
      done = true;
      clearInterval(poll);
      clearTimeout(deadline);
      watcher?.close();
      unsubscribe?.();
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      if (done) return;
      stop();
      resolve(null);
    };

    const check = async (): Promise<void> => {
      if (done) return;
      const identity = await mapIdentity(mapFile);
      // Тот же файл, что видела прошлая проба, — звать нечего. Одновременные поводы одной записи тоже сходятся
      // здесь: первый запоминает личность до пробы, остальные видят её же.
      if (done || (identity !== null && identity === probed)) return;
      probed = identity;
      try {
        const result = await probe();
        if (done || result === null) return;
        stop();
        resolve(result);
      } catch (error) {
        if (done) return;
        stop();
        reject(error as Error);
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    const poll = setInterval(() => void check(), pollMs);
    const deadline = setTimeout(() => {
      stop();
      resolve(null);
    }, timeoutMs);

    try {
      if (changes !== undefined) {
        unsubscribe = changes(() => void check());
      } else {
        watcher = watch(path.dirname(mapFile), (_event, name) => {
          if (name === null || name === path.basename(mapFile)) void check();
        });
        // Сорвавшийся watch не должен ронять ожидание: остаётся опрос.
        watcher.on('error', () => watcher?.close());
      }
    } catch {
      // Не завёлся наблюдатель или подписка сорвалась — остаётся опрос.
      watcher = undefined;
    }
  });
}
