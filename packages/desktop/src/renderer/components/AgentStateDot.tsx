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
 * Цвета — таблица 1.2 спеки окна 2026-09-29 (облик Organic): working — кольцо `neutral-700`, blocked —
 * MessageCircleQuestion `accent-600`, failed — CircleX `accent-700`. Idle, pending, «спит» и «закрыта» — токен
 * `--state-inactive` вместо ступеней таблицы (`neutral-400` и `neutral-500` после смены рамп держат 1.5–2.2:1), а
 * unseen (точка) и done (CircleCheck) — `--state-done` вместо `accent-2-600`. Оба токена — свои на тему:
 * светлая берёт `neutral-700` и `accent-2-700`, тёмная — `neutral-600` и `accent-2-600`; так значок держит не
 * ниже 3:1 ко всем фонам сайдбара, включая hover-заливки, где `neutral-600` и `accent-2-600` светлой опускались
 * до 2.5–3.0:1 (решение контролёра куска 2 и правки ревью; пары — `styles/tokens.test.ts`). Одна ступень у
 * четырёх состояний — форма разная: точка, кольцо, луна, тире. Приглушённые значки (закрытая строка .5,
 * done-карточка .6) — исключение: этого требует спека 1.2, а состояние там несёт и слово рядом.
 *
 * Раунд исправлений 1 (находка ревью B №3): рядом со значком не всегда есть
 * текст-дублёр (на вкладке терминала, спека 5.3, его нет вовсе) — значок
 * должен быть самодостаточен для скринридера. Внешний `span` несёт
 * `role="img"` и `aria-label` тем же словом, что даёт `stateWord`; все
 * внутренние глифы (включая кольцо `working`) помечены `aria-hidden`.
 */

import { CircleCheck, CircleX, MessageCircleQuestion, Moon } from 'lucide-react';
import type { SessionLifecycle } from '@parley/core';
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
      return <CircleCheck className={cn(ICON[size], 'text-state-done')} aria-hidden="true" />;

    case 'exited':
      if (exitedLifecycle === 'closed') {
        // Тире, не lucide-значок: «закрыта» — это отсутствие сессии, а не её состояние.
        return (
          <span className="text-state-inactive" aria-hidden="true">
            –
          </span>
        );
      }
      return <Moon className={cn(ICON[size], 'text-state-inactive')} aria-hidden="true" />;

    case 'pending':
      return (
        <span
          className={cn('block rounded-full border-2 border-state-inactive', DOT[size])}
          aria-hidden="true"
        />
      );

    case 'unseen':
      return (
        <span className={cn('block rounded-full bg-state-done', DOT[size])} aria-hidden="true" />
      );

    case 'failed':
      return <CircleX className={cn(ICON[size], 'text-accent-700')} aria-hidden="true" />;

    case 'idle':
      return (
        <span
          className={cn('block rounded-full bg-state-inactive', DOT[size])}
          aria-hidden="true"
        />
      );
  }
}
