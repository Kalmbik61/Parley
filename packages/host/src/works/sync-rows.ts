import { CooperativeWork, cloneWindowValue } from '@parley/core';
import type { CooperativeWorkOptions, WindowWorkMap } from '@parley/core';
import { WORKS_SYNC_ENCODED_CACHE_BYTES, WORKS_SYNC_PAGE_BYTES, worksSyncNamedRows } from '@parley/protocol';
import type { WorksSyncRecord, WorksSyncWorkKey } from '@parley/protocol';

const workId = (key: WorksSyncWorkKey): string => JSON.stringify([key.projectPath, key.workId]);
const safe = (key: string): void => {
  if (!key || key.length > 128 || key.includes('\0') || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe sync field/id');
};

function* equal(a: unknown, b: unknown): Generator<void, boolean> {
  yield;
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const key of ak) {
    if (!Object.hasOwn(b, key) || !(yield* equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))) return false;
  }
  return true;
}

type Revisioned = { value: unknown; revision: number };
type Field =
  | { kind: 'value'; value: unknown; revision: number }
  | { kind: 'rows'; rows: Map<string, Revisioned>; order: string[]; revision: number; removed: Map<string, number> };
interface State {
  key: WorksSyncWorkKey;
  map: WindowWorkMap;
  sourceVersion: number | undefined;
  structuralSourceVersion: number | undefined;
  lastStructuralRevision: number;
  metaRevision: number;
  fields: Map<string, Field>;
  resets: Map<string, number>;
}
export interface SyncRowsSnapshot {
  readonly map: WindowWorkMap;
  readonly sourceVersion: number | undefined;
  readonly structuralSourceVersion: number | undefined;
  readonly lastStructuralRevision: number;
}

/**
 * Версии неизменяемых проекций; JSON не кэшируется для каждой строки. Вызывающий сериализует update/remove
 * и передаёт собственную стабильную версию source до завершения update. Старые records держат старый State.
 * Пол журнала/его бюджет и транзакции принадлежат P3; prune вызывается только при продвижении этого пола.
 */
export class SyncRows {
  private states = new Map<string, State>();
  private removed = new Map<string, { key: WorksSyncWorkKey; revision: number; fields: string[] }>();
  constructor(private readonly options: CooperativeWorkOptions = {}) {}

  /** Candidate shares immutable work states; no row bodies are copied or exposed before adoption. */
  async fork(): Promise<SyncRows> {
    const candidate = new SyncRows(this.options);
    const states = this.states, removed = this.removed;
    function* copy(): Generator<void, void> {
      for (const [id, state] of states) { candidate.states.set(id, state); yield; }
      for (const [id, state] of removed) { candidate.removed.set(id, state); yield; }
    }
    await new CooperativeWork(this.options).run(copy());
    return candidate;
  }

  /** No await or row walk: existing records iterators keep their captured immutable states. */
  adopt(candidate: SyncRows): void {
    this.states = candidate.states;
    this.removed = candidate.removed;
  }

  snapshot(key: WorksSyncWorkKey): SyncRowsSnapshot | undefined {
    const state = this.states.get(workId(key));
    return state === undefined ? undefined : Object.freeze({ map: state.map, sourceVersion: state.sourceVersion, structuralSourceVersion: state.structuralSourceVersion, lastStructuralRevision: state.lastStructuralRevision });
  }

  async update(key: WorksSyncWorkKey, source: WindowWorkMap, sourceVersion: number | undefined, revision: number): Promise<void> {
    if (source.work.id !== key.workId) throw new Error('Sync work id mismatch');
    const id = workId(key);
    const previous = this.states.get(id);
    const deleted = this.removed.get(id);
    const task = new CooperativeWork(this.options);
    const map = await cloneWindowValue(source, task);
    function* build(): Generator<void, State> {
      const fields = new Map<string, Field>();
      const resets = new Map(previous?.resets ?? deleted?.fields.map(field => [field, deleted.revision] as const));
      let changed = previous === undefined;
      const metaChanged = previous === undefined || previous.structuralSourceVersion !== sourceVersion || !(yield* equal(previous.map.work, map.work));
      changed ||= metaChanged;
      for (const name of Object.keys(map)) {
        yield;
        if (name === 'work' || name === 'schemaVersion') continue;
        safe(name);
        const value = (map as unknown as Record<string, unknown>)[name];
        if (value === undefined) continue; // Отсутствие JSON-свойства; field-remove ниже.
        const old = previous?.fields.get(name);
        const named = Array.isArray(value) && worksSyncNamedRows(value);
        const kind = named ? 'rows' : 'value';
        if (old !== undefined && old.kind !== kind) { resets.set(name, revision); changed = true; }
        if (!named) {
          const same = old?.kind === 'value' && (yield* equal(old.value, value));
          fields.set(name, same ? old : { kind: 'value', value, revision });
          changed ||= !same;
          continue;
        }
        const rows = new Map<string, Revisioned>();
        const order: string[] = [];
        const removed = new Map(old?.kind === 'rows' ? old.removed : undefined);
        for (const row of value as Array<{ id: string }>) {
          yield;
          safe(row.id);
          if (rows.has(row.id)) throw new Error('Duplicate sync row id');
          order.push(row.id);
          const prior = old?.kind === 'rows' ? old.rows.get(row.id) : undefined;
          const same = prior !== undefined && (yield* equal(prior.value, row));
          rows.set(row.id, same ? prior : { value: row, revision });
          removed.delete(row.id);
          changed ||= !same;
        }
        if (old?.kind === 'rows') {
          for (const rowId of old.rows.keys()) {
            yield;
            if (!rows.has(rowId)) { removed.set(rowId, revision); changed = true; }
          }
        }
        const sameOrder = old?.kind === 'rows' && (yield* equal(old.order, order));
        fields.set(name, { kind: 'rows', rows, order: sameOrder ? old.order : Object.freeze(order) as unknown as string[], revision: sameOrder ? old.revision : revision, removed });
        changed ||= !sameOrder;
      }
      for (const name of previous?.fields.keys() ?? []) {
        yield;
        if (!fields.has(name)) { resets.set(name, revision); changed = true; }
      }
      return { key: Object.freeze({ ...key }), map, fields, resets, sourceVersion, structuralSourceVersion: sourceVersion, metaRevision: metaChanged ? revision : previous!.metaRevision, lastStructuralRevision: changed ? revision : previous!.lastStructuralRevision };
    }
    const next = await task.run(build());
    this.states.set(id, next);
    this.removed.delete(id);
  }

  /** Известный локальный mail-only путь: ни проекции, ни сравнения, ни структурной ревизии. */
  noteMailVersion(key: WorksSyncWorkKey, version: number): void {
    const id = workId(key), old = this.states.get(id);
    if (old !== undefined) this.states.set(id, { ...old, sourceVersion: Math.max(old.sourceVersion ?? 0, version) });
  }

  remove(key: WorksSyncWorkKey, revision: number): void {
    const id = workId(key);
    const old = this.states.get(id);
    const fields = old === undefined ? this.removed.get(id)?.fields ?? [] : [...new Set([...old.fields.keys(), ...old.resets.keys()])];
    this.states.delete(id);
    this.removed.set(id, { key: Object.freeze({ ...key }), revision, fields });
  }

  /** Захват ссылки синхронен: обновления кэша после вызова не меняют закреплённую выборку. */
  records(key: WorksSyncWorkKey, base: number): AsyncIterable<WorksSyncRecord> {
    const id = workId(key), state = this.states.get(id), removed = this.removed.get(id);
    const options = this.options;
    async function* read(): AsyncGenerator<WorksSyncRecord> {
      if (state === undefined) {
        if (removed !== undefined && removed.revision > base) yield { kind: 'work-remove', key: removed.key };
        return;
      }
      const key = state.key;
      if (state.metaRevision > base) yield { kind: 'work', key, work: state.map.work, ...(state.structuralSourceVersion === undefined ? {} : { version: state.structuralSourceVersion }) };
      for (const [field, revision] of state.resets) if (base >= 0 && revision > base) yield { kind: 'field-remove', key, field };
      let visited = 0;
      for (const [field, value] of state.fields) {
        if (value.kind === 'value') {
          if (value.revision > base) {
            if (Array.isArray(value.value)) {
              const items = value.value;
              if (items.length === 0) yield { kind: 'section', key, field, start: 0, items: [], final: true };
              for (let start = 0; start < items.length; start += 32) {
                yield { kind: 'section', key, field, start, items: items.slice(start, start + 32), final: start + 32 >= items.length };
              }
            } else yield { kind: 'row', key, field, row: value.value };
          }
          continue;
        }
        for (const [id, row] of value.rows) {
          if (row.revision > base) yield { kind: 'row', key, field, id, row: row.value };
          visited += 1;
          if (visited % (options.batchSize ?? 128) === 0) await (options.yield?.() ?? new Promise<void>(resolve => setImmediate(resolve)));
        }
        if (base >= 0) for (const [id, revision] of value.removed) if (revision > base) yield { kind: 'row-remove', key, field, id };
        if (value.revision > base) {
          if (value.order.length === 0) yield { kind: 'order-slice', key, field, start: 0, ids: [], final: true };
          for (let start = 0; start < value.order.length; start += 32) {
            yield { kind: 'order-slice', key, field, start, ids: value.order.slice(start, start + 32), final: start + 32 >= value.order.length };
          }
        }
      }
    }
    return { [Symbol.asyncIterator]: read };
  }

  async prune(floor: number): Promise<void> {
    const { states, removed } = this;
    function* prune(): Generator<void, void> {
      for (const [id, value] of removed) { if (value.revision <= floor) removed.delete(id); yield; }
      for (const [id, state] of states) {
        const fields = new Map(state.fields), resets = new Map<string, number>();
        for (const [name, field] of fields) {
          yield;
          if (field.kind !== 'rows' || field.removed.size === 0) continue;
          const kept = new Map<string, number>();
          for (const [row, revision] of field.removed) { if (revision > floor) kept.set(row, revision); yield; }
          fields.set(name, { ...field, removed: kept });
        }
        for (const [name, revision] of state.resets) { if (revision > floor) resets.set(name, revision); yield; }
        states.set(id, { ...state, fields, resets });
      }
    }
    await new CooperativeWork(this.options).run(prune());
  }
}

export interface SyncEncodeStats {
  attempts: number;
  attemptedRecords: number;
  attemptedBytes: number;
  encodeMs: number;
  encodeCpuUserMicros?: number;
  encodeCpuSystemMicros?: number;
  retries: number;
  fragments: number;
  valueEncodes?: number;
  valueBytes?: number;
}
export interface EncodedSyncRecords { records: WorksSyncRecord[]; json: string; bytes: number }
export interface SyncEncodeOptions extends Omit<CooperativeWorkOptions, 'stats'> {
  sliceStats?: CooperativeWorkOptions['stats'];
  /** Полный фактический конверт, включая id/cursor/index; bytes включает завершающий newline. */
  frame: (records: WorksSyncRecord[]) => unknown;
  maxBytes?: number;
  stats: SyncEncodeStats;
}

/** Ограниченные native-array пачки. Нет повторного кодирования всей коллекции при overflow. */
export async function* encodeSyncRecords(records: AsyncIterable<WorksSyncRecord>, options: SyncEncodeOptions): AsyncGenerator<EncodedSyncRecords> {
  const { stats } = options;
  const cap = options.maxBytes ?? WORKS_SYNC_PAGE_BYTES;
  const batchSize = Math.max(1, options.batchSize ?? 32);
  const task = new CooperativeWork({ ...options, batchSize: 1, stats: options.sliceStats ?? { yields: 0, maxSliceMs: 0 } });
  const pause = options.yield ?? (() => new Promise<void>(resolve => setImmediate(resolve)));
  async function encode(rows: WorksSyncRecord[]): Promise<EncodedSyncRecords> {
    return task.run((function* () {
      const started = performance.now();
      const cpu = process.cpuUsage();
      const json = JSON.stringify(options.frame(rows));
      const bytes = Buffer.byteLength(json, 'utf8') + 1;
      stats.attempts += 1;
      stats.attemptedRecords += rows.length;
      stats.attemptedBytes += bytes;
      stats.encodeMs += performance.now() - started;
      const usedCpu = process.cpuUsage(cpu);
      stats.encodeCpuUserMicros = (stats.encodeCpuUserMicros ?? 0) + usedCpu.user;
      stats.encodeCpuSystemMicros = (stats.encodeCpuSystemMicros ?? 0) + usedCpu.system;
      yield;
      return Object.freeze({ records: Object.freeze(rows.map(row => {
        if (row.kind === 'section') Object.freeze(row.items);
        if (row.kind === 'order-slice') Object.freeze(row.ids);
        return Object.freeze(row);
      })) as unknown as WorksSyncRecord[], json, bytes });
    })());
  }
  async function* pack(rows: WorksSyncRecord[]): AsyncGenerator<EncodedSyncRecords> {
    const encoded = await encode(rows);
    if (encoded.bytes <= cap) { yield encoded; await pause(); return; }
    stats.retries += 1;
    if (rows.length > 1) {
      const middle = Math.floor(rows.length / 2);
      yield* pack(rows.slice(0, middle));
      yield* pack(rows.slice(middle));
      return;
    }
    const row = rows[0]!;
    if (row.kind === 'order-slice' && row.ids.length > 1) {
      const middle = Math.floor(row.ids.length / 2);
      yield* pack([{ ...row, ids: row.ids.slice(0, middle), final: false }]);
      yield* pack([{ ...row, start: row.start + middle, ids: row.ids.slice(middle) }]);
      return;
    }
    if (row.kind === 'section' && row.items.length > 1) {
      const middle = Math.floor(row.items.length / 2);
      yield* pack([{ ...row, items: row.items.slice(0, middle), final: false }]);
      yield* pack([{ ...row, start: row.start + middle, items: row.items.slice(middle) }]);
      return;
    }
    if (row.kind !== 'row' && row.kind !== 'work' && !(row.kind === 'section' && row.items.length === 1)) throw new Error('Sync envelope or non-value record exceeds page budget');
    const text = await task.run((function* () {
      const started = performance.now();
      const cpu = process.cpuUsage();
      const text = JSON.stringify(row.kind === 'work' ? row.work : row.kind === 'section' ? row.items[0] : row.row);
      stats.valueEncodes = (stats.valueEncodes ?? 0) + 1;
      stats.valueBytes = (stats.valueBytes ?? 0) + Buffer.byteLength(text);
      stats.encodeMs += performance.now() - started;
      const usedCpu = process.cpuUsage(cpu);
      stats.encodeCpuUserMicros = (stats.encodeCpuUserMicros ?? 0) + usedCpu.user;
      stats.encodeCpuSystemMicros = (stats.encodeCpuSystemMicros ?? 0) + usedCpu.system;
      yield;
      return text;
    })());
    for (let at = 0, index = 0; at < text.length; index += 1) {
      let low = 1, high = Math.min(cap, text.length - at);
      let best: EncodedSyncRecords | undefined;
      let consumed = 0;
      while (low <= high) {
        const size = Math.floor((low + high) / 2);
        let end = at + size;
        // Не разрывать суррогатную пару: JSON-фрагменты валидны по UTF-8 отдельно.
        if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end -= 1;
        const fragment: WorksSyncRecord = row.kind === 'section'
          ? { kind: 'section-fragment', key: row.key, field: row.field, element: row.start, index, text: text.slice(at, end), final: end === text.length }
          : { kind: 'fragment', key: row.key, field: row.kind === 'work' ? 'work' : row.field,
            ...(row.kind === 'row' && row.id !== undefined ? { id: row.id } : {}),
            ...(row.kind === 'work' && row.version !== undefined ? { version: row.version } : {}),
            index, text: text.slice(at, end), final: end === text.length };
        const candidate = await encode([fragment]);
        if (candidate.bytes <= cap && end > at) { best = candidate; consumed = end - at; low = size + 1; }
        else { stats.retries += 1; high = size - 1; }
      }
      if (best === undefined) throw new Error('Sync fragment envelope exceeds page budget');
      stats.fragments += 1;
      yield best;
      at += consumed;
      await pause();
    }
    if (row.kind === 'section' && row.final) {
      yield* pack([{ kind: 'section', key: row.key, field: row.field, start: row.start + 1, items: [], final: true }]);
    }
  }
  let batch: WorksSyncRecord[] = [];
  for await (const row of records) {
    batch.push(row);
    if (batch.length >= batchSize) { yield* pack(batch); batch = []; }
  }
  if (batch.length > 0) yield* pack(batch);
}

/** Общий для подписчиков LRU только готовых payloads; логические строки/пины не входят в этот бюджет. */
export class EncodedSyncPageCache {
  private readonly pages = new Map<string, Readonly<{ json: string; bytes: number }>>();
  private retained = 0;
  constructor(private readonly limit = WORKS_SYNC_ENCODED_CACHE_BYTES) {}
  get bytes(): number { return this.retained; }
  get(key: string): Readonly<{ json: string; bytes: number }> | undefined {
    const value = this.pages.get(key);
    if (value !== undefined) { this.pages.delete(key); this.pages.set(key, value); }
    return value;
  }
  set(key: string, page: { json: string; bytes: number }): void {
    if (!Number.isSafeInteger(page.bytes) || page.bytes < Buffer.byteLength(page.json, 'utf8')) throw new Error('Invalid encoded page byte count');
    const prior = this.pages.get(key);
    if (prior !== undefined) { this.retained -= prior.bytes; this.pages.delete(key); }
    if (page.bytes > this.limit) return;
    this.pages.set(key, Object.freeze({ ...page }));
    this.retained += page.bytes;
    while (this.retained > this.limit) {
      const first = this.pages.keys().next().value!;
      this.retained -= this.pages.get(first)!.bytes;
      this.pages.delete(first);
    }
  }
}
