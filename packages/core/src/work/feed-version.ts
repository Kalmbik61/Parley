/**
 * Порог версии `claude` для ленты вида «Chat» (Global Constraints плана 2026-10-01): HTTP-хуки
 * ленты пишутся в файл настроек только тому `claude`, на котором их проверила разведка. Ниже — и
 * при непонятной версии — вкладка открывается терминалом, как раньше.
 */

import { parseVersion } from './channel.js';

/** Версия стенда разведки 2026-10-01: `MessageDisplay`, `PostToolBatch` и HTTP-хуки проверены на ней. */
export const FEED_MIN_VERSION = '2.1.286';

/**
 * Не ниже ли версия порога. В отличие от `channelSupported`, непонятную версию считаем старой:
 * лента без хуков пуста, а терминал работает всегда.
 */
export function feedSupported(version: string, min: string = FEED_MIN_VERSION): boolean {
  const have = parseVersion(version);
  const need = parseVersion(min);
  if (have === null || need === null) return false;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== need[i]) return (have[i] as number) > (need[i] as number);
  }
  return true;
}
