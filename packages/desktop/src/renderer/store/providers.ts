/**
 * Снимок провайдеров при подключении, Check again и providers.changed. Поколения
 * подключения и запроса не дают старому ответу вернуть удалённый ключ. Метаданные
 * старого хоста необязательны; версия/лимиты без поля читаются как null. Чужие
 * claude.ai лимиты GLM отбрасываются и в списке, и в событиях.
 *
 * Вход в аккаунты подписки (спека подписок 4.1, 10): хост вывод входа не повторяет, поэтому стор с `init` копит его
 * по провайдеру (хвост 64 КБ) — Settings, открытые заново посреди входа, показывают уже напечатанное.
 */

import { create } from 'zustand';
import type { CustomAccountInfo, Result } from '@parley/protocol';
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

/** Сколько знаков вывода входа держит стор на аккаунт: хвост, а не всё (вход печатает пару строк, предел — страховка). */
const SIGN_IN_BUFFER_CHARS = 64 * 1024;

/**
 * Строки списка с изменённым состоянием входа аккаунта `id`; тот же массив, если менять нечего (подписчики строки статуса
 * не перерисовываются от каждого куска вывода).
 */
function patchAccount(
  providers: ProviderInfo[],
  id: string,
  patch: Partial<Pick<CustomAccountInfo, 'signedIn' | 'signingIn'>>,
): ProviderInfo[] {
  let changed = false;
  const next = providers.map((provider) => {
    const custom = provider.custom;
    if (provider.id !== id || custom == null || (custom.kind !== 'claude-account' && custom.kind !== 'codex-account')) return provider;
    const keys = Object.keys(patch) as Array<keyof typeof patch>;
    if (keys.every((key) => custom[key] === patch[key])) return provider;
    changed = true;
    return { ...provider, custom: { ...custom, ...patch } };
  });
  return changed ? next : providers;
}

export interface ProvidersState {
  /** В порядке ответа хоста; строка статуса сама упорядочивает основные провайдеры. */
  providers: ProviderInfo[];
  /**
   * Первый ответ `providers.list` пришёл (успехом или отказом). До него версия `claude` неизвестна не
   * потому, что её нет, а потому, что её ещё не спросили: вид вкладки (`lib/feed-view.ts`) ждёт.
   * Переподключение его не сбрасывает: прежний снимок живёт до ответа нового хоста (`init`).
   */
  loaded: boolean;
  /** Ручное обновление всех источников; повторные клики разделяют один запрос. */
  refreshing: boolean;
  /** Вывод процесса входа по id аккаунта с момента `init` (хвост `SIGN_IN_BUFFER_CHARS`); хост его не повторяет. */
  signInOutput: Record<string, string>;
  /** Итог последнего входа за жизнь окна (выход процесса): терминал входа показывает его строкой. */
  signInResult: Record<string, { exitCode: number; signedIn: boolean }>;
  /** Вход начат из окна: прежние вывод и итог стираются, строка списка помечается `signingIn` до ответа хоста. */
  beginSignIn: (provider: string) => void;
  /** Вывод и итог входа аккаунта больше не нужны (вышел из аккаунта, аккаунт удалён): память не держит чужой вывод. */
  forgetSignIn: (provider: string) => void;
  refreshLimits: () => Promise<void>;
  /** Свежий снимок того же подключения; более поздний запрос побеждает. */
  reload: () => Promise<void>;
  /**
   * Первый запрос и подписки на changed/limitsChanged; возвращает отписку — ответ,
   * пришедший позже неё, и события после неё в стор не попадают.
   */
  init: (bridge: Pick<ParleyBridge, 'call' | 'on'>) => () => void;
}

export const useProvidersStore = create<ProvidersState>((set) => {
  let activeBridge: Pick<ParleyBridge, 'call' | 'on'> | null = null;
  let connection = 0;
  let request = 0;
  let refreshPromise: Promise<void> | null = null;
  // Ответ этого подключения уже лёг в стор; до него в списке — снимок прежнего хоста.
  let answered = false;
  const reload = async (): Promise<void> => {
    if (activeBridge === null) return;
    const currentConnection = connection;
    const currentRequest = ++request;
    try {
      const result = await activeBridge.call('providers.list', {});
      if (connection !== currentConnection || request !== currentRequest) return;
      answered = true;
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
      // Отказ до ответа подключения — список пуст: снимок прежнего хоста за ответ нового не выдаём.
      set(answered ? { loaded: true } : { providers: [], loaded: true });
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
    signInOutput: {},
    signInResult: {},
    beginSignIn: (provider) =>
      set((state) => {
        const signInOutput = { ...state.signInOutput };
        const signInResult = { ...state.signInResult };
        delete signInOutput[provider];
        delete signInResult[provider];
        return { signInOutput, signInResult, providers: patchAccount(state.providers, provider, { signingIn: true }) };
      }),
    forgetSignIn: (provider) =>
      set((state) => {
        const signInOutput = { ...state.signInOutput };
        const signInResult = { ...state.signInResult };
        delete signInOutput[provider];
        delete signInResult[provider];
        return { signInOutput, signInResult };
      }),
    refreshLimits,
    reload,
    init: (bridge) => {
      activeBridge = bridge;
      const currentConnection = ++connection;
      answered = false;
      refreshPromise = null;
      // Прежний снимок и `loaded` — до ответа нового подключения: сброс снова делал бы вид вкладок
      // «неизвестным» (`lib/feed-view.ts`), слой снимал бы поверхности терминалов, и после «Restart host»
      // пропадал бы последний вывод неживой сессии (раунд main-r2, п. 2). Старый ответ отсекают поколения.
      set({ refreshing: false });
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
      // Вывод значит, что процесс входа жив: строка помечается `signingIn`, даже если окно открыли уже посреди входа.
      const offSignInOutput = bridge.on('providers.signInOutput', ({ provider, data }) => {
        if (connection !== currentConnection) return;
        set((state) => ({
          signInOutput: {
            ...state.signInOutput,
            [provider]: `${state.signInOutput[provider] ?? ''}${data}`.slice(-SIGN_IN_BUFFER_CHARS),
          },
          providers: patchAccount(state.providers, provider, { signingIn: true }),
        }));
      });
      const offSignInExit = bridge.on('providers.signInExit', ({ provider, exitCode, signedIn }) => {
        if (connection !== currentConnection) return;
        set((state) => ({
          signInResult: { ...state.signInResult, [provider]: { exitCode, signedIn } },
          providers: patchAccount(state.providers, provider, { signingIn: false, signedIn }),
        }));
        void reload().catch(() => {});
      });
      return () => {
        if (connection === currentConnection) {
          ++connection;
          activeBridge = null;
          refreshPromise = null;
          set({ refreshing: false });
        }
        offSignInExit();
        offSignInOutput();
        offLimits();
        offChanged();
      };
    },
  };
});
