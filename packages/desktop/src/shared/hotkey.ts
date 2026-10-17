/**
 * Сочетания клавиш помощника: подпись для людей (`Alt+Space` → `⌥Space`) и обратная задача — accelerator Electron
 * из нажатия (поле сочетания в Settings → Assistant). Чистые функции, без DOM.
 */

const KEY_MARKS: ReadonlyArray<[RegExp, string]> = [
  [/^(CmdOrCtrl|CommandOrControl|Command|Cmd|Meta|Super)$/i, '⌘'],
  [/^(Control|Ctrl)$/i, '⌃'],
  [/^(Alt|Option)$/i, '⌥'],
  [/^Shift$/i, '⇧'],
];

/** `Alt+Space` → `⌥Space`: модификаторы символами macOS, клавиша как есть. */
export function hotkeyLabel(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => KEY_MARKS.find(([pattern]) => pattern.test(part))?.[1] ?? part)
    .join('');
}

export interface HotkeyPress {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Клавиши с именем, не выводимым из `code` правилом. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`',
};

function keyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1]!;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return NAMED_KEYS[code] ?? null;
}

/**
 * Accelerator Electron из нажатия: модификаторы в порядке Command (на mac; иначе Super), Control, Alt, Shift, затем
 * клавиша по `code`. `null` — нет модификатора (глобальное сочетание без него перехватывало бы печать) или нажат
 * только модификатор, или Escape.
 */
export function acceleratorFromPress(press: HotkeyPress, mac: boolean): string | null {
  const key = keyName(press.code);
  if (key === null) return null;
  const parts: string[] = [];
  if (press.metaKey) parts.push(mac ? 'Command' : 'Super');
  if (press.ctrlKey) parts.push('Control');
  if (press.altKey) parts.push('Alt');
  if (press.shiftKey) parts.push('Shift');
  if (parts.length === 0) return null;
  return [...parts, key].join('+');
}
