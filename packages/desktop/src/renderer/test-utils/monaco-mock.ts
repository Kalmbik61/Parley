/**
 * Общий подставной Monaco для тестов рендерера (кусок 7.3b; его дополняют 7.5, 8.3 и 8.4):
 * настоящий `monaco-editor` в jsdom не работает, а модули `?worker` там не собираются.
 *
 * Мок одного `@monaco-editor/react` не спасает: `MonacoEditor.tsx` через `monaco-setup.ts`
 * притянул бы настоящий `monaco-editor`. Поэтому тест подменяет оба модуля:
 *
 *   vi.mock('@monaco-editor/react', async () => (await import('../test-utils/monaco-mock.js')).monacoReactMock);
 *   vi.mock('../files/editor/monaco-setup.js', async () => (await import('../test-utils/monaco-mock.js')).monacoSetupMock);
 *
 * `Editor` — `textarea` внутри `div.monaco-editor`: по этому классу `focusContext` узнаёт
 * редактор (6.1a). `DiffEditor` — две такие `textarea`; в `onMount` он отдаёт поддельный
 * diff-редактор (8.3): `options` живут, как у настоящего `@monaco-editor/react` — новый объект
 * `options` уходит в `updateOptions`. Компоненты — обычные функции, а не
 * `vi.fn`: `vi.restoreAllMocks()` в тестах не сотрёт их реализацию.
 */

import { createElement, useEffect, useRef, useState, type ReactElement } from 'react';

/** Значения — как у настоящего Monaco 0.52: тест сверяет число, а не имя. */
export const KeyMod = { CtrlCmd: 2048, Shift: 1024, Alt: 512, WinCtrl: 256 } as const;
export const KeyCode = { KeyA: 31, KeyD: 34, KeyF: 36, KeyK: 41, KeyS: 49, KeyZ: 56, Slash: 90 } as const;
/** Номер опции не важен: `getOption` поддельного редактора на любой номер отвечает высотой строки (8.4b). */
export const EditorOption = { lineHeight: 75 } as const;
/** Высота строки поддельного редактора: `getTopForLineNumber(n)` — (n − 1) × 20 (8.4b). */
export const FAKE_LINE_HEIGHT = 20;

type Position = { lineNumber: number; column: number };

export interface FakeEditor {
  /** Опции монтирования и все `updateOptions`, слитые по порядку. */
  options: Record<string, unknown>;
  /** Последний `setPosition` (и строка `revealLineInCenter`). */
  position: Position | null;
  /** Что показано последним `reveal…InCenter`: у `revealLineInCenter` колонки нет (раунд fix-7.4). */
  revealed: { lineNumber: number; column: number | null } | null;
  /**
   * Нажатие сочетания в фокусе этого редактора: сперва его действия (`addAction`), потом команды
   * `addCommand` — те, как у настоящего Monaco 0.52, общие на всё окно (fix-8.4b, п. 1).
   */
  press(keybinding: number): void;
  /** Текст модели — как его видит редактор. */
  getValue(): string;
  /** Текст модели (8.3): `getValue` / `setValue` модели. */
  text: string;
  /** Прокрутка (8.3): `getScrollTop` / `setScrollTop`. */
  scrollTop: number;
  /** Размонтирован: тело вкладки ушло. */
  disposed: boolean;
  /**
   * View zones (8.4b): `changeViewZones` — `addZone` и `removeZone`. `domNode` зоны вставлен в DOM
   * поддельного редактора; карточка заметки — overlay widget рядом (`[data-note-overlay]`), события из
   * портала React доходят до корня, как у настоящего Monaco.
   */
  zones: Array<{ afterLineNumber: number; domNode: HTMLElement }>;
  /** `getSelection` (8.4b): выделение строк; `null` — нет. */
  selection: { startLineNumber: number; endLineNumber: number } | null;
}

export interface FakeDiffEditor {
  /** Опции монтирования и `updateOptions` (renderSideBySide, wordWrap…). */
  options: Record<string, unknown>;
  /** getOriginalEditor() */
  original: FakeEditor;
  /** getModifiedEditor() */
  modified: FakeEditor;
  /** dispose() — размонтирован. */
  disposed: boolean;
}

interface EditorApi extends FakeEditor {
  addCommand(keybinding: number, handler: () => void): string;
  updateOptions(options: Record<string, unknown>): void;
  setPosition(position: Position): void;
  revealLineInCenter(line: number): void;
  revealPositionInCenter(position: Position): void;
  focus(): void;
  getModel(): { getValue(): string; setValue(text: string): void } | null;
  saveViewState(): { position: Position | null } | null;
  restoreViewState(state: { position: Position | null } | null): void;
  getScrollTop(): number;
  setScrollTop(top: number): void;
  getContentHeight(): number;
  onDidContentSizeChange(listener: () => void): { dispose(): void };
  dispose(): void;
  changeViewZones(callback: (accessor: ZoneAccessor) => void): void;
  getTopForLineNumber(line: number): number;
  getSelection(): { startLineNumber: number; endLineNumber: number; startColumn: number; endColumn: number } | null;
  addAction(descriptor: { id: string; label: string; keybindings?: number[]; keybindingContext?: string; run(editor: unknown): void }): { dispose(): void };
  getOption(id: number): unknown;
  getLayoutInfo(): { width: number; height: number; contentLeft: number; contentWidth: number; lineNumbersLeft: number; lineNumbersWidth: number };
  onDidLayoutChange(listener: () => void): { dispose(): void };
  onDidScrollChange(listener: () => void): { dispose(): void };
  getDomNode(): HTMLElement;
  addOverlayWidget(widget: { getDomNode(): HTMLElement }): void;
  removeOverlayWidget(widget: { getDomNode(): HTMLElement }): void;
}

interface ZoneAccessor {
  addZone(zone: { afterLineNumber: number; heightInPx?: number; domNode: HTMLElement }): string;
  removeZone(id: string): void;
  layoutZone(id: string): void;
}

const editors: FakeEditor[] = [];
/**
 * Команды `addCommand` всех редакторов окна: у Monaco 0.52 они не привязаны к редактору — сочетание
 * срабатывает в любом, побеждает последний добавивший, и не снимаются при `dispose` (fix-8.4b, п. 1).
 */
const globalCommands = new Map<number, () => void>();
const diffEditors: FakeDiffEditor[] = [];
const themes: boolean[] = [];
let initError: Error | null = null;
let renderError: Error | null = null;

/**
 * `width()` — ширина стороны: у настоящего diff-редактора в одной колонке левый редактор сжат до
 * полосы номеров (`diffEditorWidget.js`), по ней 8.4b узнаёт, видна ли старая сторона.
 */
function fakeEditor(initial: string, options: Record<string, unknown>, setText: (text: string) => void, width: () => number = () => 400): EditorApi {
  const commands = new Map<number, () => void>();
  const layoutListeners = new Set<() => void>();
  // Хозяин зон — в DOM редактора: `DiffEditor` ниже вставляет его в свою разметку.
  const domNode = document.createElement('div');
  domNode.setAttribute('data-testid', 'monaco-zone-host');
  const zoneIds = new Map<string, { afterLineNumber: number; domNode: HTMLElement }>();
  let zoneSeq = 0;
  const api: EditorApi = {
    options: { ...options },
    position: null,
    revealed: null,
    disposed: false,
    zones: [],
    selection: null,
    text: initial,
    scrollTop: 0,
    press: (keybinding) => (commands.get(keybinding) ?? globalCommands.get(keybinding))?.(),
    getValue: () => api.text,
    addCommand: (keybinding, handler) => {
      globalCommands.set(keybinding, handler);
      return String(keybinding);
    },
    updateOptions: (next) => {
      api.options = { ...api.options, ...next };
    },
    setPosition: (position) => {
      api.position = { ...position };
    },
    revealLineInCenter: (line) => {
      api.position = { lineNumber: line, column: api.position?.column ?? 1 };
      api.revealed = { lineNumber: line, column: null };
    },
    revealPositionInCenter: (position) => {
      api.revealed = { lineNumber: position.lineNumber, column: position.column };
    },
    focus: () => {},
    getModel: () => ({
      getValue: () => api.text,
      setValue: (next) => {
        api.text = next;
        setText(next);
      },
    }),
    saveViewState: () => ({ position: api.position }),
    restoreViewState: (state) => {
      api.position = state?.position ?? null;
    },
    getScrollTop: () => api.scrollTop,
    setScrollTop: (top) => {
      api.scrollTop = top;
    },
    getContentHeight: () => 0,
    onDidContentSizeChange: () => ({ dispose: () => {} }),
    dispose: () => {
      api.disposed = true;
    },
    changeViewZones: (callback) => {
      callback({
        addZone: (zone) => {
          zoneSeq += 1;
          const id = String(zoneSeq);
          const entry = { afterLineNumber: zone.afterLineNumber, domNode: zone.domNode };
          zoneIds.set(id, entry);
          api.zones.push(entry);
          domNode.appendChild(zone.domNode);
          return id;
        },
        removeZone: (id) => {
          const entry = zoneIds.get(id);
          if (entry === undefined) return;
          zoneIds.delete(id);
          api.zones.splice(api.zones.indexOf(entry), 1);
          entry.domNode.remove();
        },
        layoutZone: () => {},
      });
    },
    getTopForLineNumber: (line) => (line - 1) * FAKE_LINE_HEIGHT,
    getSelection: () =>
      api.selection === null ? null : { ...api.selection, startColumn: 1, endColumn: 2 },
    // Как у настоящего `addAction`: сочетания действия — те же команды, что `press` вызывает.
    addAction: (descriptor) => {
      const keys = descriptor.keybindings ?? [];
      for (const key of keys) commands.set(key, () => descriptor.run(api));
      return {
        dispose: () => {
          for (const key of keys) commands.delete(key);
        },
      };
    },
    getOption: () => FAKE_LINE_HEIGHT,
    getLayoutInfo: () => ({ width: width(), height: 400, contentLeft: 50, contentWidth: Math.max(0, width() - 50), lineNumbersLeft: 0, lineNumbersWidth: 40 }),
    onDidLayoutChange: (listener) => {
      layoutListeners.add(listener);
      return { dispose: () => layoutListeners.delete(listener) };
    },
    onDidScrollChange: () => ({ dispose: () => {} }),
    getDomNode: () => domNode,
    // Overlay widgets (8.4b: карточки заметок над view zones) — в тот же DOM редактора.
    addOverlayWidget: (widget) => {
      domNode.appendChild(widget.getDomNode());
    },
    removeOverlayWidget: (widget) => {
      widget.getDomNode().remove();
    },
  };
  /** Смена раскладки (одна колонка ↔ две): слушатели `onDidLayoutChange`. */
  (api as EditorApi & { relayout(): void }).relayout = () => {
    for (const listener of layoutListeners) listener();
  };
  /** Правка человеком в textarea — текст модели. */
  (api as EditorApi & { typed(next: string): void }).typed = (next) => {
    api.text = next;
  };
  return api;
}

interface EditorProps {
  value?: string;
  defaultValue?: string;
  path?: string;
  options?: Record<string, unknown>;
  onChange?: (value: string | undefined) => void;
  onMount?: (editor: unknown, monaco: unknown) => void;
}

function Editor(props: EditorProps): ReactElement {
  // Бросает на каждом рендере, пока тест не снимет: React повторяет упавший рендер сам.
  if (renderError !== null) throw renderError;
  const [text, setText] = useState(props.value ?? props.defaultValue ?? '');
  const [editor] = useState(() => fakeEditor(props.value ?? props.defaultValue ?? '', props.options ?? {}, setText));
  useEffect(() => {
    editors.push(editor);
    props.onMount?.(editor, { KeyMod, KeyCode });
    return () => editor.dispose();
    // Монтирование — один раз, как у настоящего `Editor`.
  }, []);
  // Управляемое значение, как у `@monaco-editor/react`: новое `value` уходит в модель.
  useEffect(() => {
    if (props.value !== undefined && props.value !== editor.getValue()) editor.getModel()?.setValue(props.value);
  }, [props.value, editor]);
  return createElement(
    'div',
    { className: 'monaco-editor', 'data-testid': 'monaco-editor', 'data-path': props.path },
    createElement('textarea', {
      'data-testid': 'monaco-textarea',
      value: text,
      readOnly: editor.options.readOnly === true,
      onChange: (event: { target: { value: string } }) => {
        const next = event.target.value;
        (editor as EditorApi & { typed(next: string): void }).typed(next);
        setText(next);
        props.onChange?.(next);
      },
    }),
  );
}

interface DiffEditorProps {
  original?: string;
  modified?: string;
  options?: Record<string, unknown>;
  onMount?: (editor: unknown, monaco: unknown) => void;
}

function DiffEditor(props: DiffEditorProps): ReactElement {
  if (renderError !== null) throw renderError;
  const [diff] = useState(() => {
    let attached = true;
    // Одна колонка — левый редактор сжат до полосы номеров, как у настоящего diff-редактора.
    const original = fakeEditor(props.original ?? '', { readOnly: true }, () => {}, () => (api.options['renderSideBySide'] === false ? 5 : 400));
    const modified = fakeEditor(props.modified ?? '', props.options ?? {}, () => {});
    const api: FakeDiffEditor & Record<string, unknown> = {
      options: { ...props.options },
      original,
      modified,
      disposed: false,
      getOriginalEditor: () => original,
      getModifiedEditor: () => modified,
      getModel: () => (attached ? { original: { ...original.getModel(), dispose: () => {} }, modified: { ...modified.getModel(), dispose: () => {} } } : null),
      // `setModel(null)` — отвязка моделей перед размонтированием (FileDiffSection).
      setModel: (next: unknown) => {
        attached = next !== null;
      },
      updateOptions: (next: Record<string, unknown>) => {
        api.options = { ...api.options, ...next };
        for (const side of [original, modified]) (side as EditorApi & { relayout(): void }).relayout();
      },
      dispose: () => {
        api.disposed = true;
      },
    };
    return api;
  });
  useEffect(() => {
    diffEditors.push(diff);
    props.onMount?.(diff, { KeyMod, KeyCode });
    return () => {
      diff.disposed = true;
    };
  }, []);
  // Как у `@monaco-editor/react`: новый объект `options` после монтирования — `updateOptions`.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    (diff.updateOptions as (next: Record<string, unknown>) => void)(props.options ?? {});
  }, [props.options]);
  return createElement(
    'div',
    { className: 'monaco-editor', 'data-testid': 'monaco-diff-editor' },
    createElement('textarea', { 'data-testid': 'monaco-diff-original', value: props.original ?? '', readOnly: true }),
    createElement('textarea', { 'data-testid': 'monaco-diff-modified', value: props.modified ?? '', readOnly: true }),
    // Хозяева зон сторон (8.4b) — в DOM редактора; React их не пересоздаёт.
    createElement('div', {
      'data-side': 'original',
      ref: (element: HTMLElement | null) => {
        if (element !== null) element.appendChild((diff.original as EditorApi).getDomNode());
      },
    }),
    createElement('div', {
      'data-side': 'modified',
      ref: (element: HTMLElement | null) => {
        if (element !== null) element.appendChild((diff.modified as EditorApi).getDomNode());
      },
    }),
  );
}

const loader = {
  config: (): void => {},
  init: (): Promise<unknown> => {
    if (initError !== null) {
      const error = initError;
      initError = null;
      return Promise.reject(error);
    }
    return Promise.resolve({ KeyMod, KeyCode, editor: { EditorOption } });
  },
};

export const monacoReactMock: Record<string, unknown> = { default: Editor, Editor, DiffEditor, loader };

export const monacoSetupMock: Record<string, unknown> = {
  // `languages` — язык модели диффа по имени файла (8.3); у мока языков нет.
  setupMonaco: () => ({ KeyMod, KeyCode, languages: { getLanguages: () => [] }, editor: { EditorOption } }),
  applyEditorTheme: (dark: boolean) => {
    themes.push(dark);
  },
};

export const monacoMock = {
  editors,
  diffEditors,
  /** Вызовы `applyEditorTheme` по порядку. */
  themes,
  /** Следующий `loader.init()` отклонится — сбой загрузки Monaco. */
  rejectInit(error: Error): void {
    initError = error;
  },
  /** Рендер `Editor` и `DiffEditor` (8.3) бросает синхронно — сбой самого редактора; `null` снимает. */
  throwOnRender(error: Error | null): void {
    renderError = error;
  },
  reset(): void {
    editors.length = 0;
    globalCommands.clear();
    diffEditors.length = 0;
    themes.length = 0;
    initError = null;
    renderError = null;
  },
};
