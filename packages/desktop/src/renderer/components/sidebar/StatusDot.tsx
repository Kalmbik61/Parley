/**
 * Точка состояния: цвет по `dotColorVar`, мигание CSS-анимацией у `working`
 * (перенос идеи блика из `tui/src/components/activity-dot.tsx`, без общего
 * тикера — в браузере за это отвечает `animate-pulse`).
 */

import { dotColorVar, type DotState } from '../../lib/dot-state.js';

export interface StatusDotProps {
  state: DotState;
}

export function StatusDot({ state }: StatusDotProps): JSX.Element | null {
  const color = dotColorVar(state);
  // У `done` цвета нет — точка не рисуется вовсе (перенос правила из TUI).
  if (color === null) return null;

  return (
    <span
      data-state={state}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${state === 'working' ? 'animate-pulse' : ''}`}
      style={{ backgroundColor: color }}
    />
  );
}
