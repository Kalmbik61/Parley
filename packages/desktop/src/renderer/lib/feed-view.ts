/**
 * Вид вкладки сессии — «Chat» или терминал (план 2026-10-01, решение 6). Вид «Chat» доступен сессии,
 * когда у хоста есть лента (`feed.snapshot` в `hello.methods`), сессия — семейства Claude Code и её версия из
 * `providers.list` не ниже `FEED_MIN_VERSION`. Версия неизвестна (`null`: проба версий выключена или
 * сбоила) — вид недоступен: хост без версии HTTP-хуков ленты не пишет, и чат был бы пуст. Codex и
 * старый `claude` — терминал. Без поля `view` у вкладки — умолчание по доступности; явный выбор
 * человека побеждает, только пока вид доступен.
 *
 * Третье состояние — «неизвестно» (`null`): хост ленту знает, сессия — Claude Code, но первый ответ
 * `providers.list` ещё не пришёл. Тогда вид не выбирается вовсе — ни поверхности терминала, ни подписки
 * на ленту, — иначе вкладка мигнула бы одним видом и перескочила в другой (лишний `pty.attach`).
 */

import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { FEED_MIN_VERSION, refKey, type SessionRef } from '@parley/protocol';
import type { TabSpec, TerminalView } from '../../shared/layout-types.js';
import { useActivityStore, type ActivityEntry } from '../store/activity.js';
import { useHostStore } from '../store/host.js';
import { useProvidersStore } from '../store/providers.js';
import { hostMethods, semver } from './capabilities.js';

export interface FeedAvailabilityInput {
  hostMethods: ReadonlySet<string>;
  /** `WorkSession.provider`: встроенный или свой провайдер. */
  provider: string;
  /** Семейство текущей записи; нет поля у старого хоста — Claude только по id. */
  family?: 'claude' | null | undefined;
  /** Версия CLI провайдера из `providers.list`; `null` — неизвестна. */
  version: string | null;
}

/** Версия не ниже порога; не `x.y.z` — нет (хост такой версии хуков ленты тоже не пишет). */
function atLeast(version: string, min: string): boolean {
  const have = semver(version);
  const need = semver(min);
  if (have === null || need === null) return false;
  const at = have.findIndex((part, index) => part !== need[index]);
  return at === -1 || have[at]! > need[at]!;
}

export function feedAvailable({
  hostMethods: methods,
  provider,
  family,
  version,
}: FeedAvailabilityInput): boolean {
  if (!methods.has('feed.snapshot')) return false;
  if (family !== 'claude' && !(family === undefined && provider === 'claude')) return false;
  return version !== null && atLeast(version, FEED_MIN_VERSION);
}

/**
 * Доступность с третьим состоянием: Claude/GLM ждут первый снимок провайдеров.
 * Старый хост без family разрешает Chat только id claude. Хост без ленты и Codex не ждут.
 */
export function feedAvailability(
  input: FeedAvailabilityInput & { loaded: boolean },
): boolean | null {
  if (!input.hostMethods.has('feed.snapshot')) return false;
  if (
    !input.loaded &&
    (input.provider === 'claude' || input.provider === 'glm' || input.family === 'claude')
  )
    return null;
  if (!input.loaded) return false;
  return feedAvailable(input);
}

/**
 * Вид, который вкладка показывает сейчас; `null` — доступность ещё неизвестна, вид не выбран.
 * Без явного `view` вкладка показывает терминал, пока сессия не стартовала (`started`: у активности
 * есть `lastEventAt` — первое событие журнала и есть SessionStart; кусок 4a, решение М), — диалог
 * доверия папке и вход в аккаунт идут до хуков, и чат был бы пуст. Явный выбор человека побеждает
 * всегда: вид под руками не переключается. `started` — `null`, пока снимок активности не пришёл:
 * без явного `view` вид тогда не выбран (иначе вкладка возобновлённой сессии мигнула бы терминалом
 * и сделала лишний `pty.attach`).
 */
export function effectiveView(
  tab: { view?: TerminalView },
  available: boolean | null,
  started: boolean | null,
): TerminalView | null {
  if (available === null) return null;
  if (!available) return 'terminal';
  if (tab.view !== undefined) return tab.view;
  if (started === null) return null;
  return started ? 'chat' : 'terminal';
}

/** Сессия стартовала: по её активности пришло хотя бы одно событие журнала. */
export function sessionStarted(entry: ActivityEntry | null | undefined): boolean {
  return (entry?.activity.lastEventAt ?? null) !== null;
}

/** `sessionStarted` с третьим состоянием: `null`, пока снимок активности не пришёл. */
export function sessionStartedOrUnknown(
  loaded: boolean,
  entry: ActivityEntry | null | undefined,
): boolean | null {
  return loaded ? sessionStarted(entry) : null;
}

/** `sessionStartedOrUnknown` по `refKey` сессии — подписка на один признак, не на каждое `activity.changed`. */
export function useSessionStarted(ref: SessionRef): boolean | null {
  const key = refKey(ref);
  return useActivityStore((state) => sessionStartedOrUnknown(state.loaded, state.byRef[key]));
}

/**
 * Признак «стартовала» по `refKey` — для слоя, где вкладок много; `null` — снимок активности ещё не
 * пришёл. Селектор возвращает отсортированный массив с поверхностным сравнением: перерисовка только
 * когда сессия стартовала, не на метрики.
 */
export function useStartedKeys(): (key: string) => boolean | null {
  const loaded = useActivityStore((state) => state.loaded);
  const keys = useActivityStore(
    useShallow((state) =>
      Object.keys(state.byRef)
        .filter((key) => sessionStarted(state.byRef[key]))
        .sort(),
    ),
  );
  return useMemo(() => {
    const set = new Set(keys);
    return (key) => (loaded ? set.has(key) : null);
  }, [loaded, keys]);
}

/** Хост знает ленту — сегмент «Chat | Terminal» есть (выключенный, если вид сессии недоступен). */
export function useHostHasFeed(): boolean {
  return useHostStore((state) => hostMethods(state.status).has('feed.snapshot'));
}

/**
 * Доступность вида «Chat» по провайдеру сессии — функция для слоя, где вкладок много; `null` —
 * неизвестно (`feedAvailability`). Для каждой сессии выбирается family и версия
 * именно её записи, в том числе у GLM.
 */
export function useFeedAvailability(): (provider: string) => boolean | null {
  const hasFeed = useHostHasFeed();
  const providers = useProvidersStore((state) => state.providers);
  const loaded = useProvidersStore((state) => state.loaded);
  const methods = hasFeed ? FEED_METHODS : NO_METHODS;
  return (provider) => {
    const info = providers.find((entry) => entry.id === provider);
    return feedAvailability({
      hostMethods: methods,
      provider,
      family: info?.family,
      version: info?.version ?? null,
      loaded,
    });
  };
}

const FEED_METHODS: ReadonlySet<string> = new Set(['feed.snapshot']);
const NO_METHODS: ReadonlySet<string> = new Set();

/** Та же проверка вне React — для действия палитры `chat.toggleView`. */
export function feedAvailableNow(provider: string): boolean {
  const info = useProvidersStore.getState().providers.find((entry) => entry.id === provider);
  return feedAvailable({
    hostMethods: hostMethods(useHostStore.getState().status),
    provider,
    family: info?.family,
    version: info?.version ?? null,
  });
}

export type TerminalTab = Extract<TabSpec, { kind: 'terminal' }>;
