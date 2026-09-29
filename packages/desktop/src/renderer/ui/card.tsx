/**
 * Карточка Organic (спека окна 2026-09-29, раздел 4 «Компоненты Organic», классы `.card`,
 * `.card-kicker` и `.card-title` дизайн-системы): фон `surface` (`--background`), радиус 32, отступ 13.2,
 * зазор 8.8. Kicker — 10px капсом с разрядкой .1em; заголовок — Caprasimo 17px/1.2, в пустых
 * состояниях 20px (`className="text-xl"`). Kicker по умолчанию accent-700 — читается в обеих темах
 * (6.2:1 на листе светлой); у видов «Asleep» и «Closed» он neutral-700 — цвет передаётся классом.
 * Не карточка работы сайдбара и не `bg-card` (тот — активная карточка на neutral-100).
 */

import * as React from 'react';
import { cn } from '../lib/cn.js';

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex flex-col gap-(--space-2) rounded-xl bg-background p-(--space-3)', className)}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

export const CardKicker = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('text-[10px] uppercase tracking-[0.1em] text-accent-700', className)} {...props} />
  ),
);
CardKicker.displayName = 'CardKicker';

export const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('font-heading text-[17px] leading-[1.2]', className)} {...props} />
  ),
);
CardTitle.displayName = 'CardTitle';
