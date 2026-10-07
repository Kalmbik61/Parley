import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { readSharedFile, MISSING_SHARED_VERSION } from './store.js';
import type { SharedFileSnapshot, SharedWriteOptions } from './store.js';
export class ImmutableMarkdownError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'unavailable') { super(code); this.name = 'ImmutableMarkdownError'; }
}
export interface MarkdownIdentity { ino: number; dev: number; sha256: string }
export type MarkdownPublishOptions = SharedWriteOptions & { mode?: 0o600 | 0o644; onPrepared?(identity: MarkdownIdentity): Promise<void> };
const fingerprint = (content: string): string => createHash('sha256').update(content).digest('hex');
export async function publishImmutableMarkdown(dir: string, parent: string, intent: { file: string; content: string }, options: MarkdownPublishOptions = {}): Promise<MarkdownIdentity> {
  return publishMarkdown(dir, parent, intent, options);
}
/** Explicit human Share update only. The previous exact file identity is part of the private receipt. */
export async function replaceOwnedMarkdown(dir: string, parent: string, intent: { file: string; content: string }, expected: SharedFileSnapshot, identity: MarkdownIdentity, options: MarkdownPublishOptions = {}): Promise<MarkdownIdentity> {
  return publishMarkdown(dir, parent, intent, options, { expected, identity });
}
/** Exclusive publication of a fully written file: existing versions are compared, never replaced.
 * Directory checks bound redirects; portable check/link/unlink is not adversarial filesystem CAS.
 */
async function publishMarkdown(
  dir: string,
  parent: string,
  intent: { file: string; content: string },
  options: MarkdownPublishOptions,
  replace?: { expected: SharedFileSnapshot; identity: MarkdownIdentity },
): Promise<MarkdownIdentity> {
  if (path.basename(intent.file) !== intent.file || !intent.file.endsWith(".md") || intent.content.includes('\0') || intent.file.length > 255 || Buffer.byteLength(intent.content) > 1024 * 1024 || Buffer.from(intent.content).toString() !== intent.content) throw new ImmutableMarkdownError("invalid");
  const root = await lstat(dir);
  if (!root.isDirectory() || (await realpath(dir)) !== dir)
    throw new ImmutableMarkdownError("unavailable");
  try {
    await mkdir(parent, { mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const parentHandle = await open(
    parent,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const temporary = path.join(dir, `.plan-${randomUUID()}.tmp`);
  let ownedTemporary: { ino: number; dev: number } | undefined;
  const temporaryIsOwned = async (): Promise<boolean> => {
    if (!ownedTemporary) return false;
    try {
      const current = await lstat(temporary);
      return (
        current.isFile() &&
        current.ino === ownedTemporary.ino &&
        current.dev === ownedTemporary.dev &&
        (await readSharedFile(temporary)).text === intent.content
      );
    } catch {
      return false;
    }
  };
  try {
    const identity = await parentHandle.stat();
    const verify = async (): Promise<void> => {
      const current = await lstat(parent);
      const currentRoot = await lstat(dir);
      if (
        !identity.isDirectory() ||
        !current.isDirectory() ||
        identity.ino !== current.ino ||
        identity.dev !== current.dev ||
        !currentRoot.isDirectory() ||
        root.ino !== currentRoot.ino ||
        root.dev !== currentRoot.dev ||
        (await realpath(parent)) !== parent
      )
        throw new ImmutableMarkdownError("unavailable");
    };
    await verify();
    const file = path.join(parent, intent.file);
    const previous = await readSharedFile(file);
    const targetIdentity = async (): Promise<MarkdownIdentity> => {
      const current = await lstat(file);
      const content = await readSharedFile(file);
      const after = await lstat(file);
      if (!current.isFile() || !after.isFile() || current.ino !== after.ino || current.dev !== after.dev) throw new ImmutableMarkdownError("conflict");
      return { ino: current.ino, dev: current.dev, sha256: fingerprint(content.text) };
    };
    const verifyPrevious = async (): Promise<void> => {
      const current = await readSharedFile(file);
      if (!replace || current.version !== replace.expected.version) throw new ImmutableMarkdownError("conflict");
      const identity = await targetIdentity();
      if (identity.ino !== replace.identity.ino || identity.dev !== replace.identity.dev || identity.sha256 !== replace.identity.sha256) throw new ImmutableMarkdownError("conflict");
    };
    if (replace) await verifyPrevious();
    else if (previous.version !== MISSING_SHARED_VERSION) {
      if (previous.text !== intent.content) throw new ImmutableMarkdownError("conflict");
      return targetIdentity();
    }
    const handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      options.mode ?? 0o644,
    );
    try {
      ownedTemporary = await handle.stat();
      await handle.writeFile(intent.content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.onPrepared?.({ ino: ownedTemporary!.ino, dev: ownedTemporary!.dev, sha256: fingerprint(intent.content) });
    await options.beforeCommit?.(file, 0);
    await verify();
    if (!(await temporaryIsOwned()))
      throw new ImmutableMarkdownError("unavailable");
    if (replace) {
      await verifyPrevious();
      await rename(temporary, file);
    } else {
      try { await link(temporary, file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await readSharedFile(file)).text !== intent.content) throw new ImmutableMarkdownError("conflict");
      }
    }
    await verify();
    if ((await readSharedFile(file)).text !== intent.content)
      throw new ImmutableMarkdownError("conflict");
    return targetIdentity();
  } finally {
    try {
      const current = await lstat(dir);
      if (
        current.isDirectory() &&
        root.ino === current.ino &&
        root.dev === current.dev &&
        (await realpath(dir)) === dir &&
        (await temporaryIsOwned())
      )
        await unlink(temporary).catch(() => undefined);
    } finally {
      await parentHandle.close();
    }
  }
}
