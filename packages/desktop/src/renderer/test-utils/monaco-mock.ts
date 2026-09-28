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
export const KeyCode = { KeyD: 34, KeyF: 36, KeyK: 41, KeyS: 49, KeyZ: 56, Slash: 90 } as const;

type Position = { lineNumber: number; column: number };

export interface FakeEditor {
  /** Опции монтирования и все `updateOptions`, слитые по порядку. */
  options: Record<string, unknown>;
  /** Последний `setPosition` (и строка `revealLineInCenter`). */
  position: Position | null;
  /** Команда `addCommand` — как нажатие сочетания в редакторе. */
  press(keybinding: number): void;
  /** Текст модели — как его видит редактор. */
  getValue(): string;
  /** Текст модели (8.3): `getValue` / `setValue` модели. */
  text: string;
  /** Прокрутка (8.3): `getScrollTop` / `setScrollTop`. */
  scrollTop: number;
  /** Размонтирован: тело вкладки ушло. */
  disposed: boolean;
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
}

const editors: FakeEditor[] = [];
const diffEditors: FakeDiffEditor[] = [];
const themes: boolean[] = [];
let initError: Error | null = null;
let renderError: Error | null = null;

function fakeEditor(initial: string, options: Record<string, unknown>, setText: (text: string) => void): EditorApi {
  const commands = new Map<number, () => void>();
  const api: EditorApi = {
    options: { ...options },
    position: null,
    disposed: false,
    text: initial,
    scrollTop: 0,
    press: (keybinding) => commands.get(keybinding)?.(),
    getValue: () => api.text,
    addCommand: (keybinding, handler) => {
      commands.set(keybinding, handler);
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
    },
    revealPositionInCenter: () => {},
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
    const original = fakeEditor(props.original ?? '', { readOnly: true }, () => {});
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
    return Promise.resolve({ KeyMod, KeyCode });
  },
};

export const monacoReactMock: Record<string, unknown> = { default: Editor, Editor, DiffEditor, loader };

export const monacoSetupMock: Record<string, unknown> = {
  // `languages` — язык модели диффа по имени файла (8.3); у мока языков нет.
  setupMonaco: () => ({ KeyMod, KeyCode, languages: { getLanguages: () => [] } }),
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
    diffEditors.length = 0;
    themes.length = 0;
    initError = null;
    renderError = null;
  },
};
