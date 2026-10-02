/**
 * Разбор YAML-шапки `SKILL.md`, файла команды или субагента (живая проверка 2026-10-02): нужны только
 * `name` и `description`, поэтому полноценного YAML нет — берутся первые строки этих ключей.
 */

/** Сколько начала файла читается: шапка короткая, остальное подсказкам не нужно. */
export const FRONTMATTER_BYTES = 4096;

export interface Frontmatter {
  name: string | null;
  description: string | null;
}

function unquote(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}

/** Значение ключа: на той же строке; для `>`/`|` и пустого — первая непустая строка с отступом. */
function valueOf(lines: string[], index: number, rest: string): string | null {
  let value = rest.trim();
  if (value === '' || /^[>|][+-]?$/.test(value)) {
    value = '';
    for (let i = index + 1; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (line.trim() === '') continue;
      if (!/^\s/.test(line)) break;
      value = line.trim();
      break;
    }
  }
  value = unquote(value);
  return value === '' ? null : value;
}

export function parseFrontmatter(text: string): Frontmatter {
  const head = text.slice(0, FRONTMATTER_BYTES);
  const lines = (head.charCodeAt(0) === 0xfeff ? head.slice(1) : head).split(/\r?\n/);
  const result: Frontmatter = { name: null, description: null };
  if (lines[0]?.trim() !== '---') return result;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '---') break;
    const match = /^(name|description)\s*:(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1] as 'name' | 'description';
    if (result[key] === null) result[key] = valueOf(lines, i, match[2] ?? '');
  }
  return result;
}
