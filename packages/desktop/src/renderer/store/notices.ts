/**
 * Последние уведомления хоста (`host.notice`): максимум 20, новые сверху
 * (кусок 1.10 плана окна). Строка статуса показывает верхнюю запись.
 */

import { create } from 'zustand';
import type { HostNotice } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';

const LIMIT = 20;

export interface NoticesState {
  notices: HostNotice[];
  init: (bridge: ParleyBridge) => () => void;
}

export const useNoticesStore = create<NoticesState>((set) => ({
  notices: [],
  init: (bridge) =>
    bridge.on('host.notice', (notice) => {
      // Раунд исправлений 1 куска E.1: `notice.text` хост пишет по-русски и
      // не переводит (сквозное правило) — строка статуса берёт `noticeText`
      // по `notice.kind` (`shell/StatusBar.tsx`), сырой текст остаётся только
      // здесь, в консоли.
      console.warn('[parley] host.notice', notice.kind, notice.text);
      set((state) => ({ notices: [notice, ...state.notices].slice(0, LIMIT) }));
    }),
}));
