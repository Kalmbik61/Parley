import type { SessionStatus, WorkSession } from './types.js';

/**
 * Прежний единый статус из двух осей карты v2 (спецификация 7.1). Нужен
 * брифу и инструментам MCP: они называют агенту пять статусов v1. Итог важнее
 * процесса: сессия, сдавшая `done`, показывается готовой, жив её процесс или нет.
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
