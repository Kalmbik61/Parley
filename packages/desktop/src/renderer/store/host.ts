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
  /**
   * Связь с хостом уже была (раунд lane-r3, п. 2): обрыв после неё — переподключение, окно
   * остаётся на месте, а терминалы говорят «Disconnected — reconnecting…». До первой связи
   * `disconnected` — экран «No connection to host», как прежде.
   */
  everConnected: boolean;
  /** Подписка на `onStatus`; возвращает отписку. */
  init(bridge: HarnasBridge): () => void;
}

export const useHostStore = create<HostState>((set) => ({
  status: { state: 'connecting' },
  everConnected: false,
  init: (bridge) =>
    bridge.onStatus((status) =>
      set((current) => ({ status, everConnected: current.everConnected || status.state === 'connected' })),
    ),
}));
