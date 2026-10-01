/**
 * Секция файла вкладки диффа (кусок 8.3, спека 11.3): заголовок (путь, `+a −d`, «Collapse») и
 * Monaco `DiffEditor`. Редактор живёт, только пока `DiffTab` держит секцию в числе живых (не больше
 * 20, вход в экран — `IntersectionObserver`); иначе — заглушка оценочной высоты, и прокрутка
 * длинного диффа не держит сотни редакторов.
 *
 * Стороны читаются при первом входе в экран и заново на каждый новый `version` (новая загрузка
 * «Изменений», 11.1): живой редактор получает новый текст через `setValue` модели, прокрутка —
 * прежняя. Иначе заметка 8.4b не переехала бы, а человек терял бы место в файле на каждом
 * сигнале агента.
 *
 * Заметки (кусок 8.4b, спека 11.4) — только в режиме ветки (`notes` не null): слой над живым
 * редактором (`notes/DiffNotesLayer.tsx`), «Send file notes» в заголовке, полоса заметок старой
 * стороны в одной колонке. Каждое чтение сторон — `relocateFile` заметок файла по обеим сторонам
 * (решение сверки I7): агент сдвинул строки — заметка переехала, убрал — устарела.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import type { WorkEntry } from '@parley/core';
import type { DiffFile, FileRoot } from '../../shared/files-types.js';
import type { DiffNote } from '../../shared/notes-types.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';
import { releaseDiffEditor } from '../lib/release-diff-editor.js';
import { Button } from '../ui/button.js';
import { loadSides, type DiffSides } from './diff-sides.js';
import { DiffNotesLayer, NoteBody, type NoteDraft, type NoteHandlers } from './notes/DiffNotesLayer.js';
import { batchable } from './notes/send-notes.js';
import { SendMenu } from './notes/SendMenu.js';
import { notesKey, useNotesStore } from './notes/store.js';

type DiffEditorApi = Parameters<DiffOnMount>[0];
type SideEditor = ReturnType<DiffEditorApi['getModifiedEditor']>;

export type DiffMode = { kind: 'branch'; base: string } | { kind: 'commit'; hash: string };

/** Заметки секции (8.4b): чьи они и как их отправить. В режиме коммита — null. */
export interface SectionNotes {
  workKey: string;
  /** Сессия диффа — владелец заметок и получатель по умолчанию. */
  sessionId: string;
  entry: WorkEntry;
  send(notes: DiffNote[], to: string): void;
}

export interface FileDiffSectionProps {
  file: DiffFile;
  files: Parameters<typeof loadSides>[0]['files'];
  root: FileRoot;
  mode: DiffMode;
  /** Новый объект — новая загрузка списка: живой редактор перечитывает стороны. */
  version: unknown;
  /** Секция в числе живых: можно держать редактор. */
  live: boolean;
  collapsed: boolean;
  onToggle(path: string): void;
  /** Опции `DiffEditor` — одна ссылка, пока не сменились: новая уходит в `updateOptions`. */
  options: Record<string, unknown>;
  split: boolean;
  theme: string;
  language: string | undefined;
  /** Элемент секции для `IntersectionObserver` вкладки. */
  register(path: string, element: HTMLElement | null): void;
  /** Заметки режима ветки; null — режим коммита: ни «+», ни ⌘⇧A, ни зон. */
  notes: SectionNotes | null;
}

/** Строки стороны так, как их видит Monaco: `\r\n` — один перевод строки. */
function sideLines(text: string | null): string[] {
  return text === null ? [] : text.split(/\r?\n/);
}

/** Оценка высоты заглушки (план): 20px × (строк + 2), не больше 600px. */
export function placeholderHeight(lines: number): number {
  return Math.min(600, 20 * (lines + 2));
}

const FILE_STATUS: Record<string, string> = S.changes.fileStatus;

/** Номер модели: у каждого смонтированного редактора свои пути — общая модель смешала бы стороны. */
let modelSeq = 0;

/** Путь модели, как у `FileBody`: только простые символы — с `%`-кодами воркер TS не находил модель. */
function modelPath(seq: number, side: string, path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1) : '';
  const safe = /^[A-Za-z0-9._-]+$/.test(name) ? name : /^[A-Za-z0-9]+$/.test(extension) ? `file.${extension}` : 'file';
  return `file:///parley/diff/${seq}/${side}/${safe}`;
}

/** Новый текст стороны без перемонтирования: прокрутка — прежняя (спека 11.3). */
function applyText(editor: SideEditor, text: string): void {
  const model = editor.getModel();
  if (model === null || model.getValue() === text) return;
  const top = editor.getScrollTop();
  model.setValue(text);
  editor.setScrollTop(top);
}

interface LiveDiffProps {
  sides: DiffSides;
  path: string;
  options: Record<string, unknown>;
  split: boolean;
  theme: string;
  language: string | undefined;
  onHeight(height: number): void;
  /** Смонтированный редактор — слою заметок (8.4b); null — редактор уходит. */
  onEditor(editor: DiffEditorApi | null): void;
}

function LiveDiff({ sides, path, options, split, theme, language, onHeight, onEditor }: LiveDiffProps): JSX.Element {
  // Текст монтирования — один раз: дальше стороны идут через `setValue` модели. Проп `original` /
  // `modified` `@monaco-editor/react` тоже зовёт `setValue`, но без сохранения прокрутки.
  const [initial] = useState(sides);
  const [seq] = useState(() => ++modelSeq);
  const editorRef = useRef<DiffEditorApi | null>(null);
  const sidesRef = useRef(sides);
  sidesRef.current = sides;
  const splitRef = useRef(split);
  splitRef.current = split;
  const heightRef = useRef(onHeight);
  heightRef.current = onHeight;
  const editorOut = useRef(onEditor);
  editorOut.current = onEditor;
  const cleanup = useRef<Array<{ dispose(): void }>>([]);

  const apply = (editor: DiffEditorApi): void => {
    applyText(editor.getOriginalEditor(), sidesRef.current.original ?? '');
    applyText(editor.getModifiedEditor(), sidesRef.current.modified ?? '');
  };

  const measure = (): void => {
    const editor = editorRef.current;
    if (editor === null) return;
    const modified = editor.getModifiedEditor().getContentHeight();
    // Одна колонка рисует всё в правом редакторе; две — выше из двух.
    const height = splitRef.current ? Math.max(modified, editor.getOriginalEditor().getContentHeight()) : modified;
    if (height > 0) heightRef.current(height);
  };

  useEffect(() => {
    if (editorRef.current !== null) apply(editorRef.current);
  }, [sides]);

  useEffect(() => {
    measure();
  }, [split]);

  useEffect(
    () => () => {
      for (const listener of cleanup.current) listener.dispose();
      cleanup.current = [];
      // Модели — до эффекта `DiffEditor`, иначе pageerror (e2e diff.spec): `release-diff-editor.ts`.
      const editor = editorRef.current;
      editorRef.current = null;
      editorOut.current(null);
      releaseDiffEditor(editor);
    },
    [],
  );

  const onMount: DiffOnMount = (editor) => {
    editorRef.current = editor;
    // Стороны могли смениться, пока Monaco собирал редактор.
    apply(editor);
    cleanup.current.push(
      editor.getModifiedEditor().onDidContentSizeChange(measure),
      editor.getOriginalEditor().onDidContentSizeChange(measure),
    );
    measure();
    editorOut.current(editor);
  };

  return (
    <DiffEditor
      className="h-full"
      original={initial.original ?? ''}
      modified={initial.modified ?? ''}
      originalModelPath={modelPath(seq, 'original', path)}
      modifiedModelPath={modelPath(seq, 'modified', path)}
      {...(language === undefined ? {} : { language })}
      theme={theme}
      loading={null}
      options={options}
      onMount={onMount}
    />
  );
}

type Loaded = { version: unknown; sides: DiffSides } | { version: unknown; error: string };

function FileDiffSectionImpl(props: FileDiffSectionProps): JSX.Element {
  const { file, live, collapsed, onToggle, register } = props;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [forced, setForced] = useState(false);
  const [height, setHeight] = useState<number | null>(null);
  // Вход загрузки — через ref: `file` и `mode` — новые объекты на каждую загрузку, а перечитывать
  // стороны нужно только на новый `version`.
  const input = useRef(props);
  input.current = props;
  const want = live && !collapsed;
  const loadedVersion = loaded === null ? undefined : loaded.version;

  useEffect(() => {
    if (!want || (loaded !== null && loadedVersion === props.version)) return undefined;
    const { files, root, file: target, mode, version } = input.current;
    let alive = true;
    loadSides({ files, root, file: target, mode }).then(
      (sides) => {
        if (alive) setLoaded({ version, sides });
      },
      (error: unknown) => {
        const info = decodeIpcError(error);
        // Сообщение main — только в консоль: человеку — свой английский текст по коду.
        console.warn('[parley] diff: load sides', target.path, info.code, info.message);
        if (alive) setLoaded({ version, error: errorText(info.code, S.errors.actions.loadDiff) });
      },
    );
    return () => {
      alive = false;
    };
  }, [want, props.version, loadedVersion]);

  const ref = useCallback((element: HTMLElement | null) => register(file.path, element), [register, file.path]);

  // Заметки файла (8.4b). Подписка — на массив сессии: правки чужих сессий секцию не трогают.
  const ctx = props.notes;
  const sessionNotes = useNotesStore((state) => (ctx === null ? undefined : state.bySession[notesKey(ctx.workKey, ctx.sessionId)]));
  const fileNotes = useMemo(() => (sessionNotes ?? []).filter((note) => note.path === file.path), [sessionNotes, file.path]);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ api: DiffEditorApi; seq: number } | null>(null);
  const editorSeq = useRef(0);
  const onEditor = useCallback((api: DiffEditorApi | null) => {
    editorSeq.current += 1;
    setEditor(api === null ? null : { api, seq: editorSeq.current });
  }, []);
  const [layoutSplit, setLayoutSplit] = useState(true);
  const sideBySide = props.split && layoutSplit;
  const sides = loaded !== null && !('error' in loaded) ? loaded.sides : null;

  // Переезд — на каждом чтении сторон и когда заметки файла пришли или сменились (загрузка стора
  // бывает позже сторон). Правка текста заметки строк не двигает — подпись без тела.
  const noteIds = fileNotes.map((note) => note.id).join(',');
  useEffect(() => {
    if (ctx === null || sides === null || sides.binary || noteIds === '') return;
    const store = useNotesStore.getState();
    for (const side of ['original', 'modified'] as const) {
      const text = sides[side];
      // Стороны нет (добавленный или удалённый файл) — сверять не с чем.
      if (text !== null) store.relocateFile(ctx.workKey, ctx.sessionId, file.path, side, sideLines(text));
    }
  }, [ctx, sides, noteIds, file.path]);

  const handlers: NoteHandlers | null =
    ctx === null
      ? null
      : {
          entry: ctx.entry,
          defaultSessionId: ctx.sessionId,
          editing,
          onPick: (side, startLine, endLine) => {
            setEditing(null);
            setDraft({ side, startLine, endLine });
          },
          onSaveDraft: (body) => {
            if (draft === null || sides === null) return;
            const anchor = sideLines(sides[draft.side])[draft.startLine - 1] ?? '';
            useNotesStore.getState().add(ctx.workKey, ctx.sessionId, { path: file.path, ...draft, body }, anchor);
            setDraft(null);
          },
          onCancelDraft: () => setDraft(null),
          onEdit: (id) => {
            setDraft(null);
            setEditing(id);
          },
          onSaveEdit: (id, body) => {
            useNotesStore.getState().update(ctx.workKey, ctx.sessionId, id, body);
            setEditing(null);
          },
          onCancelEdit: () => setEditing(null),
          onDelete: (id) => {
            if (editing === id) setEditing(null);
            useNotesStore.getState().remove(ctx.workKey, ctx.sessionId, id);
          },
          onSend: (note, to) => ctx.send([note], to),
        };
  const unsent = batchable(fileNotes);
  // Одна колонка: заметки старой стороны — полосой над редактором, их зоны не видны.
  const originalStrip = handlers !== null && !sideBySide ? fileNotes.filter((note) => note.side === 'original') : [];

  const cap = Math.max(600, Math.round(window.innerHeight * 0.8));
  const boxHeight = Math.min(cap, height ?? placeholderHeight((file.additions ?? 0) + (file.deletions ?? 0)));
  const title = file.oldPath === null ? file.path : `${file.oldPath} → ${file.path}`;
  const toggleLabel = collapsed ? S.changes.expand : S.changes.collapse;

  let body: JSX.Element | null = null;
  if (!collapsed) {
    const placeholder = (
      <div data-diff-placeholder style={{ height: boxHeight }} className="bg-muted/30" />
    );
    if (loaded !== null && 'error' in loaded) {
      body = <p className="px-3 py-4 text-center text-xs text-muted-foreground">{loaded.error}</p>;
    } else if (loaded === null) {
      body = placeholder;
    } else if (loaded.sides.binary) {
      body = <p className="px-3 py-4 text-center text-xs text-muted-foreground">{S.files.binary}</p>;
    } else if (loaded.sides.tooLarge && !forced) {
      const text = loaded.sides.original !== null || loaded.sides.modified !== null;
      body = (
        <div className="flex flex-col items-center gap-2 px-3 py-4 text-center text-xs text-muted-foreground">
          <p>{S.changes.fileTooLarge}</p>
          {/* Больше 20 МБ текста нет вовсе — показывать нечего (diff-sides.ts). */}
          {text ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setForced(true)}>
              {S.changes.showAnyway}
            </Button>
          ) : null}
        </div>
      );
    } else if (!live) {
      body = placeholder;
    } else {
      body = (
        <>
          {originalStrip.length === 0 || handlers === null ? null : (
            <div data-testid="original-notes" className="flex flex-col gap-1.5 border-b border-border bg-muted/20 p-2">
              {originalStrip.map((note) => (
                <NoteBody key={note.id} note={note} handlers={handlers} caption={S.notes.original(note.startLine, note.endLine)} />
              ))}
            </div>
          )}
          <div style={{ height: boxHeight }} className="relative">
            <LiveDiff
              sides={loaded.sides}
              path={file.path}
              options={props.options}
              split={props.split}
              theme={props.theme}
              language={props.language}
              onHeight={setHeight}
              onEditor={onEditor}
            />
            {handlers === null || editor === null ? null : (
              <DiffNotesLayer
                key={editor.seq}
                {...handlers}
                editor={editor.api}
                sideBySide={sideBySide}
                onSideBySide={setLayoutSplit}
                notes={fileNotes}
                draft={draft !== null && draft.side === 'original' && !sideBySide ? null : draft}
                lineCount={{ original: sideLines(loaded.sides.original).length, modified: sideLines(loaded.sides.modified).length }}
              />
            )}
          </div>
        </>
      );
    }
  }

  return (
    <section ref={ref} data-diff-path={file.path} className="border-b border-border">
      <header className="sticky top-0 z-10 flex h-7 min-w-0 items-center gap-2 border-b border-border bg-background px-2 text-xs">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={toggleLabel}
          title={toggleLabel}
          aria-expanded={!collapsed}
          onClick={() => onToggle(file.path)}
        >
          {collapsed ? <ChevronRight className="size-3.5" aria-hidden="true" /> : <ChevronDown className="size-3.5" aria-hidden="true" />}
        </Button>
        <span className="w-3 shrink-0 font-mono text-muted-foreground" title={FILE_STATUS[file.status] ?? file.status}>
          {file.status}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono" title={title}>
          {title}
        </span>
        {/* Двоичный файл чисел не имеет (numstat `-`). */}
        {file.additions === null ? null : <span className="shrink-0 tabular-nums text-status-success-text">{`+${file.additions}`}</span>}
        {file.deletions === null ? null : <span className="shrink-0 tabular-nums text-accent-700">{`−${file.deletions}`}</span>}
        {ctx === null || unsent.length === 0 ? null : (
          // Сжимается путь, а не кнопка: длинный путь уходит в «…» с полным текстом в title.
          <div className="shrink-0">
            <SendMenu entry={ctx.entry} defaultSessionId={ctx.sessionId} label={S.notes.sendFile} onSend={(to) => ctx.send(unsent, to)} />
          </div>
        )}
      </header>
      {body}
    </section>
  );
}

/** memo: смена живого набора у одной секции не перерисовывает остальные 29. */
export const FileDiffSection = memo(FileDiffSectionImpl);
