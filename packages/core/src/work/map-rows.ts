/**
 * Раскладка карты работы в строки базы (спека хранилища 6.2) и обратно. Чистое преобразование данных, базы здесь нет:
 * `store.ts` читает и пишет строки, а этот модуль решает, какие из них изменились.
 *
 * Карта делится на три части:
 * - `work` — запись работы целиком (`JSON.stringify(map.work)`);
 * - `extra` — всё, что не список: `schemaVersion`, `resources`, незнакомые поля верхнего уровня и перечень
 *   присутствовавших необязательных коллекций (`present`), чтобы сборка вернула ровно тот же набор полей;
 * - строки `entries` — по одной на элемент списков карты: сессию, письмо, комнату, план и так далее.
 *
 * Изменения находятся по ключу и содержимому JSON, не по ссылке на объект: часть мутаторов заменяет массивы
 * клонами целиком (`plans.ts`, `plan-effects.ts`), `deleteRoom` фильтрует их, `removeSession` вырезает записи.
 */

import type { WorkMap } from './types.js';

export type EntryKind =
  | 'session'
  | 'message'
  | 'room'
  | 'plan'
  | 'planExport'
  | 'decisionExport'
  | 'planEffect'
  | 'planBacklogIntent';

/** Поле карты, в котором живёт список каждого вида. Порядок ключей — порядок видов при сборке и записи. */
export const ENTRY_FIELDS: Record<
  EntryKind,
  | 'sessions'
  | 'messages'
  | 'rooms'
  | 'plans'
  | 'planExports'
  | 'decisionExports'
  | 'planEffects'
  | 'planBacklogIntents'
> = {
  session: 'sessions',
  message: 'messages',
  room: 'rooms',
  plan: 'plans',
  planExport: 'planExports',
  decisionExport: 'decisionExports',
  planEffect: 'planEffects',
  planBacklogIntent: 'planBacklogIntents',
};

type EntryField = (typeof ENTRY_FIELDS)[EntryKind];

const KINDS = Object.keys(ENTRY_FIELDS) as EntryKind[];

/** Списки, которых в карте может не быть: сборка возвращает их, только если они были (`present`). */
const OPTIONAL_FIELDS: readonly EntryField[] = [
  'plans',
  'planExports',
  'decisionExports',
  'planEffects',
  'planBacklogIntents',
];

/** Поля верхнего уровня, которые знает схема. Всё остальное уходит в `extra` как есть. `compact` не хранится. */
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'work',
  'resources',
  'compact',
  ...Object.values(ENTRY_FIELDS),
]);

export interface StoredRow {
  kind: EntryKind;
  key: string;
  ord: number;
  json: string;
}

export interface MapRows {
  work: string;
  extra: string;
  rows: StoredRow[];
}

/** Содержимое `extra_json`. Незнакомые поля лежат вложенным объектом `foreign`: служебные имена (`present`) им не мешают. */
interface Extra {
  schemaVersion: unknown;
  resources?: unknown;
  present: EntryField[];
  foreign: Record<string, unknown>;
}

const rowKey = (kind: EntryKind, key: string): string => `${kind}\u0000${key}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Естественный ключ записи; `undefined` — записи нечем назвать (битая запись, которой нет в проверках формы). */
function naturalKey(kind: EntryKind, entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined;
  switch (kind) {
    case 'planExport':
      return typeof entry['file'] === 'string' ? entry['file'] : undefined;
    case 'decisionExport':
      return `${String(entry['roomId'])}/${String(entry['proposalId'])}/${String(entry['rev'])}`;
    case 'planEffect':
    case 'planBacklogIntent':
      return typeof entry['key'] === 'string' ? entry['key'] : undefined;
    default:
      return typeof entry['id'] === 'string' ? entry['id'] : undefined;
  }
}

/**
 * Ключи записей массива по порядку. Старые карты не проверяли уникальность id сессий, писем, комнат и экспортов,
 * поэтому повтор получает суффикс `#2`, `#3` в порядке массива. Записи без естественного ключа называются по месту.
 */
function uniqueKeys(kind: EntryKind, entries: readonly unknown[]): string[] {
  const used = new Set<string>();
  const repeats = new Map<string, number>();
  return entries.map((entry, index) => {
    const base = naturalKey(kind, entry) ?? `#${index}`;
    let key = base;
    let count = repeats.get(base) ?? 0;
    while (used.has(key)) {
      count += 1;
      key = `${base}#${count + 1}`;
    }
    repeats.set(base, count);
    used.add(key);
    return key;
  });
}

/**
 * Порядок строк одного вида. Прежний `ord` сохраняется, пока прежние ключи идут в прежнем порядке: удаление из
 * середины и добавление в конец не трогают соседей. Новые ключи в конце получают `max + 1`. Если порядок прежних
 * ключей нарушен или новый ключ встал перед старым — вид нумеруется заново с нуля.
 */
function orderOf(
  kind: EntryKind,
  keys: readonly string[],
  previous: ReadonlyMap<string, StoredRow> | undefined,
): number[] {
  const kept = keys.map((key) => previous?.get(rowKey(kind, key))?.ord);
  let last = -1;
  let seenNew = false;
  for (const ord of kept) {
    if (ord === undefined) {
      seenNew = true;
    } else if (seenNew || ord <= last) {
      return keys.map((_, index) => index);
    } else {
      last = ord;
    }
  }
  return kept.map((ord) => ord ?? ++last);
}

/**
 * Раскладывает карту в строки. `previous` — индекс строк, уже лежащих в базе (`rowIndex`): по нему сохраняется `ord`.
 */
export function mapToRows(map: WorkMap, previous?: ReadonlyMap<string, StoredRow>): MapRows {
  const rows: StoredRow[] = [];
  const present: EntryField[] = [];
  for (const kind of KINDS) {
    const field = ENTRY_FIELDS[kind];
    const entries = map[field] as readonly unknown[] | undefined;
    if (entries === undefined) continue;
    if (OPTIONAL_FIELDS.includes(field)) present.push(field);
    const keys = uniqueKeys(kind, entries);
    const ords = orderOf(kind, keys, previous);
    entries.forEach((entry, index) => {
      rows.push({ kind, key: keys[index]!, ord: ords[index]!, json: JSON.stringify(entry) });
    });
  }

  const foreign: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(map)) {
    if (!KNOWN_FIELDS.has(name)) foreign[name] = value;
  }
  const extra: Extra = { schemaVersion: map.schemaVersion, present, foreign };
  if (map.resources !== undefined) extra.resources = map.resources;
  return { work: JSON.stringify(map.work), extra: JSON.stringify(extra), rows };
}

/**
 * Собирает из строк сырой объект карты в порядке `ord`. Форму не проверяет и миграций не делает: дальше его ведёт
 * `normalizeMap`, как и текст `map.json`. Строки раскладываются по видам за один проход; выборка `ORDER BY kind, ord`
 * (`loadStored`) и строки `mapToRows` уже идут по возрастанию `ord`, а сортировка упорядоченного списка — один проход
 * без перестановок (спека хранилища 6.2, план 4, задача 5). Порядок выборки от этого не зависит: вперемешку строки
 * тоже собираются верно. Строка неизвестного вида пропускается, как и раньше.
 */
export function rowsToMap(work: string, extra: string, rows: readonly StoredRow[]): unknown {
  const stored = JSON.parse(extra) as Extra;
  const byKind = new Map<EntryKind, StoredRow[]>(KINDS.map((kind) => [kind, []]));
  for (const row of rows) byKind.get(row.kind)?.push(row);
  const lists = {} as Record<EntryField, unknown[]>;
  for (const kind of KINDS) {
    lists[ENTRY_FIELDS[kind]] = (byKind.get(kind) as StoredRow[])
      .sort((a, b) => a.ord - b.ord)
      .map((row) => JSON.parse(row.json) as unknown);
  }
  const map: Record<string, unknown> = {
    schemaVersion: stored.schemaVersion,
    work: JSON.parse(work) as unknown,
    sessions: lists.sessions,
    messages: lists.messages,
    rooms: lists.rooms,
  };
  for (const field of stored.present) map[field] = lists[field];
  if (stored.resources !== undefined) map['resources'] = stored.resources;
  return Object.assign(map, stored.foreign);
}

/** Строки по ключу `вид\u0000ключ`: так `mapToRows` ищет прежний `ord`, а `diffRows` — прежнее содержимое. */
export function rowIndex(rows: readonly StoredRow[]): Map<string, StoredRow> {
  return new Map(rows.map((row) => [rowKey(row.kind, row.key), row]));
}

export interface RowsDiff {
  upserts: StoredRow[];
  deletes: { kind: EntryKind; key: string }[];
  workChanged: boolean;
}

/**
 * Что записать в базу, чтобы вместо `previous` лежало `next`: строки с другим `json` или `ord` (и новые), исчезнувшие
 * ключи и признак того, что менялась запись работы или `extra`.
 */
export function diffRows(
  previous: { work: string; extra: string; index: ReadonlyMap<string, StoredRow> },
  next: MapRows,
): RowsDiff {
  const upserts: StoredRow[] = [];
  const kept = new Set<string>();
  for (const row of next.rows) {
    const id = rowKey(row.kind, row.key);
    kept.add(id);
    const old = previous.index.get(id);
    if (old === undefined || old.json !== row.json || old.ord !== row.ord) upserts.push(row);
  }
  const deletes: RowsDiff['deletes'] = [];
  for (const [id, old] of previous.index) {
    if (!kept.has(id)) deletes.push({ kind: old.kind, key: old.key });
  }
  return {
    upserts,
    deletes,
    workChanged: previous.work !== next.work || previous.extra !== next.extra,
  };
}

/**
 * Карта (или любое значение) — чистое дерево JSON: строки, конечные числа без `-0`, булевы, `null`, массивы без дыр и
 * простые объекты, и ни один массив или объект не встречается в дереве дважды. У такого значения свежий разбор его
 * же JSON даёт структурно ту же карту (`toStrictEqual`) и независимые друг от друга объекты: в нём нет ключей без
 * значения (после записи их нет), `NaN` и бесконечности (в JSON это `null`), дат, `Map`, функций, объектов с чужим
 * прототипом и общих ссылок (правка одного письма в кэше не должна задевать другое). Кэш писавшего процесса держит
 * саму записанную карту, только если она такая (спека хранилища 6.9, план 4, задача 5); иначе — разбор строк.
 */
export function isPlainJsonTree(value: unknown): boolean {
  return isPlainNode(value, new Set<object>());
}

function isPlainNode(value: unknown, seen: Set<object>): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value) && !Object.is(value, -0);
    case 'object':
      break;
    default:
      return false;
  }
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    for (let at = 0; at < value.length; at += 1) {
      if (!(at in value) || !isPlainNode(value[at], seen)) return false;
    }
    return true;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  for (const key in value) {
    if (!isPlainNode((value as Record<string, unknown>)[key], seen)) return false;
  }
  return true;
}
