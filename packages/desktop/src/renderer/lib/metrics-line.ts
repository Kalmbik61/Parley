/**
 * Строка метрик под выбранной сессией: `↑1.2к ↓845 · 12м · ▤1 · ⋮1` (кусок 1.10
 * плана окна). `formatTokens` и `formatDuration` перенесены из
 * `tui/src/format.ts` дословно — то же форматирование, тот же читатель.
 */

import type { LiveMetrics } from '@parley/protocol';
import { appI18n } from '../../shared/app-locale.js';
import { S } from '../../shared/strings.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Длительность одной строкой: 45с / 12м / 1ч 4м / 3д 2ч. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const [second, minute, hour, day] = appI18n.locale === 'ru' ? ['с', 'м', 'ч', 'д'] : ['s', 'm', 'h', 'd'];
  if (ms < MINUTE) return `${Math.max(0, Math.round(ms / 1000))}${second}`;
  if (ms < HOUR) return `${Math.round(ms / MINUTE)}${minute}`;
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    const minutes = Math.round((ms % HOUR) / MINUTE);
    return minutes === 0 ? `${hours}${hour}` : `${hours}${hour} ${minutes}${minute}`;
  }
  const days = Math.floor(ms / DAY);
  const hours = Math.round((ms % DAY) / HOUR);
  return hours === 0 ? `${days}${day}` : `${days}${day} ${hours}${hour}`;
}

/** Число с единицей: один знак после запятой, пока значение меньше десяти. */
function withUnit(value: number, unit: string): string {
  // Сравниваем уже округлённое: 9.999 показалось бы как «10.0к» — десятичная
  // с десяти и выше не нужна, а знак в узкой колонке дорог.
  const rounded = Math.round(value * 10) / 10;
  const number = rounded < 10
    ? appI18n.formatNumber(rounded, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
    : appI18n.formatNumber(Math.round(value));
  return `${number}${unit}`;
}

/** Токены: 0–999 как есть, дальше к и М. */
export function formatTokens(value: number): string {
  if (value < 1000) return String(Math.max(0, Math.round(value)));
  const thousands = value / 1000;
  // 999_600 округлилось бы до «1000к» — такое число уже читается как миллионы.
  const [k, m] = appI18n.locale === 'ru' ? [' тыс.', ' млн'] : ['k', 'M'];
  return Math.round(thousands) < 1000 ? withUnit(thousands, k) : withUnit(value / 1_000_000, m);
}

/** Счётчик строкой: неизвестный — `?`, а не `0` (измеренный ноль печатается нулём). */
const known = (value: number | null): string => (value === null ? '?' : formatTokens(value));

/**
 * Кэш и происхождение цифр: `cache r30 w?` (чтение и запись; `?` — провайдер не сообщил) и пометка,
 * когда цифры не свежий живой замер: `snapshot` (снимок из карты), `stale` (сессия идёт, свежего
 * подтверждения нет), `partial` (нижняя граница), `n/a` (нет данных). Это токены, а не деньги и не доля
 * лимита подписки.
 */
function usageParts(usage: NonNullable<LiveMetrics['usage']>): string[] {
  const parts: string[] = [];
  if (usage.cacheRead !== null || usage.cacheWrite !== null) {
    parts.push(S.usage.cache(known(usage.cacheRead), known(usage.cacheWrite)));
  }
  const flags = [
    usage.source === 'native-index' ? null : usage.source === 'unavailable' ? S.usage.notAvailable : S.usage.snapshot,
    usage.stale ? S.usage.stale : null,
    usage.completeness === 'partial' ? S.usage.partial : null,
  ].filter((flag) => flag !== null);
  if (flags.length > 0) parts.push(flags.join(' '));
  return parts;
}

/**
 * Строка метрик целиком. Токенов нет вовсе (оба `null`) — `—` вместо пары
 * стрелок; одно неизвестное число у хоста с `usage` печатается как `?`, а не нулём; нулевые `▤`
 * (субагенты) и `⋮` (непрочитанное) не печатаются — колонка не должна заполняться нулями по
 * умолчанию. Хост со списком живых субагентов (`tasks`) их число показывает бейджем с поповером в самой
 * строке сессии (кусок 4b), счётчик `▤` тогда не повторяется; прежний хост списка не присылает —
 * счётчик остаётся единственным признаком.
 */
export function formatMetricsLine(metrics: LiveMetrics): string {
  const parts: string[] = [];
  // Прежний хост одного числа без второго не присылает: там `?` не нужен и старая запись `0` сохраняется.
  const count = (value: number | null): string =>
    metrics.usage === undefined ? formatTokens(value ?? 0) : known(value);

  parts.push(
    metrics.tokensIn === null && metrics.tokensOut === null
      ? '—'
      : `↑${count(metrics.tokensIn)} ↓${count(metrics.tokensOut)}`,
  );
  if (metrics.usage !== undefined) parts.push(...usageParts(metrics.usage));
  parts.push(formatDuration(metrics.durationMs));
  if (metrics.tasks === undefined && metrics.subagents > 0) parts.push(`▤${metrics.subagents}`);
  if (metrics.unread > 0) parts.push(`⋮${metrics.unread}`);

  return parts.join(' · ');
}
