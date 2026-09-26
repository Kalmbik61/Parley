/**
 * Состояние точки сессии/работы: activity живой сессии или её жизненный цикл.
 * `dotState` и `maxDotState` перенесены из
 * `tui/src/components/activity-dot.tsx` дословно (дизайн TUI v2, 4.1). Слова
 * состояний — новые: в TUI на них не было места (там точку подписывала одна
 * буква, `stateLetter`), в окне рядом с точкой есть колонка под слово (кусок
 * 1.10 плана окна, «строка: точка, S03, ярлык, слово состояния»). Тексты
 * `blocked`/`unseen` совпадают с заголовками уведомлений («S03 ждёт ответа» /
 * «S03 закончила ход») намеренно — то же состояние, тот же текст.
 */

import type { Activity, SessionStatus } from '@harnas/core';

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

/** Слово состояния рядом с точкой в строке сайдбара. */
export const STATE_WORDS: Readonly<Record<DotState, string>> = {
  working: 'работает',
  blocked: 'ждёт ответа',
  unseen: 'закончила ход',
  idle: 'простаивает',
  pending: 'не запущена',
  exited: 'вышла',
  done: 'готово',
  failed: 'ошибка',
};

/**
 * Цвет точки по палитре (CSS-переменные темы — `theme/palettes.ts`). Роли те
 * же, что и в `tui/src/theme/roles.ts`: `warn` — жёлтый, `unseen` — синий,
 * `fail` — красный. У `done` цвета нет (точка не рисуется).
 */
export function dotColorVar(state: DotState): string | null {
  switch (state) {
    case 'blocked':
      return 'var(--h-yellow)';
    case 'unseen':
      return 'var(--h-blue)';
    case 'failed':
      return 'var(--h-red)';
    case 'working':
    case 'idle':
    case 'pending':
    case 'exited':
      return 'var(--h-muted)';
    case 'done':
      // Работа закончена отчётом — цвет ей не нужен (перенос из TUI, макеты §6).
      return null;
  }
}
