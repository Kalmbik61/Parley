/**
 * Провайдеры агентов для строки статуса (спека окна 2026-09-29, 1.1, решение 3): значок, имя и версия
 * CLI — по одному сегменту на провайдера. Данные — `providers.list`: окно зовёт его один раз при
 * подключении к хосту и снова после переподключения (`App.tsx` заводит `init` вместе с прочими
 * хранилищами на статус `connected`), а не на каждый рендер. Метода нет или хост отказал — списка нет,
 * сегментов провайдеров тоже; остальная строка статуса и окно работают как обычно.
 *
 * Поля `version` и `limits` у хоста, пережившего окно, могут отсутствовать (`PROTOCOL_VERSION` остаётся 1,
 * поля добавлялись позже) — нет поля читается как «версии нет» и «лимитов нет», `null`.
 *
 * Лимиты подписок (спека комнат Organic, 3.5) приходят с `providers.list`, дальше их обновляет событие
 * хоста `providers.limitsChanged` — по одному провайдеру за раз. Событие раньше ответа `providers.list`
 * (списка ещё нет) игнорируется: хост берёт `limits` для ответа последним, после всех ожиданий, и
 * значение в ответе не старее такого события.
 */

import { create } from 'zustand';
import type { ProviderLimits } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';

export interface ProviderInfo {
  id: string;
  label: string;
  available: boolean;
  /** Версия CLI из пробы на старте хоста; `null` — не узнали или хост её не шлёт. */
  version: string | null;
  /** Лимиты подписки из данных самого CLI; `null` — данных нет, окна сбросились или хост их не шлёт. */
  limits: ProviderLimits | null;
}

export interface ProvidersState {
  /** В порядке ответа хоста; строка статуса показывает `available`, а Claude Code и Codex и без CLI — «not found». */
  providers: ProviderInfo[];
  /**
   * Один запрос `providers.list` и подписка на `providers.limitsChanged`; возвращает отписку — ответ,
   * пришедший позже неё, и события после неё в стор не попадают.
   */
  init: (bridge: ParleyBridge) => () => void;
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
            limits: provider.limits ?? null,
          })),
        });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        // Русский текст хоста — только в консоль (сквозное правило); строка статуса просто без сегментов.
        console.warn('[parley] providers.list failed', decodeIpcError(error).message);
        set({ providers: [] });
      });
    const offLimits = bridge.on('providers.limitsChanged', ({ id, limits }) => {
      // Неизвестный провайдер — тот же объект состояния: подписчики строки статуса не перерисовываются.
      set((state) =>
        state.providers.some((provider) => provider.id === id)
          ? { providers: state.providers.map((provider) => (provider.id === id ? { ...provider, limits } : provider)) }
          : state,
      );
    });
    return () => {
      disposed = true;
      offLimits();
    };
  },
}));
