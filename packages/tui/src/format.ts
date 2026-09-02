/** Форматирование для списков. Ничего не знает про данные — только про их показ. */

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

/**
 * Сколько прошло: «сейчас», «12м», «2ч», «вчера», «3д». Форма намеренно короткая —
 * левая колонка узкая (30-40 колонок), и место нужно заголовку сессии.
 */
export function formatRelative(timestamp: string | null, now: number = Date.now()): string {
  if (timestamp === null) return '—';
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) return '—';

  const ago = now - at;
  if (ago < MINUTE) return 'сейчас';
  if (ago < HOUR) return `${Math.round(ago / MINUTE)}м`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)}ч`;
  if (ago < 2 * DAY) return 'вчера';
  return `${Math.floor(ago / DAY)}д`;
}

/** Обрезка по ширине колонки — Ink сам не переносит однострочный Text. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

/**
 * Окно видимых строк: список может быть длинным, а рисовать надо только то,
 * что помещается (specs/ui.md — виртуализация окном).
 */
export function visibleWindow(
  total: number,
  selected: number,
  height: number,
): { start: number; end: number } {
  if (height <= 0 || total === 0) return { start: 0, end: 0 };
  const half = Math.floor(height / 2);
  const start = Math.max(0, Math.min(selected - half, total - height));
  return { start: Math.max(0, start), end: Math.min(total, Math.max(0, start) + height) };
}
