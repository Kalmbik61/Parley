// packages/desktop/src/renderer/browser/annotate/AnnotationTray.tsx
/**
 * Адаптация Orca `src/renderer/src/components/browser-pane/annotate/browser-page-annotation-tray.tsx`
 * (stablyai/orca b1cd858, MIT). Copyright (c) 2026 Lovecast Inc.; полный текст лицензии — в NOTICE в корне репозитория.
 *
 * Лоток аннотаций (спека браузера 4.7) — внизу справа вкладки. Каркас — как у Orca: карточка со списком, у пункта
 * номер-кружок, цель и комментарий, кнопки правки и удаления проступают по наведению и фокусу. Изменено:
 * - «Send» с отправкой агенту и «Copy» в буфер обмена убраны — ничего не уходит само; пачку кладёт «Add to chat» внизу,
 *   рядом с Clear;
 * - шапка сворачивает лоток в «N annotations»; цель — `button.save` или `Region 308 × 20`, комментарий — одной
 *   строкой, пропавший элемент — «element gone»;
 * - правка — в редакторе у метки (тот же, что по клику на метку, спека 4.7), а не в строке лотка; без «намерения»;
 * - строки — `S.browser.annotate`; вариант `can-hover:` (его у нас нет) заменён на `group-hover`;
 * - высота — `min(100% − 1.5rem, max(45%, 8.5rem))`, а не 45 % поля: в низком поле (800×500 с панелью DevTools поле около
 *   200 px) 45 % оставляли списку 12 px без единой строки, а ниже ~185 px кнопки внизу уходили за край карточки; 8.5rem —
 *   шапка, одна строка и кнопки.
 */

import { ChevronDown, ChevronUp, MessageSquarePlus, Pencil, Trash2 } from 'lucide-react';
import type { AnnotationTarget } from '../../../shared/browser-types.js';
import { elementLabel } from '../../../shared/context-markdown.js';
import { S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import type { AnnotationItem } from './store.js';

export function annotationTargetText(target: AnnotationTarget): string {
  return target.kind === 'element'
    ? elementLabel(target.selector)
    : S.browser.annotate.region(Math.round(target.rect.width), Math.round(target.rect.height));
}

export interface AnnotationTrayProps {
  items: readonly AnnotationItem[];
  collapsed: boolean;
  /** Идёт «Add to chat»: кнопки неактивны. */
  busy: boolean;
  onToggle(): void;
  onEdit(n: number): void;
  onDelete(n: number): void;
  onClear(): void;
  onAddToChat(): void;
}

export function AnnotationTray({ items, collapsed, busy, onToggle, onEdit, onDelete, onClear, onAddToChat }: AnnotationTrayProps): JSX.Element {
  const title = S.browser.annotate.tray(items.length);
  return (
    <div
      data-testid="annotation-tray"
      className="absolute bottom-3 right-3 z-10 flex max-h-[min(calc(100%-1.5rem),max(45%,8.5rem))] w-[min(20rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)]"
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        title={collapsed ? S.browser.annotate.expand : S.browser.annotate.collapse}
        onClick={onToggle}
        className="flex h-9 shrink-0 items-center gap-2 px-3 text-sm font-medium"
      >
        <MessageSquarePlus className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left">{title}</span>
        {collapsed ? <ChevronUp className="size-3.5 shrink-0" aria-hidden="true" /> : <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />}
      </button>
      {collapsed ? null : (
        <>
          <ol className="scrollbar-sleek min-h-0 flex-1 overflow-auto border-t border-border p-1.5">
            {items.map((item) => {
              const target = annotationTargetText(item.target);
              return (
                <li
                  // Ключ метки уникален лишь в пределах документа, а в лотке есть пункты нескольких: строка — по поколению и ключу.
                  key={`${item.generation}:${item.key}`}
                  data-annotation={item.n}
                  className="group flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent focus-within:bg-accent"
                >
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-amber-500 text-[10px] font-semibold text-white">{item.n}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[11px] text-foreground" title={target}>
                      {target}
                    </div>
                    <div className="truncate text-muted-foreground" title={item.comment}>
                      {item.comment === '' ? S.browser.annotate.noComment : item.comment}
                    </div>
                  </div>
                  {item.gone ? <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">{S.browser.annotate.gone}</span> : null}
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <Button type="button" variant="ghost" size="icon-xs" aria-label={S.browser.annotate.edit(item.n)} title={S.browser.annotate.edit(item.n)} onClick={() => onEdit(item.n)}>
                      <Pencil className="size-3" aria-hidden="true" />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-xs" aria-label={S.browser.annotate.remove(item.n)} title={S.browser.annotate.remove(item.n)} onClick={() => onDelete(item.n)}>
                      <Trash2 className="size-3" aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="flex shrink-0 items-center justify-end gap-1.5 border-t border-border px-3 py-2">
            <Button type="button" variant="outline" size="xs" disabled={busy} onClick={onClear}>
              {S.browser.annotate.clear}
            </Button>
            <Button type="button" size="xs" disabled={busy} onClick={onAddToChat}>
              {S.browser.annotate.addToChat}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
