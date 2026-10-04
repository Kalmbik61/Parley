/**
 * Снимок провайдеров при подключении, Check again и providers.changed. Поколения
 * подключения и запроса не дают старому ответу вернуть удалённый ключ. Метаданные
 * старого хоста необязательны; версия/лимиты без поля читаются как null. Чужие
 * claude.ai лимиты GLM отбрасываются и в списке, и в событиях.
 */

import { create } from 'zustand';
import type { Result } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';

export interface ProviderInfo extends Omit<
  Result<'providers.list'>['providers'][number],
  'version' | 'limits'
> {
  /** Версия CLI из пробы на старте хоста; `null` — не узнали или хост её не шлёт. */
  version: string | null;
  /** Лимиты CLI или подтверждённая квота Z.ai; `null` — данных нет или хост их не шлёт. */
  limits: NonNullable<Result<'providers.list'>['providers'][number]['limits']> | null;
}

export interface ProvidersState {
  /** В порядке ответа хоста; строка статуса сама упорядочивает основные провайдеры. */
  providers: ProviderInfo[];
  /**
   * Первый ответ `providers.list` пришёл (успехом или отказом). До него версия `claude` неизвестна не
   * потому, что её нет, а потому, что её ещё не спросили: вид вкладки (`lib/feed-view.ts`) ждёт.
   */
  loaded: boolean;
  /** Ручное обновление всех источников; повторные клики разделяют один запрос. */
  refreshing: boolean;
  refreshLimits: () => Promise<void>;
  /** Свежий снимок того же подключения; более поздний запрос побеждает. */
  reload: () => Promise<void>;
  /**
   * Первый запрос и подписки на changed/limitsChanged; возвращает отписку — ответ,
   * пришедший позже неё, и события после неё в стор не попадают.
   */
  init: (bridge: ParleyBridge) => () => void;
}

export const useProvidersStore = create<ProvidersState>((set) => {
  let activeBridge: ParleyBridge | null = null;
  let connection = 0;
  let request = 0;
  let refreshPromise: Promise<void> | null = null;
  const reload = async (): Promise<void> => {
    if (activeBridge === null) return;
    const currentConnection = connection;
    const currentRequest = ++request;
    try {
      const result = await activeBridge.call('providers.list', {});
      if (connection !== currentConnection || request !== currentRequest) return;
      set({
        providers: result.providers.map((provider) => ({
          ...provider,
          version: provider.version ?? null,
          // Даже старый хост может прислать claude.ai лимиты: для GLM они чужие.
          limits: provider.id === 'glm' && provider.limits?.source !== 'zai' ? null : (provider.limits ?? null),
        })),
        loaded: true,
      });
    } catch (error: unknown) {
      if (connection !== currentConnection || request !== currentRequest) return;
      console.warn('[parley] providers.list failed', decodeIpcError(error).message);
      set({ loaded: true });
      throw error;
    }
  };
  const refreshLimits = (): Promise<void> => {
    if (activeBridge === null) return Promise.resolve();
    if (refreshPromise !== null) return refreshPromise;
    const bridge = activeBridge;
    const currentConnection = connection;
    set({ refreshing: true });
    refreshPromise = (async () => {
      try {
        let refreshError: unknown;
        let failed = false;
        try {
          await bridge.call('providers.refreshLimits', {});
        } catch (error: unknown) {
          failed = true;
          refreshError = error;
        }
        if (connection !== currentConnection) return;
        // Один источник мог отказать после публикации лимитов остальных.
        try {
          await reload();
        } catch (error: unknown) {
          if (!failed) throw error;
        }
        if (connection !== currentConnection) return;
        if (failed) throw refreshError;
      } finally {
        if (connection === currentConnection) {
          refreshPromise = null;
          set({ refreshing: false });
        }
      }
    })();
    return refreshPromise;
  };
  return {
    providers: [],
    loaded: false,
    refreshing: false,
    refreshLimits,
    reload,
    init: (bridge) => {
      activeBridge = bridge;
      const currentConnection = ++connection;
      refreshPromise = null;
      set({ providers: [], loaded: false, refreshing: false });
      void reload().catch(() => {});
      const offChanged = bridge.on('providers.changed', () => {
        if (connection === currentConnection) void reload().catch(() => {});
      });
      const offLimits = bridge.on('providers.limitsChanged', ({ id, limits }) => {
        if (connection !== currentConnection || (id === 'glm' && limits !== null && limits.source !== 'zai')) return;
        // Неизвестный провайдер — тот же объект состояния: подписчики строки статуса не перерисовываются.
        set((state) =>
          state.providers.some((provider) => provider.id === id)
            ? {
                providers: state.providers.map((provider) =>
                  provider.id === id ? { ...provider, limits } : provider,
                ),
              }
            : state,
        );
      });
      return () => {
        if (connection === currentConnection) {
          ++connection;
          activeBridge = null;
          refreshPromise = null;
          set({ refreshing: false });
        }
        offLimits();
        offChanged();
      };
    },
  };
});
