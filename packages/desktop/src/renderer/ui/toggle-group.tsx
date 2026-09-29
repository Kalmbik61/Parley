/**
 * Группа кнопок-переключателей shadcn/ui на `@radix-ui/react-toggle-group` (спека 4.5), в облике
 * «сегмента» Organic (спека окна 2026-09-29, раздел 4): рамка divider, пилюля, опции без зазоров с
 * разделителем `border-l`, выбранная — на `--primary` (`ui/toggle.tsx`). Размер задаётся один раз на
 * группе и через контекст доходит до каждого `ToggleGroupItem`. Вариант `outline` у пунктов группы
 * не нужен: рамка одна — у группы, поэтому `variant` с группы убран.
 */

import * as React from 'react';
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import type { VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn.js';
import { toggleVariants } from './toggle.js';

const ToggleGroupContext = React.createContext<Pick<VariantProps<typeof toggleVariants>, 'size'>>({
  size: 'default',
});

export const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root> &
    Pick<VariantProps<typeof toggleVariants>, 'size'>
>(({ className, size, children, ...props }, ref) => (
  <ToggleGroupPrimitive.Root
    ref={ref}
    className={cn('inline-flex items-center overflow-hidden rounded-full border border-border', className)}
    {...props}
  >
    <ToggleGroupContext.Provider value={{ size }}>{children}</ToggleGroupContext.Provider>
  </ToggleGroupPrimitive.Root>
));
ToggleGroup.displayName = ToggleGroupPrimitive.Root.displayName;

export const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item> &
    Pick<VariantProps<typeof toggleVariants>, 'size'>
>(({ className, children, size, ...props }, ref) => {
  const context = React.useContext(ToggleGroupContext);
  return (
    <ToggleGroupPrimitive.Item
      ref={ref}
      // Обводка фокуса — внутрь: снаружи её обрежет `overflow-hidden` группы (у DS так же: `outline-offset: -2px`).
      className={cn(
        toggleVariants({ size: context.size ?? size }),
        'rounded-none border-l border-border first:border-l-0 focus-visible:-outline-offset-2',
        className,
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  );
});
ToggleGroupItem.displayName = ToggleGroupPrimitive.Item.displayName;
