/**
 * Кнопка Organic на основе shadcn/ui, стиль new-york (спека 4.5; облик — спека окна 2026-09-29,
 * раздел 4 «Компоненты Organic»): пилюля, Caprasimo 14px/1.2, gap 6, рамка 1px прозрачная у всех
 * вариантов — размер от варианта не зависит. Высоты прежние — 36/32/24px, чтобы раскладка не
 * сдвигалась. Тени нет. Фокус с клавиатуры — общая обводка из `base.css`. React 18 — `forwardRef`,
 * не проп `ref` React 19 (сквозное ограничение плана).
 */

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn.js';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full border border-transparent font-heading text-sm font-normal leading-[1.2] transition-colors disabled:pointer-events-none disabled:opacity-[.45] [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // Главная: фон --primary — светлая accent-700 (текст `bg` на accent давал 3.0:1), тёмная
        // accent (решение 1 спеки); hover и active — свои токены обеих тем.
        default: 'bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active',
        // Текст — `--destructive-foreground` (= `bg`): 5.7:1 в светлой, 9.4:1 в тёмной. Белый на
        // заливке accent-700 тёмной темы (#eea373) давал 2.1:1, отсюда прежняя подмена
        // `dark:bg-destructive/60` больше не нужна.
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        // Secondary Organic: рамка divider, hover text 7 %, active text 14 %.
        outline: 'border-border bg-transparent hover:bg-foreground/7 active:bg-foreground/14',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground active:bg-foreground/14',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-[15.84px]',
        sm: 'h-8 px-(--space-3) text-xs',
        xs: 'h-6 px-(--space-2) text-xs',
        'icon-xs': 'h-6 w-6',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
