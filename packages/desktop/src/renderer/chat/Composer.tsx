/**
 * Поле ввода вида «Chat» (план 2026-10-01, решение 8): textarea на 1–8 строк (растёт по тексту —
 * `field-sizing: content`, дальше прокрутка), Enter — отправить, Shift+Enter — перенос строки. Пока
 * ход идёт, кнопка — «Queue»: сообщение уйдёт в очередь CLI. Саму отправку (`pty.send`, отказы и
 * тосты) делает владелец — `ChatView`; поле лишь отдаёт текст и очищается.
 *
 * Текст — снаружи (черновик в `ui-store.ts` по сессии): переключение вида и вкладки его не теряет.
 * Поле получает фокус, когда вид появляется (`visible`), и держит его после отправки — в том числе
 * кнопкой, которая иначе забрала бы фокус себе.
 */

import { useEffect, useRef, type KeyboardEvent } from 'react';
import { S } from '../../shared/strings.js';
import { Button } from '../ui/button.js';

export interface ComposerProps {
  /** Ход идёт — кнопка «Queue». */
  busy: boolean;
  /** Вид показан: поле берёт фокус. */
  visible: boolean;
  text: string;
  onTextChange: (text: string) => void;
  onSubmit: (text: string) => void;
}

export function Composer({ busy, visible, text, onTextChange, onSubmit }: ComposerProps): JSX.Element {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (visible) field.current?.focus();
  }, [visible]);
  const submit = (): void => {
    if (text.trim() === '') return;
    onSubmit(text);
    onTextChange('');
    field.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter во время набора иероглифов (IME) подтверждает слово, а не отправляет.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };
  return (
    <div data-testid="chat-composer" className="flex shrink-0 items-end gap-2 border-t border-border px-4 pb-3 pt-2.5">
      <textarea
        ref={field}
        aria-label={S.chat.composer.label}
        placeholder={S.chat.composer.placeholder}
        value={text}
        rows={1}
        onChange={(event) => onTextChange(event.target.value)}
        onKeyDown={onKeyDown}
        className="box-border max-h-[180px] min-h-[38px] min-w-0 flex-1 resize-none overflow-y-auto rounded-[19px] border border-input bg-transparent px-4 py-2 text-sm leading-5 caret-ring [field-sizing:content] [overflow-wrap:anywhere] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-offset-0"
      />
      <Button type="button" onClick={submit} disabled={text.trim() === ''} variant={busy ? 'outline' : 'default'}>
        {busy ? S.chat.composer.queue : S.chat.composer.send}
      </Button>
    </div>
  );
}
