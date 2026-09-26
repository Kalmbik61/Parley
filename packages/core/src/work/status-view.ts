import type { HistoryEntry, SessionStatus, WorkSession } from './types.js';

/**
 * Прежний единый статус из двух осей карты v2 (спецификация 7.1). Нужен
 * замороженному TUI и точкам окна: они рисуют пять статусов v1, а учить их
 * осям — это новые виды, которых в заморозке нет. Итог важнее процесса: сессия,
 * сдавшая `done`, показывается готовой, жив её процесс или нет.
 */
export function displayStatus(session: Pick<WorkSession, 'lifecycle' | 'result'>): SessionStatus {
  switch (session.lifecycle) {
    case 'pending':
      return 'pending';
    case 'active':
      return session.result ?? 'active';
    case 'sleeping':
    case 'closed':
      return session.result ?? 'exited';
  }
}

/**
 * Ступень `history` в прежнем виде: уход в `sleeping` или `closed` — это
 * `exited` v1. Нужна там же, где `displayStatus`: TUI ищет запись, которой
 * сессия пришла в свой статус, и рисует ленту истории глифами статусов.
 */
export function historyStatus(entry: Pick<HistoryEntry, 'event'>): SessionStatus {
  return entry.event === 'sleeping' || entry.event === 'closed' ? 'exited' : entry.event;
}
