/**
 * Проба версии `claude` перед включением push через channel (разговор агентов,
 * 4.4, решение D19).
 *
 * Флаг `--dangerously-load-development-channels` старая сборка не принимает, и
 * запуск падал бы с «unknown option», а причина была бы видна только в панели
 * гостя. Поэтому харнесс один раз спрашивает версию и ниже минимума молча
 * выключает push, показав строку статуса.
 */

import { execFile } from 'node:child_process';
import { commandBinary } from '../providers.js';
import { MCP_SERVER_NAME } from '../names.js';

/** Значение подстановки `{channel}`: чем будить сессию — именем сервера MCP (4.4). */
export const CHANNEL_VALUE = `server:${MCP_SERVER_NAME}`;

/**
 * Оверрайд `providers.json` заменяет `args` целиком, поэтому шаблон без
 * `{channel}` выключает push для этого провайдера. Это законно, но молча —
 * поэтому раз на работу об этом говорит CLI этой строкой (4.4); `planLaunch`
 * кладёт её же в `warnings` плана.
 */
export const NO_CHANNEL_WARNING = 'providers.json has no {channel}: push is off';

/**
 * Нижняя граница по документации channels (2026-09). Спайк 2026-09-18
 * проверил флаг на 2.1.276 и оставил границу документации как есть
 * (спецификация, раздел 9, пункт 7).
 */
export const CHANNEL_MIN_VERSION = '2.1.211';

/** Тройка из строки вида `2.1.276 (Claude Code)`; `null` — версии в строке нет. */
export function parseVersion(text: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Принимает ли такая версия флаг канала. Непонятную версию старой не считаем. */
export function channelSupported(version: string, min: string = CHANNEL_MIN_VERSION): boolean {
  const have = parseVersion(version);
  const need = parseVersion(min);
  if (have === null || need === null) return true;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== need[i]) return (have[i] as number) > (need[i] as number);
  }
  return true;
}

export interface ChannelProbe {
  supported: boolean;
  /** Что ответил бинарь; `null` — проба не удалась (бинаря нет, таймаут). */
  version: string | null;
}

/**
 * `claude --version` один раз на процесс харнесса. Проба не удалась — push
 * остаётся включённым: поведение как сегодня, а неизвестную установку мы не
 * вправе объявлять старой (4.4).
 */
export function probeChannelSupport(command = 'claude', timeoutMs = 3000): Promise<ChannelProbe> {
  return new Promise((resolve) => {
    execFile(commandBinary(command), ['--version'], { timeout: timeoutMs }, (error, stdout) => {
      if (error !== null) {
        resolve({ supported: true, version: null });
        return;
      }
      const version = stdout.trim();
      resolve({ supported: channelSupported(version), version });
    });
  });
}
