/**
 * Тултип shadcn/ui на `@radix-ui/react-tooltip`, поверх — облик Orca (спека
 * 4.5): цвета инвертированы (`bg-foreground text-background`), задержка
 * показа 400 мс вместо дефолтных 700 у Radix.
 *
 * Раунд исправлений 1 (находка ревью B №4): `Tooltip` — голый `Root`, как в
 * эталонном shadcn. Прежняя версия заворачивала каждый `Tooltip` в свой
 * `TooltipProvider` — из-за этого Radix терял общий `skipDelayDuration`
 * между разными тултипами (после закрытия одного наведение на другой снова
 * ждало полную задержку, а не показывалось мгновенно). Один `TooltipProvider`
 * монтируется один раз в `renderer/main.tsx` вокруг `<App />`.
 */

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '../lib/cn.js';

export const TOOLTIP_DELAY_MS = 400;

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({
  delayDuration = TOOLTIP_DELAY_MS,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>): JSX.Element {
  return <TooltipPrimitive.Root delayDuration={delayDuration} {...props} />;
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
