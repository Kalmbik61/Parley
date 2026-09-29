/**
 * Диалог shadcn/ui на `@radix-ui/react-dialog`, облик Organic (спека окна 2026-09-29, раздел 4
 * «Компоненты Organic»): фон `surface` (`--background`), радиус 32 (`rounded-xl`), отступ 17.6, зазор
 * 13.2, тень `--shadow-lg` (в тёмной — с тонкой рамкой из самой тени), затемнение — токен `--scrim`.
 * Заголовок — Caprasimo 20px, кнопки справа с зазором 8.8 и отступом сверху 8.8. Все диалоги окна на
 * этом примитиве, менять вид в каждом месте использования не нужно.
 *
 * Раунд исправлений 2 куска 3.5: сетка содержимого — `grid-cols-1` (`minmax(0, 1fr)`), а
 * заголовок и описание переносят длинные слова. Иначе минимальная ширина содержимого
 * (длинный путь, название в 120 символов без пробелов) распирала колонку сетки, и поля
 * с кнопками выходили за правый край диалога.
 *
 * Высота (находка живой проверки review-3.5-rr2): диалог не выше окна минус поля, заголовок
 * (`h2` Radix) и подвал (`data-dialog-footer`) не сжимаются, прочие прямые потомки — тело —
 * сжимаются и прокручиваются. Иначе New workspace (632px) в окне 800×500 уводил Cancel и Create
 * за нижний край. Правило общее: диалоги по отдельности не трогаются. Корень палитры
 * (`cmdk-root`) исключён — у него своя прокрутка списка. `-m-1 p-1` у тела: прокрутка
 * обрезает всё за краем, и без запаса обрезалось бы кольцо фокуса полей.
 */


import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { S } from '../../shared/strings.js';
import { cn } from '../lib/cn.js';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-scrim data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-[50%] top-[50%] z-50 flex w-full flex-col max-h-[calc(100dvh-2rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-(--space-3) rounded-xl bg-background p-(--space-4) shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]',
        // Тело — прямой потомок, кроме заголовка, подвала и корня палитры. Классы — буквально: Tailwind ищет их в тексте.
        '[&>:not(h2,[data-dialog-footer],[cmdk-root])]:min-h-0 [&>:not(h2,[data-dialog-footer],[cmdk-root])]:overflow-y-auto [&>:not(h2,[data-dialog-footer],[cmdk-root])]:-m-1 [&>:not(h2,[data-dialog-footer],[cmdk-root])]:p-1',
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-(--space-4) top-(--space-4) rounded-full opacity-70 transition-opacity hover:opacity-100 disabled:pointer-events-none">
        <X className="size-4" />
        <span className="sr-only">{S.common.close}</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

export function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)}
      {...props}
    />
  );
}

export function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      data-dialog-footer=""
      className={cn('mt-(--space-2) flex shrink-0 flex-col-reverse gap-(--space-2) sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('shrink-0 font-heading text-xl font-normal leading-[1.2] break-words', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground break-words', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;
