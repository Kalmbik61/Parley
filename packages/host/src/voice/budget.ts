/**
 * Дневной лимит голоса (спека 2026-11-03, B4): только суточный, месячного нет. Расход берётся из `voice_usage` за
 * локальные календарные сутки Mac: `seconds_final`, а пока его нет (sideband_lost, unclosed_orphan, открытая сессия) — оценка.
 */
import type { DatabaseSync } from 'node:sqlite';

export const DEFAULT_DAILY_MINUTES = 30;

export const localDay = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export interface DailyBudget {
  limitSeconds: number;
  usedSeconds: number;
  /** Не меньше нуля. */
  remainingSeconds: number;
}

export function dailyBudget(db: DatabaseSync, dailyMinutes: number, at: Date): DailyBudget {
  const row = db.prepare('SELECT COALESCE(SUM(COALESCE(seconds_final, seconds_estimate)), 0) AS used FROM voice_usage WHERE day = ?').get(localDay(at)) as { used: number };
  const limitSeconds = Math.round(dailyMinutes * 60);
  return { limitSeconds, usedSeconds: row.used, remainingSeconds: Math.max(0, limitSeconds - row.used) };
}
