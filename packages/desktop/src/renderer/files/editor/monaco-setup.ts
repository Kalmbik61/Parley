/**
 * Локальный Monaco (кусок 7.3b, спека 10.4): `monaco-editor` в режиме ESM из пакета, воркеры —
 * модулями `?worker` electron-vite. CDN не используется: `@monaco-editor/react` по умолчанию
 * грузит Monaco с jsdelivr, `loader.config({ monaco })` отдаёт ему уже собранный.
 *
 * Модуль тяжёлый (весь Monaco со всеми языками): его импортирует только `MonacoEditor.tsx` и
 * `CompareView.tsx`, а их `FileBody` грузит лениво — окно без открытых файлов Monaco не тянет.
 */

import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { isMonacoCancel } from './monaco-cancel.js';
import { applyTheme } from './editor-theme.js';

let ready = false;

/** Воркер по метке языка — как в примере Monaco для ESM-сборки. */
function workerFor(label: string): Worker {
  if (label === 'json') return new JsonWorker();
  if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
  if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
  if (label === 'typescript' || label === 'javascript') return new TsWorker();
  return new EditorWorker();
}

/** Один раз на окно: воркеры, проверка TS/JS, темы и `loader.config`. */
export function setupMonaco(): typeof import('monaco-editor') {
  if (ready) return monaco;
  self.MonacoEnvironment = { getWorker: (_workerId: string, label: string) => workerFor(label) };
  // Без проекта (tsconfig, node_modules) семантическая проверка шумит на каждом импорте.
  const diagnostics = { noSemanticValidation: true, noSyntaxValidation: false };
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(diagnostics);
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(diagnostics);
  loader.config({ monaco });
  // Monaco отменяет свои отложенные операции (подсветка слов, подсказки) при `dispose` редактора —
  // а тело вкладки размонтируется на каждой смене вкладки. Отмена приходит отклонённым промисом
  // без обработчика («Canceled»): это не сбой, в консоль и в `pageerror` ей незачем. Только его
  // отмена (fix-7.3 п. 7) — чужая `Canceled` окна остаётся видна.
  const monacoUrl = import.meta.url;
  window.addEventListener('unhandledrejection', (event) => {
    if (isMonacoCancel(event.reason, monacoUrl)) event.preventDefault();
  });
  ready = true;
  applyEditorTheme(document.documentElement.classList.contains('dark'));
  return monaco;
}

/** Тема Monaco по тёмности окна — из токенов `<html>` в момент вызова (`editor-theme.ts`). */
export function applyEditorTheme(dark: boolean): void {
  applyTheme(monaco.editor, dark, getComputedStyle(document.documentElement));
}
