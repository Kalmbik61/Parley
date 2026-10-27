/**
 * Последние уведомления хоста (`host.notice`): максимум 20, новые сверху
 * (кусок 1.10 плана окна). Строка статуса показывает верхнюю запись.
 */

import { create } from 'zustand';
import { refKey, type HostNotice } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';

const LIMIT = 20;

/** Одно и то же уведомление, пришедшее событием и снимком или повторённое хостом на новом подключении. */
const noticeKey = (notice: HostNotice): string =>
  `${notice.kind}\0${notice.at}\0${notice.ref === null ? '' : refKey(notice.ref)}\0${notice.text}`;

export interface NoticesState {
  notices: HostNotice[];
  init: (bridge: ParleyBridge) => () => void;
}

export const useNoticesStore = create<NoticesState>((set) => ({
  notices: [],
  init: (bridge) => {
    let disposed = false;
    const off = bridge.on('host.notice', (notice) => {
      // Раунд исправлений 1 куска E.1: строка статуса берёт `noticeText` по
      // `notice.kind` (`shell/StatusBar.tsx`), сырой `notice.text` хоста
      // остаётся только здесь, в консоли.
      console.warn('[parley] host.notice', notice.kind, notice.text);
      set((state) => ({ notices: [notice, ...state.notices].slice(0, LIMIT) }));
    });
    // Снимок — после подписки: стартовые уведомления хост повторяет сразу после `hello`, раньше, чем окно подписалось
    // (статус connected), и main держит их для него. Уже известное (пришло событием, осталось с прошлого подключения)
    // не дублируется; порядок — по времени уведомления, новые сверху.
    bridge
      .noticesSnapshot()
      .then((snapshot) => {
        if (disposed) return;
        set((state) => {
          const known = new Set(state.notices.map(noticeKey));
          const fresh = snapshot.filter((notice) => !known.has(noticeKey(notice)));
          if (fresh.length === 0) return state;
          for (const notice of fresh) console.warn('[parley] host.notice', notice.kind, notice.text);
          return {
            notices: [...state.notices, ...fresh].sort((a, b) => b.at.localeCompare(a.at)).slice(0, LIMIT),
          };
        });
      })
      .catch(() => {
        // Без снимка остаются живые события — как до повтора стартовых уведомлений.
      });
    return () => {
      disposed = true;
      off();
    };
  },
}));
