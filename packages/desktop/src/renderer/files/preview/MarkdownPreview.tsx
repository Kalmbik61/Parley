/**
 * Превью Markdown (кусок 7.5, спека 10.6): `react-markdown` + `remark-gfm`, **без** `rehype-raw` —
 * сырой HTML из файла агента печатается текстом, а не исполняется (как у письма, `Letter.tsx`).
 *
 * Ссылки и картинки идут только через `resolveMarkdownLink`: `http(s)` — наружу через
 * `openPreviewUrl`, относительный путь — вкладка файла того же корня, `#якорь` — прокрутка к
 * заголовку. Прочее (`javascript:`, `file:`, `data:`) — ничего. Переход окна по `<a>` погашен
 * всегда: иначе чужой адрес открылся бы в самом окне. Картинки — только из корня, байтами
 * `files.readBytes` в `Blob`: проверка корней действует и здесь, `file://` в рендерере нет, а
 * удалённые картинки CSP (`img-src`) и так не пустит — вместо них подпись `alt`.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ParleyBridge } from '../../../shared/bridge.js';
import type { FileRoot } from '../../../shared/files-types.js';
import { rootKey } from '../../../shared/work-keys.js';
import { imageType, useObjectUrl } from './object-url.js';
import { openPreviewUrl } from './open-external.js';

export type MarkdownLink = { kind: 'external'; url: string } | { kind: 'file'; path: string } | { kind: 'anchor'; id: string } | null;

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

/** id заголовка в духе GitHub: строчные, без знаков, пробелы — дефисы. Кириллица остаётся. */
function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

/** Текст узла hast — для id заголовка. */
function textOf(node: unknown): string {
  if (typeof node !== 'object' || node === null) return '';
  const item = node as { type?: string; value?: string; children?: unknown[] };
  if (item.type === 'text') return item.value ?? '';
  return (item.children ?? []).map(textOf).join('');
}

function MarkdownImage({ bridge, root, path, alt }: { bridge: ParleyBridge; root: FileRoot; path: string; alt: string }): JSX.Element {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const url = useObjectUrl(bytes, imageType(path));
  const rootId = rootKey(root);
  useEffect(() => {
    let alive = true;
    bridge.files
      .readBytes(root, path)
      .then((data) => {
        if (alive) setBytes(data);
      })
      .catch((error: unknown) => console.warn('[parley] files.readBytes', error));
    return () => {
      alive = false;
    };
    // Корень — в `rootId`: объект `root` новый на каждую отрисовку тела.
  }, [bridge, rootId, path]);
  if (url === null) return <span className="text-muted-foreground">{alt}</span>;
  return <img src={url} alt={alt} className="max-w-full" />;
}

export interface MarkdownPreviewProps {
  bridge: ParleyBridge;
  root: FileRoot;
  /** Путь файла от корня — база относительных ссылок. */
  filePath: string;
  text: string;
  onOpenFile(path: string): void;
}

type HeadingProps = JSX.IntrinsicElements['h1'] & ExtraProps;

export function MarkdownPreview({ bridge, root, filePath, text, onOpenFile }: MarkdownPreviewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const rootId = rootKey(root);
  const openFileRef = useRef(onOpenFile);
  openFileRef.current = onOpenFile;

  // Компоненты — по корню и файлу, а не на каждую отрисовку: новые функции React счёл бы новыми
  // типами и перемонтировал картинки — с новым чтением байтов на каждую правку.
  const components = useMemo((): Components => {
    const follow = (href: string | undefined): void => {
      const link = resolveMarkdownLink(href ?? '', filePath);
      if (link === null) return;
      if (link.kind === 'external') openPreviewUrl(link.url);
      else if (link.kind === 'file') openFileRef.current(link.path);
      else {
        const target = [...(containerRef.current?.querySelectorAll<HTMLElement>('[id]') ?? [])].find((el) => el.id === link.id);
        target?.scrollIntoView({ block: 'start' });
      }
    };
    const heading =
      (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') =>
      ({ node, children }: HeadingProps): JSX.Element => <Tag id={slug(textOf(node))}>{children as ReactNode}</Tag>;
    return {
      a: ({ href, children }) => {
        const link = resolveMarkdownLink(href ?? '', filePath);
        return (
          <a
            // Адрес — только подсказкой наведения у внешней ссылки; переход окна погашен всегда.
            title={link?.kind === 'external' ? link.url : undefined}
            role="link"
            tabIndex={0}
            className="cursor-pointer text-primary underline"
            onClick={(event) => {
              event.preventDefault();
              follow(href);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              follow(href);
            }}
          >
            {children}
          </a>
        );
      },
      img: ({ src, alt }) => {
        const link = typeof src === 'string' ? resolveMarkdownLink(src, filePath) : null;
        if (link?.kind !== 'file') return <span className="text-muted-foreground">{alt ?? ''}</span>;
        return <MarkdownImage bridge={bridge} root={root} path={link.path} alt={alt ?? ''} />;
      },
      h1: heading('h1'),
      h2: heading('h2'),
      h3: heading('h3'),
      h4: heading('h4'),
      h5: heading('h5'),
      h6: heading('h6'),
    };
    // `root` меняется вместе с `rootId`.
  }, [bridge, rootId, filePath]);

  return (
    <div
      ref={containerRef}
      data-testid="markdown-preview"
      className={[
        'h-full min-w-0 overflow-auto px-6 py-4 text-sm leading-relaxed break-words text-foreground',
        '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold',
        '[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-lg [&_h3]:font-semibold [&_h4]:mt-3 [&_h4]:font-semibold [&_h5]:font-semibold [&_h6]:font-semibold',
        '[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
        '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.9em]',
        '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_pre_code]:px-0',
        '[&_table]:my-2 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_td]:border [&_td]:border-border [&_td]:px-2 [&_th]:border [&_th]:border-border [&_th]:px-2',
        '[&_hr]:my-4 [&_hr]:border-border',
      ].join(' ')}
    >
      {/* Штатная чистка react-markdown пропустила бы `mailto:`, `irc:`, `xmpp:`; своя — только http(s), пути и якоря. */}
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={safeUrlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
