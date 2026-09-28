/**
 * Значок состояния сессии — таблица спеки 4.2 (девять строк: восемь значений
 * `DotState` плюс разбор `exited` на «спит»/«закрыта» через `lifecycle`).
 * Адаптация Orca `AgentStateDot.tsx`
 * (https://github.com/Kalmbik61/orca-harnas, коммит acf8e679,
 * src/renderer/src/components/AgentStateDot.tsx): своя таблица состояний
 * (`DotState` вместо `AgentDotState` Orca — по-другому делится) и без
 * встроенного тултипа — слово состояния показывает соседняя колонка строки
 * сайдбара (`lib/dot-state.ts#stateWord`, куски 1.3 и 3.3), а не сам значок.
 * Copyright (c) 2026 Lovecast Inc. Лицензия MIT — полный текст в NOTICE в
 * корне репозитория.
 *
 * Раунд исправлений 1 (находка ревью B №3): рядом со значком не всегда есть
 * текст-дублёр (на вкладке терминала, спека 5.3, его нет вовсе) — значок
 * должен быть самодостаточен для скринридера. Внешний `span` несёт
 * `role="img"` и `aria-label` тем же словом, что даёт `stateWord`; все
 * внутренние глифы (включая кольцо `working`) помечены `aria-hidden`.
 */

import { CircleCheck, MessageCircleQuestion, Moon } from 'lucide-react';
import type { SessionLifecycle } from '@harnas/core';
import { stateWord, type DotState } from '../lib/dot-state.js';
import { cn } from '../lib/cn.js';
import { AgentWorkingSpinner } from './AgentWorkingSpinner.js';

export interface AgentStateDotProps {
  state: DotState;
  /** Различает «спит» и «закрыта» у `exited` (таблица 4.2); остальным состояниям не нужен. */
  lifecycle?: SessionLifecycle;
  /** 10px / 12px (спека 4.4) — заголовок таблицы 4.2 описывает вид при «md». */
  size?: 'sm' | 'md';
  className?: string;
}

// Три вложенных размера — контейнер, точка/кольцо внутри него и значок lucide
// на весь контейнер. Пропорции — как у Orca (box 10/12, точка 6/8, значок 10/12).
const BOX: Record<'sm' | 'md', string> = { sm: 'size-2.5', md: 'size-3' };
const DOT: Record<'sm' | 'md', string> = { sm: 'size-1.5', md: 'size-2' };
const ICON: Record<'sm' | 'md', string> = { sm: 'size-2.5', md: 'size-3' };

export function AgentStateDot({
  state,
  lifecycle,
  size = 'md',
  className,
}: AgentStateDotProps): JSX.Element {
  const box = cn('inline-flex shrink-0 items-center justify-center', BOX[size], className);
  // `data-lifecycle` имеет смысл только у `exited` — у остальных состояний не выставляется.
  const effectiveLifecycle = state === 'exited' ? (lifecycle ?? 'sleeping') : undefined;
  // Для не-`exited` состояний `stateWord` игнорирует второй аргумент —
  // подставляем любое валидное значение просто чтобы удовлетворить сигнатуру.
  const ariaLabel = stateWord(state, effectiveLifecycle ?? 'active');

  return (
    <span
      className={box}
      data-state={state}
      data-lifecycle={effectiveLifecycle}
      data-testid="agent-state-dot"
      role="img"
      aria-label={ariaLabel}
    >
      {renderGlyph(state, effectiveLifecycle, size)}
    </span>
  );
}

function renderGlyph(
  state: DotState,
  exitedLifecycle: SessionLifecycle | undefined,
  size: 'sm' | 'md',
): JSX.Element {
  switch (state) {
    case 'working':
      // Кольцо .agent-working-spinner (styles/agent-spinner.css) — общую фазу
      // вращения даёт AgentWorkingSpinner (spinnerDelayMs).
      return <AgentWorkingSpinner className={DOT[size]} />;

    case 'blocked':
      return (
        <MessageCircleQuestion
          className={cn(ICON[size], 'text-agent-question')}
          aria-hidden="true"
        />
      );

    case 'done':
      return <CircleCheck className={cn(ICON[size], 'text-emerald-500')} aria-hidden="true" />;

    case 'exited':
      if (exitedLifecycle === 'closed') {
        // Тире, не lucide-значок: «закрыта» — это отсутствие сессии, а не её состояние.
        return (
          <span className="text-neutral-500/40" aria-hidden="true">
            –
          </span>
        );
      }
      return <Moon className={cn(ICON[size], 'text-neutral-500')} aria-hidden="true" />;

    case 'pending':
      return (
        <span
          className={cn('block rounded-full border-2 border-neutral-500/60', DOT[size])}
          aria-hidden="true"
        />
      );

    case 'unseen':
      return (
        <span className={cn('block rounded-full bg-emerald-500', DOT[size])} aria-hidden="true" />
      );

    case 'failed':
      return <span className={cn('block rounded-full bg-red-500', DOT[size])} aria-hidden="true" />;

    case 'idle':
      return (
        <span
          className={cn('block rounded-full bg-neutral-500/40', DOT[size])}
          aria-hidden="true"
        />
      );
  }
}
