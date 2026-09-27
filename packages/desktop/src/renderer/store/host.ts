/**
 * Статус связи с хостом (кусок 3.1). Живёт в сторе, а не в локальном state
 * `App`: его читают и экраны связи, и `useHostSupports` в пунктах меню, до
 * которых пропсами не дотянуться.
 */

import { create } from 'zustand';
import type { HarnasBridge, HostStatus } from '../../shared/bridge.js';

export interface HostState {
  /** До первого `onStatus` — `connecting`. */
  status: HostStatus;
  /** Подписка на `onStatus`; возвращает отписку. */
  init(bridge: HarnasBridge): () => void;
}

export const useHostStore = create<HostState>((set) => ({
  status: { state: 'connecting' },
  init: (bridge) => bridge.onStatus((status) => set({ status })),
}));
