/**
 * Последнее звено селектора скриптов страницы (`guest-dom.js#selectorOf`: `tag#id` или `tag.class1.class2` с
 * `:nth-of-type`): по нему окно строит
 * метку файла-контекста (`context-markdown.ts#elementLabel`), а main сверяет узел, найденный CDP по точке клика
 * (`main/browser/element-info.ts`). Имена в селекторе экранированы `CSS.escape` — здесь обратное преобразование.
 */

export interface SelectorTail {
  tag: string;
  id: string | null;
  classes: string[];
}

function unescapeCss(value: string): string {
  return value.replace(/\\([0-9a-fA-F]{1,6}) ?|\\([\s\S])/g, (_whole: string, hex: string | undefined, char: string | undefined) =>
    hex !== undefined ? String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff)) : (char ?? ''),
  );
}

export function selectorTail(selector: string): SelectorTail {
  const last = (selector.split(' > ').at(-1) ?? '').replace(/:nth-of-type\(\d+\)/g, '');
  const tag = (/^[a-zA-Z][a-zA-Z0-9-]*/.exec(last)?.[0] ?? '').toLowerCase();
  const parts = Array.from(last.slice(tag.length).matchAll(/([#.])((?:\\[0-9a-fA-F]{1,6} ?|\\[\s\S]|[^.#\\])+)/g));
  const id = parts.find((part) => part[1] === '#')?.[2];
  return {
    tag,
    id: id === undefined ? null : unescapeCss(id),
    classes: parts.filter((part) => part[1] === '.').map((part) => unescapeCss(part[2] ?? '')),
  };
}
