import { useSyncExternalStore } from 'react';
import { runtime } from './instance';
import type { RuntimeState } from './runtime';

export function useRuntimeState(): RuntimeState {
  return useSyncExternalStore(runtime.subscribe, runtime.getState, runtime.getState);
}
