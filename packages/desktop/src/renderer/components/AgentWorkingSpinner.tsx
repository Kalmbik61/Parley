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
 *
 * Раунд исправлений 1 (находка ревью A+B №1): под `prefers-reduced-motion`
 * `styles/agent-spinner.css` останавливает вращение, и без класса
 * `motion-reduce:border-t-yellow-500` застывший прозрачный верхний край
 * (`border-t-transparent`) выглядит как разорванное кольцо. Оригинал Orca
 * прямо называет это исправленным багом (#9515: «a frozen transparent-top
 * ring reads as a broken spinner; a complete ring reads as an intentional
 * static marker») — заливаем разрыв тем же классом.
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
      // Чисто оформительский элемент — доступное имя целиком несёт внешний
      // `role="img"`/`aria-label` на `AgentStateDot` (находка ревью B №3).
      aria-hidden="true"
      className={cn(
        'agent-working-spinner block rounded-full border-2 border-yellow-500 border-t-transparent motion-reduce:border-t-yellow-500',
        className,
      )}
      style={{ animationDelay: `${delayMs}ms` }}
    />
  );
}
