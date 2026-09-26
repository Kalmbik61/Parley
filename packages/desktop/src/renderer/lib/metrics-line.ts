/**
 * Строка метрик под выбранной сессией: `↑1.2к ↓845 · 12м · ▤1 · ⋮1` (кусок 1.10
 * плана окна). `formatTokens` и `formatDuration` перенесены из
 * `tui/src/format.ts` дословно — то же форматирование, тот же читатель.
 */

import type { LiveMetrics } from '@harnas/protocol';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Длительность одной строкой: 45с / 12м / 1ч 4м / 3д 2ч. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < MINUTE) return `${Math.max(0, Math.round(ms / 1000))}с`;
  if (ms < HOUR) return `${Math.round(ms / MINUTE)}м`;
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    const minutes = Math.round((ms % HOUR) / MINUTE);
    return minutes === 0 ? `${hours}ч` : `${hours}ч ${minutes}м`;
  }
  const days = Math.floor(ms / DAY);
  const hours = Math.round((ms % DAY) / HOUR);
  return hours === 0 ? `${days}д` : `${days}д ${hours}ч`;
}

/** Число с единицей: один знак после запятой, пока значение меньше десяти. */
function withUnit(value: number, unit: string): string {
  // Сравниваем уже округлённое: 9.999 показалось бы как «10.0к» — десятичная
  // с десяти и выше не нужна, а знак в узкой колонке дорог.
  const rounded = Math.round(value * 10) / 10;
  return rounded < 10 ? `${rounded.toFixed(1)}${unit}` : `${Math.round(value)}${unit}`;
}

/** Токены: 0–999 как есть, дальше к и М. */
export function formatTokens(value: number): string {
  if (value < 1000) return String(Math.max(0, Math.round(value)));
  const thousands = value / 1000;
  // 999_600 округлилось бы до «1000к» — такое число уже читается как миллионы.
  return Math.round(thousands) < 1000 ? withUnit(thousands, 'к') : withUnit(value / 1_000_000, 'М');
}

/**
 * Строка метрик целиком. Токенов нет вовсе (оба `null`) — `—` вместо пары
 * стрелок; нулевые `▤` (субагенты) и `⋮` (непрочитанное) не печатаются —
 * колонка не должна заполняться нулями по умолчанию.
 */
export function formatMetricsLine(metrics: LiveMetrics): string {
  const parts: string[] = [];

  parts.push(
    metrics.tokensIn === null && metrics.tokensOut === null
      ? '—'
      : `↑${formatTokens(metrics.tokensIn ?? 0)} ↓${formatTokens(metrics.tokensOut ?? 0)}`,
  );
  parts.push(formatDuration(metrics.durationMs));
  if (metrics.subagents > 0) parts.push(`▤${metrics.subagents}`);
  if (metrics.unread > 0) parts.push(`⋮${metrics.unread}`);

  return parts.join(' · ');
}
