/**
 * Тег Organic на основе бейджа shadcn/ui, стиль new-york (спека 4.5; облик — спека окна 2026-09-29,
 * раздел 4 «Компоненты Organic»): 11px, разрядка .02em, padding 3×10, пилюля. Три вида: `accent`
 * (фон accent-100, текст accent-800) — вопрос, `accent-2` — решение, `neutral` — заметка; текст на
 * фоне — не ниже 4.5:1 в обеих темах (`styles/tokens.test.ts`).
 */

import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn.js';

const badgeVariants = cva('inline-flex items-center rounded-full px-2.5 py-[3px] text-[11px] tracking-[0.02em]', {
  variants: {
    variant: {
      accent: 'bg-accent-100 text-accent-800',
      'accent-2': 'bg-accent-2-100 text-accent-2-800',
      neutral: 'bg-neutral-100 text-neutral-800',
    },
  },
  defaultVariants: { variant: 'neutral' },
});

export interface BadgeProps extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps): JSX.Element {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
