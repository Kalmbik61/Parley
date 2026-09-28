/**
 * Кнопка-переключатель shadcn/ui на `@radix-ui/react-toggle` (спека 4.5).
 * `toggleVariants` переиспользует `ui/toggle-group.tsx` — один набор размеров
 * и цветов на одиночный тумблер и на группу.
 *
 * Выбранный пункт — заливка `--accent` и край `--toggle-on-edge` (inset-кольцо 1px): одна заливка
 * к фону 1.1–1.9:1, ниже 3:1 WCAG 1.4.11 (раунд fix-live, D4). Кольцо inset — чтобы край не
 * обрезали панели с `overflow` и не сдвигалась раскладка; hover края не даёт.
 */

import * as React from 'react';
import * as TogglePrimitive from '@radix-ui/react-toggle';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn.js';

export const toggleVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors hover:bg-muted hover:text-muted-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground data-[state=on]:ring-1 data-[state=on]:ring-inset data-[state=on]:ring-toggle-on-edge [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline:
          'border border-input bg-transparent shadow-sm hover:bg-accent hover:text-accent-foreground',
      },
      size: {
        default: 'h-9 min-w-9 px-2',
        sm: 'h-8 min-w-8 px-1.5',
        xs: 'h-6 min-w-6 px-1',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export const Toggle = React.forwardRef<
  React.ElementRef<typeof TogglePrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>
>(({ className, variant, size, ...props }, ref) => (
  <TogglePrimitive.Root
    ref={ref}
    className={cn(toggleVariants({ variant, size, className }))}
    {...props}
  />
));
Toggle.displayName = TogglePrimitive.Root.displayName;
