/**
 * Провайдеры агентов для строки статуса (спека окна 2026-09-29, 1.1, решение 3): значок, имя и версия
 * CLI — по одному сегменту на провайдера. Данные — `providers.list`: окно зовёт его один раз при
 * подключении к хосту и снова после переподключения (`App.tsx` заводит `init` вместе с прочими
 * хранилищами на статус `connected`), а не на каждый рендер. Метода нет или хост отказал — списка нет,
 * сегментов провайдеров тоже; остальная строка статуса и окно работают как обычно.
 *
 * Поле `version` у хоста, пережившего окно, может отсутствовать (`PROTOCOL_VERSION` остаётся 1, поля
 * добавлялись позже) — нет поля читается как «версии нет», `null`.
 */

import { create } from 'zustand';
import type { HarnasBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';

export interface ProviderInfo {
  id: string;
  label: string;
  available: boolean;
  /** Версия CLI из пробы на старте хоста; `null` — не узнали или хост её не шлёт. */
  version: string | null;
}

export interface ProvidersState {
  /** В порядке ответа хоста; показывает строка статуса только `available`. */
  providers: ProviderInfo[];
  /** Один запрос `providers.list`; возвращает отписку — ответ, пришедший позже неё, в стор не попадает. */
  init: (bridge: HarnasBridge) => () => void;
}

export const useProvidersStore = create<ProvidersState>((set) => ({
  providers: [],
  init: (bridge) => {
    let disposed = false;
    bridge
      .call('providers.list', {})
      .then((result) => {
        if (disposed) return;
        set({
          providers: result.providers.map((provider) => ({
            id: provider.id,
            label: provider.label,
            available: provider.available,
            version: provider.version ?? null,
          })),
        });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        // Русский текст хоста — только в консоль (сквозное правило); строка статуса просто без сегментов.
        console.warn('[harnas] providers.list failed', decodeIpcError(error).message);
        set({ providers: [] });
      });
    return () => {
      disposed = true;
    };
  },
}));
