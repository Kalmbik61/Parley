/**
 * Версии CLI провайдеров для строки статуса окна (дизайн комнат, 3.2): одна проба
 * `<команда> --version` на каждую команду реестра при старте хоста, ответ ложится в кэш.
 *
 * Проба ничего не читает у агента и не ходит в API: `--version` печатает номер сборки
 * локально и выходит, файлов учётных данных бинарь при этом не открывает. Запускается то же,
 * что стоит у человека в PATH (или подмена `PARLEY_<КОМАНДА>_BIN` (или прежняя `HARNAS_<КОМАНДА>_BIN`), как при запуске сессии),
 * и никогда — без таймаута.
 */

import { loadProviders } from '@parley/core';
export { probeCliVersion } from '@parley/core';
import type { Log } from '../log.js';

/** Одна проба: версия команды, `null` — узнать не удалось (нет бинаря, таймаут, чужой ответ). */
export type VersionProbe = (command: string) => Promise<string | null>;

export interface ProviderVersions {
  /** Пробы старта завершены, успехом или нет; не отказывает. Его ждёт `providers.list`. */
  ready: Promise<void>;
  /** Версия по команде провайдера; `null` — не узнали или команды не было в реестре на старте. */
  get(command: string): string | null;
  /** Fresh local probe for readiness checks and launches; null without an injected probe. */
  fresh(command: string): Promise<string | null>;
}

/**
 * Запускает пробы по реестру на момент старта. Без пробы (`undefined`) ничего не запускается
 * и версий нет. Провайдер, добавленный в `providers.json` уже после старта, не пробуется:
 * проба одна и на старте. Битый реестр или упавшая проба версии не дают — хост от этого не
 * падает, `providers.list` про сам реестр отчитается своей ошибкой.
 */
export function startProviderVersions(probe: VersionProbe | undefined, log: Log): ProviderVersions {
  const cache = new Map<string, string | null>();

  const run = async (): Promise<void> => {
    if (probe === undefined) return;
    let commands: string[];
    try {
      const registry = await loadProviders();
      commands = [...new Set(Object.values(registry).map((entry) => entry.runner.command))];
    } catch (error) {
      log.warn('версии CLI не пробуются: реестр провайдеров не читается', { error: String(error) });
      return;
    }
    await Promise.all(
      commands.map(async (command) => {
        try {
          cache.set(command, await probe(command));
        } catch (error) {
          log.warn('проба версии CLI упала', { command, error: String(error) });
          cache.set(command, null);
        }
      }),
    );
  };

  return {
    ready: run(), get: (command) => cache.get(command) ?? null,
    fresh: async (command) => {
      if (probe === undefined) return null;
      let version: string | null;
      try { version = await probe(command); } catch { version = null; }
      cache.set(command, version);
      return version;
    },
  };
}
