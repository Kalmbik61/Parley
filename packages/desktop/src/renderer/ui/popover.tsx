/**
 * Всплывающая панель shadcn/ui на `@radix-ui/react-popover`, поверх — облик
 * Orca «стекло» (спека 4.5): полупрозрачная подложка, `backdrop-blur-2xl`,
 * тонкая рамка, радиус 11px, тень «меню» (таблица 4.4).
 */

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '../lib/cn.js';
import { MENU_GLASS } from './glass.js';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'center', sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(MENU_GLASS, 'w-72 p-4 outline-none', className)}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;
