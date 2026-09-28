/**
 * Редактор Monaco вкладки файла (кусок 7.3b, спека 10.4). Текст живёт в буфере стора
 * (`files/store.ts`), а не здесь: редактор получает его при монтировании и шлёт правки наверх.
 * Тело вкладки размонтируется при смене вкладки, переносе и вытеснении работы из LRU — курсор и
 * прокрутка переживают это в `viewStates` по ключу буфера.
 *
 * Сбой загрузки: `@monaco-editor/react` при отказе `loader.init()` только пишет в консоль и
 * остаётся в загрузке. Поэтому `init` зовётся здесь, отказ уходит в состояние и бросается из
 * рендера — его ловит граница ошибки `FileBody` («Editor didn't load»).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Editor, loader, type OnMount } from '@monaco-editor/react';
import { useUiStore } from '../../store/ui.js';
import { applyEditorTheme, setupMonaco } from './monaco-setup.js';

type CodeEditor = Parameters<OnMount>[0];
type ViewState = ReturnType<CodeEditor['saveViewState']>;

/**
 * Курсор и прокрутка размонтированных тел по ключу буфера. Не чистится: запись — несколько чисел
 * на когда-либо открытую вкладку файла за жизнь окна.
 */
const viewStates = new Map<string, ViewState>();

export interface MonacoEditorProps {
  /** Ключ буфера: по нему хранится курсор и прокрутка. */
  viewStateKey: string;
  /** Путь модели: язык Monaco берёт по расширению. */
  modelPath: string;
  text: string;
  readOnly: boolean;
  fontFamily: string;
  /** Размер шрифта терминала: редактору — на 1 меньше (спека 10.4). */
  fontSize: number;
  /** Разовая позиция курсора (строка и колонка с 1); после применения — `onRevealed`. */
  reveal: { line: number; col: number } | null;
  onRevealed(): void;
  onChange(text: string): void;
  onSave(): void;
}

/** Опции спеки 10.4. */
export function editorOptions(fontFamily: string, fontSize: number, readOnly: boolean, wrap: boolean): Record<string, unknown> {
  return {
    fontFamily,
    fontSize: Math.max(1, fontSize - 1),
    minimap: { enabled: false },
    renderWhitespace: 'selection',
    wordWrap: wrap ? 'on' : 'off',
    scrollBeyondLastLine: false,
    readOnly,
    automaticLayout: true,
  };
}

/**
 * Monaco готов: `setupMonaco` и `loader.init()`, тема — по `.dark`. Отказ — в состоянии: вызывающий бросает его из
 * рендера, и граница ошибки показывает «Editor didn't load».
 */
export function useMonacoReady(): 'loading' | 'ready' | Error {
  const [status, setStatus] = useState<'loading' | 'ready' | Error>('loading');
  useEffect(() => {
    let alive = true;
    try {
      setupMonaco();
    } catch (error) {
      setStatus(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    loader.init().then(
      () => {
        if (alive) setStatus('ready');
      },
      (error: unknown) => {
        console.warn('[harnas] monaco loader.init', error);
        if (alive) setStatus(error instanceof Error ? error : new Error(String(error)));
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  // Тема Monaco — вместе с `.dark` окна (тёмность `nativeTheme` main).
  const dark = useUiStore((state) => state.dark);
  useEffect(() => {
    if (status === 'ready') applyEditorTheme(dark);
  }, [status, dark]);
  return status;
}

export function MonacoEditor(props: MonacoEditorProps): JSX.Element {
  const { viewStateKey, modelPath, text, readOnly, fontFamily, fontSize, reveal, onRevealed } = props;
  const status = useMonacoReady();
  const [editor, setEditor] = useState<CodeEditor | null>(null);
  const [wrap, setWrap] = useState(false);
  const wrapRef = useRef(false);
  // Одна ссылка, пока опции те же: `@monaco-editor/react` зовёт `updateOptions` на каждую новую, и
  // перенос ⌥Z сбрасывался бы на каждой перерисовке.
  const options = useMemo(() => editorOptions(fontFamily, fontSize, readOnly, wrap), [fontFamily, fontSize, readOnly, wrap]);
  const dark = useUiStore((state) => state.dark);
  // Команды Monaco заводятся один раз при монтировании — свежие обработчики через ref.
  const handlers = useRef(props);
  handlers.current = props;

  useEffect(() => {
    editor?.updateOptions({ readOnly, fontFamily, fontSize: Math.max(1, fontSize - 1) });
  }, [editor, readOnly, fontFamily, fontSize]);

  // Текст сменился не правкой в редакторе (перезагрузка с диска): модель — новым текстом, курсор
  // и прокрутка — прежние (спека 10.5).
  useEffect(() => {
    const model = editor?.getModel() ?? null;
    if (editor === null || model === null || model.getValue() === text) return;
    const view = editor.saveViewState();
    model.setValue(text);
    if (view !== null) editor.restoreViewState(view);
  }, [editor, text]);

  useEffect(() => {
    if (editor === null || reveal === null) return;
    editor.setPosition({ lineNumber: reveal.line, column: reveal.col });
    // Позиция, а не строка (раунд fix-7.4, п. 2): совпадение глубоко в длинной (переносимой) строке
    // иначе оставалось бы за краем — видно было бы только начало строки.
    editor.revealPositionInCenter({ lineNumber: reveal.line, column: reveal.col });
    editor.focus();
    onRevealed();
  }, [editor, reveal, onRevealed]);

  // Вид — при уходе тела: следующее монтирование той же вкладки вернёт курсор и прокрутку.
  useEffect(
    () => () => {
      if (editor === null) return;
      try {
        viewStates.set(viewStateKey, editor.saveViewState());
      } catch (error) {
        // Редактор уже отпущен — вид не сохранится, курсор встанет в начало.
        console.warn('[harnas] monaco saveViewState', error);
      }
    },
    [editor, viewStateKey],
  );

  if (status instanceof Error) throw status;
  if (status === 'loading') return <div className="h-full" />;

  const onMount: OnMount = (mounted) => {
    const { KeyMod, KeyCode } = setupMonaco();
    mounted.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, () => handlers.current.onSave());
    // ⌥Z — перенос строк: своего такого сочетания у Monaco нет, а на macOS ⌥Z напечатал бы «Ω».
    mounted.addCommand(KeyMod.Alt | KeyCode.KeyZ, () => {
      const next = !wrapRef.current;
      wrapRef.current = next;
      mounted.updateOptions({ wordWrap: next ? 'on' : 'off' });
      setWrap(next);
    });
    const saved = viewStates.get(viewStateKey);
    if (saved !== undefined && saved !== null) mounted.restoreViewState(saved);
    setEditor(mounted);
  };

  return (
    <Editor
      className="h-full"
      path={modelPath}
      defaultValue={text}
      theme={dark ? 'harnas-dark' : 'harnas-light'}
      loading={null}
      options={options}
      onChange={(value) => handlers.current.onChange(value ?? '')}
      onMount={onMount}
    />
  );
}
