/**
 * Лимиты подписки Codex из его же логов сессий (спека комнат Organic, 3.5, «Codex — логи
 * сессий»). В `~/.codex/sessions/<год>/<месяц>/<день>/rollout-*.jsonl` Codex после хода пишет
 * `event_msg` с `payload.type: 'token_count'`, а в нём `rate_limits.primary` и `secondary`:
 * `used_percent`, `window_minutes`, `resets_at` (Unix-секунды) — `RateLimitWindow` из
 * `codex-rs/protocol/src/protocol.rs` репозитория openai/codex. Только чтение, как остальные
 * логи Codex. Учётные данные соседнего каталога не открываются, к API никто не ходит.
 *
 * Лог человека — это его переписка, и большой: гигабайты за годы, мегабайты на сессию. Поэтому
 * читаются не все файлы и не файл целиком, а хвост самых свежих (`readCodexLimits`).
 */

import { open, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { limitWindow, type LimitWindow, type ProviderLimits } from '../limits.js';
import { INDEX_READ_CONCURRENCY, mapLimited } from '../map-limited.js';
import { defaultCodexRoot, discoverCodexSessions } from './discover.js';

/** Длины окон, минуты: 300 — пять часов, 10080 — неделя. */
const FIVE_HOURS_MINUTES = 5 * 60;
const WEEK_MINUTES = 7 * 24 * 60;
/**
 * Допуск на длину окна — те же 5 %, с какими Codex сам подписывает окна («5h», «weekly»):
 * сервер округляет секунды до минут, и точного равенства обещать не стоит.
 */
const WINDOW_TOLERANCE = 0.05;

const isNear = (minutes: number, target: number): boolean =>
  Math.abs(minutes - target) <= target * WINDOW_TOLERANCE;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Лимиты из одной записи лога; не `token_count`, без `rate_limits` или без времени — `null`.
 * Окно определяется по `window_minutes`, а не по имени поля: на некоторых тарифах в `primary`
 * лежит недельное окно, а пятичасового нет. Окно без длины или без времени сброса не
 * показывается: по нему не понять ни что это за окно, ни когда оно кончится.
 */
export function codexLimitsOf(record: unknown): ProviderLimits | null {
  const entry = asRecord(record);
  if (entry === null || entry['type'] !== 'event_msg') return null;
  const payload = asRecord(entry['payload']);
  if (payload === null || payload['type'] !== 'token_count') return null;
  const limits = asRecord(payload['rate_limits']);
  if (limits === null) return null;
  if (typeof entry['timestamp'] !== 'string') return null;
  const at = new Date(entry['timestamp']);
  if (Number.isNaN(at.getTime())) return null;

  let fiveHour: LimitWindow | null = null;
  let week: LimitWindow | null = null;
  for (const key of ['primary', 'secondary']) {
    const raw = asRecord(limits[key]);
    const minutes = raw?.['window_minutes'];
    if (raw === null || typeof minutes !== 'number') continue;
    const window = limitWindow(raw['used_percent'], raw['resets_at']);
    if (window === null) continue;
    if (isNear(minutes, FIVE_HOURS_MINUTES)) fiveHour ??= window;
    else if (isNear(minutes, WEEK_MINUTES)) week ??= window;
  }
  return fiveHour === null && week === null ? null : { fiveHour, week, at: at.toISOString() };
}

/**
 * Сколько байт с конца файла смотрим: сначала мало — запись `token_count` идёт после каждого
 * хода, и обычно она в последних килобайтах, — потом больше, если последний ход сложился из
 * длинных выводов инструментов. Дальше 8 МиБ не заглядываем: файл целиком на каждый опрос не
 * читается никогда.
 */
const TAIL_STEPS = [64 * 1024, 1024 * 1024, 8 * 1024 * 1024];

/** Ищет последнюю запись с лимитами среди целых строк среза. */
function lastLimitsIn(chunk: Buffer, cut: boolean): ProviderLimits | null {
  let from = 0;
  if (cut) {
    // Срез начался посреди файла: первая строка оборвана, а с ней и, возможно, символ UTF-8.
    const newline = chunk.indexOf(0x0a);
    if (newline === -1) return null;
    from = newline + 1;
  }
  const lines = chunk.subarray(from).toString('utf8').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    // Дешёвый отсев до разбора JSON: записей в хвосте много, нужных среди них единицы.
    if (!line.includes('"token_count"') || !line.includes('"rate_limits"')) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // Последняя строка живого лога может быть недописана — это не повреждение файла.
      continue;
    }
    const limits = codexLimitsOf(record);
    if (limits !== null) return limits;
  }
  return null;
}

/** Последняя запись с лимитами в хвосте файла; читается с конца и только сколько нужно. */
async function tailLimits(file: string): Promise<ProviderLimits | null> {
  let handle: FileHandle;
  try {
    handle = await open(file, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    for (const step of TAIL_STEPS) {
      const length = Math.min(step, size);
      const start = size - length;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      const found = lastLimitsIn(buffer.subarray(0, bytesRead), start > 0);
      // Файл прочитан весь (`start === 0`) — растить хвост дальше некуда.
      if (found !== null || start === 0) return found;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Сколько самых свежих логов пробуем, пока не найдём запись с лимитами. У только что
 * начатой сессии `token_count` ещё нет, поэтому одним самым свежим логом не обойтись, а глубже
 * пары-тройки идти незачем: лимиты одни на аккаунт, и любая недавняя сессия их несёт.
 */
const MAX_FILES = 5;

/**
 * Лимиты Codex: последнее событие `token_count` с `rate_limits` из самого свежего rollout-лога
 * (по времени изменения файла: `codex resume` дописывает старый лог, а каталог дня остаётся
 * прежним). Нет корня, логов или событий с лимитами — `null`. Окна с прошедшим сбросом здесь
 * ещё есть: их снимает хост (`dropExpiredWindows`).
 */
export async function readCodexLimits(
  root: string = defaultCodexRoot(),
): Promise<ProviderLimits | null> {
  const rollouts = (await discoverCodexSessions(root)).filter(({ file }) =>
    path.basename(file).startsWith('rollout-'),
  );
  const stamped = await mapLimited(rollouts, INDEX_READ_CONCURRENCY, async ({ file }) => ({
    file,
    modified: await stat(file).then(
      (info) => info.mtimeMs,
      () => 0,
    ),
  }));
  // Равное время — по имени: в нём время начала сессии, и позднее значит свежее.
  stamped.sort((a, b) => b.modified - a.modified || (a.file < b.file ? 1 : -1));

  for (const { file } of stamped.slice(0, MAX_FILES)) {
    const found = await tailLimits(file);
    if (found !== null) return found;
  }
  return null;
}
