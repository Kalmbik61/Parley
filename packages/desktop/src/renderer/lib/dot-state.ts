/**
 * Состояние точки сессии/работы: activity живой сессии или её жизненный цикл.
 * `dotState` и `maxDotState` перенесены из
 * `tui/src/components/activity-dot.tsx` дословно (дизайн TUI v2, 4.1). Слово
 * состояния рядом с точкой — `stateWord` ниже (спека 4.2, кусок 1.2 плана
 * окна): в TUI на него не было места (там точку подписывала одна буква,
 * `stateLetter`).
 */

import type { Activity, SessionLifecycle, SessionStatus, WorkSession } from '@harnas/core';

/**
 * Прежний единый статус из двух осей карты v2 — копия `displayStatus` из
 * `core/work/status-view.ts`. Рендерер берёт из core только типы: рантайм core
 * тянет Node и в песочницу окна не собирается. Правка одной требует правки другой.
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

/** Что рисует точка: activity живой сессии или её жизненный цикл (4.1). */
export type DotState = Activity | Exclude<SessionStatus, 'active'>;

/** Состояние точки: у живой сессии его ведёт activity, у остальных — статус карты. */
export function dotState(status: SessionStatus, activity: Activity | null): DotState {
  if (status !== 'active') return status;
  // Живая сессия без выведенной activity — тусклая: так же, как после
  // перезапуска харнесса (раздел 4.1).
  return activity ?? 'idle';
}

/** Порядок важности: точка работы — максимум по её сессиям (раздел 4.1). */
const PRIORITY: readonly DotState[] = [
  'blocked',
  'working',
  'unseen',
  'failed',
  'idle',
  'pending',
  'exited',
  'done',
];

/** Максимум по сессиям работы; `null` — сессий нет и точка не рисуется (решение №6). */
export function maxDotState(states: readonly DotState[]): DotState | null {
  let best: DotState | null = null;
  let bestRank = PRIORITY.length;
  for (const state of states) {
    const rank = PRIORITY.indexOf(state);
    if (rank < bestRank) {
      best = state;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Слово состояния рядом со значком — колонка таблицы спеки 4.2 (кусок 1.2
 * плана окна; используют куски 1.3 и 3.3). Заменяет прежние `STATE_WORDS`
 * (тексты спеки 4.2 другие: «ждёт тебя», не «ждёт ответа», и т. д.) и
 * `dotColorVar` — код прежней палитры темы окна (раздел 4.9 спеки), который
 * ушёл в 1.3 вместе с их последними потребителями (`SessionTree.tsx`,
 * `StatusDot.tsx`). У `exited` слово решает `lifecycle`: «закрыта» для
 * `closed`, иначе — «спит» (сессия жива, просто не выведена).
 */
export function stateWord(state: DotState, lifecycle: SessionLifecycle): string {
  switch (state) {
    case 'working':
      return 'работает';
    case 'blocked':
      return 'ждёт тебя';
    case 'unseen':
      return 'закончил · не просмотрено';
    case 'idle':
      return 'простаивает';
    case 'pending':
      return 'ожидает запуска';
    case 'exited':
      return lifecycle === 'closed' ? 'закрыта' : 'спит';
    case 'done':
      return 'готово';
    case 'failed':
      return 'сбой';
  }
}
