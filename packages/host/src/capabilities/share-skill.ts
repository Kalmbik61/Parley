import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readlink, realpath, rename, unlink, symlink, link, rmdir } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { stateDir, ensureStateDir } from '@parley/core';
import type { NativeSkill } from '@parley/core';
import type { SnapshotContext } from './snapshot.js';

export type SkillShareCode = 'ok' | 'unverified' | 'unsupported-scope' | 'builtin' | 'ambiguous' | 'occupied' | 'context-changed' | 'receipt-unverified' | 'symlink-error' | 'io-error' | 'stale' | 'shutdown';
type Identity = { dev: number; ino: number; birthtimeMs: number };
const identity = (info: Stats): Identity => ({ dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs });
const same = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
export interface SkillShareTarget {
  provider: 'claude' | 'codex'; other: 'claude' | 'codex'; scope: 'user' | 'project';
  projectPath: string; document: string; original: string; destination: string;
  sourceIdentity: Identity; sourceRoot: string; sourceRootIdentity: Identity;
  destinationRoot: string; destinationParent: string; destinationParentIdentity: Identity;
  contentHash: string | null; receipt: string;
}
export type SkillSharePreparation = { ok: false; code: SkillShareCode } | { ok: true; target: SkillShareTarget };
export type SkillShareResult = { outcome: 'ok' | 'denied' | 'failed'; code: SkillShareCode; scope?: 'user' | 'project' };
interface Receipt {
  version: 1; operation: string; original: string; destination: string; target: string;
  sourceIdentity: Identity; linkIdentity: Identity | null;
}
/** Descriptor-first regular-file reads never follow a receipt/SKILL symlink or block on a FIFO. */
async function resource(file: string, max: number): Promise<{ bytes: Buffer; identity: Identity }> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let owned: Identity; let result: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) throw new Error('unsafe-file');
    const data = Buffer.alloc(max + 1); let length = 0;
    while (length < data.length) {
      const { bytesRead } = await handle.read(data, length, data.length - length, null);
      if (!bytesRead) break; length += bytesRead;
    }
    if (length > max) throw new Error('too-large');
    result = data.subarray(0, length);
    new TextDecoder('utf-8', { fatal: true }).decode(result);
    owned = identity(info);
  } finally { await handle.close(); }
  if (!same(owned, identity(await lstat(file)))) throw new Error('resource-replaced');
  return { bytes: result, identity: owned };
}
async function bytes(file: string, max: number): Promise<Buffer> { return (await resource(file, max)).bytes; }
async function plainDirectory(folder: string): Promise<Identity> {
  const info = await lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(folder) !== folder) throw new Error('unsafe-directory');
  return identity(info);
}
/** Missing native descendants are allowed, but every existing ancestor must be an ordinary canonical directory. */
async function existingParent(folder: string): Promise<{ path: string; identity: Identity }> {
  try { return { path: folder, identity: await plainDirectory(folder) }; }
  catch (error) {
    if (!missing(error) || path.dirname(folder) === folder) throw error;
    return existingParent(path.dirname(folder));
  }
}
const claudeRoot = (context: SnapshotContext): string => path.resolve(context.projectPath, context.claude?.configDir ?? path.join(context.homeDir, '.claude'));
const nativeRoot = (context: SnapshotContext, provider: 'claude' | 'codex', scope: 'user' | 'project'): string => scope === 'project'
  ? path.join(context.projectPath, provider === 'claude' ? '.claude/skills' : '.agents/skills')
  : path.join(provider === 'claude' ? claudeRoot(context) : context.homeDir, provider === 'claude' ? 'skills' : '.agents/skills');
/** Missing native loading proof does not prohibit explicit manual filesystem sharing. */
export const skillSharePolicyAllowed = (skill: NativeSkill): boolean => skill.unavailableReason === null || ['availability-unverified', 'load-tool-unavailable'].includes(skill.unavailableReason);
/** Uses discovery kind/source, not filename/name heuristics. Canonical aliases or ancestor roots unsupported in v1. */
export async function prepareSkillShare(context: SnapshotContext, skill: NativeSkill, protection: { builtin: boolean; separateCopies: boolean }, contentProof = true, cleanupOnly = false): Promise<SkillSharePreparation> {
  if (protection.builtin) return { ok: false, code: 'builtin' };
  if (protection.separateCopies) return { ok: false, code: 'ambiguous' };
  if (skill.documentKind !== 'skill' || !['user', 'project'].includes(skill.source)) return { ok: false, code: 'unsupported-scope' };
  // Manual ownership is independent of missing native loading proof; concrete human/policy hiding remains authoritative.
  if (!cleanupOnly && !skillSharePolicyAllowed(skill)) return { ok: false, code: 'unverified' };
  try {
    await plainDirectory(context.projectPath); await plainDirectory(context.homeDir);
    const scope = skill.source as 'user' | 'project';
    const original = path.dirname(skill.path); const component = path.basename(original);
    if (!path.isAbsolute(skill.path) || component === '.' || component === '..' || Buffer.byteLength(component) > 255 || path.basename(skill.path) !== 'SKILL.md') return { ok: false, code: 'unverified' };
    const roots = [nativeRoot(context, skill.provider, scope)];
    if (skill.provider === 'codex') roots.push(path.join(scope === 'user' ? path.resolve(context.codex?.codexHome ?? path.join(context.homeDir, '.codex')) : path.join(context.projectPath, '.codex'), 'skills'));
    const sourceRoot = roots.find(root => path.dirname(original) === root);
    if (!sourceRoot) return { ok: false, code: 'unverified' };
    const sourceRootIdentity = await plainDirectory(sourceRoot);
    const sourceIdentity = await plainDirectory(original);
    if (await realpath(skill.path) !== skill.path) return { ok: false, code: 'unverified' };
    const documentInfo = await lstat(skill.path);
    if (!documentInfo.isFile() || documentInfo.isSymbolicLink() || documentInfo.size > 1024 * 1024) return { ok: false, code: 'unverified' };
    const contentHash = contentProof ? hash(await bytes(skill.path, 1024 * 1024)) : null;
    const other = skill.provider === 'claude' ? 'codex' : 'claude';
    const destinationRoot = nativeRoot(context, other, scope);
    const parent = await existingParent(destinationRoot);
    const destination = path.join(destinationRoot, component);
    const receipt = path.join(stateDir(context.projectPath), 'skill-share-receipts', `${hash(destination)}.json`);
    return { ok: true, target: { provider: skill.provider, other, scope, projectPath: context.projectPath, document: skill.path, original, destination, sourceIdentity, sourceRoot, sourceRootIdentity, destinationRoot, destinationParent: parent.path, destinationParentIdentity: parent.identity, contentHash, receipt } };
  } catch { return { ok: false, code: 'unverified' }; }
}
async function validSource(target: SkillShareTarget, content: boolean): Promise<boolean> {
  try {
    return same(target.sourceIdentity, await plainDirectory(target.original)) && same(target.sourceRootIdentity, await plainDirectory(target.sourceRoot)) &&
      await realpath(target.document) === target.document && (!content || hash(await bytes(target.document, 1024 * 1024)) === target.contentHash);
  } catch { return false; }
}
async function readReceipt(target: SkillShareTarget): Promise<{ data: Receipt; identity: Identity; hash: string } | null> {
  try {
    await plainDirectory(path.dirname(target.receipt));
    const owned = await resource(target.receipt, 65536); const raw = owned.bytes; const data: unknown = JSON.parse(raw.toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const value = data as Receipt;
    const id = (v: unknown): v is Identity => !!v && typeof v === 'object' && Number.isSafeInteger((v as Identity).dev) && Number.isSafeInteger((v as Identity).ino) && Number.isFinite((v as Identity).birthtimeMs);
    if (Object.keys(value).sort().join(',') !== 'destination,linkIdentity,operation,original,sourceIdentity,target,version' || value.version !== 1 || typeof value.operation !== 'string' || !/^[a-f0-9-]{36}$/.test(value.operation) || value.original !== target.original || value.destination !== target.destination || typeof value.target !== 'string' || !id(value.sourceIdentity) || value.linkIdentity !== null && !id(value.linkIdentity)) return null;
    return { data: value, identity: owned.identity, hash: hash(raw) };
  } catch { return null; }
}
async function sameReceipt(target: SkillShareTarget, receipt: { identity: Identity; hash: string }): Promise<boolean> {
  const current = await readReceipt(target);
  return current !== null && same(current.identity, receipt.identity) && current.hash === receipt.hash;
}
async function ownLink(target: SkillShareTarget, receipt: Receipt): Promise<boolean> {
  try {
    await plainDirectory(target.destinationRoot);
    const info = await lstat(target.destination);
    return receipt.linkIdentity !== null && info.isSymbolicLink() && same(identity(info), receipt.linkIdentity) &&
      await readlink(target.destination) === receipt.target && await realpath(target.destination) === target.original &&
      same(await plainDirectory(target.original), receipt.sourceIdentity);
  } catch { return false; }
}
export async function skillShareAvailability(target: SkillShareTarget): Promise<{ share: boolean; unshare: boolean; reason: SkillShareCode }> {
  try {
    await lstat(target.destination);
    const receipt = await readReceipt(target);
    return { share: false, unshare: receipt !== null && await ownLink(target, receipt.data), reason: 'occupied' };
  } catch (error) {
    if (!missing(error)) return { share: false, unshare: false, reason: 'receipt-unverified' };
    try { await lstat(target.receipt); return { share: false, unshare: false, reason: 'receipt-unverified' }; }
    catch (receiptError) { return { share: missing(receiptError), unshare: false, reason: missing(receiptError) ? 'ok' : 'receipt-unverified' }; }
  }
}
/** Exact exclusive publication: Darwin's link() cannot hardlink symlinks; ln -P derives one child from the staged basename. */
export async function publishSkillLink(source: string, destination: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('publication-cancelled');
  if (process.platform === 'linux') { await link(source, destination); return; }
  if (process.platform !== 'darwin' || !path.isAbsolute(source) || !path.isAbsolute(destination) || path.basename(source) !== path.basename(destination)) throw new Error('unsupported-publication');
  await new Promise<void>((resolve, reject) => {
    const child = execFile('/bin/ln', ['-P', source, path.dirname(destination)], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 5000, maxBuffer: 4096, killSignal: 'SIGKILL', windowsHide: true,
      ...(signal ? { signal } : {}),
    }, error => { if (error) reject(new Error('publication-failed')); else resolve(); });
    child.stdin?.on('error', () => {}); child.stdin?.end();
  });
}
/** Explicit manual action only. The host scheduler serializes destination-provider mutations. */
export async function shareSkill(target: SkillShareTarget, isCurrent: () => boolean, publishLink?: typeof link, signal?: AbortSignal): Promise<SkillShareResult> {
  if (!isCurrent()) return { outcome: 'denied', code: 'stale' };
  if (!await validSource(target, true)) return { outcome: 'denied', code: 'context-changed' };
  const availability = await skillShareAvailability(target);
  if (!availability.share) return { outcome: 'denied', code: availability.reason };
  let reserved: { data: Receipt; identity: Identity; hash: string } | null = null;
  let staged: { folder: string; directory: Identity; file: string; link: Identity | null; target: string } | null = null;
  try {
    if (!same(await plainDirectory(target.destinationParent), target.destinationParentIdentity)) return { outcome: 'denied', code: 'context-changed' };
    const state = stateDir(target.projectPath);
    await existingParent(state);
    if (await ensureStateDir(target.projectPath) !== state) return { outcome: 'denied', code: 'context-changed' };
    await plainDirectory(state);
    await mkdir(path.dirname(target.receipt), { recursive: true, mode: 0o700 }); await plainDirectory(path.dirname(target.receipt));
    const linkTarget = target.scope === 'user' ? target.original : path.relative(target.destinationRoot, target.original);
    const receipt: Receipt = { version: 1, operation: randomUUID(), original: target.original, destination: target.destination, target: linkTarget, sourceIdentity: target.sourceIdentity, linkIdentity: null };
    const initial = `${JSON.stringify(receipt)}\n`;
    const handle = await open(target.receipt, 'wx', 0o600);
    try { reserved = { data: receipt, identity: identity(await handle.stat()), hash: hash(initial) }; await handle.writeFile(initial); await handle.sync(); } finally { await handle.close(); }
    if (!await sameReceipt(target, reserved) || !isCurrent() || !await validSource(target, true)) return { outcome: 'denied', code: 'context-changed' };
    if (!same(await plainDirectory(target.destinationParent), target.destinationParentIdentity)) return { outcome: 'denied', code: 'context-changed' };
    await mkdir(target.destinationRoot, { recursive: true }); await plainDirectory(target.destinationRoot);
    if (!await sameReceipt(target, reserved) || !isCurrent()) return { outcome: 'denied', code: 'stale' };
    // Stage outside the native skills root on its filesystem. link() publishes this symlink inode exclusively; no copy/rename fallback.
    const stageParent = path.dirname(target.destinationRoot); await plainDirectory(stageParent);
    if ((await lstat(stageParent)).dev !== (await lstat(target.destinationRoot)).dev) return { outcome: 'failed', code: 'symlink-error' };
    const stageFolder = path.join(stageParent, `.parley-skill-share-${receipt.operation}`);
    await mkdir(stageFolder, { mode: 0o700 });
    staged = { folder: stageFolder, directory: await plainDirectory(stageFolder), file: path.join(stageFolder, path.basename(target.destination)), link: null, target: linkTarget };
    const publicationRoot = await plainDirectory(target.destinationRoot);
    try {
      await symlink(linkTarget, staged.file, 'dir'); staged.link = identity(await lstat(staged.file));
      if (!await sameReceipt(target, reserved) || !isCurrent() || !await validSource(target, true)) return { outcome: 'denied', code: 'context-changed' };
      if (publishLink) await publishLink(staged.file, target.destination); else await publishSkillLink(staged.file, target.destination, signal);
    } catch { return { outcome: 'failed', code: 'symlink-error' }; }
    const info = await lstat(target.destination);
    if (!same(publicationRoot, await plainDirectory(target.destinationRoot)) || !staged.link || !same(identity(info), staged.link) || !info.isSymbolicLink() || await readlink(target.destination) !== linkTarget || await realpath(target.destination) !== target.original || !await validSource(target, true) || !same(await plainDirectory(target.destinationParent), target.destinationParentIdentity) || !await sameReceipt(target, reserved)) return { outcome: 'failed', code: 'context-changed' };
    receipt.linkIdentity = staged.link;
    const temporary = `${target.receipt}.${receipt.operation}.tmp`;
    const finalText = `${JSON.stringify(receipt)}\n`; const final = await open(temporary, 'wx', 0o600);
    let finalIdentity: Identity;
    try { finalIdentity = identity(await final.stat()); await final.writeFile(finalText); await final.sync(); } finally { await final.close(); }
    const candidate = await resource(temporary, 65536);
    if (!same(candidate.identity, finalIdentity) || hash(candidate.bytes) !== hash(finalText) || !await sameReceipt(target, reserved) || !isCurrent() || !await ownLink(target, receipt)) return { outcome: 'denied', code: 'context-changed' };
    // Foreign or failed temps are retained; never unlink an unchecked replacement. Portable compare→rename is not filesystem CAS.
    await rename(temporary, target.receipt);
    return { outcome: 'ok', code: 'ok', scope: target.scope };
  } catch { return { outcome: 'failed', code: 'io-error' }; }
  finally {
    // Cleanup only observed owned staging resources. A foreign replacement is preserved; compare→unlink still has the documented same-UID race limit.
    if (staged) try {
      if (staged.link && same(identity(await lstat(staged.file)), staged.link) && await readlink(staged.file) === staged.target) await unlink(staged.file);
      if (same(await plainDirectory(staged.folder), staged.directory)) await rmdir(staged.folder);
    } catch { /* Retain unsafe/occupied staging paths, never recursively remove them. */ }
  }
}
/** Text edits of the original are allowed. Portable compare→unlink is not filesystem CAS. */
export async function unshareSkill(target: SkillShareTarget, isCurrent: () => boolean): Promise<SkillShareResult> {
  if (!isCurrent()) return { outcome: 'denied', code: 'stale' };
  const receipt = await readReceipt(target);
  if (!receipt || !await ownLink(target, receipt.data)) return { outcome: 'denied', code: 'receipt-unverified' };
  if (!isCurrent() || !await sameReceipt(target, receipt) || !await ownLink(target, receipt.data)) return { outcome: 'denied', code: 'context-changed' };
  try {
    await unlink(target.destination);
    if (await sameReceipt(target, receipt)) await unlink(target.receipt);
    return { outcome: 'ok', code: 'ok', scope: target.scope };
  } catch { return { outcome: 'failed', code: 'io-error' }; }
}
