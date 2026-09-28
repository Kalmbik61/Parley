/**
 * Разбор времени ISO 8601 для порядка и внимания. `Date.parse` сам по себе не годится:
 * V8 разбирает и не-ISO строки (`'w-9999'` — год 9998), и такая «дата» поднимала бы карточку.
 */

// Дата и время с часовым поясом — как у `toISOString` (Z) или со смещением ±hh:mm.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Миллисекунды эпохи или null, если строка — не ISO-время или несуществующая дата. */
export function isoMs(value: string): number | null {
  if (!ISO.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
