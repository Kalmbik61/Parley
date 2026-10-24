import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { stateDir } from './state-dir.js';
import { onMapWritten, parleyHome, readMap, readWorksIndex, workVersion } from './store.js';
import type { WorkMap } from './types.js';

/** Карта работы вместе с проектом, в котором она лежит. */
export interface WorkEntry {
  projectPath: string;
  map: WorkMap;
  /**
   * Размер JSON карты в байтах, когда её собрали заново, — для счётчиков хоста, без повторного чтения: карта из кэша
   * списка приходит с 0, и счётчик не врёт про «прочитанное».
   */
  bytes?: number;
}

const worksDir = (projectPath: string): string => path.join(stateDir(projectPath), 'works');

/**
 * В тестах и разработке (`VITEST`, `PARLEY_FREEZE_MAPS=1`) карта списка замораживается: общий объект,
 * который кто-то правит «на месте», в проде тихо портил бы карту всем читателям сразу, а здесь это `TypeError`
 * в месте правки. В проде заморозки нет — обход объекта на каждую сборку лишний.
 */
const freezeMaps = process.env['VITEST'] !== undefined || process.env['PARLEY_FREEZE_MAPS'] === '1';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Карты списка по версии строки работы в базе (спека хранилища 6.9): неизменённая работа стоит одного запроса версии
 * вместо сборки карты. Карту отдаём общим объектом, не копией: читатели (`WorkEntry`) её не меняют — правки идут
 * через `updateMap`. Объект — своя копия (`readMap` выдаёт `structuredClone`), поэтому заморозка выше кэш хранилища
 * не задевает: тот мутируется `updateMap` на месте.
 */
const listedMaps = new Map<string, { version: number; map: WorkMap }>();

const listKey = (projectPath: string, workId: string): string => `${projectPath}\0${workId}`;

/**
 * Читает одну карту. Она может быть такой, что `normalizeMap` её не принимает, — в списке работ это повод
 * пропустить одну строку, а не остаться без списка совсем. Отдельная работа с такой картой отвечает за себя сама
 * (`readMap` по-прежнему бросает).
 *
 * Версию берём до карты: запись другого процесса между ними даст запоздавший ключ и лишнюю сборку при следующем
 * чтении, а не устаревшую карту под свежим ключом. `bytes` — только реальная сборка.
 */
async function readEntry(projectPath: string, workId: string): Promise<WorkEntry | null> {
  const key = listKey(projectPath, workId);
  const version = workVersion(projectPath, workId);
  if (version === undefined) {
    listedMaps.delete(key);
    return null;
  }
  const cached = listedMaps.get(key);
  if (cached !== undefined && cached.version === version) {
    return { projectPath, map: cached.map, bytes: 0 };
  }
  try {
    const copy = await readMap(projectPath, workId);
    const map = freezeMaps ? deepFreeze(copy) : copy;
    listedMaps.set(key, { version, map });
    return { projectPath, map, bytes: Buffer.byteLength(JSON.stringify(map)) };
  } catch {
    listedMaps.delete(key);
    return null;
  }
}

/**
 * Все работы, которые нужно показать: список из таблицы `works` (все проекты базы, в том числе чужие — дизайн TUI,
 * 6.5) и карта каждой из `readMap`. Каталоги проектов не читаются: всё, что Parley про работу знает, лежит в базе.
 * Аргумент-проект принимается и не используется: список один на весь дом, а вызывающие (хост, тесты) его ещё
 * передают — их правят задачи 6 и 8 плана 3.
 *
 * `archived` здесь не отсеиваются: скрывает их список, а не чтение.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- см. выше: сигнатура остаётся ради вызывающих
export async function readWorks(_projectPath?: string): Promise<WorkEntry[]> {
  const works: WorkEntry[] = [];
  const listed = new Set<string>();

  for (const item of (await readWorksIndex()).works) {
    const key = listKey(item.projectPath, item.id);
    if (listed.has(key)) continue;
    listed.add(key);
    const entry = await readEntry(item.projectPath, item.id);
    if (entry !== null) works.push(entry);
  }

  // Карты работ, которых в списке больше нет (удалены, сняты `prune`), в кэше не держим.
  for (const key of listedMaps.keys()) if (!listed.has(key)) listedMaps.delete(key);
  return works;
}

export interface WatchWorksOptions {
  /** Запись карты идёт несколькими файловыми операциями — склеиваем их в одну. */
  debounceMs?: number;
  /**
   * Следить ли за всем `parleyHome()`. По умолчанию да; наблюдателю проекта при уже заведённом
   * наблюдателе дома хватает каталога работ проекта: иначе каждая запись индекса будит каждого.
   */
  watchHome?: boolean;
  /** Чтение списка; подменяется в тестах, чтобы считать проходы. */
  read?: (projectPath: string) => Promise<WorkEntry[]>;
  onError?: (error: unknown) => void;
}

export interface WorksWatcher {
  close(): void;
}

/**
 * Номер чтения списка — общий для всех наблюдателей процесса и растёт с
 * началом чтения, а не с его концом. Чтения идут параллельно (всплеск событий,
 * несколько наблюдателей хоста), и медленное старое может закончиться позже
 * свежего: по номеру его можно узнать и отбросить.
 */
let readSeq = 0;

/** Меняют список работ только эти файлы; `map.lock`, `.bak` и `.tmp` — шум. */
const relevant = (name: string): boolean =>
  name.endsWith('map.json') || name.endsWith('works-index.json');

/**
 * Следит за работами и на изменение перечитывает список целиком: работ
 * немного, а «какая именно работа изменилась» файловая система не говорит.
 *
 * Запись базы файловая система не показывает (журнал WAL пишется без событий), поэтому при `watchHome` список
 * перечитывается по событию хранилища `onMapWritten` — по записям этого процесса. Записи других процессов
 * (CLI, MCP агента без канала) это наблюдение не видит; источник для них — опрос `PRAGMA data_version` в
 * `works-service` (план 3, задача 6), который заменит и файловое наблюдение ниже: карт и индекса на диске больше нет.
 *
 * Чтений внахлёст не бывает: пока одно идёт, события лишь помечают список «грязным».
 */
export function watchWorks(
  onWorks: (works: WorkEntry[], seq: number) => void,
  projectPath: string = process.cwd(),
  { debounceMs = 300, watchHome = true, read = readWorks, onError }: WatchWorksOptions = {},
): WorksWatcher {
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let applied = 0;
  /** Чтение идёт, и события за это время просят ровно одно повторное после него, а не чтение на каждое. */
  let reading = false;
  let dirty = false;

  const refresh = (): void => {
    timer = undefined;
    if (closed) return;
    if (reading) {
      dirty = true;
      return;
    }
    reading = true;
    const seq = ++readSeq;
    // Синхронный бросок подменённого `read` не должен оставить `reading` навсегда.
    Promise.resolve()
      .then(() => read(projectPath))
      .then((works) => {
        // Чтение, начатое раньше уже отданного, несёт устаревший список.
        if (closed || seq < applied) return;
        applied = seq;
        onWorks(works, seq);
      })
      .catch((error: unknown) => onError?.(error))
      .finally(() => {
        reading = false;
        if (dirty && !closed) {
          dirty = false;
          schedule();
        }
      });
  };

  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(refresh, debounceMs);
  };

  const unsubscribe = watchHome ? onMapWritten(schedule) : undefined;

  for (const dir of watchHome ? [parleyHome(), worksDir(projectPath)] : [worksDir(projectPath)]) {
    try {
      const watcher = watch(dir, { recursive: true }, (_event, name) => {
        if (name !== null && relevant(name.toString())) schedule();
      });
      watcher.on('error', (error) => onError?.(error));
      watchers.push(watcher);
    } catch (error) {
      // Каталога может не быть: ни одной работы ещё не создавали — это не повод
      // падать и не ошибка, о которой стоит сообщать (хост писал её в лог при
      // каждом старте, наблюдая за домом как за проектом).
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onError?.(error);
    }
  }

  return {
    close(): void {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe?.();
      for (const watcher of watchers) watcher.close();
    },
  };
}
