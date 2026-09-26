/**
 * Последние уведомления хоста (`host.notice`): максимум 20, новые сверху
 * (кусок 1.10 плана окна). Строка статуса показывает верхнюю запись.
 */

import { create } from 'zustand';
import type { HostNotice } from '@harnas/protocol';
import type { HarnasBridge } from '../../shared/bridge.js';

const LIMIT = 20;

export interface NoticesState {
  notices: HostNotice[];
  init: (bridge: HarnasBridge) => () => void;
}

export const useNoticesStore = create<NoticesState>((set) => ({
  notices: [],
  init: (bridge) =>
    bridge.on('host.notice', (notice) => {
      set((state) => ({ notices: [notice, ...state.notices].slice(0, LIMIT) }));
    }),
}));
