import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostOf, isOpenableUrl, markdownTooDeep, parseMarkdown, type MdNode } from './parse';
import { columnWidths, noHyphenBreak, plainText } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const fixture = readFileSync('src/markdown/fixtures/human-table.md', 'utf8');
const kids = (n: MdNode): MdNode[] => n.children ?? [];
const types = (n: MdNode): string[] => kids(n).map((c) => c.type);
/** Flatten all descendants. */
const all = (n: MdNode): MdNode[] => [n, ...kids(n).flatMap(all)];

describe('markdown: the human table fixture', () => {
  const root = parseMarkdown(fixture);
  const table = kids(root).find((b) => b.type === 'table')!;

  it('is a 3-column table: header + 3 rows, inline code in the cells', () => {
    expect(types(root)).toEqual(['paragraph', 'table', 'paragraph', 'paragraph']);
    expect(table.align).toHaveLength(3);
    expect(kids(table)).toHaveLength(4);
    for (const row of kids(table)) expect(kids(row)).toHaveLength(3);
    expect(types(kids(kids(table)[1]!)[0]!)).toEqual(['inlineCode']);
    expect(plainText(kids(kids(table)[0]!)[1]!)).toBe('Как запускается');
    expect(plainText(kids(kids(table)[3]!)[1]!)).toBe('локальный бинарник ~/.pencil/mcp/...');
  });

  it('column widths: longest cell × 8 + 20, clamped 64…200, equal for every row', () => {
    const w = columnWidths(kids(table));
    expect(w).toHaveLength(3);
    expect(w[0]).toBe(Math.round('21st-dev-magic'.length * 1.1 * 8) + 20); // inline code weighs 1.1 per char
    expect(w[2]).toBe(200); // "не подключился: нет API-ключа" is wider than the cap and wraps
    expect(columnWidths([{ type: 'tableRow', children: [{ type: 'tableCell', children: [] }] }])).toEqual([64]);
  });

  it('keeps the long inline path as one inlineCode', () => {
    const para = kids(root)[3]!;
    expect(all(para).filter((n) => n.type === 'inlineCode').map((n) => n.value)).toContain('.mcp.json');
  });
});

describe('markdown: blocks', () => {
  it('nested lists, 3 levels, mixed markers, ordered start', () => {
    const root = parseMarkdown('- a\n  1. b\n     * c\n     * d\n  2. e\n- f\n\n3. x\n4. y');
    const [ul, ol] = kids(root);
    expect(ul!.type).toBe('list');
    expect(ul!.ordered).toBe(false);
    const inner = kids(kids(ul!)[0]!).find((n) => n.type === 'list')!;
    expect(inner.ordered).toBe(true);
    const deepest = kids(kids(inner)[0]!).find((n) => n.type === 'list')!;
    expect(deepest.ordered).toBe(false);
    expect(kids(deepest)).toHaveLength(2);
    expect(ol!.start).toBe(3);
  });

  it('task list items carry checked', () => {
    const list = kids(parseMarkdown('- [x] done\n- [ ] todo\n- plain'))[0]!;
    expect(kids(list).map((i) => i.checked)).toEqual([true, false, null]);
  });

  it('fenced code with a language: caption above, text intact', () => {
    const code = kids(parseMarkdown('```ts title="a"\nconst a = 1;\n```'))[0]!;
    expect(code).toMatchObject({ type: 'code', value: 'const a = 1;', caption: 'ts title="a"' });
    expect(kids(parseMarkdown('```\nx\n```'))[0]!.caption).toBeUndefined();
  });

  it('a quote with a list', () => {
    const quote = kids(parseMarkdown('> intro\n> - one\n> - two'))[0]!;
    expect(quote.type).toBe('blockquote');
    expect(types(quote)).toEqual(['paragraph', 'list']);
  });

  it('heading depth 1–6, thematic break', () => {
    const root = parseMarkdown('# a\n###### f\n\n---');
    expect(kids(root).map((b) => b.depth ?? b.type)).toEqual([1, 6, 'thematicBreak']);
  });

  it('GFM: strikethrough and autolinks (literal, www, angle)', () => {
    const para = kids(parseMarkdown('~~gone~~ https://example.com/a?b=1 www.example.org <https://x.example>'))[0]!;
    expect(all(para).some((n) => n.type === 'delete')).toBe(true);
    const links = all(para).filter((n) => n.type === 'link');
    expect(links.map((l) => l.url)).toEqual(['https://example.com/a?b=1', 'http://www.example.org', 'https://x.example']);
  });
});

describe('markdown: what Markdown hides stays visible', () => {
  it('raw HTML is literal text, never parsed', () => {
    const root = parseMarkdown('<div onclick="x">hi</div>\n\nA <b>bold</b> word');
    expect(root.children![0]).toMatchObject({ type: 'html', value: '<div onclick="x">hi</div>' });
    expect(all(root.children![1]!).filter((n) => n.type === 'html').map((n) => n.value)).toEqual(['<b>', '</b>']);
  });

  it('a link definition and a footnote definition become a paragraph with their source', () => {
    const root = parseMarkdown('See [x][a] and[^1].\n\n[a]: https://example.com "Title"\n\n[^1]: the note');
    const texts = kids(root).filter((b) => b.type === 'paragraph').map(plainText);
    expect(texts).toContain('[a]: https://example.com "Title"');
    expect(texts).toContain('[^1]: the note');
    expect(types(root)).toContain('definition');
    expect(texts[0]).toContain('[^1]');
  });

  it('a link or image title is shown as " (title)"', () => {
    const para = kids(parseMarkdown('[a](https://e.com "T") ![i](https://e.com/p.png "P")'))[0]!;
    expect(plainText(para)).toContain(' (T)');
    expect(plainText(para)).toContain(' (P)');
  });

  it('a table with excess cells becomes a code block with the table source', () => {
    const src = '| a | b |\n|---|---|\n| 1 | 2 | 3 |';
    const root = parseMarkdown(src);
    expect(root.children![0]).toMatchObject({ type: 'code', value: src });
  });
});

describe('markdown: line breaks and mentions', () => {
  it('a single newline is a break', () => {
    expect(types(kids(parseMarkdown('one\ntwo'))[0]!)).toEqual(['text', 'break', 'text']);
  });

  it('@s02 / @s-02 / @human in text only', () => {
    const para = kids(parseMarkdown('hi @s02 and @s-3, @human! mail a@s02.dev @humans'))[0]!;
    const ms = kids(para).filter((n) => n.type === 'mention' || n.type === 'humanMention');
    expect(ms.map((m) => m.sessionId ?? m.raw)).toEqual(['s-02', 's-03', '@human']);
  });

  it('not in inline code, code blocks or links', () => {
    const root = parseMarkdown('`@s02` [ask @s02](https://e.com/@s02)\n\n```\n@human\n```');
    expect(all(root).filter((n) => n.type === 'mention' || n.type === 'humanMention')).toEqual([]);
  });

  it('quotes deeper than 100 → raw text, no parse', () => {
    const deep = `${'>'.repeat(101)} x\n# not a heading`;
    expect(markdownTooDeep(deep)).toBe(true);
    const root = parseMarkdown(deep);
    expect(types(root)).toEqual(['paragraph']);
    expect(plainText(root)).toBe(deep);
    expect(markdownTooDeep(`${'>'.repeat(100)} x`)).toBe(false);
  });
});

describe('inline code display rules', () => {
  it('a hyphen never breaks the line, a path stays whole', () => {
    expect(noHyphenBreak('oh-my-claudecode')).toBe('oh-⁠my-⁠claudecode');
    expect(noHyphenBreak('~/.claude/plugins/cache/x')).toBe('~/.claude/plugins/cache/x');
  });
});

describe('markdown: no remote images, only http(s) links', () => {
  it('![](https://…) and <img> never load anything: the image keeps a host, raw HTML stays text', () => {
    const fetchSpy = vi.fn();
    const imageSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('Image', imageSpy);
    const para = kids(parseMarkdown('![alt](https://tracker.example.com/p.png) and <img src="https://evil.example.org/x.gif" width=1>'))[0]!;
    const img = kids(para).find((n) => n.type === 'image')!;
    expect(hostOf(img.url!)).toBe('tracker.example.com');
    expect(all(para).some((n) => n.type === 'html')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(imageSpy).not.toHaveBeenCalled();
  });
});

describe('markdown: links', () => {
  it('only strict http(s) is openable', () => {
    for (const ok of ['https://example.com/a?b#c', 'http://example.com:8080/x', 'HTTPS://Example.com']) expect(isOpenableUrl(ok)).toBe(true);
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'mailto:a@b.c', 'ftp://x.y', 'https://evil.com\\@good.com/', 'https://u:p@host.com/', 'https://a b.com', '//x.y'])
      expect(isOpenableUrl(bad)).toBe(false);
  });

  it('hostOf gives the host of a URL-looking string', () => {
    expect(hostOf('https://Example.com/x')).toBe('example.com');
    expect(hostOf('data:text/plain,hi')).toBeNull();
  });
});

describe('link host spoofing', () => {
  it('a link with a backslash/userinfo address is in the tree but not openable (rendered as text)', () => {
    const para = kids(parseMarkdown('[x](https://evil.com\\@good.com/x) and https://user@good.com/'))[0]!;
    for (const l of all(para).filter((n) => n.type === 'link')) expect(isOpenableUrl(l.url ?? '')).toBe(false);
  });
});

describe('the renderer cannot load anything', () => {
  it('Markdown.tsx imports no Image, WebView or fetch', () => {
    const src = readFileSync('src/markdown/Markdown.tsx', 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const rnImport = /import\s*\{([^}]*)\}\s*from 'react-native'/.exec(src)?.[1] ?? '';
    expect(rnImport).not.toMatch(/\bImage\b|WebView/);
    expect(src).not.toMatch(/fetch\(|expo-image|<Image|dangerouslySet/);
  });
});
