/**
 * Время последнего события в карточке и строке сессии (спека 6.3): коротко, как у Orca.
 * Минуты и часы — по разнице, «вчера» и дата — по календарю в поясе окна: событие 20 ч
 * назад ещё «20h», хотя число уже вчерашнее.
 */

import { displayLocale } from '../../shared/app-locale.js';
import { S } from '../../shared/strings.js';
import { isoMs } from './iso-time.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 'now' (< 1 мин), '3m', '2h', 'yesterday', 'Sep 26' (этот год), 'Sep 26, 2025' (прошлые). */
function eventTime(iso: string, now: Date, withAgo: boolean): string {
  const ms = isoMs(iso);
  // Не-ISO время показать нечем — пусто, а не «Invalid Date».
  if (ms === null) return '';
  // Время из будущего (часы хоста впереди) — тоже «сейчас», а не отрицательные минуты.
  const diff = Math.max(0, now.getTime() - ms);
  if (diff < MINUTE) return S.time.now;
  if (diff < DAY) {
    const relative = diff < HOUR ? S.time.minutes(Math.floor(diff / MINUTE)) : S.time.hours(Math.floor(diff / HOUR));
    return withAgo ? S.time.ago(relative) : relative;
  }

  const at = new Date(ms);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(at, yesterday)) return S.time.yesterday;
  const day: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (at.getFullYear() !== now.getFullYear()) day.year = 'numeric';
  return at.toLocaleDateString(displayLocale(), day);
}

export function relativeTime(iso: string, now: Date): string {
  return eventTime(iso, now, false);
}

/**
 * `relativeTime` для фразы «last event …» карточки неживой сессии: минуты и часы — с «ago» (`3m ago`, `2h ago`),
 * «now», «yesterday» и дата — как есть (`last event yesterday`, `last event Sep 26`).
 */
export function relativeTimeAgo(iso: string, now: Date): string {
  return eventTime(iso, now, true);
}
