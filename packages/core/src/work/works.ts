import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { assembleFromIndex } from './assemble.js';
import { JOURNAL_SCHEMA_VERSION, parseIndex, parseMap, peekSchemaVersion } from './map.js';
import { stateDir } from './state-dir.js';
import { parleyHome, readWorksIndex, workPaths } from './store.js';
import type { WorkMap } from './types.js';

/** Карта работы вместе с проектом, в котором она лежит. */
export interface WorkEntry {
  projectPath: string;
  map: WorkMap;
  /** Размер файла карты в байтах, как его прочли с диска: для счётчиков хоста, без повторного чтения. */
  bytes?: number;
  /**
   * Работа на карте v2, которую нельзя перевести на v3, пока в ней есть живая сессия (`migrate-map.ts`). Ставит хост;
   * поля нет, когда миграция не ждёт, — прежнее окно его не знает и не должно.
   */
  migrationPending?: boolean;
}

const worksDir = (projectPath: string): string => path.join(stateDir(projectPath), 'works');

/**
 * Что известно о записи, прочитанной с диска, но не лежит в самой записи (иначе оно попало бы в кадры окну и в сравнения
 * снимков): отпечаток файла карты (`mtime:size`) для повторного использования и признак карты-журнала.
 */
const entryMeta = new WeakMap<WorkEntry, { stamp: string; journal: boolean }>();

/** Запись собрана из карты-журнала (v3): письма в ней — из журналов, а не из `map.json`. */
export const isJournalEntry = (entry: WorkEntry): boolean => entryMeta.get(entry)?.journal === true;

/** Запись с другими полями, но с тем же отпечатком файла и признаком — для дельты карты в хосте. */
export function derivedEntry(entry: WorkEntry, patch: Partial<WorkEntry>): WorkEntry {
  const next = { ...entry, ...patch };
  const meta = entryMeta.get(entry);
  if (meta !== undefined) entryMeta.set(next, meta);
  return next;
}

/** Идущие разборы карт по файлу и отпечатку: наблюдатели хоста (дом и каждый проект) читают список одновременно и не должны разбирать одну карту по разу каждый. */
const parsing = new Map<string, Promise<WorkEntry | null>>();

async function parseEntry(projectPath: string, workId: string, file: string, stamp: string): Promise<WorkEntry | null> {
  const text = await readFile(file, 'utf8');
  // Карта-журнал (v3) собирается в прежнюю форму: письма читаются из журналов, `bytes` — размер индекса.
  const journal = peekSchemaVersion(text) === JOURNAL_SCHEMA_VERSION;
  const map = journal ? await assembleFromIndex(projectPath, workId, parseIndex(text, file)) : parseMap(text, file);
  const entry: WorkEntry = { projectPath, map, bytes: Buffer.byteLength(text) };
  entryMeta.set(entry, { stamp, journal });
  return entry;
}

/**
 * Читает одну карту. Её может не быть (проект переехал или удалён) или она может
 * быть битой — в списке работ это повод пропустить одну строку, а не остаться
 * без списка совсем. Отдельная работа с битой картой отвечает за себя сама
 * (`readMap` по-прежнему бросает).
 *
 * `previous` — прежняя запись этой работы: если файл карты не изменился (mtime и размер те же), она отдаётся как есть,
 * без чтения и разбора. Отпечаток снимается до чтения: запись, влезшая между ними, даст отличие в следующий раз.
 * Одновременные чтения одного и того же файла делят один разбор; `share: false` читает заново (журнал могли подменить).
 */
export async function readWorkEntry(projectPath: string, workId: string, previous?: WorkEntry, options: { share?: boolean } = {}): Promise<WorkEntry | null> {
  return (await readWorkEntryCounted(projectPath, workId, previous, options)).entry;
}

/** `parsed` — разбор сделан этим вызовом (не взят из `previous` и не присоединён к чужому разбору): только он считается разобранными байтами. */
async function readWorkEntryCounted(
  projectPath: string,
  workId: string,
  previous: WorkEntry | undefined,
  { share = true }: { share?: boolean } = {},
): Promise<{ entry: WorkEntry | null; parsed: boolean }> {
  const file = workPaths(projectPath, workId).map;
  try {
    const info = await stat(file);
    const stamp = `${info.mtimeMs}:${info.size}`;
    if (previous !== undefined && entryMeta.get(previous)?.stamp === stamp) return { entry: previous, parsed: false };
    if (!share) return { entry: await parseEntry(projectPath, workId, file, stamp), parsed: true };
    const key = `${file}\0${stamp}`;
    let pending = parsing.get(key);
    const own = pending === undefined;
    if (pending === undefined) {
      pending = parseEntry(projectPath, workId, file, stamp).finally(() => parsing.delete(key));
      parsing.set(key, pending);
    }
    return { entry: await pending, parsed: own };
  } catch {
    return { entry: null, parsed: false };
  }
}

/** Каталоги работ проекта: индекс глобальный и может ничего про них не знать. */
async function localWorkIds(projectPath: string): Promise<string[]> {
  try {
    const items = await readdir(worksDir(projectPath), { withFileTypes: true });
    return items.filter((item) => item.isDirectory()).map((item) => item.name);
  } catch {
    // `<состояние>/works` ещё нет — работ в проекте просто нет.
    return [];
  }
}

/**
 * Все работы, которые нужно показать: из глобального индекса (в том числе чужих
 * проектов — дизайн TUI, 6.5) плюс карты текущего проекта на диске.
 *
 * `archived` здесь не отсеиваются: скрывает их список, а не чтение.
 */
export async function readWorks(projectPath: string = process.cwd(), previous: readonly WorkEntry[] = []): Promise<WorkEntry[]> {
  return (await readWorksCounted(projectPath, previous)).works;
}

/**
 * `readWorks` с числом байт карт, которые разобраны на самом деле: записи из `previous` с тем же отпечатком файла
 * отдаются без чтения и в сумму не входят. `previous` ищется по проекту и номеру работы.
 */
async function readWorksCounted(projectPath: string, previous: readonly WorkEntry[]): Promise<{ works: WorkEntry[]; parsedBytes: number }> {
  const seen = new Set<string>();
  const works: WorkEntry[] = [];
  const before = new Map(previous.map((entry) => [`${entry.projectPath}\0${entry.map.work.id}`, entry]));
  let parsedBytes = 0;

  const push = async (project: string, workId: string): Promise<void> => {
    const key = `${project}\0${workId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const prior = before.get(key);
    const { entry, parsed } = await readWorkEntryCounted(project, workId, prior);
    if (entry === null) return;
    if (parsed) parsedBytes += entry.bytes ?? 0;
    works.push(entry);
  };

  for (const entry of (await readWorksIndex()).works) {
    await push(entry.projectPath, entry.id);
  }
  for (const workId of await localWorkIds(projectPath)) {
    await push(projectPath, workId);
  }

  return { works, parsedBytes };
}

/**
 * Какой файл письма или прочитанного изменился (карта-журнал, v3). Список работ такие изменения не перечитывает: письмо
 * хост дочитывает хвостом журнала, курсор — одним небольшим файлом.
 */
export type WorkFileChange =
  | { kind: 'journal'; projectPath: string; workId: string; roomId: string | null; file: string }
  | { kind: 'cursor'; projectPath: string; workId: string; sessionId: string; file: string };

export interface WatchWorksOptions {
  /** Запись карты идёт несколькими файловыми операциями — склеиваем их в одну. */
  debounceMs?: number;
  onError?: (error: unknown) => void;
  /**
   * Журнал писем или файл курсора изменился. Зовётся сразу, без склейки: строка журнала не должна слипнуться с
   * изменением индекса, и по каждому событию хост дочитывает только новые байты.
   */
  onChange?: (change: WorkFileChange) => void;
  /** Прежние записи списка: карты с тем же mtime и размером не разбираются заново (`readWorks`). */
  reuse?: () => readonly WorkEntry[];
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
 * Журнал или курсор работы по имени файла внутри `<состояние>/works`: `<работа>/rooms/<комната>/messages.jsonl`,
 * `<работа>/direct/messages.jsonl`, `<работа>/cursors/<сессия>.json`. Остальное (`messages.lock`, `.tmp`) — `null`.
 */
function classify(projectPath: string, root: string, name: string): WorkFileChange | null {
  const parts = name.split(path.sep);
  const [workId, area, third, fourth] = parts;
  if (workId === undefined || workId === '') return null;
  const file = path.join(root, name);
  if (parts.length === 4 && area === 'rooms' && third !== undefined && fourth === 'messages.jsonl') return { kind: 'journal', projectPath, workId, roomId: third, file };
  if (parts.length === 3 && area === 'direct' && third === 'messages.jsonl') return { kind: 'journal', projectPath, workId, roomId: null, file };
  if (parts.length === 3 && area === 'cursors' && third !== undefined && third.endsWith('.json')) {
    return { kind: 'cursor', projectPath, workId, sessionId: third.slice(0, -'.json'.length), file };
  }
  return null;
}

/**
 * Следит за картами работ и на изменение перечитывает список целиком: работ
 * немного, а карта пишется атомарным rename — точечного «эта работа изменилась»
 * файловая система не даёт. Карты, чей файл не изменился (`reuse`), при этом не разбираются.
 *
 * Хватает наблюдения за домом (`parleyHome`): любая запись карты обновляет и глобальный
 * индекс (см. `updateMap`), поэтому изменения чужих проектов видны тоже. Каталог
 * работ самого проекта наблюдается вдобавок — на случай другого дома.
 *
 * Письма и курсоры карты-журнала список не перечитывают: они приходят в `onChange` с именем работы и журнала.
 */
export function watchWorks(
  onWorks: (works: WorkEntry[], seq: number, parsedBytes: number) => void,
  projectPath: string = process.cwd(),
  { debounceMs = 300, onError, onChange, reuse }: WatchWorksOptions = {},
): WorksWatcher {
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let applied = 0;

  const refresh = (): void => {
    timer = undefined;
    if (closed) return;
    const seq = ++readSeq;
    readWorksCounted(projectPath, reuse?.() ?? [])
      .then(({ works, parsedBytes }) => {
        // Чтение, начатое раньше уже отданного, несёт устаревший список.
        if (closed || seq < applied) return;
        applied = seq;
        onWorks(works, seq, parsedBytes);
      })
      .catch((error: unknown) => onError?.(error));
  };

  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(refresh, debounceMs);
  };

  const watchedDirs = [parleyHome(), worksDir(projectPath)];
  for (const dir of watchedDirs) {
    try {
      const watcher = watch(dir, { recursive: true }, (_event, name) => {
        if (name === null) return;
        const changed = name.toString();
        if (relevant(changed)) {
          schedule();
          return;
        }
        // Журналы и курсоры лежат только под каталогом работ проекта.
        if (onChange === undefined || dir !== watchedDirs[1]) return;
        const change = classify(projectPath, dir, changed);
        if (change !== null && !closed) onChange(change);
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
      for (const watcher of watchers) watcher.close();
    },
  };
}
