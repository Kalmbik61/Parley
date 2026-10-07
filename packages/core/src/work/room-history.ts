import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { representLegacyMarkdown } from './decision-journal.js';
import { participantLabel } from './thread.js';
import { stateDir } from './state-dir.js';
import { readMap, readSharedFile, sharedProjectPaths, withSharedProjectLock, withLocalHistoryLock, prepareSharedIgnore, MISSING_SHARED_VERSION } from './store.js';
import type { SharedDiagnostic, SharedFileSnapshot, SharedWriteOptions } from './store.js';
import { ImmutableMarkdownError, publishImmutableMarkdown, replaceOwnedMarkdown } from './shared-markdown.js';
import type { MarkdownIdentity } from './shared-markdown.js';
import type { WorkMap } from './types.js';

export type RoomHistoryCode = 'history-invalid' | 'history-conflict' | 'history-stale' | 'history-unavailable';
export class RoomHistoryError extends Error {
  constructor(readonly code: RoomHistoryCode) { super(code); this.name = 'RoomHistoryError'; }
}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const strict = (text: string): boolean => !text.includes('\0') && Buffer.from(text).toString() === text;
const validId = (workId: string, roomId: string): boolean => /^w-\d+$/.test(workId) && /^r-\d+$/.test(roomId) && `${workId}-${roomId}.md`.length <= 255;
const metadata = (text: string): string => JSON.stringify(text);
function member(map: WorkMap, id: string): string {
  const role = map.sessions.find(row => row.id === id)?.role;
  return `${metadata(participantLabel(map, id))}${role ? ` (${role.source}:${metadata(role.name)})` : ''}`;
}
/** Full derived room feed only. No direct/solo-provider transcript or prompt/config is read. */
export function renderRoomHistory(map: WorkMap, roomId: string): string {
  const room = map.rooms.find(row => row.id === roomId);
  if (!room || !validId(map.work.id, roomId)) throw new RoomHistoryError('history-invalid');
  const recipe = (room as typeof room & { recipe?: { id: string; name?: string; playbook?: string } }).recipe;
  const lines = [
    `# ${room.title}`, '', `Work: ${map.work.id} — ${metadata(map.work.title)}`,
    `Room: ${room.id}; mode: ${room.mode ?? 'free'}`, `Created: ${room.createdAt}`,
    `Lead: ${room.lead ? member(map, room.lead) : 'not assigned'}`, '', '## Participants',
    ...room.members.map(id => `- ${id}: ${member(map, id)}`),
  ];
  if (recipe && typeof recipe.id === 'string') lines.push('', `Recipe: ${metadata(recipe.id)}${typeof recipe.name === 'string' ? ` — ${metadata(recipe.name)}` : ''}`);
  lines.push('', '## Feed');
  for (const message of map.messages.filter(row => row.roomId === roomId)) {
    lines.push('', `### ${message.at} — ${member(map, message.from)} (${message.kind})`, message.text);
  }
  const result = representLegacyMarkdown(`${lines.join('\n')}\n`);
  if (Buffer.byteLength(result) > 1024 * 1024 || !strict(result)) throw new RoomHistoryError('history-invalid');
  return result;
}
interface OwnedHistory { target: string; proof: MarkdownIdentity; at: string }
interface PendingHistory extends OwnedHistory { kind: 'local' | 'share'; content: string }
interface HistoryReceipt {
  schemaVersion: 1; projectPath: string; workId: string; roomId: string;
  local?: OwnedHistory; shared?: OwnedHistory; pending?: PendingHistory;
}
interface HistoryPaths { root: string; parent: string; file: string; receipt: string; projectPath: string }
const identityValid = (value: unknown): value is MarkdownIdentity => {
  if (!value || typeof value !== 'object') return false;
  const v = value as MarkdownIdentity;
  return Number.isSafeInteger(v.ino) && v.ino >= 0 && Number.isSafeInteger(v.dev) && v.dev >= 0 && typeof v.sha256 === 'string' && /^[0-9a-f]{64}$/.test(v.sha256);
};
async function localPaths(projectPath: string, workId: string, roomId: string): Promise<HistoryPaths> {
  if (!validId(workId, roomId)) throw new RoomHistoryError('history-invalid');
  const project = await realpath(projectPath); const root = stateDir(project);
  if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new RoomHistoryError('history-unavailable');
  const parent = path.join(root, 'history');
  await mkdir(parent, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) throw new RoomHistoryError('history-unavailable');
  return { projectPath: project, root, parent, file: path.join(parent, `${workId}-${roomId}.md`), receipt: path.join(parent, `${workId}-${roomId}.receipt.json`) };
}
function parseReceipt(snapshot: SharedFileSnapshot, paths: HistoryPaths, workId: string, roomId: string, sharedTarget: string | undefined): HistoryReceipt {
  if (snapshot.version === MISSING_SHARED_VERSION) return { schemaVersion: 1, projectPath: paths.projectPath, workId, roomId };
  let value: HistoryReceipt;
  try { value = JSON.parse(snapshot.text) as HistoryReceipt; } catch { throw new RoomHistoryError('history-conflict'); }
  const owned = (row: OwnedHistory | undefined, target: string): boolean => row === undefined || (!!row && row.target === target && identityValid(row.proof) && typeof row.at === 'string' && Number.isFinite(Date.parse(row.at)));
  if (!value || value.schemaVersion !== 1 || value.projectPath !== paths.projectPath || value.workId !== workId || value.roomId !== roomId ||
    Object.keys(value).some(key => !['schemaVersion', 'projectPath', 'workId', 'roomId', 'local', 'shared', 'pending'].includes(key)) ||
    !owned(value.local, paths.file) ||
    (sharedTarget === undefined ? value.shared !== undefined || value.pending?.kind === 'share' : !owned(value.shared, sharedTarget)) ||
    (value.pending !== undefined && (!['local', 'share'].includes(value.pending.kind) || !owned(value.pending, value.pending.kind === 'local' ? paths.file : sharedTarget!) || typeof value.pending.content !== 'string' || !strict(value.pending.content) || Buffer.byteLength(value.pending.content) > 1024 * 1024 || hash(value.pending.content) !== value.pending.proof.sha256)))
    throw new RoomHistoryError('history-conflict');
  return value;
}
const matches = async (row: OwnedHistory): Promise<boolean> => {
  const info = await lstat(row.target).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
  if (!info || !info.isFile() || info.ino !== row.proof.ino || info.dev !== row.proof.dev) return false;
  const snapshot = await readSharedFile(row.target); const after = await lstat(row.target);
  return info.ino === after.ino && info.dev === after.dev && hash(snapshot.text) === row.proof.sha256;
};
async function receiptWriter(paths: HistoryPaths) {
  let snapshot = await readSharedFile(paths.receipt);
  return {
    snapshot,
    save: async (receipt: HistoryReceipt) => {
      const content = `${JSON.stringify(receipt)}\n`;
      if (!strict(content) || Buffer.byteLength(content) > 1024 * 1024) throw new RoomHistoryError('history-invalid');
      const root = await lstat(paths.root), parent = await lstat(paths.parent);
      const verifyParent = async (): Promise<void> => {
        const currentRoot = await lstat(paths.root), currentParent = await lstat(paths.parent);
        if (!root.isDirectory() || !parent.isDirectory() || !currentRoot.isDirectory() || !currentParent.isDirectory() ||
            root.ino !== currentRoot.ino || root.dev !== currentRoot.dev || parent.ino !== currentParent.ino || parent.dev !== currentParent.dev ||
            await realpath(paths.root) !== paths.root || await realpath(paths.parent) !== paths.parent)
          throw new RoomHistoryError('history-unavailable');
      };
      await verifyParent();
      const temporary = `${paths.receipt}.${randomUUID()}.tmp`;
      let proof: OwnedHistory | undefined;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const identity = await handle.stat();
        if (!identity.isFile()) throw new RoomHistoryError('history-unavailable');
        proof = { target: temporary, at: new Date().toISOString(), proof: { ino: identity.ino, dev: identity.dev, sha256: hash('') } };
        await handle.writeFile(content, 'utf8'); proof.proof.sha256 = hash(content);
        await handle.sync();
        // Read through the same descriptor; a path replacement cannot become our source proof.
        const bytes = Buffer.alloc(Buffer.byteLength(content) + 1);
        let length = 0;
        while (length < bytes.length) {
          const result = await handle.read(bytes, length, bytes.length - length, length);
          if (result.bytesRead === 0) break;
          length += result.bytesRead;
        }
        const final = await handle.stat();
        if (final.ino !== identity.ino || final.dev !== identity.dev || !final.isFile() ||
            length !== Buffer.byteLength(content) || createHash('sha256').update(bytes.subarray(0, length)).digest('hex') !== proof.proof.sha256)
          throw new RoomHistoryError('history-unavailable');
        await handle.close(); handle = undefined;
        await verifyParent();
        if (!await matches(proof)) throw new RoomHistoryError('history-unavailable');
        if ((await readSharedFile(paths.receipt)).version !== snapshot.version) throw new RoomHistoryError('history-conflict');
        await verifyParent();
        if (!await matches(proof)) throw new RoomHistoryError('history-unavailable');
        await rename(temporary, paths.receipt);
        if (!await matches({ ...proof, target: paths.receipt })) throw new RoomHistoryError('history-conflict');
        snapshot = await readSharedFile(paths.receipt);
      } finally {
        try { await handle?.close(); }
        finally { if (proof && await matches(proof)) await unlink(temporary); }
      }
    },
  };
}
/** Pending receipt is an own prepared inode, not permission to adopt equal foreign bytes. */
async function recover(receipt: HistoryReceipt, save: (receipt: HistoryReceipt) => Promise<void>): Promise<void> {
  const pending = receipt.pending;
  if (!pending) return;
  if (await matches(pending)) {
    const owned = { target: pending.target, proof: pending.proof, at: pending.at };
    if (pending.kind === 'local') receipt.local = owned; else receipt.shared = owned;
  } else {
    const current = await readSharedFile(pending.target);
    const old = pending.kind === 'local' ? receipt.local : receipt.shared;
    if (current.version !== MISSING_SHARED_VERSION && (!old || !await matches(old))) throw new RoomHistoryError('history-conflict');
  }
  delete receipt.pending; await save(receipt);
}
async function commitHistory(receipt: HistoryReceipt, save: (receipt: HistoryReceipt) => Promise<void>, kind: 'local' | 'share', root: string, parent: string, target: string, content: string, at: string, options: SharedWriteOptions): Promise<void> {
  const previous = await readSharedFile(target); const owned = kind === 'local' ? receipt.local : receipt.shared;
  if (previous.version !== MISSING_SHARED_VERSION && (!owned || !await matches(owned))) throw new RoomHistoryError('history-conflict');
  if (previous.version !== MISSING_SHARED_VERSION && previous.text === content && owned) {
    const next = { ...owned, at };
    if (kind === 'local') receipt.local = next; else receipt.shared = next;
    await save(receipt); return;
  }
  let prepared: MarkdownIdentity | undefined;
  const callbacks = { ...options, mode: kind === 'local' ? 0o600 as const : 0o644 as const, onPrepared: async (proof: MarkdownIdentity) => {
    prepared = proof; receipt.pending = { kind, target, content, at, proof }; await save(receipt);
  } };
  const proof = previous.version === MISSING_SHARED_VERSION
    ? await publishImmutableMarkdown(root, parent, { file: path.basename(target), content }, callbacks)
    : await replaceOwnedMarkdown(root, parent, { file: path.basename(target), content }, previous, owned!.proof, callbacks);
  if (!prepared || proof.ino !== prepared.ino || proof.dev !== prepared.dev || proof.sha256 !== prepared.sha256) throw new RoomHistoryError('history-conflict');
  const next = { target, proof, at };
  if (kind === 'local') receipt.local = next; else receipt.shared = next;
  delete receipt.pending; await save(receipt);
}
export interface RoomHistoryResult { sharedAt: string | null; diagnostics: SharedDiagnostic[] }
async function operation(projectPath: string, workId: string, roomId: string, action: 'local' | 'share' | 'unshare', options: SharedWriteOptions = {}): Promise<RoomHistoryResult> {
  try {
    const map = await readMap(projectPath, workId);
    if (map.work.id !== workId) throw new RoomHistoryError('history-invalid');
    const content = renderRoomHistory(map, roomId);
    const paths = await localPaths(projectPath, workId, roomId);
    return await withLocalHistoryLock(paths.root, paths.parent, async () => {
      const writer = await receiptWriter(paths);
      let stored: HistoryReceipt | undefined;
      if (writer.snapshot.version !== MISSING_SHARED_VERSION) {
        try { stored = JSON.parse(writer.snapshot.text) as HistoryReceipt; } catch { throw new RoomHistoryError('history-conflict'); }
      }
      const shared = action !== 'local' || stored?.shared !== undefined || stored?.pending?.kind === 'share'
        ? await sharedProjectPaths(projectPath, options) : undefined;
      const sharedTarget = shared ? path.join(shared.historyShared, `${workId}-${roomId}.md`) : undefined;
      const body = async (): Promise<RoomHistoryResult> => {
      const receipt = parseReceipt(writer.snapshot, paths, workId, roomId, sharedTarget);
      await recover(receipt, writer.save);
      if (renderRoomHistory(await readMap(projectPath, workId), roomId) !== content) throw new RoomHistoryError('history-stale');
      if (action !== 'local' && options.expectedVersion !== undefined && (await readSharedFile(sharedTarget!)).version !== options.expectedVersion) throw new RoomHistoryError('history-conflict');
      const beforeCommit = async (target: string, attempt: number) => {
        await options.beforeCommit?.(target, attempt);
        if (renderRoomHistory(await readMap(projectPath, workId), roomId) !== content) throw new RoomHistoryError('history-stale');
      };
      if (action === 'unshare') {
        const previous = await readSharedFile(sharedTarget!);
        if (previous.version !== MISSING_SHARED_VERSION) {
          if (!receipt.shared || !await matches(receipt.shared)) throw new RoomHistoryError('history-conflict');
          await beforeCommit(sharedTarget!, 0);
          if (!await matches(receipt.shared)) throw new RoomHistoryError('history-conflict');
          await unlink(sharedTarget!);
        }
        delete receipt.shared; await writer.save(receipt);
      } else {
        const at = new Date().toISOString();
        await commitHistory(receipt, writer.save, 'local', paths.root, paths.parent, paths.file, content, at, { ...options, beforeCommit });
        if (action === 'share') await commitHistory(receipt, writer.save, 'share', shared!.dir, shared!.historyShared, sharedTarget!, content, at, { ...options, beforeCommit });
      }
      return { sharedAt: receipt.shared?.at ?? null, diagnostics: action === 'share' ? await prepareSharedIgnore(shared!, options) : [] };
      };
      return shared ? withSharedProjectLock(shared, body, options) : body();
    }, options);
  } catch (error) {
    if (error instanceof RoomHistoryError) throw error;
    if (error instanceof ImmutableMarkdownError && error.code === 'conflict') throw new RoomHistoryError('history-conflict');
    throw new RoomHistoryError('history-unavailable');
  }
}
export type RoomHistoryState = 'not-shared' | 'shared' | 'conflict';
export interface RoomHistoryStatus {
  state: RoomHistoryState;
  /** Время выкладки — только если выложенный файл принадлежит Parley и не менялся; иначе `null`. */
  sharedAt: string | null;
  /** Версия выложенного файла: ждёт её `expectedVersion` Share и Unshare. `missing` — файла нет. */
  version: string;
}
/**
 * Только чтение: ничего не создаёт (ни папку истории, ни замок) и не переносит. Владение проверяется по тому же
 * приватному квитку, что и у Share: чужой или правленный файл — `conflict`, а не «выложено».
 */
export async function readRoomHistoryStatus(projectPath: string, workId: string, roomId: string, options: SharedWriteOptions = {}): Promise<RoomHistoryStatus> {
  try {
    if (!validId(workId, roomId)) throw new RoomHistoryError('history-invalid');
    const shared = await sharedProjectPaths(projectPath, options);
    const target = path.join(shared.historyShared, `${workId}-${roomId}.md`);
    const file = await readSharedFile(target);
    const project = await realpath(projectPath); const root = stateDir(project); const parent = path.join(root, 'history');
    const paths: HistoryPaths = { projectPath: project, root, parent, file: path.join(parent, `${workId}-${roomId}.md`), receipt: path.join(parent, `${workId}-${roomId}.receipt.json`) };
    const none: RoomHistoryStatus = { state: file.version === MISSING_SHARED_VERSION ? 'not-shared' : 'conflict', sharedAt: null, version: file.version };
    const dir = await lstat(parent).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (!dir) return none;
    if (!dir.isDirectory() || await realpath(parent) !== parent) throw new RoomHistoryError('history-unavailable');
    let receipt: HistoryReceipt;
    try { receipt = parseReceipt(await readSharedFile(paths.receipt), paths, workId, roomId, target); }
    catch (error) { if (error instanceof RoomHistoryError && error.code === 'history-conflict') return { ...none, state: 'conflict' }; throw error; }
    if (file.version === MISSING_SHARED_VERSION) return none;
    if (!receipt.shared || !await matches(receipt.shared)) return { state: 'conflict', sharedAt: null, version: file.version };
    return { state: 'shared', sharedAt: receipt.shared.at, version: file.version };
  } catch (error) {
    if (error instanceof RoomHistoryError) throw error;
    throw new RoomHistoryError('history-unavailable');
  }
}
export const rebuildRoomHistory = (projectPath: string, workId: string, roomId: string, options: SharedWriteOptions = {}): Promise<RoomHistoryResult> => operation(projectPath, workId, roomId, 'local', options);
/** Host calls only after explicit human publication confirmation. Snapshot never auto-follows future map changes. */
export const shareRoomHistory = (projectPath: string, workId: string, roomId: string, options: SharedWriteOptions = {}): Promise<RoomHistoryResult> => operation(projectPath, workId, roomId, 'share', options);
/** Portable compare/unlink is not adversarial filesystem CAS; receipt and shared file are separate commits. Git history remains. */
export const unshareRoomHistory = (projectPath: string, workId: string, roomId: string, options: SharedWriteOptions = {}): Promise<RoomHistoryResult> => operation(projectPath, workId, roomId, 'unshare', options);
/** Work deletion passes the captured room IDs after removing its map, so a late rebuild cannot recreate it. */
export async function removeLocalRoomHistories(projectPath: string, workId: string, roomIds: readonly string[], options: SharedWriteOptions = {}): Promise<{ removed: number; failed: { roomId: string; code: RoomHistoryCode }[] }> {
  const result: { removed: number; failed: { roomId: string; code: RoomHistoryCode }[] } = { removed: 0, failed: [] };
  if (roomIds.length > 30_000) throw new RoomHistoryError('history-invalid');
  for (const roomId of roomIds) {
    try {
      const paths = await localPaths(projectPath, workId, roomId);
      await withLocalHistoryLock(paths.root, paths.parent, async () => {
        const snapshot = await readSharedFile(paths.receipt);
        let stored: HistoryReceipt | undefined;
        if (snapshot.version !== MISSING_SHARED_VERSION) {
          try { stored = JSON.parse(snapshot.text) as HistoryReceipt; } catch { throw new RoomHistoryError('history-conflict'); }
        }
        const shared = stored?.shared !== undefined || stored?.pending?.kind === 'share'
          ? await sharedProjectPaths(projectPath, options) : undefined;
        const receipt = parseReceipt(snapshot, paths, workId, roomId, shared ? path.join(shared.historyShared, `${workId}-${roomId}.md`) : undefined);
        if (receipt.pending?.kind === 'local' && await matches(receipt.pending)) receipt.local = receipt.pending;
        const previous = await readSharedFile(paths.file);
        if (previous.version !== MISSING_SHARED_VERSION) {
          if (!receipt.local || !await matches(receipt.local)) throw new RoomHistoryError('history-conflict');
          await unlink(paths.file);
        }
        if ((await readSharedFile(paths.receipt)).version !== snapshot.version) throw new RoomHistoryError('history-conflict');
        if (snapshot.version !== MISSING_SHARED_VERSION) await unlink(paths.receipt);
        result.removed++;
      }, options);
    } catch (error) { result.failed.push({ roomId, code: error instanceof RoomHistoryError ? error.code : 'history-unavailable' }); }
  }
  return result;
}
