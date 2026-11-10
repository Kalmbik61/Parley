/**
 * Версии CLI провайдеров для строки статуса окна (дизайн комнат, 3.2): одна проба
 * `<команда> --version` на каждую команду реестра при старте хоста, ответ ложится в кэш.
 *
 * Проба ничего не читает у агента и не ходит в API: `--version` печатает номер сборки
 * локально и выходит, файлов учётных данных бинарь при этом не открывает. Запускается то же,
 * что стоит у человека в PATH (или подмена `PARLEY_<КОМАНДА>_BIN` (или прежняя `HARNAS_<КОМАНДА>_BIN`), как при запуске сессии),
 * и никогда — без таймаута.
 */

import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { BinaryNotFoundError, findRunnerBinary, loadProviders } from '@parley/core';
export { probeCliVersion } from '@parley/core';
import type { Log } from '../log.js';

/** Сколько держится `null` (нет бинаря, проба не дала версии): не пробовать заново на каждый вызов. */
export const VERSION_NULL_TTL_MS = 30_000;
/**
 * Версия скрипта на интерпретаторе (`#!/usr/bin/env node`) держится недолго: настоящая сборка может лежать
 * рядом (`package.json`, соседние файлы), и по mtime самого скрипта её смену не увидеть. Родной бинарь — без срока.
 */
export const VERSION_SCRIPT_TTL_MS = 300_000;
/** Оболочки: такой файл — обёртка, которая может запускать совсем другой бинарь; его mtime ничего не говорит. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'fish', 'csh', 'tcsh']);

/** Одна проба: версия команды, `null` — узнать не удалось (нет бинаря, таймаут, чужой ответ). */
export type VersionProbe = (command: string) => Promise<string | null>;

export interface ProviderVersions {
  /** Пробы старта завершены, успехом или нет; не отказывает. Его ждёт `providers.list`. */
  ready: Promise<void>;
  /** Версия по команде провайдера; `null` — не узнали или команды не было в реестре на старте. */
  get(command: string): string | null;
  /** Fresh local probe for readiness checks and launches; null without an injected probe. */
  fresh(command: string, options?: { force?: boolean }): Promise<string | null>;
}

/** Отпечаток бинаря, по которому кэш версии верен: `null` — кэшировать нельзя. */
export interface BinaryStamp {
  key: string;
  /** Срок ответа, мс; `Infinity` — пока отпечаток тот же. */
  ttlMs: number;
}

/**
 * Отпечаток бинаря команды. Путь берётся так же, как у пробы (оверрайд и PATH), затем раскрываются все
 * симлинки (nvm, Cellar, `~/.local/bin`) и берутся dev, ino, размер, mtime и ctime настоящего файла: обновление
 * подменяет файл или переводит ссылку на каталог новой версии. Не нашли бинарь — отпечаток «нет» на 30 с.
 * Файл со shebang оболочки — обёртка, за которой может стоять что угодно: `null`, не кэшируется.
 */
export async function binaryStamp(command: string, env: NodeJS.ProcessEnv = process.env): Promise<BinaryStamp | null> {
  try {
    const found = await findRunnerBinary(command, env);
    const real = await realpath(found);
    const info = await stat(real);
    const handle = await open(real, 'r');
    let head = '';
    try {
      const buffer = Buffer.alloc(160);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, bytesRead).toString('latin1');
    } finally {
      await handle.close();
    }
    let ttlMs = Infinity;
    if (head.startsWith('#!')) {
      const words = (head.slice(2).split('\n')[0] ?? '').trim().split(/\s+/).filter(word => word !== '');
      let interpreter = path.basename(words[0] ?? '');
      if (interpreter === 'env') {
        interpreter = path.basename(words.slice(1).find(word => !word.startsWith('-') && !word.includes('=')) ?? '');
      }
      if (interpreter === '' || SHELLS.has(interpreter)) return null;
      ttlMs = VERSION_SCRIPT_TTL_MS;
    }
    return { key: `${found}\0${real}\0${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`, ttlMs };
  } catch (error) {
    return error instanceof BinaryNotFoundError ? { key: `missing:${command}`, ttlMs: VERSION_NULL_TTL_MS } : null;
  }
}

export interface ProviderVersionsOptions {
  now?: () => number;
  stamp?: (command: string) => Promise<BinaryStamp | null>;
}

/**
 * Запускает пробы по реестру на момент старта. Без пробы (`undefined`) ничего не запускается
 * и версий нет. `fresh` отдаёт версию из кэша, пока отпечаток бинаря (`binaryStamp`) тот же; обновление CLI
 * его меняет, и следующий вызов пробует заново. `{ force: true }` кэш обходит и обновляет (кнопка «проверить снова»,
 * конец `update`). Бинарь без надёжного отпечатка (обёртка на оболочке) не кэшируется. Параллельные запросы одной
 * команды делят результат. Битый реестр или упавшая проба версии не дают — хост от этого не
 * падает, `providers.list` про сам реестр отчитается своей ошибкой.
 */
export function startProviderVersions(probe: VersionProbe | undefined, log: Log, options: ProviderVersionsOptions = {}): ProviderVersions {
  const now = options.now ?? Date.now;
  const stampOf = options.stamp ?? ((command: string) => binaryStamp(command));
  const cache = new Map<string, string | null>();
  /** Последний ответ по команде: отпечаток, версия и до какого момента верен. */
  const known = new Map<string, { key: string; version: string | null; until: number }>();
  const pending = new Map<string, Promise<string | null>>();
  const fresh = (command: string, opts: { force?: boolean } = {}): Promise<string | null> => {
    if (probe === undefined) return Promise.resolve(null);
    const current = pending.get(command);
    if (current !== undefined && opts.force !== true) return current;
    const result: Promise<string | null> = (async () => {
      const stamp = await stampOf(command).catch(() => null);
      const hit = known.get(command);
      if (opts.force !== true && stamp !== null && hit !== undefined && hit.key === stamp.key && now() < hit.until) {
        return hit.version;
      }
      const version = await Promise.resolve().then(() => probe(command)).catch((error: unknown) => {
        log.warn('проба версии CLI упала', { command, error: String(error) });
        return null;
      });
      cache.set(command, version);
      if (stamp === null) known.delete(command);
      else known.set(command, { key: stamp.key, version, until: now() + (version === null ? Math.min(stamp.ttlMs, VERSION_NULL_TTL_MS) : stamp.ttlMs) });
      return version;
    })().finally(() => {
      if (pending.get(command) === result) pending.delete(command);
    });
    pending.set(command, result);
    return result;
  };

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
    await Promise.all(commands.map(command => fresh(command)));
  };

  return { ready: run(), get: (command) => cache.get(command) ?? null, fresh };
}
