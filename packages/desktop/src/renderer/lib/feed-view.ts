/**
 * Вид вкладки сессии — «Chat» или терминал (план 2026-10-01, решение 6). Вид «Chat» доступен сессии,
 * когда у хоста есть лента (`feed.snapshot` в `hello.methods`), сессия — Claude Code и его версия из
 * `providers.list` не ниже `FEED_MIN_VERSION` либо неизвестна (`null`: проба версий выключена или
 * сбоила). Codex и старый `claude` — терминал. Без поля `view` у вкладки — умолчание по доступности;
 * явный выбор человека побеждает, только пока вид доступен.
 */

import { FEED_MIN_VERSION } from '@parley/protocol';
import type { TabSpec, TerminalView } from '../../shared/layout-types.js';
import { useHostStore } from '../store/host.js';
import { useProvidersStore } from '../store/providers.js';
import { hostMethods, semver } from './capabilities.js';

export interface FeedAvailabilityInput {
  hostMethods: ReadonlySet<string>;
  /** `WorkSession.provider`: `claude` или `codex`. */
  provider: string;
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

export function feedAvailable({ hostMethods: methods, provider, version }: FeedAvailabilityInput): boolean {
  if (!methods.has('feed.snapshot')) return false;
  if (provider !== 'claude') return false;
  return version === null || atLeast(version, FEED_MIN_VERSION);
}

/** Вид, который вкладка показывает сейчас. */
export function effectiveView(tab: { view?: TerminalView }, available: boolean): TerminalView {
  if (!available) return 'terminal';
  return tab.view ?? 'chat';
}

/** Хост знает ленту — сегмент «Chat | Terminal» есть (выключенный, если вид сессии недоступен). */
export function useHostHasFeed(): boolean {
  return useHostStore((state) => hostMethods(state.status).has('feed.snapshot'));
}

/**
 * Доступность вида «Chat» по провайдеру сессии — функция для слоя, где вкладок много. Подписка — на
 * признак ленты у хоста и версию `claude`, не на весь список провайдеров.
 */
export function useFeedAvailability(): (provider: string) => boolean {
  const hasFeed = useHostHasFeed();
  const version = useProvidersStore((state) => claudeVersion(state.providers));
  const methods = hasFeed ? FEED_METHODS : NO_METHODS;
  return (provider) => feedAvailable({ hostMethods: methods, provider, version });
}

const FEED_METHODS: ReadonlySet<string> = new Set(['feed.snapshot']);
const NO_METHODS: ReadonlySet<string> = new Set();

/** Версия `claude` из списка провайдеров; списка ещё нет или версии нет — `null`. */
export function claudeVersion(providers: ReadonlyArray<{ id: string; version: string | null }>): string | null {
  return providers.find((provider) => provider.id === 'claude')?.version ?? null;
}

/** Та же проверка вне React — для действия палитры `chat.toggleView`. */
export function feedAvailableNow(provider: string): boolean {
  return feedAvailable({
    hostMethods: hostMethods(useHostStore.getState().status),
    provider,
    version: claudeVersion(useProvidersStore.getState().providers),
  });
}

export type TerminalTab = Extract<TabSpec, { kind: 'terminal' }>;
