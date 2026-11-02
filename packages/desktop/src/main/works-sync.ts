import { setImmediate as yieldTask } from 'node:timers/promises';
import {
  WorksSyncReducer, worksSyncNamedRows, WORKS_SYNC_PAGE_BYTES, WORKS_SYNC_STALE_MS,
  WORKS_SYNC_FEATURE,
  type WorksSnapshot, type WorksSyncInvalidated, type WorksSyncRecord, type WorksSyncResult,
  type WorksSyncRootsChange, type WorksSyncSurfaceBatch, type WorksSyncSurfaceStatus,
  type WorksSyncTransaction, type WorksSyncView,
} from '@parley/protocol';
import type { HostConnection } from './host-connection.js';

/** One opt-in synchronizer per actual connection; old hosts keep their legacy consumers. */
export function bindHostWorksSync(connection: Pick<HostConnection, 'call' | 'onStatus' | 'onEvent'>): {
  sync: DesktopWorksSync;
  readonly supported: boolean;
  snapshotForLookup(): Promise<WorksSnapshot>;
  dispose(): void;
} {
  let supported = false;
  let active = false;
  const sync = new DesktopWorksSync({ pull: async (request, signal) => {
    if (signal.aborted) throw new Error('works sync disconnected');
    return await connection.call('works.sync', request) as WorksSyncResult;
  } });
  const offEvent = connection.onEvent(message => {
    if (supported && message.event === 'works.invalidated') sync.invalidate(message.data as WorksSyncInvalidated);
  });
  const offStatus = connection.onStatus(status => {
    if (status.state !== 'connected') { active = false; sync.disconnect(); return; }
    supported = (status.features ?? []).includes(WORKS_SYNC_FEATURE)
      && (status.methods ?? []).includes('works.sync') && (status.methods ?? []).includes('works.mailState');
    if (supported) { if (!active) sync.connect(); active = true; }
    else { active = false; sync.disconnect(); }
  });
  return { sync, get supported() { return supported; },
    snapshotForLookup: () => supported ? sync.snapshotForLookup() : connection.call('works.list', {}) as Promise<WorksSnapshot>,
    dispose: () => { offStatus(); offEvent(); sync.dispose(); },
  };
}

/** P4a: транспорт подставляется тестом; настоящая привязка к hello/хосту принадлежит P4b. */
export interface WorksSyncTransport {
  pull(request: { base: number } | { cursor: string }, signal: AbortSignal): Promise<WorksSyncResult>;
  list?(): Promise<WorksSnapshot>;
}
export interface WorksSyncSurface {
  /** Promise — подтверждение обработки одной пачки, до него следующая не отправляется. */
  batch(batch: WorksSyncSurfaceBatch): Promise<void>;
  status(status: WorksSyncSurfaceStatus): void;
}
interface Surface {
  sink: WorksSyncSurface;
  island: boolean;
  active: boolean;
  tail: Promise<void>;
  closed: Promise<void>;
  close(): void;
  scheduled: { epoch: string; revision: number } | null;
  cap: number;
}
interface Options {
  pageBytes?: number;
  staleMs?: number;
  retryMs?: number;
}

/** Счётчики работы кодировщика; не измерение задержек или P7 PASS. */
export interface WorksSyncEncodingCounters {
  valueEncodes: number;
  fragmentSizingAttempts: number;
  fragmentRejectedAttempts: number;
  maxFragmentCandidateChars: number;
  fragmentCandidateChars: number;
  fragmentSizingYields: number;
}

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
const sameKey = (a: { projectPath: string; workId: string }, b: { projectPath: string; workId: string }): boolean =>
  a.projectPath === b.projectPath && a.workId === b.workId;

/** Единственный запрет island-проекции совпадает с прежним projectIslandWorks. */
function publicSession(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const result = { ...value } as Record<string, unknown>;
  delete result['codexThreadBinding'];
  return result;
}
function publicSessions(value: unknown): unknown {
  return Array.isArray(value) ? value.map(publicSession) : value;
}

function* snapshotRecords(snapshot: WorksSnapshot): Generator<WorksSyncRecord> {
  for (const entry of snapshot.entries) {
    const key = { projectPath: entry.projectPath, workId: entry.map.work.id };
    yield { kind: 'work', key, work: entry.map.work, ...(entry.version !== undefined ? { version: entry.version } : {}) };
    for (const [field, value] of Object.entries(entry.map)) {
      if (field === 'work' || field === 'schemaVersion' || value === undefined) continue;
      if (Array.isArray(value) && worksSyncNamedRows(value)) {
        for (const row of value) yield { kind: 'row', key, field, id: row.id, row };
        // Только ограниченные native-срезы с самого начала, без создания полного вектора.
        for (let start = 0; start < value.length; start += 64) {
          yield { kind: 'order-slice', key, field, start, ids: value.slice(start, start + 64).map(row => row.id), final: start + 64 >= value.length };
        }
      } else if (Array.isArray(value)) {
        if (value.length === 0) yield { kind: 'section', key, field, start: 0, items: [], final: true };
        for (let start = 0; start < value.length; start++) {
          yield { kind: 'section', key, field, start, items: [value[start]], final: start === value.length - 1 };
        }
      } else {
        yield { kind: 'row', key, field, row: value };
      }
    }
  }
  for (const [projectPath, branch] of Object.entries(snapshot.branches)) yield { kind: 'branch', projectPath, branch };
}

/**
 * Фрагменты пересобраны P1 до этой границы. Берём проверенное значение из committed view,
 * поэтому ни один сырой кусок private proof не покинет main. Не трогаем неизменённые работы.
 */
function* committedRecords(records: Iterable<WorksSyncRecord>, snapshot: WorksSnapshot, island: boolean, counters?: WorksSyncEncodingCounters): Generator<WorksSyncRecord> {
  const seen = new Map<string, Set<string | number | undefined>>();
  for (const record of records) {
    let output = record;
    if (record.kind === 'field-remove') seen.delete(JSON.stringify([record.key.projectPath, record.key.workId, record.field]));
    if (record.kind === 'fragment' || record.kind === 'section-fragment') {
      const field = JSON.stringify([record.key.projectPath, record.key.workId, record.field]);
      let ids = seen.get(field);
      const address = record.kind === 'fragment' ? record.id : record.element;
      if (ids?.has(address)) continue;
      if (ids === undefined) { ids = new Set(); seen.set(field, ids); }
      ids.add(address);
      const entry = snapshot.entries.find((e) => sameKey(record.key, { projectPath: e.projectPath, workId: e.map.work.id }));
      if (entry === undefined) continue;
      if (record.kind === 'section-fragment') {
        const list = (entry.map as unknown as Record<string, unknown>)[record.field];
        if (!Array.isArray(list) || record.element >= list.length) continue;
        const value = island && record.field === 'sessions' ? publicSession(list[record.element]) : list[record.element];
        const text = JSON.stringify(value);
        if (text === undefined) throw new Error('works sync section element is not JSON');
        if (counters !== undefined) counters.valueEncodes++;
        // Сохраняем fragment-представление: куски могут законно идти после section(final).
        output = { ...record, index: 0, text, final: true };
      } else if (record.field === 'work') {
        output = { kind: 'work', key: record.key, work: entry.map.work,
          ...(entry.version !== undefined ? { version: entry.version } : {}) };
      } else {
        let value = (entry.map as unknown as Record<string, unknown>)[record.field];
        if (record.id !== undefined) value = Array.isArray(value) ? value.find((row: { id?: string }) => row?.id === record.id) : undefined;
        if (value === undefined) continue;
        output = { kind: 'row', key: record.key, field: record.field, row: value,
          ...(record.id !== undefined ? { id: record.id } : {}) };
      }
    }
    if (island && output.kind === 'row' && output.field === 'sessions') {
      output = { ...output, row: output.id === undefined ? publicSessions(output.row) : publicSession(output.row) };
    } else if (island && output.kind === 'section' && output.field === 'sessions') {
      output = { ...output, items: output.items.map(publicSession) };
    }
    yield output;
  }
}

/** Ограниченные JSON-пачки: счётчик, commit и envelope включены в проверку. */
async function* batchRecords(records: Iterable<WorksSyncRecord>, transaction: WorksSyncTransaction, cap: number, counters?: WorksSyncEncodingCounters): AsyncGenerator<WorksSyncSurfaceBatch> {
  let index = 0;
  let pending: WorksSyncRecord[] = [];
  let pendingBytes = 0;
  const batch = (rows: WorksSyncRecord[], commit = false): WorksSyncSurfaceBatch =>
    ({ kind: 'works-sync-batch', transaction, index, records: rows, commit });
  const batchBytes = (rowBytes: number, count: number): number => bytes(batch([])) + rowBytes + Math.max(0, count - 1);
  if (bytes(batch([])) > cap) throw new Error('works sync IPC envelope exceeds page budget');
  const encodeValue = (value: unknown): string => {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error('works sync IPC value is not JSON');
    if (counters !== undefined) counters.valueEncodes++;
    return text;
  };
  const fragments = async function* (text: string, make: (index: number, text: string, final: boolean) => WorksSyncRecord): AsyncGenerator<WorksSyncRecord> {
    let offset = 0;
    let fragmentIndex = 0;
    while (offset < text.length) {
      const fragment = (end: number): WorksSyncRecord => make(fragmentIndex, text.slice(offset, end), end === text.length);
      let low = offset;
      // Даже первый кандидат ограничен байтовым бюджетом: не строим половину оставшегося значения.
      const available = cap - 32 - bytes(batch([fragment(offset)]));
      if (available <= 0) throw new Error('works sync IPC fragment envelope exceeds page budget');
      let high = Math.min(text.length, offset + available);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (counters !== undefined) {
          counters.fragmentSizingAttempts++;
          counters.fragmentCandidateChars += mid - offset;
          counters.maxFragmentCandidateChars = Math.max(counters.maxFragmentCandidateChars, mid - offset);
        }
        if (bytes(batch([fragment(mid)])) <= cap - 32) low = mid;
        else {
          high = mid - 1;
          if (counters !== undefined) { counters.fragmentRejectedAttempts++; counters.fragmentSizingYields++; }
          await yieldTask();
        }
      }
      if (low < text.length && low > offset && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low--;
      if (low === offset) throw new Error('works sync IPC fragment envelope exceeds page budget');
      yield fragment(low);
      offset = low;
      fragmentIndex++;
    }
  };
  for (const record of records) {
    const split = async function* (): AsyncGenerator<WorksSyncRecord> {
      if (record.kind === 'order' || record.kind === 'order-slice') {
        const ids = record.kind === 'order' ? record.order : record.ids;
        let start = record.kind === 'order' ? 0 : record.start;
        let slice: string[] = [];
        let sliceBytes = 0;
        const part = (final: boolean): WorksSyncRecord => ({ kind: 'order-slice', key: record.key, field: record.field, start, ids: slice, final });
        for (const id of ids) {
          const idBytes = bytes(id);
          if (counters !== undefined) counters.valueEncodes++;
          const header = (): number => bytes(batch([{ ...part(false), ids: [] } as WorksSyncRecord]));
          if (slice.length > 0 && header() + sliceBytes + idBytes + slice.length > cap - 32) {
            yield part(false);
            start += slice.length;
            slice = [];
            sliceBytes = 0;
          }
          if (header() + sliceBytes + idBytes + slice.length > cap - 32) throw new Error('works sync IPC order ID exceeds page budget');
          slice.push(id);
          sliceBytes += idBytes;
        }
        yield part(record.kind === 'order' || record.final);
        return;
      }
      if (record.kind === 'section-fragment') {
        yield* fragments(record.text, (index, text, final) => ({ ...record, index, text, final }));
        return;
      }
      if (record.kind === 'section') {
        for (let at = 0; at < record.items.length; at++) {
          const value = record.items[at];
          const text = encodeValue(value);
          const element = record.start + at;
          const single: WorksSyncRecord = { ...record, start: element, items: [value], final: false };
          const size = bytes({ ...single, items: [null] }) - 4 + Buffer.byteLength(text);
          if (batchBytes(size, 1) <= cap - 32) yield single;
          else yield* fragments(text, (index, text, final) => ({ kind: 'section-fragment', key: record.key,
            field: record.field, element, index, text, final }));
        }
        if (record.final) yield { ...record, start: record.start + record.items.length, items: [] };
        return;
      }
      if (record.kind !== 'row' && record.kind !== 'work') {
        if (bytes(batch([record])) > cap - 32) throw new Error('works sync IPC record exceeds page budget');
        yield record;
        return;
      }
      // Одна сериализация значения; не кодируем весь oversized record ещё и ради проверки размера.
      const text = encodeValue(record.kind === 'work' ? record.work : record.row);
      const envelope = record.kind === 'work' ? { ...record, work: null } : { ...record, row: null };
      const recordBytes = bytes(envelope) - 4 + Buffer.byteLength(text);
      if (batchBytes(recordBytes, 1) <= cap - 32) { yield record; return; }
      yield* fragments(text, (index, text, final) => ({ kind: 'fragment', key: record.key,
        field: record.kind === 'work' ? 'work' : record.field,
        ...(record.kind === 'row' && record.id !== undefined ? { id: record.id } : {}),
        ...(record.kind === 'work' && record.version !== undefined ? { version: record.version } : {}),
        index, text, final }));
    };
    for await (const part of split()) {
      const partBytes = bytes(part);
      if (pending.length > 0 && batchBytes(pendingBytes + partBytes, pending.length + 1) > cap) {
        yield batch(pending);
        index++;
        pending = [];
        pendingBytes = 0;
        await yieldTask();
      }
      if (bytes(batch([part])) > cap) throw new Error('works sync IPC batch exceeds page budget');
      pending.push(part);
      pendingBytes += partBytes;
    }
  }
  yield batch(pending, true);
}

export async function* surfaceBatches(snapshot: WorksSnapshot, transaction: WorksSyncTransaction, cap = WORKS_SYNC_PAGE_BYTES, island = false, counters?: WorksSyncEncodingCounters): AsyncGenerator<WorksSyncSurfaceBatch> {
  yield* batchRecords(committedRecords(snapshotRecords(snapshot), snapshot, island, counters), transaction, cap, counters);
}

/** Один владелец committed view, pull-loop и ограниченных локальных поверхностей. */
export class DesktopWorksSync {
  readonly encoding: WorksSyncEncodingCounters = { valueEncodes: 0, fragmentSizingAttempts: 0, fragmentRejectedAttempts: 0,
    maxFragmentCandidateChars: 0, fragmentCandidateChars: 0, fragmentSizingYields: 0 };
  private reducer = new WorksSyncReducer();
  private connected = false;
  private supported = true;
  private disposed = false;
  private generation = 0;
  private pulling = false;
  private reset = true;
  private wanted = 0;
  private wantedEpoch: string | null = null;
  private bootstrapped = false;
  private connectionReady = false;
  private controller = new AbortController();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private readonly surfaces = new Set<Surface>();
  private readonly waiters = new Set<{ resolve(snapshot: WorksSnapshot): void; reject(error: Error): void }>();
  private readonly commits = new Set<(change: WorksSyncRootsChange) => void>();
  private state: WorksSyncSurfaceStatus = { state: 'loading', epoch: null, wanted: 0, applied: 0, pages: 0, rows: 0 };

  constructor(private readonly transport: WorksSyncTransport, private readonly options: Options = {}) {}
  get view(): WorksSyncView { return this.reducer.view; }
  get ready(): boolean { return this.bootstrapped && this.connectionReady; }
  get status(): WorksSyncSurfaceStatus { return this.state; }

  connect(supported = true): void {
    if (this.disposed) return;
    this.stop(false);
    this.connected = true;
    this.supported = supported;
    this.controller = new AbortController();
    this.reset = true;
    this.wanted = 0;
    this.wantedEpoch = null;
    this.setStatus({ state: 'loading', epoch: this.view.epoch, wanted: 0, applied: this.view.revision, pages: 0, rows: 0 });
    this.armStale();
    this.kick();
  }

  disconnect(): void {
    this.stop(true);
  }
  private stop(notify: boolean): void {
    this.connected = false;
    this.connectionReady = false;
    this.generation++;
    this.controller.abort();
    this.reducer.abandon();
    this.clearTimers();
    this.rejectWaiters();
    if (notify) this.setStatus({ state: 'error', epoch: this.view.epoch, applied: this.view.revision, error: 'connection', retryable: true });
  }
  dispose(): void {
    this.disconnect();
    this.disposed = true;
    for (const surface of this.surfaces) surface.close();
    this.surfaces.clear();
    this.commits.clear();
  }

  invalidate(event: WorksSyncInvalidated): void {
    if (!this.connected || this.disposed) return;
    if (event.epoch === this.view.epoch && event.revision <= this.view.revision) return;
    if (this.wantedEpoch !== event.epoch) {
      this.wantedEpoch = event.epoch;
      this.wanted = event.revision;
    } else this.wanted = Math.max(this.wanted, event.revision);
    if (this.view.epoch !== null && event.epoch !== this.view.epoch) this.reset = true;
    if (this.connectionReady && this.view.epoch !== null) this.setStatus({ state: 'catching-up', epoch: this.view.epoch, wanted: this.wanted, applied: this.view.revision });
    if (this.staleTimer === null) this.armStale();
    this.kick();
  }

  retry(): void {
    if (!this.connected || this.disposed) return;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.reset = true;
    this.reducer.abandon();
    this.armStale();
    this.kick();
  }

  /** Старые хосты остаются на прежнем пути; oversize не исчезает по таймеру. */
  legacyTooLarge(): void {
    this.clearTimers();
    this.setStatus({ state: 'stale', epoch: this.view.epoch, wanted: this.wanted, applied: this.view.revision, reason: 'no-page-progress' });
    this.rejectWaiters();
  }

  /** Roots получает только завершённые коммиты, сам P5 здесь не реализован. */
  onCommit(listener: (change: WorksSyncRootsChange) => void): () => void {
    this.commits.add(listener);
    return () => { this.commits.delete(listener); };
  }

  snapshotForLookup(): Promise<WorksSnapshot> {
    if (!this.connected || this.disposed || this.state.state === 'stale' || this.state.state === 'error') return Promise.reject(new Error('works sync not ready'));
    if (this.bootstrapped && this.state.state === 'current' && !this.needsPull()) return Promise.resolve(this.view.snapshot);
    return new Promise((resolve, reject) => { this.waiters.add({ resolve, reject }); });
  }

  attach(sink: WorksSyncSurface, island = false, envelopeBytes = 0): () => void {
    let close!: () => void;
    const closed = new Promise<void>((resolve) => { close = resolve; });
    const surface: Surface = { sink, island, active: true, tail: Promise.resolve(), closed, scheduled: null,
      cap: (this.options.pageBytes ?? WORKS_SYNC_PAGE_BYTES) - envelopeBytes,
      close: () => { surface.active = false; close(); this.surfaces.delete(surface); } };
    this.surfaces.add(surface);
    sink.status(this.bootstrapped ? { state: 'loading', epoch: this.view.epoch, wanted: this.wanted,
      applied: 0, pages: 0, rows: 0 } : this.state);
    if (this.bootstrapped) {
      const view = this.view;
      surface.scheduled = { epoch: view.epoch!, revision: view.revision };
      void this.enqueue(surface, surfaceBatches(view.snapshot, { mode: 'reset', epoch: view.epoch!, base: 0, target: view.revision }, surface.cap, island, this.encoding))
        .then(() => { if (surface.active) sink.status(this.state); });
    }
    return surface.close;
  }

  private enqueue(surface: Surface, batches: AsyncIterable<WorksSyncSurfaceBatch>): Promise<void> {
    surface.tail = surface.tail.then(async () => {
      for await (const batch of batches) {
        if (!surface.active) break;
        await Promise.race([surface.sink.batch(batch), surface.closed]);
      }
    }).catch(() => {
      try { surface.sink.status({ state: 'error', epoch: this.view.epoch, applied: this.view.revision, error: 'protocol', retryable: true }); }
      catch { /* Поверхность уже недоступна. */ }
      surface.close();
    });
    return surface.tail;
  }

  private needsPull(): boolean {
    if (!this.supported && this.state.state === 'stale' && !this.reset) return false;
    return this.reset || !this.bootstrapped || (this.wantedEpoch !== null && this.wantedEpoch !== this.view.epoch) || this.wanted > this.view.revision;
  }
  private kick(): void {
    if (!this.connected || this.disposed || this.pulling || this.retryTimer !== null || !this.needsPull()) return;
    this.pulling = true;
    const generation = this.generation;
    void this.run(generation).catch(() => {
      if (generation === this.generation && this.connected) this.failed('connection');
    }).finally(() => {
      this.pulling = false;
      this.kick();
    });
  }

  private async run(generation: number): Promise<void> {
    const live = (): boolean => this.connected && !this.disposed && generation === this.generation;
    if (!this.supported) {
      try {
        if (this.transport.list === undefined) throw new Error('legacy works.list unavailable');
        const snapshot = await this.transport.list();
        if (!live()) return;
        this.reducer = new WorksSyncReducer({ epoch: 'legacy', revision: snapshot.revision ?? 0, snapshot });
        this.reset = false;
        this.wantedEpoch = 'legacy';
        this.wanted = this.view.revision;
        this.bootstrapped = true;
        this.completed();
        const transaction = { mode: 'reset', epoch: 'legacy', base: 0, target: this.view.revision } as const;
        await Promise.all([...this.surfaces].map((s) => this.enqueue(s, surfaceBatches(snapshot, transaction, s.cap, s.island, this.encoding))));
        if (live()) this.setStatus(this.state);
      } catch (error) {
        if (live()) {
          const details = error as { code?: string; data?: { reason?: string } };
          if (details.code === 'snapshot_too_large' || details.data?.reason === 'snapshot-too-large') {
            this.reset = false;
            this.legacyTooLarge();
          } else this.failed('connection');
        }
      }
      return;
    }
    while (live() && this.needsPull()) {
      const forceReset = this.reset;
      this.reset = false;
      let request: { base: number } | { cursor: string } = { base: forceReset ? 0 : this.view.revision };
      const records: WorksSyncRecord[] = [];
      let pages = 0;
      let rows = 0;
      while (live()) {
        const result = await this.transport.pull(request, this.controller.signal);
        if (!live()) return;
        if (result.kind === 'reset-required') { this.failed('reset-required'); return; }
        const previous = this.view;
        const outcome = this.reducer.applyPage(result);
        if (outcome.state === 'rejected') { this.failed('protocol'); return; }
        records.push(...result.records);
        pages++;
        rows += result.records.length;
        if (!this.connectionReady) {
          this.setStatus({ state: 'loading', epoch: result.transaction.epoch, wanted: this.wanted, applied: this.view.revision, pages, rows });
          this.armStale();
        }
        if (outcome.state === 'staged') { request = { cursor: result.next! }; continue; }
        if (this.bootstrapped && previous.epoch === this.view.epoch && previous.revision === this.view.revision && this.needsPull()) {
          this.failed('protocol');
          return;
        }
        if (this.wantedEpoch === null) this.wantedEpoch = this.view.epoch;
        if (this.wantedEpoch === this.view.epoch) this.wanted = Math.max(this.wanted, this.view.revision);
        const wasReady = this.bootstrapped;
        this.bootstrapped = true;
        this.completed();
        const change: WorksSyncRootsChange = { epoch: outcome.commit.epoch, revision: outcome.commit.revision,
          changed: result.transaction.mode === 'reset' ? this.view.snapshot.entries.map((e) => ({ projectPath: e.projectPath, workId: e.map.work.id })) : outcome.commit.affected,
          deleted: result.transaction.mode === 'reset'
            ? previous.snapshot.entries.filter((old) => !this.view.snapshot.entries.some((entry) => entry.projectPath === old.projectPath && entry.map.work.id === old.map.work.id))
              .map((e) => ({ projectPath: e.projectPath, workId: e.map.work.id }))
            : outcome.commit.deleted, complete: this.view.snapshot };
        for (const listener of this.commits) listener(change);
        // Capture immutable committed references before awaiting surface acknowledgements.
        const view = this.view;
        await Promise.all([...this.surfaces].map((s) => {
          // Reconnect/Retry must reconcile consumers even when the host revision did
          // not change. Only duplicate deltas can reuse an already scheduled view.
          if (result.transaction.mode !== 'reset' && s.scheduled?.epoch === view.epoch && s.scheduled.revision === view.revision) return s.tail;
          const resetSurface = result.transaction.mode !== 'reset' && (!wasReady || s.scheduled?.epoch !== view.epoch || s.scheduled.revision !== result.transaction.base);
          s.scheduled = { epoch: view.epoch!, revision: view.revision };
          return this.enqueue(s, resetSurface
            ? surfaceBatches(view.snapshot, { mode: 'reset', epoch: view.epoch!, base: 0, target: view.revision }, s.cap, s.island, this.encoding)
            : batchRecords(committedRecords(records, view.snapshot, s.island, this.encoding), result.transaction, s.cap, this.encoding));
        }));
        if (live()) this.setStatus(this.state);
        break;
      }
    }
  }

  private completed(): void {
    this.connectionReady = true;
    this.failures = 0;
    this.clearTimers();
    if (this.needsPull()) {
      this.state = { state: 'catching-up', epoch: this.view.epoch!, wanted: this.wanted, applied: this.view.revision };
      this.armStale();
    } else this.state = { state: 'current', epoch: this.view.epoch!, applied: this.view.revision };
    for (const waiter of this.waiters) waiter.resolve(this.view.snapshot);
    this.waiters.clear();
  }
  private failed(error: 'connection' | 'protocol' | 'reset-required'): void {
    this.reducer.abandon();
    this.clearTimers();
    this.reset = true;
    this.setStatus({ state: 'error', epoch: this.view.epoch, applied: this.view.revision, error, retryable: true });
    this.rejectWaiters();
    const delay = Math.min((this.options.retryMs ?? 250) * 2 ** Math.min(this.failures++, 5), 5_000);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.armStale(); this.kick(); }, delay);
    this.retryTimer.unref();
  }
  private rejectWaiters(): void {
    for (const waiter of this.waiters) waiter.reject(new Error('works sync not ready'));
    this.waiters.clear();
  }
  private setStatus(status: WorksSyncSurfaceStatus): void {
    this.state = status;
    for (const surface of this.surfaces) {
      try { surface.sink.status(status); } catch { surface.close(); }
    }
  }
  private armStale(): void {
    if (this.staleTimer !== null) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      if (!this.connected || this.disposed) return;
      this.setStatus({ state: 'stale', epoch: this.view.epoch, wanted: this.wanted, applied: this.view.revision,
        reason: this.connectionReady ? 'no-commit' : 'no-page-progress' });
      this.rejectWaiters();
    }, this.options.staleMs ?? WORKS_SYNC_STALE_MS);
    this.staleTimer.unref();
  }
  private clearTimers(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.staleTimer !== null) clearTimeout(this.staleTimer);
    this.retryTimer = null;
    this.staleTimer = null;
  }
}
