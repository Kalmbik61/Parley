import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { assembleFromIndex } from './assemble.js';
import { DIRECT_CURSOR_KEY, MAX_MARKS, cursorFile, journalFile, journalLine, type JournalLetter } from './journal.js';
import { recipientsOf } from './letters.js';
import { hasLiveProcess } from './liveness.js';
import { JOURNAL_SCHEMA_VERSION, parseIndex, parseMap, peekSchemaVersion } from './map.js';
import { DEFAULT_LOCK_TIMEOUT_MS, MapLockTimeoutError, updateIndex, withLock, workPaths, writeAtomic } from './store.js';
import { HUMAN, type Message, type V2Kept, type WorkIndexMap, type WorkMap } from './types.js';

/**
 * Миграция карты v2 → v3 (спека 2026-10-16, B5): письма раскладываются по журналам, `readBy` становится курсорами,
 * `decisionExports` — файлом `decisions.json`, индекс без писем ложится последним.
 *
 * ПОРЯДОК НА ДИСКЕ (всё под `map.lock`, поэтому писатели v2 ждут):
 *   1. `map.v2.json` — копия прочитанных байт `map.json` (откат);
 *   2. `rooms/<id>/messages.jsonl` и `direct/messages.jsonl` — каждый целиком, заменой файла;
 *   3. `cursors/<сессия>.json` — каталог курсоров собирается заново;
 *   4. `decisions.json`;
 *   5. сверка в памяти: сборщик по ещё не записанному индексу даёт те же письма (число и id) — иначе отказ;
 *   6. `map.json` — индекс v3, атомарно, ПОСЛЕДНИЙ шаг.
 * До шага 6 карта на диске остаётся v2 и читается как раньше: файлы шагов 2–4 для читателя v2 не существуют.
 *
 * ПОВТОР. На v3 вызов ничего не делает (`already-journal`). После сбоя до шага 6 повтор начинает с нуля: журналы и
 * курсоры пишутся заменой, а не дописыванием, поэтому письма не удваиваются, а остатки сорванной попытки
 * (курсор сессии, которой больше нет, журнал опустевшей комнаты) убираются.
 *
 * Сбой — результат `failed` с шагом, а не исключение: хост на старте от миграции не зависит (как `migrate.ts`).
 */

/** Шаги миграции; после каждого, кроме `index`, вызывается `afterStep` (для тестов: бросок = сбой на этом шаге). */
export type MigrationStep = 'copy' | 'journals' | 'cursors' | 'decisions' | 'verify' | 'index';

export interface MigrateMapOptions {
  lockTimeoutMs?: number;
  /**
   * Запуск хоста, который переводит работу (время его старта, ISO); ложится в индекс как `migratedRun`.
   * Не задан — момент вызова: такая миграция считается свежей для любого хоста, начатого до неё.
   */
  run?: string;
  afterStep?: (step: MigrationStep) => void | Promise<void>;
}

export type MigrateMapResult =
  | {
      status: 'migrated';
      /** Письма, записанные в журналы. */
      letters: number;
      /** Письма комнаты, которой нет в индексе: в журнал не идут (собрать их нечем), остаются только в `map.v2.json`. */
      orphaned: number;
      /** Файлов курсоров и отметок в них. */
      cursors: number;
      marks: number;
      /** Отметки сверх `MAX_MARKS` на журнал: самые старые отброшены, письма снова выглядят непрочитанными. */
      droppedMarks: number;
      /** Позиций, где собранный порядок писем не совпал с порядком v2 (равное время в обратном порядке журналов, часы назад). */
      orderMismatches: number;
      /** Писем, у которых набор читателей после сборки не совпал с `readBy` v2 (не адресат, архивная комната). */
      readByMismatches: number;
    }
  | { status: 'skipped'; reason: 'no-map' | 'not-v2' | 'already-journal' | 'locked' | 'live-session' }
  | { status: 'failed'; step: MigrationStep | 'read'; detail: string };

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const keyOf = (roomId: string | null): string => (roomId === null ? DIRECT_CURSOR_KEY : roomId);

/**
 * Есть ли в работе живая сессия. Решает та же проверка, что у сверки живости хоста (`hasLiveProcess`): `active` по
 * pid и времени старта процесса, `sleeping` — жив ли процесс, `pending` и `closed` — нет. Вызывать после
 * `reconcileLiveness`: мёртвые `active` там уже стали `sleeping`.
 */
export async function hasLiveSession(map: Pick<WorkMap, 'sessions'>): Promise<boolean> {
  for (const session of map.sessions) if (await hasLiveProcess(session)) return true;
  return false;
}

/** Читатели письма как в сборщике: адресаты (`recipientsOf`) и человек на письмах, которые он видит. */
function readersOf(message: Message, map: WorkMap): Set<string> {
  const readers = new Set(recipientsOf(message, map));
  if (message.from !== HUMAN && (message.roomId !== null || message.to.includes(HUMAN))) readers.add(HUMAN);
  return readers;
}

interface Cursor {
  watermark?: string;
  marks: string[];
}

/**
 * `readBy` → курсоры. Читатель идёт по письмам журнала, которые мог прочесть (адресованным ему): пока подряд прочитано —
 * водораздел стоит на последнем прочитанном; первое непрочитанное — разрыв, прочитанные ПОСЛЕ него (вразнобой) уходят в
 * отметки. Так непрочитанное остаётся непрочитанным: водораздел на самом новом прочитанном письме проглотил бы разрыв.
 * Без разрывов (обычный случай) курсор — просто самое новое прочитанное письмо.
 */
function cursorsOf(journal: readonly Message[], map: WorkMap): Map<string, Cursor> {
  const readers = new Set<string>();
  for (const message of journal) for (const reader of Object.keys(message.readBy)) readers.add(reader);
  const result = new Map<string, Cursor>();
  for (const reader of readers) {
    const cursor: Cursor = { marks: [] };
    let gap = false;
    for (const message of journal) {
      if (!readersOf(message, map).has(reader)) continue;
      if (message.readBy[reader] === undefined) gap = true;
      else if (gap) cursor.marks.push(message.id);
      else cursor.watermark = message.id;
    }
    if (cursor.watermark !== undefined || cursor.marks.length > 0) result.set(reader, cursor);
  }
  return result;
}

/** Есть ли расхождение, из-за которого `map.v2.json` нельзя удалять. */
const hasDropped = (kept: V2Kept): boolean => kept.orphaned > 0 || kept.droppedMarks > 0 || kept.readByMismatches > 0 || kept.orderMismatches > 0;

const toLetter = (message: Message, seq: number): JournalLetter => {
  const letter = { ...message, seq } as Message & { seq: number };
  delete (letter as { readBy?: unknown }).readBy;
  delete (letter as { textBytes?: unknown }).textBytes;
  return letter as unknown as JournalLetter;
};

/** Сколько писем сборка вернула не теми и не в том порядке: потеря письма — отказ, порядок и читатели — счётчики. */
function compare(expected: readonly Message[], assembled: readonly Message[]): { orderMismatches: number; readByMismatches: number } {
  const want = new Set(expected.map((message) => message.id));
  if (assembled.length !== expected.length || assembled.some((message) => !want.has(message.id))) {
    throw new Error(`the assembled map has ${assembled.length} letters, the v2 map ${expected.length}: the migration would lose or invent letters`);
  }
  const byId = new Map(assembled.map((message) => [message.id, message]));
  // Время чтения курсор не хранит: сборщик ставит время письма, поэтому сверяются читатели, а не значения.
  const readers = (message: Message): string => Object.keys(message.readBy).sort().join(',');
  return {
    orderMismatches: expected.filter((message, at) => assembled[at]?.id !== message.id).length,
    readByMismatches: expected.filter((message) => readers(message) !== readers(byId.get(message.id)!)).length,
  };
}

export async function migrateMapToJournal(projectPath: string, workId: string, options: MigrateMapOptions = {}): Promise<MigrateMapResult> {
  const { lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS, afterStep, run = new Date().toISOString() } = options;
  const paths = workPaths(projectPath, workId);
  const v2Copy = path.join(paths.dir, 'map.v2.json');
  if (!(await stat(paths.map).then(() => true, () => false))) return { status: 'skipped', reason: 'no-map' };
  let step: MigrationStep | 'read' = 'read';
  const done = async (finished: MigrationStep): Promise<void> => {
    step = finished;
    await afterStep?.(finished);
  };
  try {
    return await withLock(paths.lock, lockTimeoutMs, async (): Promise<MigrateMapResult> => {
      let raw: string;
      try {
        raw = await readFile(paths.map, 'utf8');
      } catch (error) {
        if (missing(error)) return { status: 'skipped', reason: 'no-map' };
        throw error;
      }
      const version = peekSchemaVersion(raw);
      if (version === JOURNAL_SCHEMA_VERSION) return { status: 'skipped', reason: 'already-journal' };
      if (version !== 2) return { status: 'skipped', reason: 'not-v2' };
      const map = parseMap(raw, paths.map);
      // Живая сессия проверяется ЗДЕСЬ, на карте, прочитанной под замком: снимок хоста устарел бы, если сессия ожила
      // между ним и замком (resume, запуск, ждавший тот же `map.lock`). Проверка хоста до вызова — лишь дешёвый фильтр.
      if (await hasLiveSession(map)) return { status: 'skipped', reason: 'live-session' };

      // 1. Откат: байты, которые прочитали, а не пересчёт. Прежняя копия (сорванная попытка) заменяется: истина — `map.json`.
      step = 'copy';
      await writeAtomic(v2Copy, raw);
      await done('copy');

      // 2. Журналы: каждый заменой файла, номер строки — позиция в v2-массиве, id остаются прежними (`m-NN`).
      step = 'journals';
      const roomIds = new Set(map.rooms.map((room) => room.id));
      const keys: (string | null)[] = [null, ...map.rooms.map((room) => room.id)];
      const orphans = map.messages.filter((message) => message.roomId !== null && !roomIds.has(message.roomId));
      const byKey = new Map<string, Message[]>(keys.map((roomId) => [keyOf(roomId), []]));
      for (const message of map.messages) byKey.get(keyOf(message.roomId))?.push(message);
      for (const roomId of keys) {
        const letters = byKey.get(keyOf(roomId))!;
        const file = journalFile(paths, roomId);
        if (letters.length === 0) {
          await rm(file, { force: true });
          continue;
        }
        await mkdir(path.dirname(file), { recursive: true });
        await writeAtomic(file, letters.map((message, at) => journalLine(toLetter(message, at + 1))).join(''));
      }
      await done('journals');

      // 3. Курсоры: каталог собирается заново, чужие остатки сорванной попытки в нём не остаются.
      step = 'cursors';
      await rm(paths.cursors, { recursive: true, force: true });
      const perReader = new Map<string, Record<string, unknown>>();
      let marks = 0;
      let droppedMarks = 0;
      for (const roomId of keys) {
        const key = keyOf(roomId);
        for (const [reader, cursor] of cursorsOf(byKey.get(key)!, map)) {
          const file = perReader.get(reader) ?? {};
          if (cursor.watermark !== undefined) file[key] = cursor.watermark;
          if (cursor.marks.length > 0) {
            const kept = cursor.marks.slice(-MAX_MARKS);
            droppedMarks += cursor.marks.length - kept.length;
            marks += kept.length;
            file.marks = { ...(file.marks as Record<string, string[]> | undefined), [key]: kept };
          }
          perReader.set(reader, file);
        }
      }
      if (perReader.size > 0) await mkdir(paths.cursors, { recursive: true });
      for (const [reader, file] of perReader) await writeAtomic(cursorFile(paths, reader), `${JSON.stringify(file)}\n`);
      await done('cursors');

      // 4. Решения. Формат записи — как у приёмника писем (`letter-sink.ts`).
      step = 'decisions';
      if (map.decisionExports === undefined) await rm(paths.decisions, { force: true });
      else await writeAtomic(paths.decisions, `${JSON.stringify(map.decisionExports)}\n`);
      await done('decisions');

      // 5. Сверка до записи индекса: сборщик по индексу в памяти должен отдать все письма v2. Порядок слияния сборщика —
      // по времени письма (`mergeByTime`), v2 хранил один массив в порядке записи; где они расходятся (равное время в
      // обратном порядке журналов, часы назад), письма целы, но порядок иной, и это уходит в результат, а не прячется.
      step = 'verify';
      const index = { ...map } as Record<string, unknown>;
      delete index.schemaVersion;
      delete index.messages;
      delete index.decisionExports;
      const orphanIds = new Set(orphans.map((message) => message.id));
      const expected = map.messages.filter((message) => !orphanIds.has(message.id));
      const assembled = await assembleFromIndex(projectPath, workId, { schemaVersion: JOURNAL_SCHEMA_VERSION, ...index } as unknown as WorkIndexMap);
      const { orderMismatches, readByMismatches } = compare(expected, assembled.messages);
      // ПРАВИЛО КОПИИ: ничего не отброшено и не расходится — копия может быть убрана позже (`finishV2Cleanup`); хоть одно
      // число не ноль — `v2Kept` в индексе, и копия не удаляется никогда: она единственная хранит то, чего нет в журналах.
      const kept: V2Kept = { orphaned: orphans.length, droppedMarks, readByMismatches, orderMismatches };
      const indexMap = {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        ...index,
        v2Removed: false,
        migratedRun: run,
        ...(hasDropped(kept) ? { v2Kept: kept } : {}),
      } as unknown as WorkIndexMap;
      await done('verify');

      // 6. Индекс — последним и атомарно: до этой строки карта на диске v2. `schemaVersion` — первый ключ (`peekSchemaVersion`).
      step = 'index';
      await writeAtomic(paths.map, `${JSON.stringify(indexMap, null, 2)}\n`);
      return {
        status: 'migrated',
        letters: expected.length,
        orphaned: orphans.length,
        cursors: perReader.size,
        marks,
        droppedMarks,
        orderMismatches,
        readByMismatches,
      };
    });
  } catch (error) {
    if (error instanceof MapLockTimeoutError) return { status: 'skipped', reason: 'locked' };
    return { status: 'failed', step, detail: errorText(error) };
  }
}

/**
 * Удаление `map.v2.json` (спека B5, план задачи 7). Копия живёт, пока её не прочли все потребители новой раскладки.
 * Миграция пишет в индекс `v2Removed: false`, `migratedRun` (запуск хоста, который перевёл работу) и, если что-то не
 * воспроизведено, `v2Kept`. Копия удаляется и ставится `v2Removed: true`, только когда выполнено ВСЁ:
 *   1. `v2Kept` в индексе нет: ни письма без комнаты, ни отброшенные отметки, ни расхождение читателей или порядка —
 *      иначе `kept-dropped`, копия остаётся навсегда (причину пишет хост в журнал по счётчикам индекса);
 *   2. `migratedRun` раньше `currentRun`, запуска хоста, который зовёт уборку: копия, сделанная этим запуском (или чужим
 *      запуском, начатым после него), его собственным не убирается — иначе `same-run`;
 *   3. индекс собирается (`assembleFromIndex`) — собранная карта и есть то, что читают окно и панели; иначе `kept`.
 * Идемпотентна: копии нет, а флаг ложен (сорвалось между удалением и флагом) — ставится только флаг.
 */
export async function finishV2Cleanup(
  projectPath: string,
  workId: string,
  currentRun: string,
): Promise<'removed' | 'kept' | 'kept-dropped' | 'same-run' | 'nothing'> {
  const paths = workPaths(projectPath, workId);
  let raw: string;
  try {
    raw = await readFile(paths.map, 'utf8');
  } catch (error) {
    if (missing(error)) return 'nothing';
    throw error;
  }
  if (peekSchemaVersion(raw) !== JOURNAL_SCHEMA_VERSION) return 'nothing';
  let index: WorkIndexMap;
  try {
    index = parseIndex(raw, paths.map);
  } catch {
    return 'kept';
  }
  if (index.v2Removed !== false) return 'nothing';
  if (index.v2Kept !== undefined) return 'kept-dropped';
  if (index.migratedRun === undefined || index.migratedRun >= currentRun) return 'same-run';
  try {
    await assembleFromIndex(projectPath, workId, index);
  } catch {
    return 'kept';
  }
  await rm(path.join(paths.dir, 'map.v2.json'), { force: true });
  await updateIndex(projectPath, workId, (current) => {
    current.v2Removed = true;
  }, { touch: false });
  return 'removed';
}

/** Остатки миграции в каталоге работы: нужны хосту, чтобы не звать `finishV2Cleanup` по каждой работе подряд. */
export async function hasV2Copy(projectPath: string, workId: string): Promise<boolean> {
  return stat(path.join(workPaths(projectPath, workId).dir, 'map.v2.json')).then(() => true, () => false);
}
