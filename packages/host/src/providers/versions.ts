/**
 * Версии CLI провайдеров для строки статуса окна (дизайн комнат, 3.2): одна проба
 * `<команда> --version` на каждую команду реестра при старте хоста, ответ ложится в кэш.
 *
 * Проба ничего не читает у агента и не ходит в API: `--version` печатает номер сборки
 * локально и выходит, файлов учётных данных бинарь при этом не открывает. Запускается то же,
 * что стоит у человека в PATH (или подмена `HARNAS_<КОМАНДА>_BIN`, как при запуске сессии),
 * и никогда — без таймаута.
 */

import { execFile } from 'node:child_process';
import { commandBinary, loadProviders, parseVersion } from '@parley/core';
import type { Log } from '../log.js';

/** Одна проба: версия команды, `null` — узнать не удалось (нет бинаря, таймаут, чужой ответ). */
export type VersionProbe = (command: string) => Promise<string | null>;

/** Как долго ждём ответа `--version`: живой CLI отвечает за доли секунды, зависший — не ждём. */
const PROBE_TIMEOUT_MS = 3000;

/**
 * Настоящая проба: `<команда> --version`, версия — первая тройка цифр ответа
 * (`2.1.276 (Claude Code)` → `2.1.276`, `codex-cli 0.44.0` → `0.44.0`). Хост подключает её
 * только в `main.ts`: тесты, где команды запускать нельзя, зовут `startHost` без пробы.
 */
export function probeCliVersion(
  command: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      commandBinary(command),
      ['--version'],
      // SIGKILL, а не SIGTERM: зависший бинарь сигнал мог бы и проигнорировать.
      { timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          resolve(null);
          return;
        }
        const version = parseVersion(stdout);
        resolve(version === null ? null : version.join('.'));
      },
    );
    // Бинарь, читающий stdin до конца, без EOF не вышел бы до таймаута.
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });
}

export interface ProviderVersions {
  /** Пробы старта завершены, успехом или нет; не отказывает. Его ждёт `providers.list`. */
  ready: Promise<void>;
  /** Версия по команде провайдера; `null` — не узнали или команды не было в реестре на старте. */
  get(command: string): string | null;
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

  return { ready: run(), get: (command) => cache.get(command) ?? null };
}
