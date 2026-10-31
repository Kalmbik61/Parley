/**
 * Датчик давления памяти (спека 2026-10-30, 4.2, «Давление памяти»). Раз в 10 с хост читает уровень давления: по нему
 * сервис ёмкости решает, пускать ли новый запуск, а сервис сна — пора ли усыплять простаивающих агентов.
 *
 * Откуда берётся уровень:
 * - macOS: `sysctl -n kern.memorystatus_vm_pressure_level` (1 — `normal`, 2 — `warn`, 4 — `critical`); занятый своп —
 *   `sysctl -n vm.swapusage`;
 * - Linux: `/proc/pressure/memory` (PSI) и `/proc/meminfo` (`MemAvailable`, своп);
 * - другая система и любой сбой чтения — `unknown`. Он ведёт себя как `normal`: нет данных — ничего не блокируется.
 *   Датчик ничего не бросает, о сбое он говорит только этим уровнем.
 *
 * Рычаг приёмки: `PARLEY_MEMORY_PRESSURE_FILE` — путь к файлу со словом `normal`, `warn` или `critical`. Пока переменная
 * задана, уровень — содержимое файла (своп `null`), а ОС не спрашивается; файла нет или в нём другое слово — `unknown`.
 */

import { execFile } from 'node:child_process';
import { readFile as readFileFromDisk } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { MemoryPressure } from '@parley/core';

const execFileAsync = promisify(execFile);

/** Как часто датчик читает давление. */
export const PRESSURE_INTERVAL_MS = 10_000;

/** Зависший `sysctl` датчик держать не должен: через 5 с чтение считается неудавшимся. */
const SYSCTL_TIMEOUT_MS = 5_000;

/** Рычаг приёмки: путь к файлу с уровнем вместо вопроса к ОС. */
const LEVER = 'PARLEY_MEMORY_PRESSURE_FILE';

/**
 * Linux: давление не нормальное, если задачи за последние 10 с стояли в ожидании памяти не меньше стольких процентов
 * времени (`avg10` в PSI): `some` — хотя бы одна задача (`warn`), `full` — все (`critical`).
 */
const STALL_PERCENT = 10;

/** Linux: `MemAvailable` ниже этой доли `MemTotal` (в процентах) — `critical`, ниже следующей — `warn`. */
const CRITICAL_AVAILABLE_PERCENT = 5;
const WARN_AVAILABLE_PERCENT = 10;

/** `/proc/meminfo` считает в килобайтах. */
const KB_PER_GB = 1024 * 1024;

export interface PressureReading {
  level: MemoryPressure;
  /** Занятый своп, ГБ; `null` — не узнали. */
  swapGb: number | null;
  /** Когда прочитано, мс; `0` — датчик ещё ни разу не читал. */
  at: number;
}

export interface PressureSensor {
  start(): void;
  stop(): void;
  /** Последнее чтение; до первого — `{ level: 'unknown', swapGb: null, at: 0 }`. */
  current(): PressureReading;
  /** Слушатель каждого чтения (раз в `intervalMs`); возвращает отписку. */
  onReading(listener: (reading: PressureReading) => void): () => void;
  /** Одно чтение сейчас: обновляет `current()` и зовёт слушателей. Не бросает. */
  read(): Promise<PressureReading>;
}

export interface PressureSensorDeps {
  platform?: NodeJS.Platform;
  /** stdout `execFile(command, args)`; ошибка — отказ промиса. */
  run?: (command: string, args: readonly string[]) => Promise<string>;
  readFile?: (file: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  now?: () => number;
}

/** То, что датчик узнал за одно чтение, без времени. */
type Sample = Pick<PressureReading, 'level' | 'swapGb'>;

/** `1` → `normal`, `2` → `warn`, `4` → `critical`, остальное → `unknown`. */
export function parseDarwinLevel(text: string): MemoryPressure {
  switch (text.trim()) {
    case '1':
      return 'normal';
    case '2':
      return 'warn';
    case '4':
      return 'critical';
    default:
      return 'unknown';
  }
}

/** Занятая часть в строке `total = 3072.00M  used = 2365.44M  free = 706.56M  (encrypted)`. */
const SWAP_USED = /\bused\s*=\s*(\d+(?:\.\d+)?)([MG])\b/;

/** Занятый своп в ГБ из вывода `sysctl -n vm.swapusage` (`M` или `G`); не разобралось — `null`. */
export function parseDarwinSwap(text: string): number | null {
  const match = SWAP_USED.exec(text);
  if (match === null) return null;
  const amount = Number(match[1]);
  return match[2] === 'G' ? amount : amount / 1024;
}

/** Число из первой группы выражения; строки нет — `null`. */
function numberAt(text: string, pattern: RegExp): number | null {
  const found = pattern.exec(text)?.[1];
  return found === undefined ? null : Number(found);
}

/**
 * Уровень и своп Linux по тексту `/proc/pressure/memory` (`psi`) и `/proc/meminfo`. Каждый из двух источников может
 * не прочитаться (пустая строка): уровень тогда по оставшемуся, а если не разобрался ни один — `unknown`.
 * - `critical` — `full avg10` не меньше 10 или `MemAvailable` меньше 5 % от `MemTotal`;
 * - `warn` — `some avg10` не меньше 10 или `MemAvailable` меньше 10 %;
 * - иначе `normal`;
 * - своп — `SwapTotal − SwapFree`, ГБ.
 */
export function parseLinuxPressure(
  psi: string,
  meminfo: string,
): { level: MemoryPressure; swapGb: number | null } {
  const some = numberAt(psi, /^some\s+avg10=(\d+(?:\.\d+)?)/m);
  const full = numberAt(psi, /^full\s+avg10=(\d+(?:\.\d+)?)/m);
  const total = numberAt(meminfo, /^MemTotal:\s+(\d+)/m);
  const available = numberAt(meminfo, /^MemAvailable:\s+(\d+)/m);
  const swapTotal = numberAt(meminfo, /^SwapTotal:\s+(\d+)/m);
  const swapFree = numberAt(meminfo, /^SwapFree:\s+(\d+)/m);

  const availablePercent =
    total !== null && total > 0 && available !== null ? (available / total) * 100 : null;
  const swapGb =
    swapTotal !== null && swapFree !== null
      ? Math.max(0, swapTotal - swapFree) / KB_PER_GB
      : null;

  if (some === null && full === null && availablePercent === null) return { level: 'unknown', swapGb };
  const critical =
    (full !== null && full >= STALL_PERCENT) ||
    (availablePercent !== null && availablePercent < CRITICAL_AVAILABLE_PERCENT);
  if (critical) return { level: 'critical', swapGb };
  const warn =
    (some !== null && some >= STALL_PERCENT) ||
    (availablePercent !== null && availablePercent < WARN_AVAILABLE_PERCENT);
  return { level: warn ? 'warn' : 'normal', swapGb };
}

const defaultRun = async (command: string, args: readonly string[]): Promise<string> =>
  (await execFileAsync(command, args, { timeout: SYSCTL_TIMEOUT_MS })).stdout;

const defaultReadFile = (file: string): Promise<string> => readFileFromDisk(file, 'utf8');

/** Источник, который не ответил (нет команды, нет файла, мусор в выводе), даёт запасное значение: датчик не бросает. */
async function orElse<T>(source: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await source();
  } catch {
    return fallback;
  }
}

/** Слово из файла рычага; любое другое — `unknown`. */
function leverLevel(word: string): MemoryPressure {
  switch (word) {
    case 'normal':
    case 'warn':
    case 'critical':
      return word;
    default:
      return 'unknown';
  }
}

export function createPressureSensor(deps: PressureSensorDeps = {}): PressureSensor {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? defaultRun;
  const readFile = deps.readFile ?? defaultReadFile;
  const env = deps.env ?? process.env;
  const intervalMs = deps.intervalMs ?? PRESSURE_INTERVAL_MS;
  const now = deps.now ?? Date.now;

  const listeners = new Set<(reading: PressureReading) => void>();
  let latest: PressureReading = { level: 'unknown', swapGb: null, at: 0 };
  let inFlight: Promise<PressureReading> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  /** Уровень и своп спрашиваются независимо: ответил один — его и берём. */
  async function sampleDarwin(): Promise<Sample> {
    const [level, swapGb] = await Promise.all([
      orElse(
        async () => parseDarwinLevel(await run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])),
        'unknown',
      ),
      orElse(async () => parseDarwinSwap(await run('sysctl', ['-n', 'vm.swapusage'])), null),
    ]);
    return { level, swapGb };
  }

  async function sampleLinux(): Promise<Sample> {
    const [psi, meminfo] = await Promise.all([
      orElse(() => readFile('/proc/pressure/memory'), ''),
      orElse(() => readFile('/proc/meminfo'), ''),
    ]);
    return parseLinuxPressure(psi, meminfo);
  }

  async function sampleLever(file: string): Promise<Sample> {
    const word = await orElse(async () => (await readFile(file)).trim(), '');
    return { level: leverLevel(word), swapGb: null };
  }

  function sample(): Promise<Sample> {
    // Переменная читается на каждом чтении: приёмка меняет файл, а не окружение.
    const lever = env[LEVER];
    if (lever !== undefined && lever !== '') return sampleLever(lever);
    if (platform === 'darwin') return sampleDarwin();
    if (platform === 'linux') return sampleLinux();
    return Promise.resolve({ level: 'unknown', swapGb: null });
  }

  function publish(sampled: Sample): PressureReading {
    latest = { ...sampled, at: now() };
    for (const listener of listeners) {
      try {
        listener(latest);
      } catch {
        // Сбой слушателя — его дело: он не должен ни лишить чтения остальных слушателей, ни уронить хост
        // непойманным отказом в таймере.
      }
    }
    return latest;
  }

  /**
   * Чтение, которое уже идёт, общее: второй `sysctl` подряд не нужен, а запоздавший ответ не затрёт более свежий.
   */
  function read(): Promise<PressureReading> {
    inFlight ??= sample()
      .then(publish)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    start() {
      if (timer !== null) return;
      void read();
      timer = setInterval(() => void read(), intervalMs);
      // Хост живёт клиентами и сессиями, а не этим таймером: он не должен удерживать процесс.
      timer.unref();
    },
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
    current: () => latest,
    onReading(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
  };
}
