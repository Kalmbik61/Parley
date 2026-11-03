// What a room's ⋯ menu is doing right now, outside the screen (critic A41b M3, m3): the action in flight (Put all to sleep,
// Wake all, Archive, Delete — including the Face ID wait), the progress of a run, and its result until somebody has seen it.
// Leaving the screen does not stop a run; coming back shows the progress, and an unseen result with failures opens its sheet.
// No React: the screen reads it with `useSyncExternalStore`.
import type { SessionCommandOutcome } from '@parley/remote-client';
import { runAll, runSummary, type Pending, type PendingKind, type RunResult } from './room-menu';

export interface Unseen {
  title: string;
  results: RunResult[];
}

export interface RoomRunState {
  pending: Pending | null;
  /** A finished run with failures, not yet closed by the person. */
  unseen: Unseen | null;
}

const EMPTY: RoomRunState = { pending: null, unseen: null };

export function createRoomRuns() {
  const states = new Map<string, RoomRunState>();
  const listeners = new Set<() => void>();
  const get = (key: string): RoomRunState => states.get(key) ?? EMPTY;
  const set = (key: string, patch: Partial<RoomRunState>): void => {
    states.set(key, { ...get(key), ...patch });
    for (const l of [...listeners]) l();
  };
  return {
    get,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Takes the room's single slot; `started: false` — another action is in flight, nothing was done. */
    async hold<T>(key: string, kind: PendingKind, work: (progress: (done: number, total: number) => void) => Promise<T>): Promise<{ started: false } | { started: true; value: T }> {
      if (get(key).pending !== null) return { started: false };
      set(key, { pending: { kind, done: 0, total: null } });
      try {
        const value = await work((done, total) => set(key, { pending: { kind, done, total } }));
        return { started: true, value };
      } finally {
        set(key, { pending: null });
      }
    },
    /** Put all to sleep / Wake all: one call at a time; a result with failures stays as `unseen`. */
    async run(key: string, kind: 'sleep' | 'wake', targets: ReadonlyArray<{ id: string; label: string }>, call: (id: string) => Promise<SessionCommandOutcome>) {
      const res = await this.hold(key, kind, async (progress) => {
        progress(0, targets.length);
        const results = await runAll(targets, call, progress);
        const sum = runSummary(kind, results);
        if (!sum.allOk) set(key, { unseen: { title: sum.title, results } });
        return sum;
      });
      return res.started ? res.value : null;
    },
    /** The person closed the result sheet. */
    seen(key: string): void {
      if (get(key).unseen !== null) set(key, { unseen: null });
    },
    /** Developer preview only: shows a run in progress without making calls. */
    seedPending(key: string, pending: Pending | null): void {
      set(key, { pending });
    },
  };
}

export const roomRuns = createRoomRuns();
