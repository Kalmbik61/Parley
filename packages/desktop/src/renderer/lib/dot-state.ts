/**
 * Состояние точки сессии/работы: activity живой сессии или её жизненный цикл.
 * `dotState` перенесён из
 * `tui/src/components/activity-dot.tsx` дословно (дизайн TUI v2, 4.1). Слово
 * состояния рядом с точкой — `stateWord` ниже (спека 4.2, кусок 1.2 плана
 * окна): в TUI на него не было места (там точку подписывала одна буква,
 * `stateLetter`).
 */

import type { Activity, SessionLifecycle, SessionStatus, WorkSession } from '@parley/core';
import { S } from '../../shared/strings.js';

/**
 * Единый статус из двух осей карты v2. Не копия `displayStatus` из
 * `core/work/status-view.ts` (рантайм core тянет Node и в песочницу окна не
 * собирается): у живой сессии итог `report` не показываем — агент сдаёт его в
 * конце каждого хода и остаётся жить, так что состояние ведёт activity. Итог
 * видят спящая/закрытая сессия и тултип строки; core-версия (бриф, MCP) другая намеренно.
 */
export function displayStatus(session: Pick<WorkSession, 'lifecycle' | 'result'>): SessionStatus {
  switch (session.lifecycle) {
    case 'pending':
      return 'pending';
    case 'active':
      return 'active';
    case 'sleeping':
    case 'closed':
      return session.result ?? 'exited';
  }
}

/** Что рисует точка: activity живой сессии или её жизненный цикл (4.1). */
export type DotState = Activity | Exclude<SessionStatus, 'active'>;

/** Состояние точки: у живой сессии его ведёт activity, у остальных — статус карты. */
export function dotState(status: SessionStatus, activity: Activity | null): DotState {
  if (status !== 'active') return status;
  // Живая сессия без выведенной activity — тусклая: так же, как после
  // перезапуска харнесса (раздел 4.1).
  return activity ?? 'idle';
}

/**
 * Слово состояния рядом со значком — колонка таблицы спеки 4.2 (кусок 1.2
 * плана окна; используют куски 1.3 и 3.3). Заменяет прежние `STATE_WORDS`
 * (тексты спеки 4.2 другие: «ждёт тебя», не «ждёт ответа», и т. д.) и
 * `dotColorVar` — код прежней палитры темы окна (раздел 4.9 спеки), который
 * ушёл в 1.3 вместе с их последними потребителями (прежние дерево сессий и
 * точка статуса сайдбара). У `exited` слово решает `lifecycle`: «закрыта» для
 * `closed`, иначе — «спит» (сессия жива, просто не выведена).
 */
export function stateWord(state: DotState, lifecycle: SessionLifecycle): string {
  switch (state) {
    case 'working':
      return S.states.working;
    case 'blocked':
      return S.states.blocked;
    case 'unseen':
      return S.states.unseen;
    case 'idle':
      return S.states.idle;
    case 'pending':
      return S.states.pending;
    case 'exited':
      return lifecycle === 'closed' ? S.states.closed : S.states.asleep;
    case 'done':
      return S.states.done;
    case 'failed':
      return S.states.failed;
  }
}
