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
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import type { DiffFile, FileRoot } from '../../shared/files-types.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';
import { Button } from '../ui/button.js';
import { loadSides, type DiffSides } from './diff-sides.js';

type DiffEditorApi = Parameters<DiffOnMount>[0];
type SideEditor = ReturnType<DiffEditorApi['getModifiedEditor']>;

export type DiffMode = { kind: 'branch'; base: string } | { kind: 'commit'; hash: string };

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
  return `file:///harnas/diff/${seq}/${side}/${safe}`;
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
}

function LiveDiff({ sides, path, options, split, theme, language, onHeight }: LiveDiffProps): JSX.Element {
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
      // `@monaco-editor/react` 4.7 при размонтировании диспозит модели раньше редактора — Monaco
      // бросает «TextModel got disposed before DiffEditorWidget model got reset» (pageerror на
      // собранном окне, e2e diff.spec). Эффект родителя снимается раньше эффекта `DiffEditor`:
      // сначала отвязываем модели от редактора и диспозим их сами — библиотеке остаётся редактор.
      const editor = editorRef.current;
      editorRef.current = null;
      const models = editor?.getModel() ?? null;
      editor?.setModel(null);
      models?.original.dispose();
      models?.modified.dispose();
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
        console.warn('[harnas] diff: load sides', target.path, info.code, info.message);
        if (alive) setLoaded({ version, error: errorText(info.code, S.errors.actions.loadDiff) });
      },
    );
    return () => {
      alive = false;
    };
  }, [want, props.version, loadedVersion]);

  const ref = useCallback((element: HTMLElement | null) => register(file.path, element), [register, file.path]);

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
        <div style={{ height: boxHeight }}>
          <LiveDiff
            sides={loaded.sides}
            path={file.path}
            options={props.options}
            split={props.split}
            theme={props.theme}
            language={props.language}
            onHeight={setHeight}
          />
        </div>
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
        {file.additions === null ? null : <span className="shrink-0 tabular-nums text-status-success">{`+${file.additions}`}</span>}
        {file.deletions === null ? null : <span className="shrink-0 tabular-nums text-destructive">{`−${file.deletions}`}</span>}
      </header>
      {body}
    </section>
  );
}

/** memo: смена живого набора у одной секции не перерисовывает остальные 29. */
export const FileDiffSection = memo(FileDiffSectionImpl);
