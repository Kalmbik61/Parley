/**
 * Тултип shadcn/ui на `@radix-ui/react-tooltip`, поверх — облик Orca (спека
 * 4.5): цвета инвертированы (`bg-foreground text-background`), задержка
 * показа 400 мс вместо дефолтных 700 у Radix.
 *
 * `Tooltip` сам оборачивает себя в `TooltipProvider` — тултип работает без
 * обязательной общей обёртки в корне приложения (её всё равно можно
 * поставить снаружи: ближайший Provider просто победит).
 */

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '../lib/cn.js';

const TOOLTIP_DELAY_MS = 400;

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({
  delayDuration = TOOLTIP_DELAY_MS,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>): JSX.Element {
  return (
    <TooltipProvider delayDuration={delayDuration}>
      <TooltipPrimitive.Root delayDuration={delayDuration} {...props} />
    </TooltipProvider>
  );
}

export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 overflow-hidden rounded-md bg-foreground px-3 py-1.5 text-xs text-background animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;
