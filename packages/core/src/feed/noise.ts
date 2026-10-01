/**
 * Шум хуков, который лента не показывает (план 2026-10-01, решение 11): служебные субагенты
 * Claude Code (заголовок сессии, подсказки) приходят `SubagentStart`/`SubagentStop` с пустым
 * `agent_type`, а `PostModelSwitch` с `source: auto` — смена модели под генерацию заголовка и план.
 */

import { textOf } from '../work/events.js';

/** Событие хука — шум, лента его отбрасывает целиком. */
export function isHookNoise(event: Record<string, unknown>): boolean {
  const name = event['hook_event_name'];
  if (name === 'SubagentStart' || name === 'SubagentStop')
    return textOf(event['agent_type']) === null;
  if (name === 'PostModelSwitch') return event['source'] === 'auto';
  return false;
}
