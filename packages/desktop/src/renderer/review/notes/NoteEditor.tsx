/**
 * Поле заметки (кусок 8.4b, спека 11.4): под строкой диффа — view zone Monaco, в одной колонке —
 * полоса старой стороны. ⌘Enter сохраняет (1–4000 символов), Esc отменяет. Сохранение агенту
 * ничего не шлёт: отправка — только кнопкой «Send» (рамка 15.1).
 *
 * Клавиши поля дальше него не идут: поле живёт внутри DOM редактора, а `StandaloneKeybindingService`
 * Monaco слушает keydown на своём корне — иначе ⌘F или ⌘⇧A поля доставались бы редактору. Слушатель
 * поэтому родной, на самом поле: React 18 разбирает события на корне приложения — позже Monaco.
 * Обработчик окна (6.1a) — в capture на `window`, его это не касается.
 */

import { useEffect, useRef, useState } from 'react';
import { NOTES_LIMITS } from '../../../shared/notes-types.js';
import { S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';

export interface NoteEditorProps {
  initial: string;
  onSave(body: string): void;
  onCancel(): void;
}

/** Текст из одних пробелов агенту ничего не скажет — как пустой. */
function valid(body: string): boolean {
  return body.trim().length > 0 && body.length <= NOTES_LIMITS.body;
}

export function NoteEditor({ initial, onSave, onCancel }: NoteEditorProps): JSX.Element {
  const [body, setBody] = useState(initial);
  const field = useRef<HTMLTextAreaElement>(null);
  const save = (): void => {
    if (valid(body)) onSave(body);
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const node = field.current;
    if (node === null) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        saveRef.current();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelRef.current();
      }
    };
    node.addEventListener('keydown', onKeyDown);
    // Поле открывает нажатие человека («+», ⌘⇧A, «Edit») — фокус сразу в нём. Не `autoFocus`: тот
    // срабатывает до эффектов родителя, а view zone вставляет узел поля в DOM редактора в своём
    // эффекте и показывает его (`display: none` → `block`) только на следующем кадре Monaco.
    node.focus();
    let frame = 0;
    let tries = 0;
    const retry = (): void => {
      if (document.activeElement === node || tries >= 3) return;
      tries += 1;
      node.focus();
      frame = requestAnimationFrame(retry);
    };
    frame = requestAnimationFrame(retry);
    return () => {
      cancelAnimationFrame(frame);
      node.removeEventListener('keydown', onKeyDown);
    };
  }, []);
  return (
    <div data-testid="note-editor" className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-card p-2 text-xs shadow-sm">
      <textarea
        ref={field}
        value={body}
        maxLength={NOTES_LIMITS.body}
        placeholder={S.notes.placeholder}
        rows={3}
        className="min-h-14 w-full min-w-0 resize-y rounded border border-input bg-background px-2 py-1 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          {S.common.cancel}
        </Button>
        <Button type="button" size="xs" disabled={!valid(body)} onClick={save}>
          {S.files.save}
        </Button>
      </div>
    </div>
  );
}
