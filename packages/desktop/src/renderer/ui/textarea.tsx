/**
 * Многострочное поле ввода Organic на основе shadcn/ui (спека 4.5): то же поле, что `Input`, но радиус 16
 * и высота от 90px (спека окна 2026-09-29, раздел 4).
 */

import * as React from 'react';
import { cn } from '../lib/cn.js';

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      className={cn(
        'flex min-h-[90px] w-full resize-y rounded-md border border-input bg-background px-[14px] py-[6px] text-sm caret-ring transition-colors placeholder:text-muted-foreground hover:border-foreground/45 focus-visible:border-ring focus-visible:outline-offset-0 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';
