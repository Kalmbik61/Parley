/**
 * Ссылки Markdown — чистые функции без DOM (кусок 7.5, спека 10.6; вынесены из
 * `files/preview/MarkdownPreview.tsx` в 0.2.0): куда ведёт ссылка (`resolveMarkdownLink`) и какие адреса
 * `react-markdown` вообще пропускает (`safeUrlTransform`). Их зовут и превью файлов, и лента комнаты
 * (`components/rooms/RoomMarkdown.tsx`): правила безопасности ссылок у обоих одни.
 */

export type MarkdownLink =
  | { kind: 'external'; url: string }
  | { kind: 'file'; path: string }
  | { kind: 'anchor'; id: string }
  | null;

function decode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/**
 * Куда ведёт ссылка из файла `filePath` (путь от корня). Относительный путь — от папки файла,
 * `/путь` — от корня; хвост `?…` и `#…` у пути отбрасывается. Выход выше корня — null: main
 * отказал бы всё равно, а вкладка с `../` в пути — мусор раскладки.
 */
export function resolveMarkdownLink(href: string, filePath: string): MarkdownLink {
  const raw = href.trim();
  if (raw === '') return null;
  if (raw.startsWith('#')) {
    const id = decode(raw.slice(1));
    return id === null || id === '' ? null : { kind: 'anchor', id };
  }
  // Схема (`https:`, `javascript:`, `file:`) или адрес без схемы `//хост`.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
    if (!/^https?:/i.test(raw)) return null;
    // Адрес уходит как написан: разбор только проверяет, что он годен.
    return URL.canParse(raw) ? { kind: 'external', url: raw } : null;
  }
  const cut = raw.search(/[?#]/);
  const decoded = decode(cut < 0 ? raw : raw.slice(0, cut));
  if (decoded === null || decoded === '') return null;
  const base = decoded.startsWith('/') ? [] : filePath.split('/').slice(0, -1);
  const parts = [...base];
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length === 0 ? null : { kind: 'file', path: parts.join('/') };
}

/**
 * `urlTransform` превью (fix-7.5): свой вместо штатного, но такой же запирающий — пропускает
 * `http(s):`, относительные пути и `#якоря`, прочее (`javascript:`, `data:`, `file:`, `vbscript:`,
 * `mailto:`, `//хост`) — пустая строка. Так опасный адрес не доходит даже до своих `a`/`img`, и
 * их будущая правка (скажем, `href` для «открыть в новой вкладке») не откроет дорогу XSS.
 * Табуляции, переводы строк и управляющие символы по краям браузер выбрасывает из адреса сам
 * (`java\tscript:`), поэтому схема проверяется уже без них.
 */
export function safeUrlTransform(url: string): string {
  // eslint-disable-next-line no-control-regex -- управляющие символы и есть то, что вычищается
  const bare = url.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
  // `//хост` и `\\хост` браузер читает как адрес другого хоста.
  if (/^[/\\]{2}/.test(bare)) return '';
  const colon = bare.indexOf(':');
  const end = bare.search(/[/?#]/);
  // Двоеточие до первого `/`, `?`, `#` — это схема; двоеточие дальше — часть пути (`a/b:c.md`).
  if (colon === -1 || (end !== -1 && end < colon)) return url;
  return /^https?$/i.test(bare.slice(0, colon)) ? url : '';
}
