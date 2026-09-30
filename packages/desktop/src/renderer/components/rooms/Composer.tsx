/**
 * Поле ввода комнаты (спека окна 2026-09-29, 1.3, 2.2, 2.3): `contentEditable` с упоминаниями `@`.
 * Подпись над полем — `To everyone` или `To S02, S03` по чипам; Enter отправляет, Shift+Enter —
 * перенос, пустое не уходит, вставка — только текст. Адресаты — упомянутые сессии; без упоминаний
 * `to: []`, то есть всем (2.2). Текст уходит с токенами `@s02`.
 *
 * Черновик — на комнату (`draftKey`), в сторе окна (`store/ui.ts#composerDrafts`): тело вкладки при
 * смене вкладки размонтируется, а текст должен пережить и смену вкладок, и смену работ. Черновик —
 * текст с токенами, а не разметка поля: назад он собирается через DOM (`fillEditor`), и чужая
 * разметка (например, из перетащенного в поле фрагмента страницы) в стор не попадает.
 *
 * Поле ведёт браузер, компонент читает его после каждого события (`refresh`) и правит только
 * через `mention-editor.ts`. Условия меню, фильтр и токены — `mention.ts`.
 *
 * Вставка и перетаскивание берут только `text/plain`: выделение из ленты приносит HTML с `data-mention`, а
 * читатель поля считает чипом любой такой узел; чипы рождает только меню упоминаний.
 *
 * Фокус — контур `--ring` 2px с отступом 2px: правило `:focus-visible` слоя base (`styles/base.css`,
 * спека 4), поле его не перекрывает; каретка цвета ring. Контур и при клике мышью — как у прочих полей окна:
 * у текстовых полей `:focus-visible` срабатывает всегда.
 */

import { useCallback, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { S } from '../../../shared/strings.js';
import { sessionTag } from '../../lib/participant.js';
import { useUiStore } from '../../store/ui.js';
import { Button } from '../../ui/button.js';
import { MentionMenu } from './MentionMenu.js';
import { filterMentions } from './mention.js';
import {
  fillEditor,
  insertDroppedText,
  insertLineBreak,
  insertMention,
  insertPlainText,
  isBlank,
  mentionContext,
  readEditor,
  removeAdjacentChip,
  type MentionContext,
} from './mention-editor.js';

/** Участник комнаты, которого можно упомянуть: живая сессия. */
export interface ComposerMember {
  id: string;
  /** `S02 бэкенд` — подпись пункта меню и чипа. */
  label: string;
  /** Ярлык без номера — для фильтра меню. */
  rawLabel: string;
  provider: string;
  providerName: string;
  /** Модель сессии из живых метрик (`Opus 5.5`); `null` — неизвестна. Мета пункта меню и фильтр. */
  model: string | null;
  /** Слово состояния: `idle`, `working`… */
  word: string;
  /** Ведущий комнаты: в меню у него `★`, как в ленте участников. */
  lead: boolean;
}

export interface ComposerSubmission {
  /** Упомянутые сессии; пусто — «всем участникам» (`to: []`). */
  to: string[];
  text: string;
}

export interface ComposerProps {
  members: readonly ComposerMember[];
  /** Ключ черновика — `roomKey(workKey, roomId)` (`lib/room-view.ts`). Другая комната — другой ключ и заново смонтированное поле. */
  draftKey: string;
  /**
   * Отправка. Отказ (промис отклонён) возвращает текст в поле, если оно ещё пусто: письмо не должно
   * пропасть вместе с ошибкой, которую показывает вызывающий.
   */
  onSend: (submission: ComposerSubmission) => Promise<void> | void;
}

interface MenuState {
  context: MentionContext;
  selected: number;
  /** Выбор сдвинули клавиши или новый запрос, а не мышь: пункт надо показать в видимой части списка. */
  reveal: boolean;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

export function Composer({ members, draftKey, onSend }: ComposerProps): JSX.Element {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [blank, setBlank] = useState(true);
  const [to, setTo] = useState<string[]>([]);
  const [menu, setMenu] = useState<MenuState | null>(null);
  /**
   * `@запрос`, закрытый Esc: пока курсор стоит в нём, меню не возвращается (иначе `keyup` того же
   * Esc открыл бы его снова). Забывается, когда `@запроса` перед курсором больше нет.
   */
  const dismissedRef = useRef<{ node: Text; start: number } | null>(null);
  const membersRef = useRef(members);
  membersRef.current = members;

  const chipLabel = useCallback((sessionId: string): string | null => {
    const member = membersRef.current.find((candidate) => candidate.id === sessionId);
    return member === undefined ? null : `@${member.label}`;
  }, []);

  /** Прочитать поле: подпись, плейсхолдер, черновик в стор, меню по положению курсора. */
  const refresh = useCallback((): void => {
    const editor = editorRef.current;
    if (editor === null) return;
    const content = readEditor(editor);
    const empty = isBlank(content);
    setBlank(empty);
    setTo((previous) => (sameList(previous, content.to) ? previous : content.to));
    useUiStore.getState().setComposerDraft(draftKey, empty ? '' : content.text);

    let context = mentionContext(editor);
    const dismissed = dismissedRef.current;
    if (context === null) dismissedRef.current = null;
    else if (dismissed !== null && dismissed.node === context.node && dismissed.start === context.start) context = null;
    setMenu((previous) => {
      if (context === null) return null;
      // Запрос сменился — выбор снова на первом пункте, и его надо показать; тот же — всё держится
      // (стрелки сдвигают выбор сами).
      const same = previous !== null && previous.context.query === context.query;
      return { context, selected: same ? previous.selected : 0, reveal: same ? previous.reveal : true };
    });
  }, [draftKey]);

  // Черновик комнаты — в поле при монтировании (и при смене комнаты, если поле не пересоздали).
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (editor === null) return;
    fillEditor(editor, useUiStore.getState().composerDrafts[draftKey] ?? '', chipLabel);
    refresh();
  }, [draftKey, chipLabel, refresh]);

  const items = menu === null ? [] : filterMentions(members, menu.context.query);
  const selected = Math.min(menu?.selected ?? 0, Math.max(0, items.length - 1));

  const pick = (member: ComposerMember): void => {
    const editor = editorRef.current;
    if (editor === null || menu === null) return;
    insertMention(editor, menu.context, member.id, `@${member.label}`);
    dismissedRef.current = null;
    setMenu(null);
    refresh();
  };

  const submit = (): void => {
    const editor = editorRef.current;
    if (editor === null) return;
    const content = readEditor(editor);
    const trimmed = content.text.trim();
    if (trimmed === '') return;
    // Поле очищается сразу, до ответа хоста: второй Enter не отправит то же письмо второй раз.
    editor.replaceChildren();
    dismissedRef.current = null;
    refresh();
    void Promise.resolve(onSend({ to: content.to, text: trimmed })).catch(() => {
      const current = editorRef.current;
      if (current === null || !isBlank(readEditor(current))) return;
      fillEditor(current, trimmed, chipLabel);
      refresh();
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const editor = editorRef.current;
    // Enter, которым подтверждают набор в IME, — не отправка.
    if (editor === null || event.nativeEvent.isComposing) return;

    if (menu !== null && items.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setMenu({ ...menu, selected: (selected + step + items.length) % items.length, reveal: true });
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        pick(items[selected] as ComposerMember);
        return;
      }
    }
    if (menu !== null && event.key === 'Escape') {
      event.preventDefault();
      dismissedRef.current = { node: menu.context.node, start: menu.context.start };
      setMenu(null);
      return;
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      if (removeAdjacentChip(editor, event.key === 'Backspace' ? 'backward' : 'forward')) {
        event.preventDefault();
        refresh();
      }
      return;
    }
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      insertLineBreak(editor.ownerDocument);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>): void => {
    // Вставка — только текст: разметка из буфера в поле не попадает (2.2).
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    if (text !== '') insertPlainText(event.currentTarget.ownerDocument, text);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    // Перетаскивание — то же, что вставка: выделение из ленты приносит HTML с `data-mention`, а читатель
    // поля считает чипом любой такой узел — в `to[]` попал бы чужой адресат. Чипы рождает только меню.
    event.preventDefault();
    const text = event.dataTransfer.getData('text/plain');
    if (text !== '') insertDroppedText(event.currentTarget, text, { x: event.clientX, y: event.clientY });
  };

  return (
    <div className="relative flex shrink-0 flex-col gap-1.5 border-t border-[color-mix(in_srgb,currentColor_12%,transparent)] px-9 pb-[18px] pt-2.5">
      {menu === null ? null : (
        <MentionMenu
          items={items}
          selected={selected}
          reveal={menu.reveal}
          onPick={pick}
          onHover={(index) => setMenu({ ...menu, selected: index, reveal: false })}
        />
      )}
      <span className="truncate text-xs text-muted-foreground">
        {to.length === 0 ? S.rooms.toEveryone : S.rooms.toList(to.map(sessionTag).join(', '))}
      </span>
      <div className="flex items-end gap-2">
        <div className="relative min-w-0 flex-1">
          {blank ? (
            <span className="pointer-events-none absolute left-[17px] top-[9px] max-w-[calc(100%-34px)] truncate text-sm leading-5 text-muted-foreground">
              {S.rooms.composerPlaceholder}
            </span>
          ) : null}
          <div
            ref={editorRef}
            role="textbox"
            aria-multiline="true"
            aria-label={S.rooms.messageField}
            data-room-editor=""
            contentEditable
            onInput={refresh}
            onKeyDown={onKeyDown}
            onKeyUp={refresh}
            onClick={refresh}
            onPaste={onPaste}
            onDrop={onDrop}
            onBlur={() => {
              dismissedRef.current = null;
              setMenu(null);
            }}
            className="box-border max-h-[140px] min-h-[38px] overflow-y-auto whitespace-pre-wrap rounded-[19px] border border-[color-mix(in_srgb,currentColor_22%,transparent)] bg-[color-mix(in_srgb,currentColor_5%,transparent)] px-4 py-2 text-sm leading-5 caret-ring [overflow-wrap:anywhere]"
          />
        </div>
        <Button type="button" onClick={submit}>
          {S.rooms.send}
        </Button>
      </div>
    </div>
  );
}
