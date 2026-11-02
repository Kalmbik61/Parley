import { randomUUID } from 'node:crypto';
import { cloneWindowValue, CooperativeWork } from '@parley/core';
import type { MapCompactMail, WindowWorkEntry } from '@parley/core';
import {
  WORKS_SYNC_FEATURE, WORKS_SYNC_PAGE_BYTES, WORKS_SYNC_ENCODED_CACHE_BYTES,
  WORKS_SYNC_PIN_IDLE_MS, WORKS_SYNC_JOURNAL_BYTES, WORKS_SYNC_JOURNAL_COMMITS, encodeLine,
} from '@parley/protocol';
import type { Params, WorksMailStateField, WorksMailStateIdentity, WorksMailStatePage, WorksMailStateRecord, WorksMailStateResult, WorksMailStateFailureReason, WorksSyncPage, WorksSyncRecord, WorksSyncResult, WorksSyncResetReason, WorksSyncTransaction, WorksSyncWorkKey } from '@parley/protocol';
import type { Client } from '../client.js';
import { HostError } from '../errors.js';
import { SyncRows, EncodedSyncPageCache, encodeSyncRecords } from './sync-rows.js';
import type { EncodedSyncRecords, SyncEncodeStats } from './sync-rows.js';

const keyId = (key: WorksSyncWorkKey): string => JSON.stringify([key.projectPath, key.workId]);
export type WorksMailCaptureResult = { kind: 'captured'; key: WorksSyncWorkKey; sourceVersion: number; requiredStructuralVersion: number; lifetime?: object; mail: Pick<MapCompactMail, 'rooms' | 'unread' | 'mentionCandidates'> } | Extract<WorksMailStateResult, { kind: 'mail-unavailable' }>;
export interface WorksSyncOptions {
  /** Изолированные тесты могут уменьшать кадр; production использует только принятый бюджет. */
  pageBytes?: number;
  cacheBytes?: number;
  journalBytes?: number;
  journalCommits?: number;
  pinIdleMs?: number;
  maxPins?: number;
  highWaterBytes?: number;
  now?: () => number;
  clients?: () => readonly Client[];
  /** Возвращает собственное стабильное значение, захваченное до первого await. */
  captureMail?: (key: WorksSyncWorkKey) => Promise<WorksMailCaptureResult>;
  mailAlive?: (key: WorksSyncWorkKey, sourceVersion: number, lifetime?: object) => boolean;
}
export interface PreparedWorksSyncReply {
  readonly result: WorksSyncResult | WorksMailStateResult;
  readonly line: string;
  readonly bytes: number;
  readonly resultBytes: number;
  sent(writable: boolean): void;
}
interface PayloadTransfer {
  id: string;
  epoch: string;
  make: () => AsyncGenerator<EncodedSyncRecords>;
  iterator: AsyncGenerator<EncodedSyncRecords>;
  produced: number;
  total: number | null;
  tail: Promise<unknown>;
}
interface Transfer extends PayloadTransfer { transaction: WorksSyncTransaction }
interface MailTransfer extends PayloadTransfer { identity: WorksMailStateIdentity; lifetime?: object }
interface MailPin { client: string; transfer: MailTransfer; index: number; cursor: string; touched: number }
interface MailReader { pin?: MailPin; pulling: boolean; closed: boolean; backpressure: boolean }
interface Pin { client: string; transfer: Transfer; index: number; cursor: string; touched: number }
interface Reader { pin?: Pin; backpressure: boolean; pulling: boolean; notified: boolean; completed: boolean; closed: boolean }

/**
 * Публикации сериализованы, но страницы читаются с закреплённых неизменяемых версий вне очереди публикаций.
 * Один pull/пин на клиента. Общий LRU ограничивает только кодированные страницы; вытеснение регенерирует
 * страницу из тех же закреплённых iterable, а не из текущего кэша. Ни aggregate-size gate, ни full-map JSON.
 */
export class WorksSyncHost {
  readonly pageBytes: number;
  private currentEpoch: string = randomUUID();
  get epoch(): string { return this.currentEpoch; }
  readonly stats: SyncEncodeStats = { attempts: 0, attemptedRecords: 0, attemptedBytes: 0, encodeMs: 0, retries: 0, fragments: 0 };
  readonly rows = new SyncRows();
  private cache: EncodedSyncPageCache;
  private readonly payloads = new WeakMap<object, EncodedSyncRecords>();
  private readonly readers = new Map<string, Reader>();
  private readonly mailVersions = new Map<string, { version: number; incarnation: number | undefined }>();
  private incarnations = new Map<string, number>();
  incarnation(key: WorksSyncWorkKey): number | undefined { return this.incarnations.get(keyId(key)); }
  private readonly cursors = new Map<string, Pin>();
  private readonly expired = new Map<string, string>();
  private readonly transfers = new Map<string, Transfer>();
  private readonly mailReaders = new Map<string, MailReader>();
  private readonly mailCursors = new Map<string, MailPin>();
  private readonly mailExpired = new Map<string, { client: string; key: WorksSyncWorkKey }>();
  private mailStarting = 0;
  private branchRows = new Map<string, { value: string | null; revision: number }>();
  private branchDeletes = new Map<string, number>();
  private journal: Array<{ revision: number; bytes: number }> = [];
  private keys: WorksSyncWorkKey[] = [];
  private revision = 0;
  private floor = 0;
  private journalSize = 0;
  private stopped = false;
  private publicationFailed = false;
  private expiryTimer: NodeJS.Timeout | undefined;
  private publication: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly payloadCap: number;
  constructor(private readonly options: WorksSyncOptions = {}) {
    this.pageBytes = options.pageBytes ?? WORKS_SYNC_PAGE_BYTES;
    this.cache = new EncodedSyncPageCache(options.cacheBytes ?? WORKS_SYNC_ENCODED_CACHE_BYTES);
    this.now = options.now ?? (() => Date.now());
    // Максимальный числовой id и ограниченные токены/индексы: резерв только малого конверта.
    // Каждый ответ всё равно проверяется с фактическим id непосредственно перед sendLine.
    const page: WorksSyncPage = { kind: 'page', transaction: { mode: 'reset', epoch: this.epoch, base: Number.MAX_SAFE_INTEGER, target: Number.MAX_SAFE_INTEGER }, index: Number.MAX_SAFE_INTEGER, cursor: 'x'.repeat(80), next: 'x'.repeat(80), records: [], commit: false };
    const overhead = Buffer.byteLength(JSON.stringify({ id: -Number.MAX_VALUE, result: page })) - 2 + 1;
    this.payloadCap = this.pageBytes - overhead;
    if (this.payloadCap < 256) throw new Error('Works sync page budget cannot fit the RPC envelope');
  }
  get currentRevision(): number { return this.revision; }
  get cacheBytes(): number { return this.cache.bytes; }
  get pinCount(): number { return this.cursors.size; }
  get mailPinCount(): number { return this.mailCursors.size; }
  snapshot(key: WorksSyncWorkKey) { return this.rows.snapshot(key); }
  committedSnapshot(key: WorksSyncWorkKey) {
    return this.queue(() => {
      if (this.stopped || this.publicationFailed) throw new HostError('conflict', 'Works sync publication requires repair.');
      return this.rows.snapshot(key);
    });
  }
  noteMailVersion(key: WorksSyncWorkKey, version: number, incarnation?: number): void {
    const id = keyId(key), old = this.mailVersions.get(id);
    const value = old !== undefined && old.incarnation === incarnation ? Math.max(old.version, version) : version;
    this.mailVersions.set(id, { version: value, incarnation });
    if (this.incarnations.get(id) === incarnation) this.rows.noteMailVersion(key, value);
  }
  private queue<T>(run: () => T | Promise<T>): Promise<T> {
    const next = this.publication.then(run);
    this.publication = next.catch(() => undefined);
    return next;
  }

  async publish(upserts: readonly WindowWorkEntry[], keys?: readonly WorksSyncWorkKey[], branches?: Record<string, string | null>, isCurrent?: () => boolean, identities?: readonly { key: WorksSyncWorkKey; incarnation: number }[]): Promise<void> {
    await this.queue(async () => {
      if (this.stopped) return;
      const incoming = new Map(identities?.map(row => [keyId(row.key), row.incarnation]));
      const changedLife = (key: WorksSyncWorkKey) => incoming.has(keyId(key)) && this.incarnations.has(keyId(key)) && incoming.get(keyId(key)) !== this.incarnations.get(keyId(key));
      const validate = (): void => {
        if (this.stopped || isCurrent?.() === false) throw new HostError('conflict', 'Works publication was superseded.');
        for (const entry of upserts) {
          const key = { projectPath: entry.projectPath, workId: entry.map.work.id };
          if ((incoming.get(keyId(key)) ?? this.incarnations.get(keyId(key)) ?? 0) < (this.incarnations.get(keyId(key)) ?? 0)) throw new HostError('conflict', 'Works publication was superseded.');
          if ((keys === undefined && !this.keys.some(current => keyId(current) === keyId(key))) ||
              (!changedLife(key) && (this.rows.snapshot(key)?.structuralSourceVersion ?? 0) > (entry.version ?? 0))) {
            throw new HostError('conflict', 'Works publication was superseded.');
          }
        }
      };
      validate();
      // Only candidate state crosses awaits. Readers and mail-only writes keep using committed rows.
      const candidate = await (async () => {
        try {
          const rows = await this.rows.fork();
          const task = new CooperativeWork();
          const targetKeys = keys ?? this.keys;
          const targetBranches = branches ?? Object.fromEntries([...this.branchRows].map(([path, row]) => [path, row.value]));
          const nextRevision = this.revision + 1;
          const incarnations = new Map(this.incarnations);
          for (const [id, incarnation] of incoming) incarnations.set(id, incarnation);
          let retire = false;
          const wanted = new Set<string>();
          function* catalogue(): Generator<void, void> {
            for (const key of targetKeys) { wanted.add(keyId(key)); yield; }
          }
          await task.run(catalogue());
          let bytes = 0, changed = upserts.length > 0;
          const removed: WorksSyncWorkKey[] = [];
          const deletedKeys: Array<{ key: WorksSyncWorkKey; revision: number }> = [];
          const priorDeleted = this.deletedKeys, committedKeys = this.keys;
          function* removals(): Generator<void, void> {
            for (const row of priorDeleted) { deletedKeys.push(row); yield; }
            for (const key of committedKeys) {
              retire ||= !wanted.has(keyId(key)) || changedLife(key);
              if (!wanted.has(keyId(key))) {
                rows.remove(key, nextRevision);
                incarnations.delete(keyId(key));
                bytes += 64 + 6 * (key.projectPath.length + key.workId.length);
                removed.push(key); deletedKeys.push({ key, revision: nextRevision }); changed = true;
              }
              yield;
            }
          }
          await task.run(removals());
          const nextEpoch = retire ? randomUUID() : this.epoch;
          for (const entry of upserts) {
            const key = { projectPath: entry.projectPath, workId: entry.map.work.id };
            await rows.update(key, entry.map, entry.version, nextRevision);
            bytes += 64 + 6 * (key.projectPath.length + key.workId.length);
            for await (const record of rows.records(key, this.revision)) {
              bytes += 64;
              if ('field' in record) bytes += record.field.length * 6;
              if ('id' in record && record.id !== undefined) bytes += record.id.length * 6;
              if (record.kind === 'order-slice') for (const id of record.ids) bytes += id.length * 6;
            }
          }
          const branchRows = new Map<string, { value: string | null; revision: number }>(), branchDeletes = new Map<string, number>();
          const journal: Array<{ revision: number; bytes: number }> = [];
          let journalSize = this.journalSize, floor = this.floor;
          const priorKeys = this.keys, priorBranchRows = this.branchRows, priorBranchDeletes = this.branchDeletes, priorJournal = this.journal;
          const journalCommits = this.options.journalCommits ?? WORKS_SYNC_JOURNAL_COMMITS, journalBytes = this.options.journalBytes ?? WORKS_SYNC_JOURNAL_BYTES;
          function* metadata(): Generator<void, void> {
            for (const [path, row] of priorBranchRows) { branchRows.set(path, row); yield; }
            for (const [path, revision] of priorBranchDeletes) { branchDeletes.set(path, revision); yield; }
            for (const [path] of branchRows) {
              if (!Object.hasOwn(targetBranches, path)) { branchRows.delete(path); branchDeletes.set(path, nextRevision); bytes += 32 + path.length * 6; changed = true; }
              yield;
            }
            for (const [path, value] of Object.entries(targetBranches)) {
              if (branchRows.get(path)?.value !== value) { branchRows.set(path, { value, revision: nextRevision }); branchDeletes.delete(path); bytes += 64 + path.length * 6; changed = true; }
              yield;
            }
            const deltaOrder: string[] = [], priorIds = new Set<string>();
            for (const key of priorKeys) { const id = keyId(key); priorIds.add(id); if (wanted.has(id)) deltaOrder.push(id); yield; }
            for (const key of targetKeys) { const id = keyId(key); if (!priorIds.has(id)) deltaOrder.push(id); yield; }
            let reordered = false;
            for (let at = 0; at < targetKeys.length; at += 1) { reordered ||= deltaOrder[at] !== keyId(targetKeys[at]!); yield; }
            changed ||= reordered;
            for (const row of priorJournal) { journal.push(row); yield; }
            if (changed) {
              journal.push({ revision: nextRevision, bytes: bytes + removed.length * 128 });
              journalSize += bytes + removed.length * 128;
              while (journal.length > journalCommits || journalSize > journalBytes) {
                const oldest = journal.shift()!; journalSize -= oldest.bytes; floor = Math.max(floor, oldest.revision); yield;
              }
              if (reordered || retire) floor = nextRevision;
            }
          }
          await task.run(metadata());
          if (floor > this.floor) await rows.prune(floor);
          const candidateKeys: WorksSyncWorkKey[] = [], keptDeletes: typeof deletedKeys = [];
          function* retention(): Generator<void, void> {
            for (const key of targetKeys) { candidateKeys.push(Object.freeze({ ...key })); yield; }
            for (const row of deletedKeys) { if (row.revision > floor) keptDeletes.push(row); yield; }
            for (const [path, revision] of branchDeletes) { if (revision <= floor) branchDeletes.delete(path); yield; }
          }
          await task.run(retention());
          return { rows, keys: candidateKeys, branchRows, branchDeletes, deletedKeys: keptDeletes,
            journal, journalSize, floor, nextRevision, nextEpoch, incarnations, changed, removed };
        } catch (error) { this.publicationFailed = true; throw error; }
      })();
      // Supersession is not cache corruption. Discard without changing any committed state or pins.
      validate();
      // No await between final validation and adoption. Reconcile mail-only writes made while staging;
      // these advance sourceVersion, never structuralSourceVersion or the captured map's mail coverage.
      for (const key of candidate.keys) {
        const id = keyId(key), mail = this.mailVersions.get(id);
        if (mail !== undefined && mail.incarnation === candidate.incarnations.get(id)) candidate.rows.noteMailVersion(key, mail.version);
      }
      const retired = candidate.nextEpoch !== this.epoch;
      if (retired) {
        for (const pin of [...this.cursors.values()]) this.forget(pin);
        for (const pin of [...this.mailCursors.values()]) this.forgetMail(pin);
        for (const reader of this.readers.values()) { reader.notified = false; reader.completed = false; }
        this.transfers.clear(); this.expired.clear(); this.mailExpired.clear();
        this.cache = new EncodedSyncPageCache(this.options.cacheBytes ?? WORKS_SYNC_ENCODED_CACHE_BYTES);
        this.currentEpoch = candidate.nextEpoch;
      }
      for (const [id, mail] of this.mailVersions) if (candidate.incarnations.get(id) !== mail.incarnation) this.mailVersions.delete(id);
      this.incarnations = candidate.incarnations;
      this.rows.adopt(candidate.rows);
      this.keys = candidate.keys;
      this.branchRows = candidate.branchRows;
      this.branchDeletes = candidate.branchDeletes;
      this.deletedKeys = candidate.deletedKeys;
      this.journal = candidate.journal;
      this.journalSize = candidate.journalSize;
      this.floor = candidate.floor;
      for (const key of candidate.removed) this.mailVersions.delete(keyId(key));
      this.publicationFailed = false;
      if (!candidate.changed) return;
      this.revision = candidate.nextRevision;
      for (const [id, transfer] of this.transfers) if (transfer.transaction.target !== this.revision) this.transfers.delete(id);
      this.expire();
      const targets = (this.options.clients?.() ?? []).filter(client => client.role !== 'remote' && client.features.has(WORKS_SYNC_FEATURE));
      const active = new Set(targets.map(client => client.id));
      for (const id of this.readers.keys()) if (!active.has(id) && this.options.clients !== undefined) this.dropClient(id);
      const data = { epoch: this.epoch, revision: this.revision };
      const line = encodeLine({ event: 'works.invalidated', data });
      for (const client of targets) {
        const reader = this.reader(client.id);
        if (reader.notified) continue;
        reader.notified = true;
        try { if (client.sendLine !== undefined) client.sendLine(line); else client.send({ event: 'works.invalidated', data }); } catch { reader.notified = false; }
      }
    });
  }

  private reader(id: string): Reader {
    let reader = this.readers.get(id);
    if (reader === undefined) { reader = { pulling: false, backpressure: false, notified: false, completed: false, closed: false }; this.readers.set(id, reader); }
    return reader;
  }
  private forget(pin: Pin, expired = false): void {
    this.cursors.delete(pin.cursor);
    const reader = this.readers.get(pin.client);
    if (reader?.pin === pin) delete reader.pin;
    if (this.cursors.size === 0 && this.mailCursors.size === 0 && this.expiryTimer !== undefined) { clearInterval(this.expiryTimer); this.expiryTimer = undefined; }
    if (expired) {
      this.expired.set(pin.cursor, pin.client);
      while (this.expired.size > 256) this.expired.delete(this.expired.keys().next().value!);
    }
  }
  private expire(): void {
    for (const pin of this.cursors.values()) if (this.now() - pin.touched > (this.options.pinIdleMs ?? WORKS_SYNC_PIN_IDLE_MS)) this.forget(pin, true);
    for (const pin of this.mailCursors.values()) if (this.now() - pin.touched > (this.options.pinIdleMs ?? WORKS_SYNC_PIN_IDLE_MS)) this.forgetMail(pin, true);
  }
  dropClient(id: string): void {
    const reader = this.readers.get(id);
    if (reader?.pin !== undefined) this.forget(reader.pin);
    if (reader !== undefined) reader.closed = true;
    this.readers.delete(id);
    const mail = this.mailReaders.get(id);
    if (mail?.pin !== undefined) this.forgetMail(mail.pin);
    if (mail !== undefined) mail.closed = true;
    this.mailReaders.delete(id);
  }
  stop(): void { this.stopped = true; if (this.expiryTimer !== undefined) clearInterval(this.expiryTimer); for (const id of new Set([...this.readers.keys(), ...this.mailReaders.keys()])) this.dropClient(id); this.transfers.clear(); }

  private start(client: Client, base: number): Promise<Pin> {
    return this.queue(() => {
      const reader = this.readers.get(client.id);
      if (this.publicationFailed) throw new HostError('conflict', 'Works sync publication requires repair.');
      if (reader === undefined || reader.closed || this.stopped) throw new HostError('conflict', 'Works sync client disconnected.');
      if (reader.pin !== undefined) this.forget(reader.pin);
      this.expire();
      while (this.cursors.size >= Math.max(1, this.options.maxPins ?? 64)) this.forget(this.cursors.values().next().value!, true);
      const reset = base === 0 || !reader.completed || base < this.floor || base > this.revision;
      const transaction: WorksSyncTransaction = { mode: reset ? 'reset' : 'delta', epoch: this.epoch, base: reset ? 0 : base, target: this.revision };
      const id = JSON.stringify(transaction);
      let transfer = this.transfers.get(id);
      if (transfer === undefined) {
        const streams = this.keys.map(key => this.rows.records(key, reset ? -1 : base));
        // Удаления работ включаются из снимка tombstone, до следующей публикации/продвижения пола.
        const present = new Set(this.keys.map(keyId));
        const tombstones = this.deletedKeys.filter(row => row.revision > base && !present.has(keyId(row.key))).map(row => ({ kind: 'work-remove', key: row.key }) as WorksSyncRecord);
        const branchRecords: WorksSyncRecord[] = [];
        for (const [projectPath, row] of this.branchRows) if (reset || row.revision > base) branchRecords.push({ kind: 'branch', projectPath, branch: row.value });
        if (!reset) for (const [projectPath, revision] of this.branchDeletes) if (revision > base) branchRecords.push({ kind: 'branch-remove', projectPath });
        const makeRecords = async function* (): AsyncGenerator<WorksSyncRecord> {
          for (const record of branchRecords) yield record;
          for (const stream of streams) yield* stream;
          if (!reset) for (const record of tombstones) yield record;
        };
        const make = () => encodeSyncRecords(makeRecords(), { frame: records => records, maxBytes: this.payloadCap, stats: this.stats });
        transfer = { id, epoch: this.epoch, transaction: Object.freeze(transaction), make, iterator: make(), produced: 0, total: null, tail: Promise.resolve() };
        this.transfers.set(id, transfer);
        while (this.transfers.size > 16) this.transfers.delete(this.transfers.keys().next().value!);
      }
      const pin: Pin = { client: client.id, transfer, index: 0, cursor: randomUUID(), touched: this.now() };
      reader.pin = pin; reader.notified = false;
      this.cursors.set(pin.cursor, pin);
      if (this.expiryTimer === undefined) {
        this.expiryTimer = setInterval(() => this.expire(), Math.max(5, Math.min(1000, this.options.pinIdleMs ?? WORKS_SYNC_PIN_IDLE_MS)));
        this.expiryTimer.unref();
      }
      return pin;
    });
  }
  private deletedKeys: Array<{ key: WorksSyncWorkKey; revision: number }> = [];

  private async page(transfer: PayloadTransfer, index: number): Promise<EncodedSyncRecords | null> {
    const cache = this.cache;
    const run = async (): Promise<EncodedSyncRecords | null> => {
      if (transfer.epoch !== this.epoch) return null;
      const key = `${transfer.id}:${index}`;
      const resident = cache.get(key);
      if (resident !== undefined) { const page = this.payloads.get(resident); if (page !== undefined) return page; }
      if (transfer.total !== null && index >= transfer.total) return null;
      let page: IteratorResult<EncodedSyncRecords>;
      if (index < transfer.produced) {
        const replay = transfer.make();
        try { for (let at = 0; ; at += 1) { page = await replay.next(); if (page.done || at === index) break; } }
        finally { await replay.return(undefined); }
      } else {
        page = await transfer.iterator.next();
        if (page.done) { transfer.total = transfer.produced; return null; }
        transfer.produced += 1;
      }
      if (page.done) return null;
      if (transfer.epoch !== this.epoch) return null;
      cache.set(key, { json: page.value.json, bytes: page.value.bytes });
      const cached = cache.get(key);
      if (cached !== undefined) this.payloads.set(cached, page.value);
      return page.value;
    };
    const next = transfer.tail.then(run);
    transfer.tail = next.catch(() => undefined);
    return next;
  }

  async pull(client: Client, request: Params<'works.sync'>, id: number): Promise<PreparedWorksSyncReply> {
    if (this.stopped || client.role === 'remote' || !client.features.has(WORKS_SYNC_FEATURE)) throw new HostError('bad_request', 'Works sync is unavailable for this client.');
    const reader = this.reader(client.id);
    if (reader.pulling) throw new HostError('conflict', 'Only one works sync pull is allowed per client.');
    reader.pulling = true;
    try {
      let pin: Pin;
      if (request.cursor !== undefined) {
        const found = this.cursors.get(request.cursor);
        if (found === undefined) return this.repair(client, id, this.expired.get(request.cursor) === client.id ? 'cursor-expired' : 'cursor-unknown');
        if (found.client !== client.id) return this.repair(client, id, 'cursor-client');
        if (this.now() - found.touched > (this.options.pinIdleMs ?? WORKS_SYNC_PIN_IDLE_MS)) { this.forget(found, true); return this.repair(client, id, 'cursor-expired'); }
        pin = found;
      } else pin = await this.start(client, request.base!);
      if (reader.backpressure) { await new Promise<void>(resolve => setImmediate(resolve)); reader.backpressure = false; }
      while (client.writableLength() > (this.options.highWaterBytes ?? 4 * 1024 * 1024)) {
        if (reader.closed || this.stopped || this.now() - pin.touched > (this.options.pinIdleMs ?? WORKS_SYNC_PIN_IDLE_MS)) { this.forget(pin, true); return this.repair(client, id, 'cursor-expired'); }
        await new Promise<void>(resolve => setTimeout(resolve, 10));
      }
      const payload = await this.page(pin.transfer, pin.index);
      const nextPayload = payload === null ? null : await this.page(pin.transfer, pin.index + 1);
      if (reader.closed || this.stopped || reader.pin !== pin) return this.repair(client, id, 'cursor-unknown');
      const commit = nextPayload === null;
      const currentCursor = pin.cursor;
      const nextCursor = commit ? null : randomUUID();
      const result: WorksSyncPage = { kind: 'page', transaction: pin.transfer.transaction, index: pin.index, cursor: currentCursor, next: nextCursor, records: payload?.records ?? [], commit };
      const recordsJson = payload?.json ?? '[]';
      const envelope = { kind: result.kind, transaction: result.transaction, index: result.index, cursor: result.cursor, next: result.next, commit: result.commit };
      const resultJson = JSON.stringify(envelope).slice(0, -1) + ',"records":' + recordsJson + '}';
      this.cursors.delete(currentCursor);
      pin.touched = this.now(); pin.index += 1;
      if (nextCursor === null) { delete reader.pin; reader.completed = true; if (this.cursors.size === 0 && this.mailCursors.size === 0 && this.expiryTimer !== undefined) { clearInterval(this.expiryTimer); this.expiryTimer = undefined; } }
      else { pin.cursor = nextCursor; this.cursors.set(nextCursor, pin); }
      return this.prepared(client, id, result, resultJson);
    } finally { reader.pulling = false; }
  }

  private repair(client: Client, id: number, reason: WorksSyncResetReason): PreparedWorksSyncReply {
    const result: WorksSyncResult = { kind: 'reset-required', reason };
    return this.prepared(client, id, result, JSON.stringify(result));
  }
  private prepared(client: Client, id: number, result: WorksSyncResult | WorksMailStateResult, json: string, sent?: (writable: boolean) => void): PreparedWorksSyncReply {
    const line = `{"id":${JSON.stringify(id)},"result":${json}}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (!Number.isFinite(id) || bytes > this.pageBytes) throw new HostError('internal', 'Works sync response exceeds its frame budget.');
    return Object.freeze({ result: Object.freeze(result), line, bytes, resultBytes: Buffer.byteLength(json), sent: sent ?? ((writable: boolean) => { const reader = this.readers.get(client.id); if (!writable && reader !== undefined) reader.backpressure = true; }) });
  }

  private forgetMail(pin: MailPin, expired = false): void {
    this.mailCursors.delete(pin.cursor);
    const reader = this.mailReaders.get(pin.client);
    if (reader?.pin === pin) delete reader.pin;
    // Незавершённый generator больше не удерживает метаданные после истечения/отключения.
    void pin.transfer.iterator.return(undefined).catch(() => undefined);
    if (expired) {
      this.mailExpired.set(pin.cursor, { client: pin.client, key: pin.transfer.identity.key });
      while (this.mailExpired.size > 256) this.mailExpired.delete(this.mailExpired.keys().next().value!);
    }
    if (this.cursors.size === 0 && this.mailCursors.size === 0 && this.expiryTimer !== undefined) { clearInterval(this.expiryTimer); this.expiryTimer = undefined; }
  }

  /** Независимо один mail pull/пин и один structural pull/пин на соединение. */
  async pullMailState(client: Client, request: Params<'works.mailState'>, id: number): Promise<PreparedWorksSyncReply> {
    if (this.stopped || client.role === 'remote' || !client.features.has(WORKS_SYNC_FEATURE)) throw new HostError('bad_request', 'Mail state is unavailable for this client.');
    const unavailable = (reason: WorksMailStateFailureReason): PreparedWorksSyncReply => {
      const result: WorksMailStateResult = { kind: 'mail-unavailable', reason };
      return this.prepared(client, id, result, JSON.stringify(result));
    };
    const epoch = this.epoch;
    let reader = this.mailReaders.get(client.id);
    if (reader === undefined) { reader = { pulling: false, closed: false, backpressure: false }; this.mailReaders.set(client.id, reader); }
    if (reader.pulling) return unavailable('busy');
    reader.pulling = true;
    let pin: MailPin | undefined;
    let starting = false;
    try {
      this.expire();
      if (request.cursor !== undefined) {
        pin = this.mailCursors.get(request.cursor);
        if (pin === undefined) return unavailable(this.mailExpired.get(request.cursor)?.client === client.id ? 'cursor-expired' : 'cursor-unknown');
        if (pin.client !== client.id) return unavailable('cursor-client');
        if (keyId(pin.transfer.identity.key) !== keyId(request)) return unavailable('cursor-work');
      } else {
        if (reader.pin !== undefined || this.mailCursors.size + this.mailStarting >= Math.max(1, this.options.maxPins ?? 64)) return unavailable('busy');
        if (this.options.captureMail === undefined) return unavailable('retry');
        this.mailStarting += 1; starting = true;
        const captured = await this.options.captureMail({ projectPath: request.projectPath, workId: request.workId });
        if (reader.closed || this.stopped) return unavailable('cursor-unknown');
        if (epoch !== this.epoch) return unavailable('retry');
        if (captured.kind !== 'captured') return unavailable(captured.reason);
        if (keyId(captured.key) !== keyId(request) || captured.requiredStructuralVersion > captured.sourceVersion) return unavailable('retry');
        const mail = await cloneWindowValue(captured.mail);
        if (reader.closed || this.stopped) return unavailable('cursor-unknown');
        if (epoch !== this.epoch) return unavailable('retry');
        const identity: WorksMailStateIdentity = { epoch, key: Object.freeze({ ...captured.key }), sourceVersion: captured.sourceVersion, requiredStructuralVersion: captured.requiredStructuralVersion };
        const reserve: WorksMailStatePage = { kind: 'mail-page', ...identity, index: Number.MAX_SAFE_INTEGER, cursor: 'x'.repeat(80), next: 'x'.repeat(80), records: [], commit: false };
        const cap = this.pageBytes - (Buffer.byteLength(JSON.stringify({ id: -Number.MAX_VALUE, result: reserve })) - 2 + 1);
        if (cap < 256) return unavailable('retry');
        const makeRecords = async function* (): AsyncGenerator<WorksSyncRecord> {
          yield { kind: 'row', key: identity.key, field: 'mailSummary', row: { unreadLetters: mail.unread.letters } };
          function* rooms(): Generator<unknown> { for (const roomId in mail.rooms) if (Object.hasOwn(mail.rooms, roomId)) yield { roomId, metadata: mail.rooms[roomId]! }; }
          function* unread(): Generator<unknown> { for (const roomId in mail.unread.rooms) if (Object.hasOwn(mail.unread.rooms, roomId)) yield { roomId, count: mail.unread.rooms[roomId]! }; }
          const lists: Array<[WorksMailStateField, Iterable<unknown>]> = [
            ['mailRooms', rooms()],
            ['unreadRooms', unread()],
            ['mentionCandidates', mail.mentionCandidates],
          ];
          for (const [field, values] of lists) {
            let start = 0, items: unknown[] = [];
            for (const value of values) {
              items.push(value);
              if (items.length === 32) { yield { kind: 'section', key: identity.key, field, start, items, final: false }; start += items.length; items = []; }
            }
            yield { kind: 'section', key: identity.key, field, start, items, final: true };
          }
        };
        const make = () => encodeSyncRecords(makeRecords(), { frame: mailWireRecords, maxBytes: cap, stats: this.stats });
        const transfer: MailTransfer = { id: `mail:${randomUUID()}`, epoch, identity: Object.freeze(identity), ...(captured.lifetime === undefined ? {} : { lifetime: captured.lifetime }), make, iterator: make(), produced: 0, total: null, tail: Promise.resolve() };
        pin = { client: client.id, transfer, index: 0, cursor: randomUUID(), touched: this.now() };
        reader.pin = pin; this.mailCursors.set(pin.cursor, pin);
        this.mailStarting -= 1; starting = false;
        if (this.expiryTimer === undefined) {
          this.expiryTimer = setInterval(() => this.expire(), Math.max(5, Math.min(1000, this.options.pinIdleMs ?? WORKS_SYNC_PIN_IDLE_MS))); this.expiryTimer.unref();
        }
      }
      const alive = (): WorksMailStateFailureReason | undefined => {
        try { if (epoch !== this.epoch || reader.pin !== pin) return 'cursor-unknown'; return this.options.mailAlive?.(pin!.transfer.identity.key, pin!.transfer.identity.sourceVersion, pin!.transfer.lifetime) === false ? 'not-found' : undefined; }
        catch { return 'busy'; }
      };
      let failure = alive();
      if (failure !== undefined) { this.forgetMail(pin); return unavailable(failure); }
      if (reader.backpressure) { await new Promise<void>(resolve => setImmediate(resolve)); reader.backpressure = false; }
      while (client.writableLength() > (this.options.highWaterBytes ?? 4 * 1024 * 1024)) {
        if (reader.closed || this.stopped || reader.pin !== pin || this.now() - pin.touched > (this.options.pinIdleMs ?? WORKS_SYNC_PIN_IDLE_MS)) { this.forgetMail(pin, true); return unavailable('cursor-expired'); }
        await new Promise<void>(resolve => setTimeout(resolve, 10));
      }
      const payload = await this.page(pin.transfer, pin.index);
      const following = payload === null ? null : await this.page(pin.transfer, pin.index + 1);
      if (reader.closed || this.stopped || reader.pin !== pin) return unavailable('cursor-unknown');
      failure = alive();
      if (failure !== undefined) { this.forgetMail(pin); return unavailable(failure); }
      const next = following === null ? null : randomUUID();
      const result: WorksMailStatePage = { kind: 'mail-page', ...pin.transfer.identity, index: pin.index, cursor: pin.cursor, next, commit: next === null, records: mailWireRecords(payload?.records ?? []) };
      const envelope = { kind: result.kind, ...pin.transfer.identity, index: result.index, cursor: result.cursor, next: result.next, commit: result.commit };
      const json = JSON.stringify(envelope).slice(0, -1) + ',"records":' + (payload?.json ?? '[]') + '}';
      this.mailCursors.delete(pin.cursor); pin.index += 1; pin.touched = this.now();
      if (next === null) this.forgetMail(pin);
      else { pin.cursor = next; this.mailCursors.set(next, pin); }
      return this.prepared(client, id, result, json, writable => { if (!writable) reader.backpressure = true; });
    } catch (error) { if (pin !== undefined && pin.client === client.id) this.forgetMail(pin); throw error; }
    finally { if (starting) this.mailStarting -= 1; reader.pulling = false; }
  }
}

function mailWireRecords(records: readonly WorksSyncRecord[]): WorksMailStateRecord[] {
  const rows: WorksMailStateRecord[] = records.map(record => {
    if (record.kind === 'row' && record.id === undefined && record.field === 'mailSummary' && typeof record.row === 'object' && record.row !== null && 'unreadLetters' in record.row && typeof record.row.unreadLetters === 'number') return Object.freeze({ kind: 'mail-summary', key: record.key, unreadLetters: record.row.unreadLetters });
    if ((record.kind === 'section' || record.kind === 'section-fragment') && (record.field === 'mailRooms' || record.field === 'unreadRooms' || record.field === 'mentionCandidates')) return Object.freeze({ ...record, field: record.field });
    throw new Error('Structural record cannot enter mail-state wire');
  });
  return Object.freeze(rows) as unknown as WorksMailStateRecord[];
}

// Runtime-private brand: JSON клиента или похожие ключи не могут породить доверенный wire-result.
const prepared = new WeakMap<object, (id: number) => Promise<PreparedWorksSyncReply>>();
export function prepareWorksSyncReply(host: WorksSyncHost, client: Client, request: Params<'works.sync'>): object {
  const token = Object.freeze({});
  prepared.set(token, id => host.pull(client, request, id));
  return token;
}
export function prepareWorksMailStateReply(host: WorksSyncHost, client: Client, request: Params<'works.mailState'>): object {
  const token = Object.freeze({});
  prepared.set(token, id => host.pullMailState(client, request, id));
  return token;
}
export function resolvePreparedWorksSyncReply(value: unknown, id: number): Promise<PreparedWorksSyncReply | undefined> {
  if (typeof value !== 'object' || value === null) return Promise.resolve(undefined);
  const build = prepared.get(value);
  if (build === undefined) return Promise.resolve(undefined);
  prepared.delete(value);
  return build(id);
}
