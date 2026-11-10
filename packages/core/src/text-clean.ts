// ESC (0x1b) и прочие управляющие знаки в регулярках ниже — не опечатка: это ровно те байты, которые вырезает очистка.
/* eslint-disable no-control-regex */
// OSC (заголовок окна, OSC 52 — буфер обмена и т.п.): тело до BEL или ST (ESC \\), без
// терминатора — до конца строки. Иначе OTHER_ESCAPE снял бы только ESC ']', а тело
// осталось бы печатным мусором в тексте pty.send.
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g;
// ECMA-48 CSI: ESC '[' параметры (0x30–0x3F) intermediate (0x20–0x2F) финальный байт (0x40–0x7E).
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// SS3 (клавиши F1-F4 в некоторых терминалах): ESC 'O' + один байт.
const SS3 = /\x1bO./g;
// Всё прочее ESC + один байт (Alt+клавиша, сброс терминала и т.п.).
const OTHER_ESCAPE = /\x1b./g;
// C0 кроме \t и \n, DEL и C1: в поле ввода агента это клавиши, а не текст.
const CONTROL_KEEP_TAB_LF = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
/* eslint-enable no-control-regex */
// Невидимые знаки формата: нулевая ширина, бидо-метки и изоляты, BOM. Соединители U+200C и U+200D
// остаются: без них ломаются составные эмодзи и письмо на фарси и хинди.
const INVISIBLE = /[\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
const INVISIBLE_CHAR = /[\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/;

/** Правила вырезания ESC-последовательностей; ими же чистит текст pty.send (спека 8.6, шаг 2). */
export function stripEscapes(data: string): string {
  return data.replace(OSC, '').replace(CSI, '').replace(SS3, '').replace(OTHER_ESCAPE, '');
}

/** Текст в одну строку для всего, что хост печатает в терминал сам: без управляющих знаков, переводов строк и невидимок. */
export function cleanInline(text: string, max = 80): string {
  const clean = stripEscapes(text)
    .replace(/\s+/g, ' ')
    .replace(CONTROL, '')
    .replace(INVISIBLE, '')
    .trim();
  return Array.from(clean).slice(0, max).join('').trim();
}

/** Текст человека с абзацами: остаются `\n` и `\t`, всё управляющее и ESC-последовательности вырезаются. */
export function cleanMultiline(text: string): string {
  return stripEscapes(text.replace(/\r\n?/g, '\n')).replace(CONTROL_KEEP_TAB_LF, '');
}

/** Есть ли в тексте строка оболочки: первый значащий знак строки — `!` (Claude Code исполняет её как команду). */
export function startsShellLine(text: string): boolean {
  return cleanMultiline(text)
    .split('\n')
    .some((line) => {
      for (const char of line) {
        if (char === ' ' || char === '\t' || INVISIBLE_CHAR.test(char)) continue;
        return char === '!';
      }
      return false;
    });
}
