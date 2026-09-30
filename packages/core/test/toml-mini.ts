/**
 * Мини-разбор TOML для тестов: ровно то, что харнесс отдаёт Codex значениями `-c` (строки,
 * массивы, инлайн-таблицы, целые). Нужен как строгий оракул: Codex разбирает значение `-c` как
 * TOML и при первой же неудаче молча берёт его обычной строкой — кривое экранирование не дало
 * бы ошибки, а превратило бы таблицу сервера в текст. Разборщик тестов такого не прощает: сырой
 * управляющий знак в строке, неизвестный `\`-escape, суррогат в `\u`, запятая перед `}` — всё
 * это отказ, как у настоящего TOML 1.0.
 */

export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const SHORT_ESCAPES: Record<string, string> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
};

class Cursor {
  pos = 0;
  constructor(readonly text: string) {}

  peek(): string | undefined {
    return this.text[this.pos];
  }

  skipSpace(): void {
    while (this.text[this.pos] === ' ' || this.text[this.pos] === '\t') this.pos += 1;
  }

  expect(char: string): void {
    this.skipSpace();
    if (this.text[this.pos] !== char) {
      throw new Error(`TOML: ожидалось «${char}» на позиции ${this.pos} в ${this.text}`);
    }
    this.pos += 1;
  }

  done(): boolean {
    this.skipSpace();
    return this.pos >= this.text.length;
  }
}

function hexScalar(cursor: Cursor, length: number): string {
  const digits = cursor.text.slice(cursor.pos, cursor.pos + length);
  if (digits.length !== length || !/^[0-9A-Fa-f]+$/.test(digits)) {
    throw new Error(`TOML: escape \\u с неверными цифрами «${digits}»`);
  }
  const code = Number.parseInt(digits, 16);
  // Одиночный суррогат и всё выше U+10FFFF — не скаляр Unicode: такой escape TOML отвергает.
  if ((code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) {
    throw new Error(`TOML: escape U+${digits} — не скаляр Unicode`);
  }
  cursor.pos += length;
  return String.fromCodePoint(code);
}

function parseString(cursor: Cursor): string {
  cursor.expect('"');
  let result = '';
  for (;;) {
    const char = cursor.text[cursor.pos];
    if (char === undefined) throw new Error('TOML: строка не закрыта');
    cursor.pos += 1;
    if (char === '"') return result;
    if (char === '\\') {
      const next = cursor.text[cursor.pos];
      cursor.pos += 1;
      if (next === undefined) throw new Error('TOML: escape без продолжения');
      if (next === 'u') result += hexScalar(cursor, 4);
      else if (next === 'U') result += hexScalar(cursor, 8);
      else if (next in SHORT_ESCAPES) result += SHORT_ESCAPES[next];
      else throw new Error(`TOML: неизвестный escape \\${next}`);
      continue;
    }
    const code = char.charCodeAt(0);
    // Табуляция в базовой строке разрешена, остальные управляющие и DEL — только escape-ом.
    if ((code <= 0x08 || (code >= 0x0a && code <= 0x1f) || code === 0x7f) && code !== 0x09) {
      throw new Error(
        `TOML: сырой управляющий знак U+${code.toString(16).padStart(4, '0')} в строке`,
      );
    }
    result += char;
  }
}

function parseKey(cursor: Cursor): string {
  cursor.skipSpace();
  if (cursor.peek() === '"') return parseString(cursor);
  const match = /^[A-Za-z0-9_-]+/.exec(cursor.text.slice(cursor.pos));
  if (match === null) throw new Error(`TOML: ключ ожидался на позиции ${cursor.pos}`);
  cursor.pos += match[0].length;
  return match[0];
}

function parseValue(cursor: Cursor): TomlValue {
  cursor.skipSpace();
  const char = cursor.peek();
  if (char === '"') return parseString(cursor);
  if (char === '[') {
    cursor.pos += 1;
    const items: TomlValue[] = [];
    for (;;) {
      cursor.skipSpace();
      if (cursor.peek() === ']') {
        cursor.pos += 1;
        return items;
      }
      if (items.length > 0) cursor.expect(',');
      cursor.skipSpace();
      // Запятая после последнего элемента массиву разрешена.
      if (cursor.peek() === ']') continue;
      items.push(parseValue(cursor));
    }
  }
  if (char === '{') {
    cursor.pos += 1;
    const table: { [key: string]: TomlValue } = {};
    cursor.skipSpace();
    if (cursor.peek() === '}') {
      cursor.pos += 1;
      return table;
    }
    for (;;) {
      const key = parseKey(cursor);
      if (key in table) throw new Error(`TOML: ключ ${key} повторён`);
      cursor.expect('=');
      table[key] = parseValue(cursor);
      cursor.skipSpace();
      if (cursor.peek() === '}') {
        cursor.pos += 1;
        return table;
      }
      // Запятая в инлайн-таблице — только между парами: после последней TOML 1.0 её не терпит.
      cursor.expect(',');
    }
  }
  const rest = cursor.text.slice(cursor.pos);
  const integer = /^[+-]?\d+/.exec(rest);
  if (integer !== null) {
    cursor.pos += integer[0].length;
    return Number(integer[0]);
  }
  if (rest.startsWith('true')) {
    cursor.pos += 4;
    return true;
  }
  if (rest.startsWith('false')) {
    cursor.pos += 5;
    return false;
  }
  throw new Error(`TOML: значение не распознано на позиции ${cursor.pos}: ${rest.slice(0, 20)}`);
}

/** Значение целиком; хвост после него — ошибка. */
export function parseTomlValue(text: string): TomlValue {
  const cursor = new Cursor(text);
  const value = parseValue(cursor);
  if (!cursor.done()) throw new Error(`TOML: лишнее после значения: ${text.slice(cursor.pos)}`);
  return value;
}

/**
 * Присваивание в виде, каким его принимает `codex -c`: `путь.через.точки=значение`. Ключ режется
 * по первому `=`, значение обязано быть TOML — иначе Codex взял бы его строкой.
 */
export function parseTomlAssignment(text: string): { key: string[]; value: TomlValue } {
  const at = text.indexOf('=');
  if (at === -1) throw new Error(`TOML: в «${text}» нет «=»`);
  const key = text.slice(0, at).trim();
  const parts = key.split('.');
  if (parts.some((part) => !BARE_KEY.test(part))) throw new Error(`TOML: ключ «${key}» не годится`);
  return { key: parts, value: parseTomlValue(text.slice(at + 1)) };
}
