import { watch } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { sharedProjectPaths } from '@parley/core';
import type { BacklogChanged, BacklogSnapshot } from '@parley/protocol';
import { HostError } from '../errors.js';
import { readBacklogSnapshot } from '../methods/backlog.js';

interface WatchHandle { close(): void; on(event: 'error', listener: () => void): unknown }
type Notify = (change: BacklogChanged) => boolean | void;
interface Subscriber { projectPath: string; clientId: string; notify: Notify }
interface Entry {
  key: string; projectPath: string; dir: string; root: WatchHandle; directory: WatchHandle | null;
  directoryIdentity: string | null; subscribers: Map<string, Subscriber>; timer: ReturnType<typeof setTimeout> | null;
  arming: Promise<void> | null; rootIdentity: string; reading: boolean; dirty: boolean; closed: boolean; version: string;
}
export interface BacklogServiceOptions {
  debounceMs?: number;
  watchDirectory?: (directory: string, changed: () => void) => WatchHandle;
  snapshot?: typeof readBacklogSnapshot;
}
export interface BacklogService {
  subscribe(projectPath: string, clientId: string, notify: Notify): Promise<BacklogSnapshot>;
  unsubscribe(projectPath: string, clientId: string): void;
  removeClient(clientId: string): void;
  close(): void;
}
const unavailable = (): HostError => new HostError('internal', 'Live backlog updates are unavailable.', { code: 'backlog-watch-unavailable' });
/** В отпечаток входит file: выбор файла и появление TODOS.md меняют снимок, даже когда version бэклога прежний. */
const fingerprint = (snapshot: BacklogSnapshot): string => JSON.stringify({ version: snapshot.version, file: snapshot.file, suggestions: snapshot.suggestions, rule: snapshot.rule, diagnostics: snapshot.diagnostics });

/** Watches only proven project/state directories. OS event names are hints, never trusted paths or data. */
export function createBacklogService(options: BacklogServiceOptions = {}): BacklogService {
  const watchDirectory = options.watchDirectory ?? ((directory, changed) => watch(directory, { persistent: false }, changed));
  const snapshot = options.snapshot ?? readBacklogSnapshot;
  const debounceMs = options.debounceMs ?? 100;
  if (!Number.isFinite(debounceMs) || debounceMs < 0 || debounceMs > 1000) throw unavailable();
  const entries = new Map<string, Entry>();
  const subscribers = new Map<string, Entry>();
  const pending = new Map<string, Subscriber>();
  let closed = false;
  const subscriptionKey = (projectPath: string, clientId: string): string => `${clientId}\0${projectPath}`;
  const dispose = (entry: Entry): void => {
    if (entry.closed) return;
    entry.closed = true;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.root.close(); entry.directory?.close(); entries.delete(entry.key);
    for (const key of entry.subscribers.keys()) subscribers.delete(key);
    entry.subscribers.clear();
  };
  const remove = (key: string): void => {
    const entry = subscribers.get(key); if (!entry) return;
    subscribers.delete(key); entry.subscribers.delete(key);
    if (entry.subscribers.size === 0) dispose(entry);
  };
  const notify = (entry: Entry, failed: boolean): void => {
    for (const [key, subscriber] of [...entry.subscribers]) {
      try { if (subscriber.notify({ projectPath: subscriber.projectPath, ...(failed ? { unavailable: true as const } : {}) }) === false) remove(key); }
      catch { remove(key); }
    }
  };
  const fail = (entry: Entry): void => { if (entry.closed) return; notify(entry, true); dispose(entry); };
  const schedule = (entry: Entry): void => {
    if (entry.closed || closed) return;
    entry.dirty = true;
    if (entry.timer !== null || entry.reading) return;
    entry.timer = setTimeout(() => { entry.timer = null; void refresh(entry); }, debounceMs);
    entry.timer.unref?.();
  };
  const arm = async (entry: Entry): Promise<void> => {
    if (entry.arming) return entry.arming;
    const task = (async () => {
      const paths = await sharedProjectPaths(entry.projectPath);
      if (paths.context.projectPath !== entry.key || paths.dir !== entry.dir) throw unavailable();
      const rootInfo = await lstat(entry.key);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || `${rootInfo.dev}:${rootInfo.ino}` !== entry.rootIdentity) throw unavailable();
      let identity: string | null = null;
      try {
        const info = await lstat(entry.dir);
        if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
        identity = `${info.dev}:${info.ino}`;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (entry.closed || identity === entry.directoryIdentity) return;
      entry.directory?.close(); entry.directory = null; entry.directoryIdentity = identity;
      if (identity !== null) {
        entry.directory = watchDirectory(entry.dir, () => schedule(entry));
        entry.directory.on('error', () => fail(entry));
      }
    })();
    entry.arming = task;
    try { await task; } finally { if (entry.arming === task) entry.arming = null; }
  };
  const refresh = async (entry: Entry): Promise<void> => {
    if (entry.closed || closed) return;
    entry.reading = true; entry.dirty = false;
    try {
      await arm(entry);
      const current = await snapshot(entry.projectPath);
      if (entry.closed) return;
      if (current.sharedProjectPath !== entry.key) throw unavailable();
      const version = fingerprint(current);
      if (entry.version !== version) { entry.version = version; notify(entry, false); }
    } catch { fail(entry); }
    finally { entry.reading = false; if (entry.dirty) schedule(entry); }
  };
  return {
    async subscribe(projectPath, clientId, listener) {
      if (closed) throw unavailable();
      const key = subscriptionKey(projectPath, clientId);
      if (!subscribers.has(key) && !pending.has(key) && new Set([...subscribers.keys(), ...pending.keys()]).size >= 128) throw unavailable();
      const token = { projectPath, clientId, notify: listener };
      pending.set(key, token);
      try {
        const paths = await sharedProjectPaths(projectPath);
        if (closed || pending.get(key) !== token || (!subscribers.has(key) && subscribers.size >= 128)) throw unavailable();
        let entry = entries.get(paths.context.projectPath);
        if (!entry && entries.size >= 32) throw unavailable();
        if (!entry) {
          const rootInfo = await lstat(paths.context.projectPath);
          if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw unavailable();
          // Recheck after the awaited filesystem proof so concurrent first subscriptions share one watcher.
          entry = entries.get(paths.context.projectPath);
          if (!entry) {
            if (closed || pending.get(key) !== token || entries.size >= 32) throw unavailable();
            let root: WatchHandle;
            try { root = watchDirectory(paths.context.projectPath, () => { if (entry) schedule(entry); }); }
            catch { throw unavailable(); }
            entry = { key: paths.context.projectPath, projectPath: paths.context.projectPath, dir: paths.dir, root, directory: null, directoryIdentity: null,
              subscribers: new Map(), timer: null, arming: null, rootIdentity: `${rootInfo.dev}:${rootInfo.ino}`, reading: false, dirty: false, closed: false, version: '' };
            entries.set(entry.key, entry); root.on('error', () => { if (entry) fail(entry); });
          }
        }
        const selected = entry;
        // Subscribe before reading: an agent write during the initial GET is observed and then refreshed.
        if (!subscribers.has(key) && subscribers.size >= 128) { if (selected.subscribers.size === 0) dispose(selected); throw unavailable(); }
        selected.subscribers.set(key, token); subscribers.set(key, selected);
        try {
          await arm(selected);
          const current = await snapshot(projectPath);
          if (closed || selected.closed || selected.subscribers.get(key) !== token || current.sharedProjectPath !== selected.key) throw unavailable();
          if (!selected.version) selected.version = fingerprint(current);
          return current;
        } catch { if (selected.subscribers.get(key) === token) remove(key); throw unavailable(); }
      } finally { if (pending.get(key) === token) pending.delete(key); }
    },
    unsubscribe(projectPath, clientId) { const key = subscriptionKey(projectPath, clientId); pending.delete(key); remove(key); },
    removeClient(clientId) { for (const [key, token] of pending) if (token.clientId === clientId) pending.delete(key); for (const [key, entry] of [...subscribers]) if (entry.subscribers.get(key)?.clientId === clientId) remove(key); },
    close() { closed = true; pending.clear(); for (const entry of [...entries.values()]) dispose(entry); },
  };
}
