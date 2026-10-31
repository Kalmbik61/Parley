import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { RemoteClient, RemoteState } from '@parley/remote-client';
import { DEMO } from '../dev/flags';
import { useRuntimeState } from '../runtime/use-runtime';

/** Current client of the current host; `null` before a host is known. */
export function useClient(): RemoteClient | null {
  return useRuntimeState().client;
}

/** The remote-client state; changes identity on every store update, so derive with `useMemo(..., [state])`. */
export function useRemoteState(): RemoteState | null {
  const store = useClient()?.store ?? null;
  const subscribe = useCallback((cb: () => void) => (store === null ? () => undefined : store.subscribe(() => cb())), [store]);
  return useSyncExternalStore(subscribe, () => (store === null ? null : store.getState()), () => null);
}

/** Decisions are possible only on a ready connection (D1 §4: "actions are paused" otherwise). */
export function useCanAct(): boolean {
  const ready = useRuntimeState().supervisor?.state === 'ready';
  return DEMO || ready;
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
