import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DIRECT_CURSOR_KEY,
  mergeByTime,
  parseCursorFile,
  parseLetters,
  readCursorFile,
  readMessages,
  unreadableCursorsMessage,
  type JournalLetter,
  type CursorFile,
} from './journal.js';
import { recipientsOf } from './letters.js';
import { attachPreviewSink, attachSink, JournalLetterSink } from './letter-sink.js';
import { JOURNAL_SCHEMA_VERSION, parseIndex, parseMap, peekSchemaVersion } from './map.js';
import { readIndex, workPaths, type WorkPaths } from './store.js';
import { validateDecisionJournalStorage, type DecisionJournalIntent } from './decision-journal.js';
import { HUMAN, type Message, type WorkIndexMap, type WorkMap } from './types.js';

/**
 * Сборщик карты-журнала (спека 2026-10-16, B3, B5): индекс + письма всех журналов + `decisions.json` в прежней форме
 * `WorkMap`. Читатели, которых эта работа не переписывает, получают то, что давала карта v2.
 *
 * Собранная карта несёт `schemaVersion: 2` — это форма, а не файл на диске: писать её целиком нельзя
 * (`updateMap` на карте-журнале пишет один индекс).
 */

/** Ключ журнала в курсорах и в списке журналов: id комнаты или `direct`. */
const keyOf = (roomId: string | null): string => (roomId === null ? DIRECT_CURSOR_KEY : roomId);

/**
 * Журналы работы: прямые письма первыми, затем комнаты индекса в его порядке. Комнаты, которых в индексе нет, не читаются.
 *
 * Инвариант: журнал комнаты живёт ровно столько, сколько сама комната в индексе; удаление комнаты обязано удалить и её
 * журнал (задача 6). В v2 письма удалённой комнаты уходили из карты вместе с ней (`rooms.ts`), поэтому комната без
 * письма здесь верна. Пока удаление журнал не убирает, сборщик предупреждает о журнале комнаты, которой нет в индексе
 * (`strayWarning`), а не молчит.
 */
const journalKeys = (index: WorkIndexMap): (string | null)[] => [null, ...index.rooms.map((room) => room.id)];

interface Parts {
  /** Письма по ключу журнала, в порядке журнала. */
  journals: Map<string, JournalLetter[]>;
  /** Курсоры по id сессии (в том числе `human`). */
  cursors: Map<string, CursorFile>;
  decisions: DecisionJournalIntent[] | undefined;
}

/**
 * Кому у письма стоит отметка `readBy`: адресатам (`recipientsOf`) и человеку на письмах, которые он видит (`unreadForHuman`:
 * не его собственные, прямые — только ему). Общее правило сборки и дельты (`appendLetters`, `applyCursors`).
 */
function readersOf(message: Message, shape: WorkMap): Set<string> {
  return new Set([...recipientsOf(message, shape), ...(message.from !== HUMAN && (message.roomId !== null || message.to.includes(HUMAN)) ? [HUMAN] : [])]);
}

function compose(index: WorkIndexMap, keys: (string | null)[], { journals, cursors, decisions }: Parts): WorkMap {
  // Позиция письма в своём журнале и позиция курсора там же: прочитано, если курсор на письме или за ним.
  const positions = new Map<string, Map<string, number>>();
  for (const [key, letters] of journals) positions.set(key, new Map(letters.map((letter, at) => [letter.id, at])));

  // Форма карты для `recipientsOf`: ему нужны только комнаты индекса.
  const shape = { ...index, schemaVersion: 2, messages: [] } as unknown as WorkMap;
  const deletedSessions = new Set(index.work.deletedSessions ?? []);
  const ordered = mergeByTime(keys.map((roomId) => journals.get(keyOf(roomId)) ?? []));
  const messages: Message[] = ordered.map((row) => {
    const letter = { ...row };
    delete (letter as { seq?: number }).seq;
    const key = keyOf(letter.roomId);
    const own = positions.get(key)?.get(letter.id) ?? -1;
    const message = { ...letter, readBy: {} } as Message;
    // Письма удалённой сессии помечает `removeSession` на v2; журнал дописывается только вперёд, поэтому метка
    // выводится из `work.deletedSessions` (номера сессий не переиспользуются).
    if (deletedSessions.has(letter.from) || letter.to.some((id) => deletedSessions.has(id))) message.deleted = true;
    // Правило `readBy`, как в v2: отметка стоит у адресата письма (`recipientsOf` — не у отправителя и не у сессии,
    // которой письмо не предназначалось) и у человека для писем, которые он видит (`unreadForHuman`: не его
    // собственные, прямые — только ему). Остальные сессии отметки не получают, даже если курсор ушёл дальше.
    //
    // КУРСОР — ВОДОРАЗДЕЛ плюс разреженные отметки (форма файла — у `SessionCursors`): «прочитано» значит «всё до
    // водораздела включительно» или «письмо отмечено отдельно». Явное «прочёл» человека из окна (`markHumanRead`) двигает
    // водораздел (цена спеки), а отметка мутатора на только что добавленной системной строке — только отметка:
    // письма человеку, лежащие позади неё, остаются непрочитанными.
    for (const sessionId of readersOf(message, shape)) {
      const file = cursors.get(sessionId);
      const cursor = file?.cursors[key];
      const read = cursor === undefined ? -1 : (positions.get(key)?.get(cursor) ?? -1);
      // Время чтения курсор не хранит: отметкой служит время самого письма. Читатели проверяют наличие отметки.
      // Прочитано по водоразделу или по разреженной отметке (`marks`): системная строка не гасит письма позади себя.
      if (own !== -1 && (read >= own || file?.marks[key]?.includes(letter.id) === true)) message.readBy[sessionId] = letter.at;
    }
    return message;
  });

  // Работа «двигается» с каждым письмом: письмо индекс не пишет, поэтому `updatedAt` — позднее из индекса и писем.
  const newest = messages.reduce((latest, message) => (message.at > latest ? message.at : latest), index.work.updatedAt);
  const rest = { ...index };
  delete (rest as { schemaVersion?: unknown }).schemaVersion;
  const map: WorkMap = {
    ...rest,
    schemaVersion: 2,
    work: { ...index.work, updatedAt: newest },
    messages,
    ...(decisions === undefined ? {} : { decisionExports: decisions }),
  };
  validateDecisionJournalStorage(map); // та же проверка, что у `parseMap` карты v2: битый журнал решений — отказ читать
  return map;
}

function parseDecisions(text: string, file: string): DecisionJournalIntent[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`decisions ${file} cannot be parsed: ${(error as Error).message}`);
  }
  if (!Array.isArray(value)) throw new Error(`decisions ${file} cannot be parsed: expected an array`);
  return value as DecisionJournalIntent[];
}

/** Комнаты в каталоге `rooms/`, которых нет в индексе. Предупреждение одно на журнал; письма таких журналов в карту не входят. */
function strayWarning(room: string, file: string): string {
  return `journal ${file}: room ${room} is not in the index, its letters are left out of the map (room deletion must remove the journal)`;
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const sessionOf = (name: string): string | null => (name.endsWith('.json') ? name.slice(0, -'.json'.length) : null);

/** Сборка из индекса, уже прочитанного вызывающим (`readMap` не читает индекс дважды). */
export async function assembleFromIndex(projectPath: string, workId: string, index: WorkIndexMap): Promise<WorkMap> {
  const paths = workPaths(projectPath, workId);
  const keys = journalKeys(index);
  const journals = new Map<string, JournalLetter[]>();
  await Promise.all(
    keys.map(async (roomId) => {
      journals.set(keyOf(roomId), await readMessages(projectPath, workId, roomId, { limit: Infinity, maxBytes: Infinity }));
    }),
  );
  const strays = (await readdir(paths.rooms).catch(() => [] as string[])).filter((name) => !index.rooms.some((room) => room.id === name));
  await Promise.all(
    strays.map(async (name) => {
      const file = path.join(paths.rooms, name, 'messages.jsonl');
      if (await access(file).then(() => true, () => false)) console.warn(strayWarning(name, file));
    }),
  );
  const cursors = new Map<string, CursorFile>();
  const names = await readdir(paths.cursors).catch((error: unknown) => {
    if (missing(error)) return [] as string[];
    throw error;
  });
  await Promise.all(
    names.map(async (name) => {
      const sessionId = sessionOf(name);
      if (sessionId !== null) cursors.set(sessionId, await readCursorFile(projectPath, workId, sessionId));
    }),
  );
  const decisions = await readFile(paths.decisions, 'utf8').then(
    (text) => parseDecisions(text, paths.decisions),
    (error: unknown) => {
      if (missing(error)) return undefined;
      throw error;
    },
  );
  return compose(index, keys, { journals, cursors, decisions });
}

/**
 * Индекс поверх уже собранной карты той же работы: сессии, комнаты и всё, что лежит в индексе, берутся из него, письма и
 * решения (`messages`, `decisionExports`) остаются как в `base`. Для хоста, который уже держит собранную карту и ведёт её
 * хвостом журналов: после записи индекса (сверка живости) журналы читать заново незачем. `work.updatedAt` — позднее из
 * индекса и `base` (письмо индекс не двигает). `base` должна быть собрана из журналов этой же работы, не из карты v2.
 */
export function rebaseOnIndex(base: WorkMap, index: WorkIndexMap): WorkMap {
  const rest = { ...index };
  delete (rest as { schemaVersion?: unknown }).schemaVersion;
  const updatedAt = base.work.updatedAt > index.work.updatedAt ? base.work.updatedAt : index.work.updatedAt;
  return {
    ...rest,
    schemaVersion: 2,
    work: { ...index.work, updatedAt },
    messages: base.messages,
    ...(base.decisionExports === undefined ? {} : { decisionExports: base.decisionExports }),
  } as unknown as WorkMap;
}

/**
 * Карта с письмами ОДНОЙ комнаты: индекс плюс журнал этой комнаты, без остальных журналов, курсоров и решений. Для читателей,
 * которым нужна одна комната и её участники (история комнаты): `readMap` на карте-журнале читает журналы всех комнат.
 * Письма — без `readBy` (курсоры не читаются). Карта v2 разбирается целиком, как в `readMap`: письма всех комнат уже в файле.
 */
export async function readMapWithRoom(projectPath: string, workId: string, roomId: string): Promise<WorkMap> {
  const file = workPaths(projectPath, workId).map;
  const raw = await readFile(file, 'utf8');
  if (peekSchemaVersion(raw) !== JOURNAL_SCHEMA_VERSION) return parseMap(raw, file);
  const index = parseIndex(raw, file);
  const letters = index.rooms.some((room) => room.id === roomId)
    ? await readMessages(projectPath, workId, roomId, { limit: Infinity, maxBytes: Infinity })
    : [];
  const rest = { ...index };
  delete (rest as { schemaVersion?: unknown }).schemaVersion;
  const messages = letters.map((letter) => {
    const message = { ...letter, readBy: {} };
    delete (message as { seq?: number }).seq;
    return message as Message;
  });
  return { ...rest, schemaVersion: 2, messages } as unknown as WorkMap;
}

/**
 * Карта для примерки резервирования эффектов плана (`reservePlanEffects`): индекс, `decisionExports` из `decisions.json`
 * и приёмник примерки вместо писем. Письма не читаются: примерке нужны планы, комнаты и письма Parley за последний час,
 * а их даёт приёмник из хвостов журналов, и только если в очереди что-то есть. Карту можно передавать в `reservePlanEffects`
 * без копии: он копирует то, что меняет, а записать что-либо через эту карту нельзя. Карта v2 — обычный разбор, как в `readMap`.
 */
export async function readMapForPlanPreview(projectPath: string, workId: string): Promise<WorkMap> {
  const file = workPaths(projectPath, workId).map;
  const raw = await readFile(file, 'utf8');
  if (peekSchemaVersion(raw) !== JOURNAL_SCHEMA_VERSION) return parseMap(raw, file);
  const map = lazyJournalMap(projectPath, workId, parseIndex(raw, file));
  attachPreviewSink(map, projectPath, workId);
  return map;
}

// ---------------------------------------------------------------------------------------------------------------
// Дельта собранной карты (хост, задача 8): хвост журнала или курсор меняют карту в памяти, не читая диск. Результат
// совпадает с полной сборкой (`assembleMap`) на тех же файлах; прежняя карта не меняется — её уже раздали слушателям.

/**
 * Карта с дописанными письмами журналов (`letters` — новые строки, в порядке журнала). Письма комнат, которых в карте нет,
 * пропускаются: комнату принесёт индекс, и его перечитывание соберёт карту заново. `cursors` — курсоры, уже известные
 * вызывающему: отметка на новом письме (системная строка мутатора) могла прийти раньше самого письма.
 */
export function appendLetters(map: WorkMap, letters: readonly JournalLetter[], cursors: ReadonlyMap<string, CursorFile> = new Map()): WorkMap {
  const keys = journalKeys(map as unknown as WorkIndexMap);
  const lists = new Map<string, Message[]>(keys.map((roomId) => [keyOf(roomId), []]));
  for (const message of map.messages) lists.get(keyOf(message.roomId))?.push(message);
  const added = new Map<string, JournalLetter[]>();
  for (const letter of letters) {
    const key = keyOf(letter.roomId);
    if (lists.has(key)) added.set(key, [...(added.get(key) ?? []), letter]);
  }
  if (added.size === 0) return map;
  const deletedSessions = new Set(map.work.deletedSessions ?? []);
  let newest = map.work.updatedAt;
  for (const [key, rows] of added) {
    rows.forEach((row, at) => {
      const letter = { ...row };
      delete (letter as { seq?: number }).seq;
      const message = { ...letter, readBy: {} } as Message;
      if (deletedSessions.has(letter.from) || letter.to.some((id) => deletedSessions.has(id))) message.deleted = true;
      for (const sessionId of readersOf(message, map)) {
        const file = cursors.get(sessionId);
        const cursor = file?.cursors[key];
        // Водораздел на этом письме или на письме позади него в той же порции; отметка — на самом письме.
        const covered = cursor !== undefined && rows.slice(at).some((later) => later.id === cursor);
        if (file !== undefined && (covered || file.marks[key]?.includes(letter.id) === true)) message.readBy[sessionId] = letter.at;
      }
      lists.get(key)!.push(message);
      if (message.at > newest) newest = message.at;
    });
  }
  return {
    ...map,
    work: newest === map.work.updatedAt ? map.work : { ...map.work, updatedAt: newest },
    messages: mergeByTime(keys.map((roomId) => lists.get(keyOf(roomId))!)),
  };
}

/**
 * Карта с пересчитанным `readBy` одной сессии по её файлу курсоров (`undefined` — файла нет: ничего не прочитано).
 * Письма, чья отметка не изменилась, остаются прежними объектами.
 */
export function applyCursors(map: WorkMap, sessionId: string, file: CursorFile | undefined): WorkMap {
  const counts = new Map<string, number>();
  const cursorAt = new Map<string, number>();
  const positions = map.messages.map((message) => {
    const key = keyOf(message.roomId);
    const position = counts.get(key) ?? 0;
    counts.set(key, position + 1);
    if (file?.cursors[key] === message.id) cursorAt.set(key, position);
    return position;
  });
  let changed = false;
  const messages = map.messages.map((message, at) => {
    if (!readersOf(message, map).has(sessionId)) return message;
    const key = keyOf(message.roomId);
    const read = file !== undefined && ((cursorAt.get(key) ?? -1) >= positions[at]! || file.marks[key]?.includes(message.id) === true);
    if (read === (message.readBy[sessionId] !== undefined)) return message;
    changed = true;
    const readBy = { ...message.readBy };
    if (read) readBy[sessionId] = message.at;
    else delete readBy[sessionId];
    return { ...message, readBy };
  });
  return changed ? { ...map, messages } : map;
}

/** `map.json` v3 + журналы + `decisions.json` → `WorkMap` прежней формы. */
export async function assembleMap(projectPath: string, workId: string): Promise<WorkMap> {
  return assembleFromIndex(projectPath, workId, await readIndex(projectPath, workId));
}

// ---------------------------------------------------------------------------------------------------------------
// Синхронное чтение существует потому, что мутатор `updateMap` синхронный: `async` в него не втиснуть. Платит за него
// только тот, кто действительно читает письма или решения (ленивая сборка при первом обращении): мутатор `updateMap`
// или вызывающий, которому вернулась карта (`lazyJournalMap`). Читает под замком работы (`map.lock`), поэтому журналы и курсоры не меняются
// между чтениями. Разбор строк и файлов курсоров общий с асинхронным чтением (`parseLetters`, `parseCursors`).

function readLettersSync(file: string): JournalLetter[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  return parseLetters(text, file);
}

function readCursorsSync(paths: WorkPaths): Map<string, CursorFile> {
  const cursors = new Map<string, CursorFile>();
  let names: string[];
  try {
    names = readdirSync(paths.cursors);
  } catch (error) {
    if (missing(error)) return cursors;
    throw error;
  }
  for (const name of names) {
    const sessionId = sessionOf(name);
    if (sessionId === null) continue;
    const file = path.join(paths.cursors, name);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if (missing(error)) continue;
      console.warn(unreadableCursorsMessage(file));
      continue;
    }
    const value = parseCursorFile(text);
    if (value === null) console.warn(unreadableCursorsMessage(file));
    else cursors.set(sessionId, value);
  }
  return cursors;
}

/** Письма синхронно (все журналы, курсоры): `readdir`/`readFile` журналов начинаются только отсюда. */
function messagesSync(paths: WorkPaths, index: WorkIndexMap): Message[] {
  try {
    for (const name of readdirSync(paths.rooms)) {
      const file = path.join(paths.rooms, name, 'messages.jsonl');
      if (!index.rooms.some((room) => room.id === name) && existsSync(file)) console.warn(strayWarning(name, file));
    }
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const keys = journalKeys(index);
  const journals = new Map(keys.map((roomId) => [keyOf(roomId), readLettersSync(roomId === null ? paths.direct : path.join(paths.rooms, roomId, 'messages.jsonl'))]));
  return compose(index, keys, { journals, cursors: readCursorsSync(paths), decisions: undefined }).messages;
}

/** Решения синхронно; той же проверкой, что у `parseMap` карты v2. Файла нет — `undefined`. */
function decisionsSync(paths: WorkPaths, index: WorkIndexMap): DecisionJournalIntent[] | undefined {
  let decisions: DecisionJournalIntent[];
  try {
    decisions = parseDecisions(readFileSync(paths.decisions, 'utf8'), paths.decisions);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  validateDecisionJournalStorage({ work: index.work, decisionExports: decisions });
  return decisions;
}

type LetterField = 'messages' | 'decisionExports';
const LETTER_FIELDS: readonly LetterField[] = ['messages', 'decisionExports'];

/**
 * Ленивая сборка полей, которых нет в индексе. `decisionExports` есть, только когда есть `decisions.json` (у v2 поле тоже
 * необязательное): это проверка существования (`stat`), не чтение. Каждое поле читается при первом обращении и запоминается;
 * письма не читают решения, и наоборот. Журналы и файл решений читаются под замком работы, пока мутатор или `finish` её держат,
 * а после — при первом обращении вызывающего (письмо, добавленное за это время, увидит и он).
 */
function lazyParts(projectPath: string, workId: string, index: WorkIndexMap): { fields: LetterField[]; read: (field: LetterField) => Message[] & DecisionJournalIntent[] } {
  const paths = workPaths(projectPath, workId);
  const fields = LETTER_FIELDS.filter((field) => field === 'messages' || existsSync(paths.decisions));
  const memo = new Map<LetterField, unknown>();
  const read = (field: LetterField): Message[] & DecisionJournalIntent[] => {
    if (!memo.has(field)) memo.set(field, field === 'messages' ? messagesSync(paths, index) : decisionsSync(paths, index));
    return memo.get(field) as Message[] & DecisionJournalIntent[];
  };
  return { fields, read };
}

/**
 * Карта, которую `updateMap` возвращает на карте-журнале: ОБЫЧНЫЙ объект (не `Proxy`) с полями индекса, у которого
 * `messages` и `decisionExports` — перечислимые настраиваемые свойства-аксессоры. Журналы не читаются, пока их не спросили:
 * запись индекса стоит только записи индекса. Перечисление, `in`, расширение, `JSON.stringify` и `structuredClone`
 * вызывают аксессоры и видят письма как на карте v2. Присвоение поля заменяет аксессор обычным значением.
 * `work.updatedAt` здесь — из индекса (сдвинут записью); письмо, более позднее, чем запись, его не двигает (у `readMap` двигает).
 */
export function lazyJournalMap(projectPath: string, workId: string, index: WorkIndexMap): WorkMap {
  const rest = { ...index };
  delete (rest as { schemaVersion?: unknown }).schemaVersion;
  const map = { ...rest, schemaVersion: 2 } as unknown as WorkMap;
  const { fields, read } = lazyParts(projectPath, workId, index);
  for (const field of fields) {
    Object.defineProperty(map, field, {
      enumerable: true,
      configurable: true,
      get: () => read(field),
      set: (value: unknown) => void Object.defineProperty(map, field, { value, writable: true, enumerable: true, configurable: true }),
    });
  }
  return map;
}

/** Попытка изменить письма или решения карты-журнала через `updateMap`: писать их надо в журнал. */
export class MapJournalReadonlyError extends Error {
  readonly code = 'map-journal-readonly';
  constructor(what: 'messages' | 'decisionExports') {
    super(
      what === 'messages'
        ? 'map.messages is read-only on a journal workspace (schemaVersion 3): add a letter with appendMessage, mark letters read with writeCursor'
        : 'map.decisionExports is read-only on a journal workspace (schemaVersion 3): decisions live in decisions.json — use the decisions journal API, not updateMap',
    );
    this.name = 'MapJournalReadonlyError';
  }
}

/** Глубокая обёртка только для чтения: чтение как обычно, любая запись — `MapJournalReadonlyError`. */
function readOnly<T extends object>(value: T, what: 'messages' | 'decisionExports', cache: WeakMap<object, object>): T {
  const cached = cache.get(value);
  if (cached !== undefined) return cached as T;
  const refuse = (): never => {
    throw new MapJournalReadonlyError(what);
  };
  const proxy = new Proxy(value, {
    get(target, key) {
      const item: unknown = Reflect.get(target, key);
      return typeof item === 'object' && item !== null ? readOnly(item, what, cache) : item;
    },
    set: refuse,
    deleteProperty: refuse,
    defineProperty: refuse,
    setPrototypeOf: refuse,
    preventExtensions: refuse,
  });
  cache.set(value, proxy);
  return proxy;
}

/**
 * Карта для мутатора `updateMap` на карте-журнале: обычный объект с копией полей индекса (вложенные объекты общие с индексом,
 * поэтому их правка уходит в индекс) и аксессорами `messages` и `decisionExports`, читающими журналы при первом обращении.
 * Мутатор, не трогающий письма, не читает ни одного журнала. Присвоить поле тем же содержимым (`map.messages = [...map.messages]`
 * в черновиках планов) можно — это не запись; иное содержимое — `MapJournalReadonlyError` сразу. Сами письма отдаются только
 * для чтения (`readOnly`): `push`, `splice`, индекс, `sort`, `length`, `delete` — та же ошибка.
 *
 * Перечисление, `in`, расширение и `JSON.stringify` видят оба поля как на карте v2. Сторона платы за охрану: письма в
 * мутаторе — `Proxy` только для чтения, поэтому `structuredClone(map)` и `structuredClone(map.messages)` внутри мутатора
 * невозможны (клонировать прокси нельзя в принципе); вне мутатора возвращённая карта (`lazyJournalMap`) клонируется.
 *
 * Верхнеуровневые присвоения (`map.work = ...`, `map.planEffects ??= []`) идут в копию, поэтому `commit` после мутатора
 * переносит их в индекс и проверяет охрану: `delete map.messages`, `defineProperty` поверх аксессора или значение, присвоенное
 * несуществующему `decisionExports`, — `MapJournalReadonlyError` до записи на диск.
 */
export function journalMapView(projectPath: string, workId: string, index: WorkIndexMap): { view: WorkMap; commit: () => void; sink: JournalLetterSink } {
  const cache = new WeakMap<object, object>();
  const { fields, read } = lazyParts(projectPath, workId, index);
  const view = { ...index } as unknown as WorkMap;
  // Письма и решения, которые мутатор добавляет (`addMessage`, `captureDecisionJournal`), уходят в приёмник, а не в
  // `messages`: журнал дописывает `updateStored` при сохранении, под замками журналов (`letter-sink.ts`).
  const sink = new JournalLetterSink(projectPath, workId);
  attachSink(view, sink);
  const getters = new Map<LetterField, () => unknown>();
  for (const field of fields) {
    const get = (): unknown => {
      const value = read(field);
      // Письма очереди видны рядом с письмами журналов: `captureDecisionJournal` ищет только что добавленное решение.
      if (field === 'messages') sink.mergePending(value as Message[]);
      return value === undefined ? undefined : readOnly(value, field, cache);
    };
    getters.set(field, get);
    Object.defineProperty(view, field, {
      enumerable: true,
      configurable: true,
      get,
      set(value: unknown) {
        // Сравнение с тем, что видит мутатор (охраняемые копии одного кэша), а не с сырым массивом.
        const current = get() as readonly unknown[] | undefined;
        // Черновик плана (`edit` в plans.ts) снимает копию `messages`, а письма, которые мутатор добавил после
        // снимка, лежат в очереди приёмника: копия — начало текущего списка и не короче того, что уже в журналах.
        const onDisk = current === undefined ? 0 : current.length - (field === 'messages' ? sink.pending.length : 0);
        const same =
          Array.isArray(value) &&
          current !== undefined &&
          value.length >= onDisk &&
          value.length <= current.length &&
          value.every((item, at) => item === current[at]);
        if (!same) throw new MapJournalReadonlyError(field);
      },
    });
  }
  const commit = (): void => {
    for (const field of LETTER_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(view, field);
      if (getters.has(field) ? descriptor?.get !== getters.get(field) : descriptor !== undefined) throw new MapJournalReadonlyError(field);
    }
    const target = index as unknown as Record<string, unknown>;
    const source = view as unknown as Record<string, unknown>;
    for (const key of Object.keys(source)) if (!LETTER_FIELDS.includes(key as LetterField)) target[key] = source[key];
    for (const key of Object.keys(target)) if (!(key in source)) delete target[key];
  };
  return { view, commit, sink };
}
