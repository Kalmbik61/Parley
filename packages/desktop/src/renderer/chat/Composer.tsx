/**
 * Поле ввода вида «Chat» (план 2026-10-01, решение 8): textarea на 1–8 строк (растёт по тексту —
 * `field-sizing: content`, дальше прокрутка), Enter — отправить, Shift+Enter — перенос строки. Пока
 * ход идёт, кнопка — «Queue»: сообщение уйдёт в очередь CLI. Саму отправку (`pty.send`, отказы и
 * тосты) делает владелец — `ChatView`; поле лишь отдаёт набранное (текст и пути вложений), а очищает его
 * владелец — и он же возвращает набранное, если хост ничего не вставил.
 *
 * Текст и вложения — снаружи (черновик и список путей в `ui-store.ts` по сессии): переключение вида и
 * вкладки их не теряет. Поле получает фокус, когда вид появляется (`visible`), и держит его после
 * отправки — в том числе кнопкой, которая иначе забрала бы фокус себе.
 *
 * Подсказки (живая проверка 2026-10-02): `/` — команды и скиллы, `/model ` — модели, `@` — субагенты и
 * файлы; попап над полем (`SuggestionList`), ↑/↓ выбирают, Enter и Tab принимают (Enter тогда не отправляет),
 * Esc закрывает. Окно только вставляет текст — разбирает его CLI.
 *
 * Вложения: картинка из буфера (вставка без текста), файлы, брошенные на вид (их кладёт в стор владелец), и
 * скрепка в текст поля не попадают — это чипы над ним: у картинки миниатюра, у файла значок и имя,
 * крестик убирает. При отправке к тексту дописываются упоминания Claude Code `@"путь"` (`attachments.ts`),
 * и CLI сам прикладывает файл. Одни вложения без текста тоже можно отправить. Ничего не отправляется само.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type SyntheticEvent,
} from 'react';
import { Paperclip, Square } from 'lucide-react';
import type { ParleyBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { Button } from '../ui/button.js';
import { pasteHasOnlyImage } from '../terminal/drop.js';
import { addAttachments } from './attachments.js';
import { AttachmentChip } from './AttachmentChip.js';
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
  /** Вложения над полем — пути файлов; при отправке уходят упоминаниями после текста. */
  attachments: readonly string[];
  onAttachmentsChange: (next: readonly string[]) => void;
  /** Мост окна: по нему чипы берут миниатюры картинок. */
  bridge: ParleyBridge;
  /**
   * Набранное как есть — текст и пути вложений. Сборку «текст + упоминания» (`composePrompt`), очистку поля и вложений
   * и их возврат при отказе отправки делает владелец: поле само ничего не стирает.
   */
  onSubmit: (text: string, attachments: readonly string[]) => void;
  /** Есть — слева от «Send/Queue» кнопка «Stop» (ход идёт; живая проверка 2026-10-02). */
  onStop?: () => void;
  /** Откуда берутся подсказки: команды и скиллы, модели, файлы и субагенты. */
  source: SuggestionSource;
  /** Диалог выбора файлов (скрепка): пути выбранных, `[]` — отмена. Отказ владелец показывает тостом. */
  onPickFiles: () => Promise<string[]>;
  /** Скриншот из буфера обмена → путь сохранённого файла; `null` — нет картинки или отказ (тост у владельца). */
  onPasteImage: () => Promise<string | null>;
}

export function Composer({
  busy,
  visible,
  text,
  onTextChange,
  attachments,
  onAttachmentsChange,
  bridge,
  onSubmit,
  onStop,
  source,
  onPickFiles,
  onPasteImage,
}: ComposerProps): JSX.Element {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (visible) field.current?.focus();
  }, [visible]);

  // Каретка: подсказки зависят от места в тексте, а текст живёт снаружи (черновик в сторе).
  const [caretAt, setCaretAt] = useState(text.length);
  const caret = Math.min(caretAt, text.length);
  const pendingCaret = useRef<number | null>(null);
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

  // Вложение — чип над полем, а не текст: путь уходит упоминанием при отправке (`composePrompt`). Ответы
  // IPC (скрепка, скриншот) приходят позже отрисовки, поэтому и список — через ссылку на свежий.
  const latestAttachments = useRef(attachments);
  latestAttachments.current = attachments;
  const attach = (paths: readonly string[]): void => {
    onAttachmentsChange(addAttachments(latestAttachments.current, paths));
  };
  const detach = (path: string): void => {
    onAttachmentsChange(attachments.filter((item) => item !== path));
    field.current?.focus();
  };
  // Новое вложение — скрепка, скриншот или бросок на вид, который кладёт владелец, — возвращает фокус в поле:
  // вопрос дописывают сразу.
  const attachedCount = useRef(attachments.length);
  useEffect(() => {
    if (attachments.length > attachedCount.current) field.current?.focus();
    attachedCount.current = attachments.length;
  }, [attachments.length]);

  const pickFiles = (): void => {
    void onPickFiles().then(attach);
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    // Текст в буфере — обычная вставка; перехватывается только картинка без текста.
    if (!pasteHasOnlyImage(event.clipboardData)) return;
    event.preventDefault();
    void onPasteImage().then((saved) => {
      if (saved !== null) attach([saved]);
    });
  };

  const canSend = text.trim() !== '' || attachments.length > 0;
  const submit = (): void => {
    if (!canSend) return;
    onSubmit(text, attachments);
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
    <div data-testid="chat-composer" className="relative flex shrink-0 flex-col gap-2 border-t border-border px-4 pb-3 pt-2.5">
      {open ? <SuggestionList items={items} selected={current} onSelect={setSelected} onAccept={accept} /> : null}
      {attachments.length === 0 ? null : (
        // Предел высоты: десятки брошенных файлов не должны вытеснить ленту — лишние прокручиваются.
        <div data-testid="chat-attachments" className="flex max-h-[124px] flex-wrap items-center gap-2 overflow-y-auto">
          {attachments.map((path) => (
            <AttachmentChip key={path} path={path} bridge={bridge} size="composer" onRemove={() => detach(path)} />
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
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
        <Button type="button" onClick={submit} disabled={!canSend} variant={busy ? 'outline' : 'default'}>
          {busy ? S.chat.composer.queue : S.chat.composer.send}
        </Button>
      </div>
    </div>
  );
}
