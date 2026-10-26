import {
  channelStats,
  rebuildRoomHistory,
  removeLocalRoomHistories,
  workExists,
} from '@parley/core';
import type { WorkEntry } from '@parley/core';
import type { WorksService } from '../works/works-service.js';

export interface HistoryServiceIO {
  rebuild: typeof rebuildRoomHistory;
  remove: typeof removeLocalRoomHistories;
  deleted(projectPath: string, workId: string): Promise<boolean>;
  /** Итоги писем по каналам работы (`channelStats`): число и номер новейшего письма — отпечаток ленты комнат. */
  stats: typeof channelStats;
}
export interface HistoryServiceOptions {
  io?: HistoryServiceIO;
  debounceMs?: number;
  onFailure?(failure: { projectPath: string; workId: string; count: number }): void;
}
export interface HistoryService {
  start(): void;
  stop(): void;
  removeWork(projectPath: string, workId: string, capturedRoomIds: readonly string[]): Promise<void>;
}
interface HistoryState {
  projectPath: string;
  workId: string;
  rooms: Set<string>;
  source: string | null;
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
}
/**
 * Работу сняли, если её строки в базе нет (спека хранилища 6.9). Строка, которую `normalizeMap` не принимает, или сбой
 * чтения базы удалением не считаются: чистку производных файлов нельзя делать по догадке.
 */
export async function isWorkDeleted(projectPath: string, workId: string): Promise<boolean> {
  try { return !workExists(projectPath, workId); }
  catch { return false; }
}
/** Derivative files only; it never publishes shared history or changes the source map. */
export function createHistoryService(
  works: Pick<WorksService, 'snapshot' | 'entry' | 'onChange'>,
  options: HistoryServiceOptions = {},
): HistoryService {
  const io = options.io ?? {
    rebuild: rebuildRoomHistory,
    remove: removeLocalRoomHistories,
    deleted: isWorkDeleted,
    stats: channelStats,
  };
  /**
   * Отпечаток всего, от чего зависит история комнат работы: комнаты, подписи и роли участников, название работы и итоги
   * писем по каналам. Письма не правятся, поэтому запись или удаление письма меняют число или номер новейшего; тексты
   * лент для отпечатка не читаются — иначе каждая запись письма читала бы все письма всех комнат (спека хранилища 6.2).
   */
  const identity = (entry: WorkEntry): string => {
    const { work, rooms, sessions } = entry.map;
    return JSON.stringify([
      work.id,
      work.title,
      work.deletedSessions ?? [],
      rooms,
      sessions.map((session) => [session.id, session.label, session.role ?? null]),
      io.stats(entry.projectPath, work.id),
    ]);
  };
  const states = new Map<string, HistoryState>();
  const noticed = new Set<string>();
  const delay = options.debounceMs ?? 2000;
  if (!Number.isFinite(delay) || delay < 0 || delay > 30_000) throw new Error('invalid history debounce');
  let stopped = false;
  let off: (() => void) | undefined;
  const keyOf = (projectPath: string, workId: string): string => `${projectPath}\0${workId}`;
  function notify(state: HistoryState, count: number): void {
    const key = keyOf(state.projectPath, state.workId);
    if (stopped || noticed.has(key) || noticed.size >= 1000) return;
    noticed.add(key);
    options.onFailure?.({ projectPath: state.projectPath, workId: state.workId, count });
  }
  function clear(state: HistoryState): void {
    if (state.timer !== undefined) { clearTimeout(state.timer); delete state.timer; }
  }
  async function removeWork(projectPath: string, workId: string, capturedRoomIds: readonly string[]): Promise<void> {
    if (capturedRoomIds.length > 30_000 || capturedRoomIds.some(id => !/^r-\d+$/.test(id)))
      throw new Error('invalid history room IDs');
    if (stopped) return;
    // Manual deletion sees a fresher map than the watcher cache. Keep its room IDs
    // even when a stale cached entry postpones cleanup until cache convergence.
    const key = keyOf(projectPath, workId);
    const state = states.get(key) ?? { projectPath, workId, rooms: new Set<string>(), source: null, dirty: false };
    const rooms = new Set([...state.rooms, ...capturedRoomIds]);
    if (rooms.size > 30_000) throw new Error('invalid history room IDs');
    state.rooms = rooms;
    states.set(key, state);
    if (works.entry(projectPath, workId) || !await io.deleted(projectPath, workId)) return;
    // The authoritative entry can reappear while the deletion proof was read.
    if (stopped || works.entry(projectPath, workId)) return;
    const result = await io.remove(projectPath, workId, [...state.rooms]);
    if (result.failed.length) notify({ projectPath, workId, rooms: new Set(), source: null, dirty: false }, result.failed.length);
  }
  async function process(state: HistoryState): Promise<void> {
    do {
      state.dirty = false;
      if (stopped) return;
      const entry = works.entry(state.projectPath, state.workId);
      if (!entry) {
        await removeWork(state.projectPath, state.workId, [...state.rooms]);
        if (!works.entry(state.projectPath, state.workId)) states.delete(keyOf(state.projectPath, state.workId));
        return;
      }
      let failed = 0;
      for (const room of entry.map.rooms) {
        if (stopped || !works.entry(state.projectPath, state.workId)) return;
        try { await io.rebuild(state.projectPath, state.workId, room.id); }
        catch { failed++; }
      }
      if (failed) notify(state, failed);
    } while (state.dirty && !stopped);
  }
  function schedule(state: HistoryState): void {
    clear(state);
    state.timer = setTimeout(() => {
      delete state.timer;
      if (stopped) return;
      if (state.running) { state.dirty = true; return; }
      state.running = process(state).catch(() => notify(state, 1)).finally(() => { delete state.running; });
    }, delay);
  }
  function scan(): void {
    const current = new Set<string>();
    for (const entry of works.snapshot().entries) {
      const key = keyOf(entry.projectPath, entry.map.work.id);
      current.add(key);
      if (!entry.map.rooms.length) continue;
      let state = states.get(key);
      if (!state) {
        state = { projectPath: entry.projectPath, workId: entry.map.work.id, rooms: new Set(), source: null, dirty: false };
        states.set(key, state);
      }
      let source: string;
      try { source = identity(entry); } catch { notify(state, 1); continue; }
      for (const room of entry.map.rooms) state.rooms.add(room.id);
      if (source !== state.source) { state.source = source; state.dirty = true; schedule(state); }
    }
    for (const [key, state] of states) if (!current.has(key)) { state.dirty = true; schedule(state); }
  }
  return {
    start() { if (off || stopped) return; off = works.onChange(scan); scan(); },
    stop() { stopped = true; off?.(); off = undefined; for (const state of states.values()) clear(state); states.clear(); noticed.clear(); },
    removeWork,
  };
}
