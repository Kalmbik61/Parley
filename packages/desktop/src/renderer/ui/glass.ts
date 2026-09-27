/**
 * «Стекло» меню/попапов — общая подложка для `dropdown-menu`, `context-menu`,
 * `popover`, `hover-card` и `select` (спека 4.5): все они — всплывающие
 * поверхности на Radix Popper с одной и той же тенью «меню» (таблица 4.4).
 *
 * Раунд исправлений 1 (находка ревью A №2): рецепт был скопирован в каждый из
 * пяти файлов отдельно и уже разошёлся — у `context-menu` пропали
 * направленные анимации выезда (`data-[side=*]:slide-in-from-*`) и
 * `transition-colors` пункта, которые есть у `dropdown-menu`. Теперь одно
 * место на все пять; ширина/отступы/переполнение — своё у каждой поверхности
 * (список пунктов против свободного содержимого попапа), поэтому в общую
 * константу не входят.
 */
export const MENU_GLASS =
  'z-50 overflow-hidden rounded-[11px] border border-black/[0.14] bg-white/[0.82] text-popover-foreground shadow-[0_12px_28px_rgba(0,0,0,0.22)] backdrop-blur-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 dark:border-white/[0.14] dark:bg-black/[0.72] dark:shadow-[0_12px_28px_rgba(0,0,0,0.40)]';

/** Пункт меню — 12/17 весом 450 (спека 4.5); общий для `dropdown-menu` и `context-menu`. */
export const MENU_ITEM =
  'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-xs leading-[17px] font-[450] outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0';
