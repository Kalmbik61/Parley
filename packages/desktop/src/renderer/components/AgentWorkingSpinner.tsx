/**
 * Кольцо состояния `working` — адаптация Orca `AgentWorkingSpinner.tsx`
 * (https://github.com/Kalmbik61/orca-harnas, коммит acf8e679,
 * src/renderer/src/components/AgentWorkingSpinner.tsx). Анимация вращения —
 * тот же исходник, `styles/agent-spinner.css` (main.css:1590-1604).
 * Copyright (c) 2026 Lovecast Inc. Лицензия MIT — полный текст в NOTICE в
 * корне репозитория.
 *
 * Адаптация: Orca синхронизирует общую фазу через Web Animations API
 * (`animation.startTime = 0` в обработчике `animationstart`) — этого API нет
 * в jsdom, где рендерятся компонентные тесты окна. Тот же результат — общий
 * ноль фазы у всех колец, чтобы они не мигали вразнобой (спека 4.2) — здесь
 * даёт чистая функция `spinnerDelayMs`, подставленная в `animation-delay`
 * инлайн-стилем: она проверяется без DOM (тест 3 куска 1.2).
 */

import { useState } from 'react';
import { cn } from '../lib/cn.js';

/** Длительность `agent-spinner-rotate` (styles/agent-spinner.css) — 86400s. */
const SPINNER_PERIOD_MS = 86_400_000;

/** Задержка от общего нуля фазы: кольца, смонтированные в разное время, вращаются в такт. */
export function spinnerDelayMs(nowMs: number, periodMs: number): number {
  return -(nowMs % periodMs);
}

export interface AgentWorkingSpinnerProps {
  className?: string;
}

export function AgentWorkingSpinner({ className }: AgentWorkingSpinnerProps): JSX.Element {
  // Ленивый инициализатор — задержка считается один раз при монтировании,
  // а не на каждый рендер.
  const [delayMs] = useState(() => spinnerDelayMs(Date.now(), SPINNER_PERIOD_MS));
  return (
    <span
      className={cn(
        'agent-working-spinner block rounded-full border-2 border-yellow-500 border-t-transparent',
        className,
      )}
      style={{ animationDelay: `${delayMs}ms` }}
    />
  );
}
