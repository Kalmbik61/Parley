import { useSyncExternalStore } from 'react';
import { pairing } from './instance';
import type { PairState } from './session';

export function usePairState(): PairState {
  return useSyncExternalStore(pairing.subscribe, pairing.getState, pairing.getState);
}
