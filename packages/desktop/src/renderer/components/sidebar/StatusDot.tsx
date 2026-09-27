/**
 * Обёртка над `AgentStateDot` для строк старого сайдбара (кусок 1.3 плана
 * окна, спека 4.2): точку без своей окраски (`dotColorVar`, раздел 4.9 —
 * ушёл вместе со старой палитрой `--h-*`) заменил общий значок состояния. Сам
 * файл и оба его вызывающих (`WorkList.tsx`, `SessionTree.tsx`) уходят вместе
 * со старым сайдбаром в 3.5, когда его заменят карточки, — тогда они станут
 * звать `AgentStateDot` напрямую и этот переходник будет не нужен.
 */

import type { SessionLifecycle } from '@harnas/core';
import { AgentStateDot } from '../AgentStateDot.js';
import type { DotState } from '../../lib/dot-state.js';

export interface StatusDotProps {
  state: DotState;
  /** Различает «спит»/«закрыта» у `exited` (таблица 4.2) — есть только у строки сессии. */
  lifecycle?: SessionLifecycle;
}

export function StatusDot({ state, lifecycle }: StatusDotProps): JSX.Element {
  // Не `lifecycle={lifecycle}` напрямую: под `exactOptionalPropertyTypes`
  // явный `undefined` — не то же самое, что отсутствие ключа (тот же приём,
  // что и в `Workspace.tsx#openOrFocus`).
  return <AgentStateDot state={state} {...(lifecycle !== undefined ? { lifecycle } : {})} />;
}
