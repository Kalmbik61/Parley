/**
 * Поле ввода вида «Chat» (план 2026-10-01, решение 8): textarea на 1–8 строк (растёт по тексту —
 * `field-sizing: content`, дальше прокрутка), Enter — отправить, Shift+Enter — перенос строки. Пока
 * ход идёт, кнопка — «Queue»: сообщение уйдёт в очередь CLI. Саму отправку (`pty.send`, отказы и
 * тосты) делает владелец — `ChatView`; поле лишь отдаёт текст и очищается.
 *
 * Текст — снаружи (черновик в `ui-store.ts` по сессии): переключение вида и вкладки его не теряет.
 * Поле получает фокус, когда вид появляется (`visible`), и держит его после отправки — в том числе
 * кнопкой, которая иначе забрала бы фокус себе.
 *
 * Подсказки (живая проверка 2026-10-02): `/` — команды и скиллы, `/model ` — модели, `@` — субагенты и
 * файлы; попап над полем (`SuggestionList`), ↑/↓ выбирают, Enter и Tab принимают (Enter тогда не отправляет),
 * Esc закрывает. Окно только вставляет текст — разбирает его CLI.
 *
 * Вложения: картинка из буфера (вставка без текста), файлы, брошенные на вид, и скрепка кладут в поле
 * путь файла — как терминал; Claude Code сам читает файл или картинку по пути. Ничего не отправляется.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type SyntheticEvent,
} from 'react';
import { Paperclip, Square } from 'lucide-react';
import { S } from '../../shared/strings.js';
import { Button } from '../ui/button.js';
import { pasteHasOnlyImage, pathsToInput } from '../terminal/drop.js';
import { applySuggestion, suggestionContext } from './suggestions.js';
import { SuggestionList } from './SuggestionList.js';
import { useSuggestions, type SuggestionItem, type SuggestionSource } from './use-suggestions.js';

export interface ComposerProps {
  /** Ход идёт — кнопка «Queue». */
  busy: boolean;
  /** Вид показан: поле берёт фокус. */
  visible: boolean;
  text: string;
  onTextChange: (text: string) => void;
  onSubmit: (text: string) => void;
  /** Есть — слева от «Send/Queue» кнопка «Stop» (ход идёт; живая проверка 2026-10-02). */
  onStop?: () => void;
  /** Откуда берутся подсказки: команды и скиллы, модели, файлы и субагенты. */
  source: SuggestionSource;
  /** Диалог выбора файлов (скрепка): пути выбранных, `[]` — отмена. Отказ владелец показывает тостом. */
  onPickFiles: () => Promise<string[]>;
  /** Скриншот из буфера обмена → путь сохранённого файла; `null` — нет картинки или отказ (тост у владельца). */
  onPasteImage: () => Promise<string | null>;
}

/** Что владелец может сделать с полем: вставить пути брошенных на вид файлов по каретке. */
export interface ComposerHandle {
  insertPaths: (paths: string[]) => void;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { busy, visible, text, onTextChange, onSubmit, onStop, source, onPickFiles, onPasteImage },
  ref,
): JSX.Element {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (visible) field.current?.focus();
  }, [visible]);

  // Каретка: подсказки зависят от места в тексте, а текст живёт снаружи (черновик в сторе).
  const [caretAt, setCaretAt] = useState(text.length);
  const caret = Math.min(caretAt, text.length);
  const pendingCaret = useRef<number | null>(null);
  const latestText = useRef(text);
  latestText.current = text;
  useLayoutEffect(() => {
    const target = pendingCaret.current;
    if (target === null) return;
    pendingCaret.current = null;
    field.current?.setSelectionRange(target, target);
  }, [text]);
  // Пока вставка ждёт перерисовки (`pendingCaret`), событие select от keydown несёт ещё старую каретку.
  const syncCaret = (event: SyntheticEvent<HTMLTextAreaElement>): void => {
    if (pendingCaret.current === null) setCaretAt(event.currentTarget.selectionStart);
  };
  const replaceText = (next: { text: string; caret: number }): void => {
    pendingCaret.current = next.caret;
    setCaretAt(next.caret);
    onTextChange(next.text);
    field.current?.focus();
  };

  // Подсказки: закрытие Esc действует, пока текст тот же; следующая буква открывает их снова.
  const context = suggestionContext(text, caret);
  const items = useSuggestions(source, context);
  const [selected, setSelected] = useState(0);
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const contextKey = context === null ? '' : `${context.kind}:${context.query}`;
  useEffect(() => setSelected(0), [contextKey]);
  const open = context !== null && items.length > 0 && closedFor !== text;
  const current = Math.min(selected, items.length - 1);
  const accept = (item: SuggestionItem): void => {
    if (context === null) return;
    replaceText(applySuggestion(text, caret, context, item.insert));
  };

  // Вложение — путь в тексте (как в терминале: Claude Code читает файл или картинку по пути).
  // Пути в кавычках через пробел и пробел в конце: человек дописывает вопрос сразу за ними.
  const insertPaths = (paths: string[]): void => {
    if (paths.length === 0) return;
    const now = latestText.current;
    const at = Math.min(field.current?.selectionStart ?? now.length, now.length);
    const insert = pathsToInput(paths);
    replaceText({ text: `${now.slice(0, at)}${insert}${now.slice(at)}`, caret: at + insert.length });
  };
  useImperativeHandle(ref, () => ({ insertPaths }));

  const pickFiles = (): void => {
    void onPickFiles().then(insertPaths);
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    // Текст в буфере — обычная вставка; перехватывается только картинка без текста.
    if (!pasteHasOnlyImage(event.clipboardData)) return;
    event.preventDefault();
    void onPasteImage().then((saved) => {
      if (saved !== null) insertPaths([saved]);
    });
  };

  const submit = (): void => {
    if (text.trim() === '') return;
    onSubmit(text);
    onTextChange('');
    field.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (open) {
      const item = items[current];
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setSelected((current + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        if (item === undefined) return;
        event.preventDefault();
        accept(item);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setClosedFor(text);
        return;
      }
    }
    // Enter во время набора иероглифов (IME) подтверждает слово, а не отправляет.
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    submit();
  };
  return (
    <div data-testid="chat-composer" className="relative flex shrink-0 items-end gap-2 border-t border-border px-4 pb-3 pt-2.5">
      {open ? <SuggestionList items={items} selected={current} onSelect={setSelected} onAccept={accept} /> : null}
      <Button
        type="button"
        variant="outline"
        data-testid="chat-attach"
        title={S.chat.composer.attach}
        aria-label={S.chat.composer.attach}
        onClick={pickFiles}
        className="size-[38px] shrink-0 rounded-full px-0"
      >
        <Paperclip className="size-4" aria-hidden="true" />
      </Button>
      <textarea
        ref={field}
        aria-label={S.chat.composer.label}
        aria-expanded={open}
        aria-controls={open ? 'chat-suggestions' : undefined}
        placeholder={S.chat.composer.placeholder}
        value={text}
        rows={1}
        onChange={(event) => {
          setCaretAt(event.target.selectionStart);
          onTextChange(event.target.value);
        }}
        onSelect={syncCaret}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className="box-border max-h-[180px] min-h-[38px] min-w-0 flex-1 resize-none overflow-y-auto rounded-[19px] border border-input bg-transparent px-4 py-2 text-sm leading-5 caret-ring [field-sizing:content] [overflow-wrap:anywhere] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-offset-0"
      />
      {onStop === undefined ? null : (
        <Button type="button" variant="outline" data-testid="chat-stop" title={S.chat.stopTitle} onClick={onStop}>
          <Square className="size-3" aria-hidden="true" />
          {S.chat.stop}
        </Button>
      )}
      <Button type="button" onClick={submit} disabled={text.trim() === ''} variant={busy ? 'outline' : 'default'}>
        {busy ? S.chat.composer.queue : S.chat.composer.send}
      </Button>
    </div>
  );
});
