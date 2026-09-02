/** Форматирование для списков. Ничего не знает про данные — только про их показ. */

import { homedir } from 'node:os';
import type { TokenTotals } from '@harnas/core';

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
export function truncate(text: string, width: number, ellipsis = '…'): string {
  if (width <= 0) return '';
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}${ellipsis}` : text;
}

/**
 * Обрезка слева: у путей важен хвост — имя файла и последние каталоги
 * (дизайн координации TUI, 6.4).
 */
export function truncateLeft(text: string, width: number, ellipsis = '…'): string {
  if (width <= 0) return '';
  return text.length > width
    ? `${ellipsis}${text.slice(text.length - Math.max(0, width - 1))}`
    : text;
}

/**
 * Многострочное поле панели ДЕТАЛИ: перенос по словам и не больше `maxLines`
 * строк, дальше `…` (дизайн координации TUI, 6.4). Слово длиннее строки рвётся —
 * иначе путь или длинный идентификатор выпал бы из вывода целиком.
 */
export function wrapText(text: string, width: number, maxLines: number, ellipsis = '…'): string[] {
  if (width <= 0 || maxLines <= 0 || text === '') return [];

  const words = text.split(/\s+/).filter((word) => word !== '');
  const lines: string[] = [];
  let current = '';

  const push = (): void => {
    if (current !== '') lines.push(current);
    current = '';
  };

  for (const word of words) {
    let rest = word;
    while (rest.length > width) {
      push();
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    if (current === '') current = rest;
    else if (current.length + 1 + rest.length <= width) current = `${current} ${rest}`;
    else {
      push();
      current = rest;
    }
  }
  push();

  if (lines.length <= maxLines) return lines;
  // Последняя видимая строка набивается остатком и обрезается: многоточие в её
  // конце — единственный знак, что текст продолжается (полностью — прокруткой).
  const visible = lines.slice(0, maxLines - 1);
  visible.push(truncate(lines.slice(maxLines - 1).join(' '), width, ellipsis));
  return visible;
}

/** Часы и минуты по местному времени: `14:02` (дизайн 3 — время выхода, история). */
export function formatClock(timestamp: string | null): string {
  if (timestamp === null) return '—';
  const at = new Date(timestamp);
  return Number.isNaN(at.getTime()) ? '—' : at.toTimeString().slice(0, 5);
}

/**
 * Домашняя директория в пути — тильдой: в узкой колонке `~/dev/shop` читается,
 * а хвост `…s/имя/dev/shop` — нет (дизайн 2.1, 6.4).
 */
export function withHome(path: string, home: string = homedir()): string {
  if (home === '') return path;
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
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

/** Число с единицей: один знак после запятой, пока значение меньше десяти. */
function withUnit(value: number, unit: string): string {
  // Сравниваем уже округлённое: 9.999 показалось бы как «10.0к» — десятичная
  // с десяти и выше не нужна, а знак в узкой колонке дорог.
  const rounded = Math.round(value * 10) / 10;
  return rounded < 10 ? `${rounded.toFixed(1)}${unit}` : `${Math.round(value)}${unit}`;
}

/** Токены: 0–999 как есть, дальше к и М (дизайн координации TUI, 6.3). */
export function formatTokens(value: number): string {
  if (value < 1000) return String(Math.max(0, Math.round(value)));
  const thousands = value / 1000;
  // 999_600 округлилось бы до «1000к» — такое число уже читается как миллионы.
  return Math.round(thousands) < 1000 ? withUnit(thousands, 'к') : withUnit(value / 1_000_000, 'М');
}

/**
 * Пара «вход/выход» для строки списка. Кэш сюда не выводится никогда: он на
 * порядки больше и читается как шум — все четыре счётчика показывают детали.
 */
export function formatTokenPair(tokens: TokenTotals | null): string {
  if (tokens === null) return '—';
  return `${formatTokens(tokens.input)}/${formatTokens(tokens.output)}`;
}
