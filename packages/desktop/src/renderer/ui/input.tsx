/**
 * Поле ввода Organic на основе shadcn/ui (спека 4.5; облик — спека окна 2026-09-29, раздел 4):
 * пилюля 36px, фон `surface` (`--background`), рамка divider, padding 6×14, 14px; hover — рамка
 * text 45 %, фокус — рамка accent (`--ring`) и её обводка из `base.css` без смещения, caret accent.
 */

import * as React from 'react';
import { cn } from '../lib/cn.js';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        'flex h-9 w-full rounded-full border border-input bg-background px-[14px] py-[6px] text-sm caret-ring transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground hover:border-foreground/45 focus-visible:border-ring focus-visible:outline-offset-0 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
