/**
 * Кнопка-переключатель shadcn/ui на `@radix-ui/react-toggle` (спека 4.5). `toggleVariants`
 * переиспользует `ui/toggle-group.tsx` — один набор размеров и цветов на одиночный тумблер и на
 * группу.
 *
 * Organic (спека окна 2026-09-29, раздел 4, «сегмент»): пилюля, 13px обычным весом, padding 7×12 (высота
 * размера по умолчанию — от текста, ≈32px, как в дизайн-системе); hover — text 7 %; выбранный пункт —
 * заливка `--primary` с текстом `--primary-foreground` (светлая — accent-700, тёмная — accent), как у
 * главной кнопки: 5.7:1 / 6.5:1 по тексту и не ниже 3:1 к фону окна и карточке по самой заливке
 * (`styles/tokens.test.ts`). Прежний край `--toggle-on-edge` (раунд fix-live, D4) не нужен: он
 * подпирал заливку `--accent` 1.1–1.9:1 к фону, а заливка `--primary` признак состояния несёт сама.
 */

import * as React from 'react';
import * as TogglePrimitive from '@radix-ui/react-toggle';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn.js';

export const toggleVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-full text-[13px] transition-colors hover:bg-foreground/7 disabled:pointer-events-none disabled:opacity-[.45] data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary-hover [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline: 'border border-input bg-transparent',
      },
      size: {
        default: 'min-w-9 px-3 py-[7px]',
        sm: 'h-8 min-w-8 px-2.5',
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
