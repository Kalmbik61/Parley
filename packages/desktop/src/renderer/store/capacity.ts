/**
 * Снимок ёмкости машины для строки статуса (спека сна агентов и ёмкости, 4.5): числа те же, что у `get_capacity`.
 * Хост шлёт первое `capacity.changed` только на первое своё событие, поэтому начальное значение берётся из
 * `capacity.get`; событие свежее ответа и не откатывается им. Хост прежней сборки без метода — снимка нет, сегмента нет.
 */

import { create } from 'zustand';
import type { CapacitySnapshot } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';

type CapacityBridge = Pick<ParleyBridge, 'call' | 'on'>;

export interface CapacityState {
  snapshot: CapacitySnapshot | null;
  /** Подписывается на мост и один раз запрашивает `capacity.get`; возвращает отписку. */
  init: (bridge: CapacityBridge) => () => void;
}

export const useCapacityStore = create<CapacityState>((set) => ({
  snapshot: null,
  init: (bridge) => {
    let disposed = false;
    let fresh = false;
    // Снимок старого подключения не переживает переподключение: хост мог быть другим процессом.
    set({ snapshot: null });

    bridge.call('capacity.get', {}).then(
      (result) => {
        if (disposed || fresh) return;
        set({ snapshot: result });
      },
      () => {
        // Хост прежней сборки без `capacity.get`: сегмента нет, строка статуса предложит перезапуск.
      },
    );

    const unsubscribe = bridge.on('capacity.changed', (event) => {
      if (disposed) return;
      fresh = true;
      set({ snapshot: event });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  },
}));
