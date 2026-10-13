// packages/desktop/src/renderer/browser/annotate/AnnotationEditor.tsx
/**
 * Адаптация Orca `src/renderer/src/components/browser-pane/annotate/pending-browser-annotation-card.tsx`
 * (stablyai/orca b1cd858, MIT). Copyright (c) 2026 Lovecast Inc.; полный текст лицензии — в NOTICE в корне репозитория.
 *
 * Редактор комментария метки (спека браузера 4.7) — в окне, а не в странице: Radix-поповер у точки метки над
 * `<webview>`. Как у Orca: якорь — невидимая точка в слое страницы, поповер рисуется в этом слое (`portalContainer`),
 * держится в его пределах (`collisionBoundary`) и у края переворачивается вверх. Изменено: без «намерения» (спека
 * 2.13); строки — `S.browser.annotate`; Enter сохраняет (спека 4.7; у Orca — ⌘Enter), ⇧Enter — перенос; Delete
 * убирает метку; Esc отменяет новую метку (у готовой — закрывает без изменений) и до вкладки не доходит: там Esc
 * выключил бы режим. `open` без `onOpenChange`: клик мимо — в том числе в страницу, куда уходит фокус, — поповер не
 * закрывает, текст человека не теряется. Вместо `ImeTextarea` Orca — `nativeEvent.isComposing`.
 */

import { CONTEXT_LIMITS } from '../../../shared/context-markdown.js';
import { S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { Popover, PopoverAnchor, PopoverContent } from '../../ui/popover.js';

export interface AnnotationEditorProps {
  n: number;
  draft: string;
  /** Точка метки в пикселях слоя страницы (`BrowserSurface#anchorAt`): у неё якорь поповера. */
  anchor: { left: number; top: number };
  /** Слой страницы: поповер рисуется в нём и не выходит за его края; `null` — `document.body`. */
  container: HTMLElement | null;
  onDraft(text: string): void;
  onSave(): void;
  /** Новая метка — отмена, готовая — удаление. */
  onDelete(): void;
  onCancel(): void;
}

export function AnnotationEditor({ n, draft, anchor, container, onDraft, onSave, onDelete, onCancel }: AnnotationEditorProps): JSX.Element {
  const label = S.browser.annotate.comment(n);
  return (
    <Popover open>
      <PopoverAnchor asChild>
        <span data-testid="annotation-anchor" className="pointer-events-none absolute size-px" style={{ left: anchor.left, top: anchor.top }} />
      </PopoverAnchor>
      <PopoverContent
        data-testid="annotation-editor"
        data-annotation={n}
        aria-label={label}
        side="bottom"
        align="start"
        sideOffset={8}
        collisionBoundary={container ?? []}
        collisionPadding={8}
        portalContainer={container}
        className="z-20 flex w-72 max-w-[calc(var(--radix-popover-content-available-width)-1rem)] flex-col gap-2 p-2.5 text-xs"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }}
      >
        <textarea
          aria-label={label}
          value={draft}
          maxLength={CONTEXT_LIMITS.comment}
          rows={3}
          autoFocus
          placeholder={S.browser.annotate.placeholder}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter во время набора иероглифов (IME) подтверждает слово, а не сохраняет.
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            onSave();
          }}
          className="min-h-16 w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
        />
        <div className="flex items-center justify-end gap-1.5">
          <Button type="button" variant="outline" size="xs" onClick={onDelete}>
            {S.browser.annotate.delete}
          </Button>
          <Button type="button" size="xs" onClick={onSave}>
            {S.browser.annotate.save}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
