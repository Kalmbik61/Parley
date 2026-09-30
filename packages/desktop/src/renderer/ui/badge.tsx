/**
 * Тег Organic на основе бейджа shadcn/ui, стиль new-york (спека 4.5; облик — спека окна 2026-09-29,
 * раздел 4 «Компоненты Organic»): 11px, разрядка .02em, padding 3×10, пилюля. Три вида: `accent`
 * (фон accent-100, текст accent-800) — вопрос, `accent-2` — решение, `neutral` — заметка; текст на
 * фоне — не ниже 4.5:1 в обеих темах (`styles/tokens.test.ts`).
 *
 * `neutral-sheet`, `accent-sheet`, `accent-2-sheet` — теги заметки, вопроса и решения на листе центра (лента
 * комнаты): в светлой теме `neutral-100` — это сам лист (`--sheet` = #f9f4ed), а `accent-100` и `accent-2-100` от него
 * на 1.00–1.01:1, и обычный тег слился бы с ним; там заливка — 200 своей рампы (от листа на 1.11–1.13:1, текст 800 на
 * ней не ниже 8:1). В тёмной лист `#0b0a09`, и 100 на нём видна, как на снимке handoff `dark-08`, — она и остаётся.
 * Ступени и пары держит `styles/tokens.test.ts`, читая их из этих классов.
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
      'neutral-sheet': 'bg-neutral-200 text-neutral-800 dark:bg-neutral-100',
      'accent-sheet': 'bg-accent-200 text-accent-800 dark:bg-accent-100',
      'accent-2-sheet': 'bg-accent-2-200 text-accent-2-800 dark:bg-accent-2-100',
    },
  },
  defaultVariants: { variant: 'neutral' },
});

export interface BadgeProps extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps): JSX.Element {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
