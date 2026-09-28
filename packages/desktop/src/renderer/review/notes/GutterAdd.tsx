/**
 * «+» гаттера стороны диффа (кусок 8.4b, спека 11.4): свой оверлей над номерами строк —
 * glyph-декорации Monaco не кликабельны.
 *
 * - Наведение показывает «+» у строки под указателем.
 * - Протяжка с зажатой кнопкой — диапазон строк; отпускание открывает поле заметки (`onPick`).
 * - ⌘⇧A — заметка на выделение: действие редактора (`addAction`), а не `addCommand` — у того
 *   сочетание общее на все редакторы окна (побеждает последний смонтированный) и не снимается.
 *   Реестр клавиш окна ⌘⇧A не занимает (6.1a).
 *
 * Строка под указателем — по `getTopForLineNumber` и прокрутке редактора: между строкой и следующей
 * может стоять view zone (заметка, плашка скрытых строк) — над ней «+» нет.
 * Оверлей только открывает поле: заметку сохраняет ⌘Enter, агенту её шлёт «Send» (рамка 15.1).
 */

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Plus } from 'lucide-react';
import { S } from '../../../shared/strings.js';
import { setupMonaco } from '../../files/editor/monaco-setup.js';

/** Сторона diff-редактора — то, что оверлею нужно от Monaco. */
export interface GutterEditor {
  getTopForLineNumber(line: number): number;
  getScrollTop(): number;
  getOption(id: number): unknown;
  getSelection(): { startLineNumber: number; endLineNumber: number; endColumn: number } | null;
  getLayoutInfo(): { width: number; height: number; contentLeft: number; contentWidth: number; lineNumbersLeft: number; lineNumbersWidth: number };
  getDomNode(): HTMLElement | null;
  onDidScrollChange(listener: () => void): { dispose(): void };
  onDidLayoutChange(listener: () => void): { dispose(): void };
  addAction(descriptor: {
    id: string;
    label: string;
    keybindings?: number[];
    keybindingContext?: string;
    run(editor: unknown): void;
  }): { dispose(): void };
}

export interface GutterAddProps {
  editor: GutterEditor;
  /** Строк в модели стороны: за последней «+» нет. */
  lineCount: number;
  /** Для разметки и E2E: чей это гаттер. */
  side?: 'modified' | 'original';
  onPick(startLine: number, endLine: number): void;
}

interface Box {
  left: number;
  width: number;
  height: number;
}

export function GutterAdd({ editor, lineCount, side, onPick }: GutterAddProps): JSX.Element {
  const strip = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDragState] = useState<{ from: number; to: number } | null>(null);
  // Протяжка — и в ref: соседние pointermove приходят раньше перерисовки, состояние в замыкании отстало бы.
  const dragRef = useRef<{ from: number; to: number } | null>(null);
  const setDrag = (next: { from: number; to: number } | null): void => {
    dragRef.current = next;
    setDragState(next);
  };
  const [box, setBox] = useState<Box>({ left: 0, width: 0, height: 0 });
  const [, setScroll] = useState(0);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  const lineHeight = Number(editor.getOption(setupMonaco().editor.EditorOption.lineHeight)) || 18;

  /** Строка под точкой `clientY` или null: вне строк или над view zone между ними. */
  const lineAt = (clientY: number): number | null => {
    const node = strip.current;
    if (node === null || lineCount < 1) return null;
    const y = clientY - node.getBoundingClientRect().top + editor.getScrollTop();
    // Верх строк не убывает: последняя строка, чей верх не ниже точки. Скрытые неизменённые строки
    // делят верх со следующей видимой — берётся она.
    let low = 1;
    let high = lineCount;
    let found = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (editor.getTopForLineNumber(mid) <= y) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (found === 0 || y >= editor.getTopForLineNumber(found) + lineHeight) return null;
    return found;
  };

  // Место оверлея — над номерами строк своей стороны: у двух колонок правая сторона сдвинута.
  useLayoutEffect(() => {
    const measure = (): void => {
      const info = editor.getLayoutInfo();
      const host = strip.current?.parentElement?.getBoundingClientRect();
      const dom = editor.getDomNode()?.getBoundingClientRect();
      const offset = host === undefined || dom === undefined ? 0 : dom.left - host.left;
      setBox({ left: offset + info.lineNumbersLeft, width: info.lineNumbersWidth, height: info.height });
    };
    measure();
    const layout = editor.onDidLayoutChange(measure);
    // «+» едет вместе со строкой при прокрутке.
    const scroll = editor.onDidScrollChange(() => setScroll((n) => n + 1));
    return () => {
      layout.dispose();
      scroll.dispose();
    };
  }, [editor]);

  useEffect(() => {
    const { KeyMod, KeyCode } = setupMonaco();
    const action = editor.addAction({
      id: 'harnas.diff.addNote',
      label: S.notes.add,
      keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA],
      // Только из текста этой стороны: из поля заметки в зоне сочетание новой заметки не ставит.
      keybindingContext: 'editorTextFocus',
      run: () => {
        const selection = editor.getSelection();
        if (selection === null) return;
        let end = selection.endLineNumber;
        // Выделение до начала строки эту строку не берёт — как у Monaco.
        if (end > selection.startLineNumber && selection.endColumn === 1) end -= 1;
        pickRef.current(selection.startLineNumber, end);
      },
    });
    return () => action.dispose();
  }, [editor]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const line = lineAt(event.clientY);
    if (line === null) return;
    // Мимо Monaco: иначе он начал бы выделение строк под оверлеем и забрал фокус.
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({ from: line, to: line });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const line = lineAt(event.clientY);
    const current = dragRef.current;
    if (current !== null) {
      if (line !== null && line !== current.to) setDrag({ from: current.from, to: line });
      return;
    }
    setHover(line);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = dragRef.current;
    if (current === null) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const from = Math.min(current.from, current.to);
    const to = Math.max(current.from, current.to);
    setDrag(null);
    setHover(null);
    pickRef.current(from, to);
  };

  const scrollTop = editor.getScrollTop();
  const topOf = (line: number): number => editor.getTopForLineNumber(line) - scrollTop;
  const shown = drag?.to ?? hover;
  const band = drag === null ? null : { from: Math.min(drag.from, drag.to), to: Math.max(drag.from, drag.to) };

  return (
    <div
      ref={strip}
      data-testid="gutter-add"
      data-side={side}
      className="absolute top-0 z-[5] cursor-pointer select-none"
      style={{ left: box.left, width: box.width, height: box.height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        if (dragRef.current === null) setHover(null);
      }}
    >
      {band === null ? null : (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 rounded-sm bg-primary/20"
          style={{ top: topOf(band.from), height: topOf(band.to) - topOf(band.from) + lineHeight }}
        />
      )}
      {shown === null ? null : (
        <button
          type="button"
          aria-label={S.notes.add}
          title={S.notes.add}
          className="absolute right-0 flex items-center justify-center rounded-sm bg-primary text-primary-foreground shadow"
          style={{ top: topOf(shown), width: lineHeight, height: lineHeight }}
          onClick={(event) => {
            // Мышь уже поставила заметку отпусканием; клик — только с клавиатуры (Enter, пробел).
            if (event.detail === 0) pickRef.current(shown, shown);
          }}
        >
          <Plus className="size-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
