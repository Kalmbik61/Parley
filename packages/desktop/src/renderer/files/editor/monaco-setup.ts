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
  // без обработчика («Canceled»): это не сбой, в консоль и в `pageerror` ей незачем.
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    if (reason instanceof Error && reason.name === 'Canceled' && reason.message === 'Canceled') event.preventDefault();
  });
  ready = true;
  applyEditorTheme(document.documentElement.classList.contains('dark'));
  return monaco;
}

/** Цвет токена, если он в hex (Monaco понимает только hex); иначе — запасной. */
function tokenColor(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = style.getPropertyValue(name).trim();
  return /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback;
}

/**
 * Темы `harnas-dark` и `harnas-light` из токенов окна (фон `--editor-surface`). Токены читаются
 * в момент вызова: его зовут после смены `.dark` на `<html>`, и переменные уже нужной темы.
 */
export function applyEditorTheme(dark: boolean): void {
  const style = getComputedStyle(document.documentElement);
  const name = dark ? 'harnas-dark' : 'harnas-light';
  const background = tokenColor(style, '--editor-surface', dark ? '#1e1e1e' : '#ffffff');
  const foreground = tokenColor(style, '--foreground', dark ? '#fafafa' : '#0a0a0a');
  monaco.editor.defineTheme(name, {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': background,
      'editor.foreground': foreground,
      'editorCursor.foreground': foreground,
      'editorGutter.background': background,
      // Выделение — полупрозрачный синий палитры окна (как у Orca): читается на обоих фонах.
      'editor.selectionBackground': dark ? '#264f78' : '#add6ff',
    },
  });
  monaco.editor.setTheme(name);
}
