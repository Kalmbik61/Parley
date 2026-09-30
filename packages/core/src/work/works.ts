import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseMap } from './map.js';
import { parleyHome, readWorksIndex, workPaths } from './store.js';
import type { WorkMap } from './types.js';

/** Карта работы вместе с проектом, в котором она лежит. */
export interface WorkEntry {
  projectPath: string;
  map: WorkMap;
}

const worksDir = (projectPath: string): string => path.join(projectPath, '.harnas', 'works');

/**
 * Читает одну карту. Её может не быть (проект переехал или удалён) или она может
 * быть битой — в списке работ это повод пропустить одну строку, а не остаться
 * без списка совсем. Отдельная работа с битой картой отвечает за себя сама
 * (`readMap` по-прежнему бросает).
 */
async function readEntry(projectPath: string, workId: string): Promise<WorkEntry | null> {
  const file = workPaths(projectPath, workId).map;
  try {
    return { projectPath, map: parseMap(await readFile(file, 'utf8'), file) };
  } catch {
    return null;
  }
}

/** Каталоги работ проекта: индекс глобальный и может ничего про них не знать. */
async function localWorkIds(projectPath: string): Promise<string[]> {
  try {
    const items = await readdir(worksDir(projectPath), { withFileTypes: true });
    return items.filter((item) => item.isDirectory()).map((item) => item.name);
  } catch {
    // `.harnas/works` ещё нет — работ в проекте просто нет.
    return [];
  }
}

/**
 * Все работы, которые нужно показать: из глобального индекса (в том числе чужих
 * проектов — дизайн TUI, 6.5) плюс карты текущего проекта на диске.
 *
 * `archived` здесь не отсеиваются: скрывает их список, а не чтение.
 */
export async function readWorks(projectPath: string = process.cwd()): Promise<WorkEntry[]> {
  const seen = new Set<string>();
  const works: WorkEntry[] = [];

  const push = async (project: string, workId: string): Promise<void> => {
    const key = `${project}\0${workId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const entry = await readEntry(project, workId);
    if (entry !== null) works.push(entry);
  };

  for (const entry of (await readWorksIndex()).works) {
    await push(entry.projectPath, entry.id);
  }
  for (const workId of await localWorkIds(projectPath)) {
    await push(projectPath, workId);
  }

  return works;
}

export interface WatchWorksOptions {
  /** Запись карты идёт несколькими файловыми операциями — склеиваем их в одну. */
  debounceMs?: number;
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
 * Следит за картами работ и на изменение перечитывает список целиком: работ
 * немного, а карта пишется атомарным rename — точечного «эта работа изменилась»
 * файловая система не даёт.
 *
 * Хватает наблюдения за `HARNAS_HOME`: любая запись карты обновляет и глобальный
 * индекс (см. `updateMap`), поэтому изменения чужих проектов видны тоже. Каталог
 * работ самого проекта наблюдается вдобавок — на случай другого `HARNAS_HOME`.
 */
export function watchWorks(
  onWorks: (works: WorkEntry[], seq: number) => void,
  projectPath: string = process.cwd(),
  { debounceMs = 300, onError }: WatchWorksOptions = {},
): WorksWatcher {
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let applied = 0;

  const refresh = (): void => {
    timer = undefined;
    if (closed) return;
    const seq = ++readSeq;
    readWorks(projectPath)
      .then((works) => {
        // Чтение, начатое раньше уже отданного, несёт устаревший список.
        if (closed || seq < applied) return;
        applied = seq;
        onWorks(works, seq);
      })
      .catch((error: unknown) => onError?.(error));
  };

  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(refresh, debounceMs);
  };

  for (const dir of [parleyHome(), worksDir(projectPath)]) {
    try {
      const watcher = watch(dir, { recursive: true }, (_event, name) => {
        if (name !== null && relevant(name.toString())) schedule();
      });
      watcher.on('error', (error) => onError?.(error));
      watchers.push(watcher);
    } catch (error) {
      // Каталога может не быть: ни одной работы ещё не создавали — это не повод
      // падать и не ошибка, о которой стоит сообщать (хост писал её в лог при
      // каждом старте, наблюдая за HARNAS_HOME как за проектом).
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onError?.(error);
    }
  }

  return {
    close(): void {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    },
  };
}
