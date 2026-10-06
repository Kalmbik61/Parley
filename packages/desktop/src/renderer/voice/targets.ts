/**
 * Цели диктовки для полей (спека 3.2–3.4): `textarea` (чат, первый промпт) и contentEditable (комната). Каретка
 * запоминается в начале записи, только если фокус в поле; иначе текст встаёт в конец. Последние `apply` и `onChange`
 * берутся из ref: цель регистрируется один раз на id.
 */
import { useEffect, useRef, type RefObject } from 'react';
import { matchesAccelerator, type KeyLike } from '../../shared/keybindings.js';
import { insertPlainText } from '../components/rooms/mention-editor.js';
import { useDictationStore } from './dictation-store.js';
import { joinTranscript, spliceTranscript } from './insert.js';

export const VOICE_ACCELERATOR = 'CmdOrCtrl+Shift+M';

export function isVoiceShortcut(event: KeyLike): boolean {
  return matchesAccelerator(VOICE_ACCELERATOR, event);
}

export function useTextareaDictation(id: string, field: RefObject<HTMLTextAreaElement | null>, apply: (value: string) => void): void {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    let caret: number | null = null;
    return useDictationStore.getState().register({
      id,
      element: () => field.current,
      remember: () => {
        const el = field.current;
        caret = el !== null && el.ownerDocument.activeElement === el ? el.selectionStart : null;
      },
      insert: (text) => {
        const el = field.current;
        const value = el?.value ?? '';
        const next = spliceTranscript(value, caret ?? value.length, text);
        applyRef.current(next.value);
        if (el !== null) {
          requestAnimationFrame(() => {
            el.focus();
            el.setSelectionRange(next.caret, next.caret);
          });
        }
      },
    });
  }, [id, field]);
}

export function useEditableDictation(id: string, editor: RefObject<HTMLElement | null>, onChange: () => void): void {
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  useEffect(() => {
    let saved: Range | null = null;
    return useDictationStore.getState().register({
      id,
      element: () => editor.current,
      remember: () => {
        const el = editor.current;
        const selection = el?.ownerDocument.getSelection();
        const range = selection !== null && selection !== undefined && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
        saved = el !== null && range !== null && el.contains(range.startContainer) ? range.cloneRange() : null;
      },
      insert: (text) => {
        const el = editor.current;
        if (el === null) return;
        const doc = el.ownerDocument;
        el.focus();
        let range = saved !== null && el.contains(saved.startContainer) ? saved : null;
        if (range === null) {
          range = doc.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
        }
        const selection = doc.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        const before = doc.createRange();
        before.selectNodeContents(el);
        before.setEnd(range.startContainer, range.startOffset);
        insertPlainText(doc, joinTranscript(before.toString(), text));
        changeRef.current();
      },
    });
  }, [id, editor]);
}
