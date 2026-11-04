// A43 (pure part, no React): what the person expanded on a work ("N more closed", "N archived rooms"), per work, in memory for the app run —
// the window keeps the same for its session (WorkCard). No React: screens read it with `useSyncExternalStore`.
import { workKeyOf } from '@parley/remote-client';

export interface Expansion {
  closed: boolean;
  archived: boolean;
}

const OFF: Expansion = { closed: false, archived: false };

export function createClosedStore() {
  const states = new Map<string, Expansion>();
  const listeners = new Set<() => void>();
  const get = (key: string): Expansion => states.get(key) ?? OFF;
  return {
    get,
    toggle(key: string, part: keyof Expansion): void {
      states.set(key, { ...get(key), [part]: !get(key)[part] });
      for (const l of [...listeners]) l();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The key: the Mac too — two Macs can have the same project path and work id. */
export const expansionKey = (hostId: string | null, ref: { projectPath: string; workId: string }): string =>
  `${hostId ?? ''}\u0000${workKeyOf(ref.projectPath, ref.workId)}`;

export const closedLabel = (n: number, open: boolean): string => (open ? 'Hide closed' : `${n} more closed`);
export const archivedLabel = (n: number, open: boolean): string => (open ? 'Hide archived rooms' : `${n} archived room${n === 1 ? '' : 's'}`);
