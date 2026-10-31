import { useSyncExternalStore } from 'react';
import type { RemoteState } from '@parley/remote-client';
import { runtime } from './instance';
import { useRuntimeState } from './use-runtime';

const NOOP = () => () => {};
const NONE = (): null => null;

/** The remote-client state of the current host; `null` before a host is paired. */
export function useRemoteState(): RemoteState | null {
  const { client } = useRuntimeState();
  return useSyncExternalStore(
    client ? (l) => client.store.subscribe(() => l()) : NOOP,
    client ? client.store.getState : NONE,
    client ? client.store.getState : NONE,
  );
}

export { runtime };
