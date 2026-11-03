// A43: the per-work expansion store of the app run and its hook. The logic is in `closed-state.ts`.
import { useSyncExternalStore } from 'react';
import { useRuntimeState } from '../runtime/use-runtime';
import { createClosedStore, expansionKey, type Expansion } from './closed-state';

export const closedStore = createClosedStore();
export type { Expansion };

export function useExpansion(ref: { projectPath: string; workId: string } | null): { key: string; expansion: Expansion } {
  const hostId = useRuntimeState().host?.hostId ?? null;
  const key = ref === null ? '' : expansionKey(hostId, ref);
  const expansion = useSyncExternalStore(closedStore.subscribe, () => closedStore.get(key), () => closedStore.get(key));
  return { key, expansion };
}
