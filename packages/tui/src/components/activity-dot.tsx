/**
 * Точка состояния сессии: глиф, цвет и мигание (дизайн TUI v2, 4.1 и 7,
 * макеты §1.4 и §6).
 *
 * Тикер мигания — один на процесс: точки подписываются на него и мигают
 * синхронно, а сам он живёт, только пока есть хотя бы одна `working` точка
 * (раздел 8.2, решение №10). Других таймеров в интерфейсе нет.
 */

import type { Activity, SessionStatus } from '@harnas/core';
import { Text } from 'ink';
import { useCallback, useSyncExternalStore, type ReactNode } from 'react';
import type { Glyphs } from '../glyphs.js';
import { theme } from '../theme/index.js';

/** Что рисует точка: activity живой сессии или её жизненный цикл (4.1). */
export type DotState = Activity | Exclude<SessionStatus, 'active'>;

/** Полсекунды на фазу: `●` 0–500 мс, `○` 500–1000 мс (макет 1.4). */
const BLINK_MS = 500;

const listeners = new Set<() => void>();
let ticker: NodeJS.Timeout | null = null;
let phaseB = false;

/** Жив ли общий тикер: проверяется тестами и ничего больше не решает. */
export function blinkTicking(): boolean {
  return ticker !== null;
}

function subscribeBlink(listener: () => void): () => void {
  listeners.add(listener);
  if (ticker === null) {
    ticker = setInterval(() => {
      phaseB = !phaseB;
      for (const notify of [...listeners]) notify();
    }, BLINK_MS);
    // Мигание не держит процесс живым: без него харнесс не завершился бы.
    ticker.unref?.();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || ticker === null) return;
    clearInterval(ticker);
    ticker = null;
    // Следующее мигание начинается с фазы A, иначе точка «моргает» при запуске.
    phaseB = false;
  };
}

const NEVER = (): (() => void) => () => {};

/**
 * Фаза мигания. `active === false` — подписки нет вовсе: тикер не должен
 * существовать из-за неподвижных точек (раздел 8.2).
 */
export function useBlink(active: boolean): boolean {
  const subscribe = useCallback(
    (listener: () => void) => (active ? subscribeBlink(listener) : NEVER()),
    [active],
  );
  return useSyncExternalStore(
    subscribe,
    () => active && phaseB,
    () => false,
  );
}

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

export function dotGlyph(state: DotState, g: Glyphs, blinked = false): string {
  switch (state) {
    case 'working':
      return blinked ? g.blink : g.active;
    case 'blocked':
    case 'unseen':
    case 'idle':
      return g.active;
    default:
      return g[state];
  }
}

/** Цвета таблицы макетов §6. Пустых пропсов не передаём — exactOptionalPropertyTypes. */
export function dotColor(state: DotState): { color?: string; dimColor?: boolean } {
  switch (state) {
    // Отклонение принято сознательно (дизайн темы TUI, 3.2): раньше здесь
    // стоял `blackBright`, роль `fg.muted` на шестнадцати цветах отдаёт `dim`.
    // Серый остаётся серым, но код всё-таки другой — единственное место, где
    // кадр шестнадцати цветов отличается от прежнего.
    case 'working':
      return theme().fg.muted;
    case 'blocked':
      return theme().status.warn;
    case 'unseen':
      return theme().status.unseen;
    case 'failed':
      return theme().status.fail;
    case 'idle':
    case 'pending':
    case 'exited':
      return theme().fg.muted;
    case 'done':
      // Работа закончена отчётом — цвет ей не нужен (макеты §6).
      return {};
  }
}

/** Ширина 18: слово заменяется буквой, и только у живых состояний (макет 1.2). */
export function stateLetter(state: DotState): string {
  switch (state) {
    case 'working':
      return 'w';
    case 'blocked':
      return 'b';
    case 'unseen':
      return 'u';
    case 'idle':
      return 'i';
    default:
      return '';
  }
}

export interface ActivityDotProps {
  state: DotState;
  g: Glyphs;
}

export function ActivityDot({ state, g }: ActivityDotProps): ReactNode {
  const blinked = useBlink(state === 'working');
  return <Text {...dotColor(state)}>{dotGlyph(state, g, blinked)}</Text>;
}
