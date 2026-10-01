/**
 * Тема Monaco из токенов окна (кусок 7.3b, спека 10.4; раунд fix-7.3b). Отдельно от
 * `monaco-setup.ts`: тот тянет весь Monaco и воркеры `?worker`, а это — чистая логика, её
 * проверяют юнит-тесты без Monaco.
 */

/** Часть `monaco.editor`, которой хватает теме. */
export interface ThemeApi {
  defineTheme(name: string, data: {
    base: 'vs' | 'vs-dark';
    inherit: boolean;
    rules: never[];
    colors: Record<string, string>;
  }): void;
  setTheme(name: string): void;
}

/**
 * Цвет для Monaco: только полный hex `#rrggbb`/`#rrggbbaa`. Сборка сжимает `#ffffff` в `#fff`, а
 * Monaco короткий hex в `editor.background` не принимает («Illegal value for token color») —
 * поэтому `#rgb`/`#rgba` разворачиваются. Не hex (`rgb(…)`, `oklch(…)`) — запасной.
 */
export function tokenColor(value: string, fallback: string): string {
  const color = value.trim();
  if (/^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) return color;
  if (/^#[0-9a-f]{3,4}$/i.test(color)) return `#${[...color.slice(1)].map((digit) => digit + digit).join('')}`;
  return fallback;
}

/**
 * Темы `parley-dark` и `parley-light` из токенов окна (фон `--editor-surface`). Токены читаются
 * в момент вызова: его зовут после смены `.dark` на `<html>`, и переменные уже нужной темы.
 * Сбой своей темы не роняет редактор: встроенная `vs`/`vs-dark` и предупреждение в консоль —
 * текст файла важнее цвета фона.
 */
export function applyTheme(api: ThemeApi, dark: boolean, style: CSSStyleDeclaration): void {
  const name = dark ? 'parley-dark' : 'parley-light';
  const background = tokenColor(style.getPropertyValue('--editor-surface'), dark ? '#1e1e1e' : '#ffffff');
  const foreground = tokenColor(style.getPropertyValue('--foreground'), dark ? '#fafafa' : '#0a0a0a');
  try {
    api.defineTheme(name, {
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
    api.setTheme(name);
  } catch (error) {
    console.warn('[parley] monaco theme', error);
    api.setTheme(dark ? 'vs-dark' : 'vs');
  }
}
