/**
 * Заметки над живым diff-редактором секции (кусок 8.4b, спека 11.4): «+» гаттера и ⌘⇧A на видимых
 * сторонах, view zones заметок и поля под `endLine` своей стороны.
 *
 * Одна колонка (решение сверки M18): старая сторона скрыта — у неё ни «+», ни зон; её заметки
 * рисует полоса над редактором (`FileDiffSection`). Видна ли она, слой узнаёт по раскладке Monaco,
 * а не по `renderSideBySide`: в одной колонке левый редактор сжат до полосы номеров. Вкладка диффа
 * выключает авто-одну колонку (`useInlineViewWhenSpaceIsLimited: false`, раунд fix-live, D1), но
 * раскладка остаётся единственным источником правды о том, что Monaco нарисовал.
 *
 * В режиме коммита слоя нет вовсе (решение сверки M22): заметки ставятся и показываются только в
 * диффе ветки.
 */

import { Fragment, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WorkEntry } from '@harnas/core';
import type { DiffNote } from '../../../shared/notes-types.js';
import { GutterAdd, type GutterEditor } from './GutterAdd.js';
import { NoteEditor } from './NoteEditor.js';
import { NoteZone, useViewZones, type ZoneEditor } from './NoteZone.js';

export type NoteSide = DiffNote['side'];

/** Поле новой заметки: сторона и строки, выбранные «+» или ⌘⇧A. */
export interface NoteDraft {
  side: NoteSide;
  startLine: number;
  endLine: number;
}

type SideEditor = GutterEditor & ZoneEditor;

export interface NotesDiffEditor {
  getOriginalEditor(): unknown;
  getModifiedEditor(): unknown;
}

export interface NoteHandlers {
  entry: WorkEntry;
  defaultSessionId: string;
  editing: string | null;
  onPick(side: NoteSide, startLine: number, endLine: number): void;
  onSaveDraft(body: string): void;
  onCancelDraft(): void;
  onEdit(id: string): void;
  onSaveEdit(id: string, body: string): void;
  onCancelEdit(): void;
  onDelete(id: string): void;
  onSend(note: DiffNote, to: string): void;
}

export interface DiffNotesLayerProps extends NoteHandlers {
  editor: NotesDiffEditor;
  /** Две колонки видны: и выбор человека, и раскладка Monaco. */
  sideBySide: boolean;
  onSideBySide(visible: boolean): void;
  notes: DiffNote[];
  draft: NoteDraft | null;
  lineCount: Record<NoteSide, number>;
}

/** Карточка или поле заметки — одно и то же в зоне и в полосе одной колонки. */
export function NoteBody({ note, handlers, caption }: { note: DiffNote; handlers: NoteHandlers; caption?: string }): JSX.Element {
  if (handlers.editing === note.id) {
    return <NoteEditor initial={note.body} onSave={(body) => handlers.onSaveEdit(note.id, body)} onCancel={handlers.onCancelEdit} />;
  }
  return (
    <NoteZone
      note={note}
      entry={handlers.entry}
      defaultSessionId={handlers.defaultSessionId}
      {...(caption === undefined ? {} : { caption })}
      onEdit={() => handlers.onEdit(note.id)}
      onDelete={() => handlers.onDelete(note.id)}
      onSend={(to) => handlers.onSend(note, to)}
    />
  );
}

const DRAFT = 'draft';

function SideNotes({ side, editor, props }: { side: NoteSide; editor: SideEditor; props: DiffNotesLayerProps }): JSX.Element {
  const notes = props.notes.filter((note) => note.side === side);
  const draft = props.draft?.side === side ? props.draft : null;
  const specs = notes.map((note) => ({ key: note.id, afterLineNumber: note.endLine }));
  if (draft !== null) specs.push({ key: DRAFT, afterLineNumber: draft.endLine });
  // Ширина текста стороны — по раскладке Monaco: окно сузили — карточки сузились вместе с ним.
  const [width, setWidth] = useState(() => editor.getLayoutInfo().contentWidth);
  useLayoutEffect(() => {
    const layout = editor.onDidLayoutChange(() => setWidth(editor.getLayoutInfo().contentWidth));
    return () => layout.dispose();
  }, [editor]);
  const nodes = useViewZones(editor, specs, width);
  return (
    <>
      <GutterAdd editor={editor} side={side} lineCount={props.lineCount[side]} onPick={(start, end) => props.onPick(side, start, end)} />
      {notes.map((note) => {
        const node = nodes.get(note.id);
        return node === undefined ? null : <Fragment key={note.id}>{createPortal(<NoteBody note={note} handlers={props} />, node)}</Fragment>;
      })}
      {draft === null || nodes.get(DRAFT) === undefined
        ? null
        : createPortal(<NoteEditor initial="" onSave={props.onSaveDraft} onCancel={props.onCancelDraft} />, nodes.get(DRAFT) as HTMLElement)}
    </>
  );
}

export function DiffNotesLayer(props: DiffNotesLayerProps): JSX.Element {
  const original = props.editor.getOriginalEditor() as SideEditor;
  const modified = props.editor.getModifiedEditor() as SideEditor;
  const { onSideBySide } = props;

  useLayoutEffect(() => {
    // В одной колонке левый редактор — только полоса номеров: ширина не больше начала текста.
    const check = (): void => {
      const info = original.getLayoutInfo();
      onSideBySide(info.width > info.contentLeft);
    };
    check();
    const layout = original.onDidLayoutChange(check);
    return () => layout.dispose();
  }, [original, onSideBySide]);

  return (
    <>
      {props.sideBySide ? <SideNotes side="original" editor={original} props={props} /> : null}
      <SideNotes side="modified" editor={modified} props={props} />
    </>
  );
}
