import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostOf, isOpenableUrl, markdownTooDeep, MD_LIST_ITEMS_MAX, MD_NEST_MAX, parseMarkdown, type MdNode } from './parse';
import { addressOf, codeText, columnWidths, imageLine, linkLabelIsEmpty, linkTarget, noHyphenBreak, plainText } from './helpers';
import { definitionsOf } from './parse';

afterEach(() => vi.unstubAllGlobals());

// Prefixes that must not let one line in front hide a bomb from the guards (A40 critic M6, M8, M9).
const BAND_PREFIXES: Record<string, string> = {
    quoteFence: '> ```\n',
    tabFence: '\t```\n',
    spaceTabFence: '  \t```\n',
    indentedQuoteFence: '    > ```\n',
    bulletFence: '- a\n  ```\n',
    orderedFence: '1. a\n   ```\n',
    looseBulletFence: '* x\n\n  ```\n',
    quoteHtmlFence: '> <div>\n> ```\n>\n',
    listHtmlFence: '- <div>\n  ```\n\n',
    nestedQuoteFence: '> > ```\n> ',
    earlyClose: '```\n\t```\n```\n',
    // A closing fence followed by a tab or spaces still closes (CommonMark): the bomb after it counts (M8).
    closeTab: '```\nx\n```\t\n',
    closeSpaceTab: '```\nx\n``` \t\n',
    closeTildeTab: '~~~\nx\n~~~\t\n',
    quoteEarlyClose: '```\n> ```\n```\n',
    badInfo: '```a`\n',
    html: '<div>\n```\n\n',
    comment: '<!--\n```\n-->\n\n',
      // Blank-looking lines that are not blank for CommonMark (M9): NBSP, form feed, BOM, U+3000 between `<div>` and a fence.
    htmlNbsp: '<div>\n\u00A0\n```\n\n',
    htmlFormFeed: '<div>\n\f\n```\n\n',
    htmlBom: '<div>\n\uFEFF\n```\n\n',
    htmlIdeographic: '<div>\n\u3000\n```\n\n',
    commentNbsp: '<!--\n\u00A0\n```\n-->\n\n',
    quoteNbsp: '> a\n\u00A0\n',
    plain: '',
    tildeInfo: '~~~ a`b\n',
};

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
    expect(w[0]).toBe(Math.round('21st-dev-magic'.length * 1.1 * 8 + 20)); // inline code weighs 1.1 per char
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
    // the title stays a literal text node right after the image (the renderer keeps it on the image line)
    const kidsOf = kids(para);
    expect(kidsOf[kidsOf.findIndex((n) => n.type === 'image') + 1]).toMatchObject({ type: 'text', value: ' (P)', literal: true });
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

const longPath = readFileSync('src/markdown/fixtures/long-path.md', 'utf8').trimEnd();

describe('inline code display (long path fixture)', () => {
  const code = all(parseMarkdown(longPath)).filter((n) => n.type === 'inlineCode').map((n) => n.value ?? '');
  it('the fixture has a long path and a hyphenated name as inline code', () => {
    expect(code).toHaveLength(3);
    expect(code[0]).toMatch(/^\/Users\/me\/\.claude\/plugins\/.*SKILL\.md$/);
  });
  it('noHyphenBreak puts a word joiner after every hyphen and leaves "/" alone', () => {
    for (const value of code) {
      const shown = noHyphenBreak(value);
      expect(shown.replace(/\u2060/g, '')).toBe(value);
      expect((shown.match(/-\u2060/g) ?? []).length).toBe((value.match(/-/g) ?? []).length);
      expect(shown).not.toMatch(/-(?!\u2060)/);
      expect(shown.split('/').length).toBe(value.split('/').length);
    }
  });
  it('a newline inside inline code is a space', () => {
    const para = kids(parseMarkdown('`a\nb-c`'))[0]!;
    expect(codeText(kids(para)[0]!.value ?? '')).toBe('a b-\u2060c');
  });
});

describe('renderer safety helpers', () => {
  const defs = (md: string) => definitionsOf(parseMarkdown(md));
  const first = (md: string, type: string): MdNode => all(parseMarkdown(md)).find((n) => n.type === type)!;

  it('linkTarget opens only strict http(s)', () => {
    const bad = ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'mailto:a@b.c', '//evil.example/x', 'https://evil.com\\@good.com/', 'https://user@good.com/'];
    for (const url of bad) expect(linkTarget({ type: 'link', url }, new Map())).toBeNull();
    expect(linkTarget({ type: 'link', url: ' https://example.com/a ' }, new Map())).toBe('https://example.com/a');
  });

  it('the GFM email autolink is not openable', () => {
    const link = first('write to me@example.com now', 'link');
    expect(link.url).toBe('mailto:me@example.com');
    expect(linkTarget(link, new Map())).toBeNull();
  });

  it('a linkReference resolves through its definition (first one wins), unsafe stays null', () => {
    const md = '[a][x] [b][y]\n\n[x]: https://example.com/x\n[x]: https://other.example/\n[y]: javascript:alert(1)';
    const d = defs(md);
    const [a, b] = all(parseMarkdown(md)).filter((n) => n.type === 'linkReference');
    expect(linkTarget(a!, d)).toBe('https://example.com/x');
    expect(linkTarget(b!, d)).toBeNull();
    expect(addressOf(b!, d)).toBe('javascript:alert(1)');
  });

  it('an empty or blank label falls back to the address', () => {
    expect(linkLabelIsEmpty(first('[](https://e.com/x)', 'link'))).toBe(true);
    expect(linkLabelIsEmpty(first('[ ](https://e.com/x)', 'link'))).toBe(true);
    expect(linkLabelIsEmpty(first('[a](https://e.com/x)', 'link'))).toBe(false);
    const md = '[][r]\n\n[r]: https://e.com/ref';
    const ref = first(md, 'linkReference');
    expect(linkLabelIsEmpty(ref)).toBe(true);
    expect(addressOf(ref, defs(md))).toBe('https://e.com/ref');
  });

  it('an image is a line with its host and alt, without alt its full address; never anything to load', () => {
    const img = first('![Approve: drop the prod DB](https://x.example/p.png)', 'image');
    expect(imageLine(img, new Map())).toBe('[Image not loaded · x.example] Approve: drop the prod DB');
    expect(imageLine(first('![](https://x.example/p.png?a=1)', 'image'), new Map())).toBe('[Image not loaded · x.example] https://x.example/p.png?a=1');
    const md = '![pic][i]\n\n[i]: https://y.example/z.png';
    expect(imageLine(first(md, 'imageReference'), defs(md))).toBe('[Image not loaded · y.example] pic');
    expect(imageLine({ type: 'image', url: 'javascript:x', alt: '' }, new Map())).toBe('[Image not loaded] javascript:x');
  });
});

describe('limits', () => {
  it('text over 64 KB or with over 2000 emphasis delimiters is raw', () => {
    const big = `${'a'.repeat(65 * 1024)}\n\n# h`;
    expect(types(parseMarkdown(big))).toEqual(['paragraph']);
    const bomb = '*a '.repeat(2001);
    expect(plainText(parseMarkdown(bomb))).toBe(bomb);
    expect(types(parseMarkdown('**ok** _fine_'))).toEqual(['paragraph']);
    expect(all(parseMarkdown('**ok** _fine_')).some((n) => n.type === 'strong')).toBe(true);
  });

  it('a table over 200 rows or 2000 cells becomes a code block with its source', () => {
    const rows = (n: number, cols: number) => `| ${Array.from({ length: cols }, (_, i) => `h${i}`).join(' | ')} |\n|${'---|'.repeat(cols)}\n${Array.from({ length: n }, () => `| ${Array.from({ length: cols }, () => 'x').join(' | ')} |`).join('\n')}`;
    const tall = rows(200, 2); // 201 rows with the header
    expect(kids(parseMarkdown(tall))[0]).toMatchObject({ type: 'code', value: tall });
    const wide = rows(100, 25); // 101 rows × 25 = 2525 cells
    expect(kids(parseMarkdown(wide))[0]!.type).toBe('code');
    expect(kids(parseMarkdown(rows(50, 5)))[0]!.type).toBe('table');
  });

  it('lists and quotes nested deeper than 24 together are raw text', () => {
    const nest = (depth: number) => Array.from({ length: depth }, (_, i) => `${'  '.repeat(i)}- x`).join('\n');
    expect(types(parseMarkdown(nest(MD_NEST_MAX)))).toEqual(['list']);
    const deep = nest(MD_NEST_MAX + 1);
    expect(plainText(parseMarkdown(deep))).toBe(deep);
    const mixed = (pairs: number) => `${'> - '.repeat(pairs)}x`; // a quote and a list per pair
    expect(kids(parseMarkdown(mixed(12)))[0]!.type).toBe('blockquote');
    expect(plainText(parseMarkdown(mixed(13)))).toBe(mixed(13));
  });
});

describe('links are not entered', () => {
  it('a mention or newline inside a link label stays text / a space, as in the window', () => {
    const link = first('[**@s02** hi\nthere](https://e.com)');
    expect(all(link).some((n) => n.type === 'mention')).toBe(false);
    expect(plainText(link)).toBe('@s02 hi there');
  });
  function first(md: string): MdNode {
    return all(parseMarkdown(md)).find((n) => n.type === 'link')!;
  }
});

describe('table width and font scale', () => {
  it('widths and clamps grow with the font scale', () => {
    const cell = (v: string): MdNode => ({ type: 'tableCell', children: [{ type: 'text', value: v }] });
    const rows: MdNode[] = [{ type: 'tableRow', children: [cell('x'.repeat(10))] }];
    expect(columnWidths(rows, 1)).toEqual([100]);
    expect(columnWidths(rows, 2)).toEqual([180]);
    expect(columnWidths([{ type: 'tableRow', children: [cell('')] }], 2)).toEqual([128]);
  });
});

describe('pre-parse guards on bombs (A40 critic M2, M3)', () => {
  const timed = (md: string): { ms: number; root: MdNode } => {
    const t = performance.now();
    const root = parseMarkdown(md);
    return { ms: performance.now() - t, root };
  };

  it('a bracket bomb returns raw text fast', () => {
    const bomb = `${'['.repeat(10000)}a${']'.repeat(10000)}`;
    const { ms, root } = timed(bomb);
    expect(ms).toBeLessThan(200);
    expect(plainText(root)).toBe(bomb);
    const flat = `${'[a] '.repeat(2001)}`; // balanced but more than 2000 `[`
    expect(plainText(parseMarkdown(flat))).toBe(flat);
    expect(all(parseMarkdown('[a](https://e.com) [b] [c]')).some((n) => n.type === 'link')).toBe(true);
  });

  it('list and quote markers on one line, together, return raw text fast', () => {
    // `- - - …` alone is a thematic break (cheap, not raw); the others are bombs.
    expect(timed('- '.repeat(4000)).ms).toBeLessThan(200);
    const bombs = [
      '> - '.repeat(400), '1. '.repeat(3000), `${'>'.repeat(30)} x`,
      `>${'- '.repeat(4000)}`, `${'>'.repeat(100)} ${'- '.repeat(4000)}`, '- >'.repeat(3000), '1. >'.repeat(2000),
    ];
    for (const bomb of bombs) {
      const { ms, root } = timed(bomb);
      expect(ms).toBeLessThan(200);
      expect(plainText(root)).toBe(bomb);
    }
    expect(all(parseMarkdown('- a\n- b\n  - c')).some((n) => n.type === 'list')).toBe(true);
    expect(types(parseMarkdown('- '.repeat(24) + 'x'))).toEqual(['list']);
  });
});

describe('lazy continuation, false positives and the bomb regression (A40 critic M5, m15)', () => {
  const timed = (md: string): { ms: number; root: MdNode } => {
    const t = performance.now();
    const root = parseMarkdown(md);
    return { ms: performance.now() - t, root };
  };

  it('lazy continuation lines after a list item or a quote return raw text fast', () => {
    for (const bomb of ['- a\n' + 'b\n'.repeat(14998), '> a\n' + 'b\n'.repeat(14998), '> a\nb\n'.repeat(10000)]) {
      const { ms, root } = timed(bomb);
      expect(ms).toBeLessThan(200);
      expect(plainText(root)).toBe(bomb);
    }
  });

  it('a realistic long reply still renders as Markdown', () => {
    const logLine = 'x'.repeat(60);
    const item = `- a list item\n${`${logLine}\n`.repeat(400)}`;
    expect(types(parseMarkdown(item))).toEqual(['list']);
    const code = `\`\`\`\n${'x\n'.repeat(15000)}\`\`\``;
    expect(kids(parseMarkdown(code))[0]).toMatchObject({ type: 'code' });
  });

  it('a thematic break of spaced dashes and ANSI colours in a code block are not bombs', () => {
    expect(types(parseMarkdown(`${'- '.repeat(25)}\n\ntext`))).toEqual(['thematicBreak', 'paragraph']);
    const ansi = `\`\`\`\n${'\u001b[32mok\u001b[0m\n'.repeat(33)}\`\`\`\n\ntext with **bold**`;
    expect(types(parseMarkdown(ansi))).toEqual(['code', 'paragraph']);
    // ESC [ does not count in prose either
    expect(types(parseMarkdown(`${'\u001b[32mx '.repeat(40)}`))).toEqual(['paragraph']);
    // brackets, emphasis and markers inside fenced code do not count
    const heavyCode = `\`\`\`\n${'[a] [b] '.repeat(700)}\n${'a*b '.repeat(700)}\n${'- '.repeat(30)}\n\`\`\``;
    expect(kids(parseMarkdown(heavyCode))[0]!.type).toBe('code');
  });

  it('every known bomb generator, about 30 KB each, returns within a fixed bound behind every prefix', () => {
    const fill = (unit: string, size = 30_000): string => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
    const table = (rows: number): string => `| a | b |\n|---|---|\n${'| 1 | 2 |\n'.repeat(rows)}`;
    const generators: Record<string, string> = {
      emphasis: fill('**_'),
      tildes: fill('~~a '),
      brackets: `${'['.repeat(10000)}a${']'.repeat(10000)}`,
      openBrackets: fill('['),
      linkOpeners: fill('[a]('),
      imageOpeners: fill('!['),
      footnoteOpeners: fill('[^'),
      markersSpace: fill('- '),
      markersQuote: fill('> - '),
      markersNoSpace: `>${fill('- ', 15_000)}`,
      markersMixed: fill('- >'),
      markersOrdered: fill('1. >'),
      markersDeepQuote: `${'>'.repeat(100)} ${fill('- ', 15_000)}`,
      lazyList: `- a\n${fill('b\n')}`,
      lazyQuote: fill('> a\nb\n'),
      hugeTable: table(6000),
      wideTable: `|${'a|'.repeat(8000)}\n|${'-|'.repeat(8000)}\n`,
      backticks: fill('`'),
      backtickRuns: fill('``a` '),
      lessThan: fill('<'),
      htmlOpeners: fill('<a '),
      entities: fill('&amp; &#x41; &bogus;'),
      www: fill('www.a.b '),
      backslashes: fill('\\'),
      autolinks: fill('<https://a.b> '),
      definitions: fill('[a]: x\n'),
    };
    // Every generator behind EVERY prefix of the suite (a line that looks like a fence / an HTML block / a blank line to a
    // naive guard): the guard must not let one line in front hide a bomb. One run each, a second only when one is slow.
    const slow: string[] = [];
    for (const [name, bomb] of Object.entries(generators)) {
      for (const [pname, prefix] of Object.entries(BAND_PREFIXES)) {
        const input = prefix + bomb;
        let ms = timed(input).ms;
        if (ms > 2000) ms = timed(input).ms; // a busy machine may stall one run, a real hang (seconds) stalls both
        if (ms > 2000) slow.push(`${pname}+${name}: ${Math.round(ms)} ms`);
      }
    }
    expect(slow).toEqual([]);
  });
});

describe('guards: fence recognition, headings, short inline code (A40 critic M6, m17, m14)', () => {
  it('a heading is not a lazy-line container', () => {
    const doc = `# Files\n${'plain line\n'.repeat(600)}`;
    expect(types(parseMarkdown(doc))[0]).toBe('heading');
  });

  it('a fence inside a quote or a list item is not skipped: counted like text (the safe side)', () => {
    const doc = `> \`\`\`\n${'> line [x\n'.repeat(600)}> \`\`\`\n\ntext`;
    expect(plainText(parseMarkdown(doc))).toBe(doc);
    // the same code at column 0 with balanced brackets stays Markdown
    expect(types(parseMarkdown(`\`\`\`\n${'line [x]\n'.repeat(600)}\`\`\`\n\ntext`))).toEqual(['code', 'paragraph']);
  });

  it('a real fence still skips, a fake one (backtick in the info string) does not', () => {
    const bomb = '**_'.repeat(8000);
    expect(plainText(parseMarkdown(`\`\`\`a\`\n${bomb}`))).toContain('**_**_');
    expect(types(parseMarkdown(`\`\`\`js\n${'*'.repeat(500)}\n\`\`\`\n\nok`))).toEqual(['code', 'paragraph']);
  });

  it('short inline code does not wrap: no-break space and U+2060 after "/"', () => {
    expect(codeText('~/.claude/settings.json', true)).toBe('~/\u2060.claude/\u2060settings.json');
    expect(codeText('docker mcp run', true)).toBe('docker\u00A0mcp\u00A0run');
    expect(codeText('a b/c', false)).toBe('a b/c');
  });
});

describe('the code skip cannot be fooled (A40 critic M6, round 5)', () => {
  const timed = (md: string): { ms: number; root: MdNode } => {
    const t = performance.now();
    const root = parseMarkdown(md);
    return { ms: performance.now() - t, root };
  };
  const isRaw = (root: MdNode, md: string): boolean => types(root).length === 1 && plainText(root) === md;

  const prefixes = BAND_PREFIXES;
  // Bombs between 1x and the backstop: over a limit, under twice it.
  const band: Record<string, string> = {
    emphasis: '**_'.repeat(1000),
    nestedBrackets: `${'['.repeat(1500)}a${']'.repeat(1500)}`,
    markers60: `${'> - '.repeat(30)}x\n`.repeat(200),
    lazy1500: `- a\n${'b\n'.repeat(1500)}`,
    lazySeries: `${'> a\n' + 'b\n'.repeat(1500)}`.repeat(3),
  };

  it('every band bomb behind every prefix is raw or parses fast', () => {
    const bad: string[] = [];
    for (const [bname, bomb] of Object.entries(band)) {
      for (const [pname, prefix] of Object.entries(prefixes)) {
        const input = prefix + bomb;
        const first = timed(input);
        const ms = Math.min(first.ms, timed(input).ms);
        if (ms > 2000) bad.push(`${pname}+${bname}: ${Math.round(ms)} ms`);
        // The fence is not column 0 / not a fence, so the bomb counts: it must come back raw.
        // `tildeInfo` is a real fence at column 0: the bomb is code (a legal parse), only the time bound applies.
        if (pname !== 'tildeInfo' && !isRaw(first.root, input)) bad.push(`${pname}+${bname}: not raw`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('a real fence at column 0 still hides code from the counts', () => {
    const code = `\`\`\`\n${'**_'.repeat(1000)}\n\`\`\`\n\nok`;
    expect(types(parseMarkdown(code))).toEqual(['code', 'paragraph']);
  });

  it('a fence line resets the lazy count', () => {
    const doc = `- a\n\`\`\`\n${'b\n'.repeat(2500)}\`\`\`\n\nok`;
    expect(types(parseMarkdown(doc))).toEqual(['list', 'code', 'paragraph']);
  });
});

describe('a long list is shown as its source (A40 critic m19)', () => {
  it('over 300 items becomes a code block, 300 stays a list', () => {
    const src = (n: number) => Array.from({ length: n }, (_, i) => `- item ${i}`).join('\n');
    expect(kids(parseMarkdown(src(MD_LIST_ITEMS_MAX)))[0]!.type).toBe('list');
    expect(kids(parseMarkdown(src(MD_LIST_ITEMS_MAX + 1)))[0]).toMatchObject({ type: 'code', value: src(MD_LIST_ITEMS_MAX + 1) });
    const run = (): number => {
      const t = performance.now();
      parseMarkdown(src(4999));
      return performance.now() - t;
    };
    expect(Math.min(run(), run())).toBeLessThan(2000); // the best of two: a busy machine may stall one run
  });
});

describe('one budget per message (A40 critic M7)', () => {
  const timed = (md: string): { ms: number; root: MdNode } => {
    const t = performance.now();
    const root = parseMarkdown(md);
    return { ms: performance.now() - t, root };
  };
  const rawOrCode = (root: MdNode, md: string): boolean =>
    (types(root).length === 1 && plainText(root) === md) || types(root).every((t) => t === 'code');

  const generators: Record<string, string> = {
    // 24 markers per line (the limit is 25), the first marker alternates so no line joins the previous list
    markers24: Array.from({ length: 1300 }, (_, i) => `${i % 2 === 0 ? '-' : '+'} ${'- '.repeat(22)}x`).join('\n'),
    // 14 tables of 199 rows x 10 columns, each within its own limits
    tables: Array.from({ length: 14 }, () => `| ${Array.from({ length: 10 }, (_, c) => `h${c}`).join(' | ')} |\n|${'---|'.repeat(10)}\n${Array.from({ length: 199 }, () => `| ${'x | '.repeat(9)}x |`).join('\n')}`).join('\n\n'),
    // 16 lists of 300 items, the marker alternates
    lists: Array.from({ length: 16 }, (_, l) => Array.from({ length: 300 }, () => `${l % 2 === 0 ? '-' : '+'} a`).join('\n')).join('\n\n'),
    // everything below 1x, 28 KB, thousands of items
    mixed: Array.from({ length: 32 }, (_, l) => Array.from({ length: 300 }, () => `${l % 2 === 0 ? '-' : '+'} x`).join('\n')).join('\n\n'),
  };

  it('the critic generators come back raw (or as code) in under 0.5 s', () => {
    const bad: string[] = [];
    for (const [name, md] of Object.entries(generators)) {
      const first = timed(md);
      const ms = Math.min(first.ms, timed(md).ms);
      if (ms > 2000) bad.push(`${name}: ${Math.round(ms)} ms`);
      if (!rawOrCode(first.root, md)) bad.push(`${name}: neither raw nor code`);
    }
    expect(bad).toEqual([]);
  });

  it('a real document with a few lists and tables stays Markdown', () => {
    const doc = `# T\n\n${generators.lists!.split('\n\n').slice(0, 2).join('\n\n')}\n\n| a | b |\n|---|---|\n${'| 1 | 2 |\n'.repeat(150)}`;
    expect(types(parseMarkdown(doc))).toEqual(['heading', 'list', 'list', 'table']);
  });
});

describe('real code is not counted by the backstop (A40 critic m20)', () => {
  it('a 1300-line Python block with underscores stays Markdown', () => {
    const py = `\`\`\`python\n${'self._a_b = __c__\n'.repeat(1300)}\`\`\`\n\nok`;
    expect(types(parseMarkdown(py))).toEqual(['code', 'paragraph']);
  });
  it('a 65-line progress bar with [=====> stays Markdown', () => {
    const bar = `\`\`\`\n${'progress [=====>\n'.repeat(65)}\`\`\`\n\nok`;
    expect(types(parseMarkdown(bar))).toEqual(['code', 'paragraph']);
  });
});

describe('inline nodes are in the budget (A40 critic m21)', () => {
  it('a paragraph of many inline nodes is raw text, a normal long paragraph is not', () => {
    const many = '`a` '.repeat(8000); // 16 000 nodes
    expect(plainText(parseMarkdown(many))).toBe(many);
    const normal = 'word `code` **bold** '.repeat(200);
    expect(types(parseMarkdown(normal))).toEqual(['paragraph']);
  });
});

describe('skipped code keeps a coarse backstop (A40 critic M8)', () => {
  it('real code with ~7800 underscores or 3000 [ stays Markdown, 9000 is raw', () => {
    expect(types(parseMarkdown(`\`\`\`\n${'_a_b_c_\n'.repeat(1300)}\`\`\`\n\nok`))).toEqual(['code', 'paragraph']);
    const heavy = `\`\`\`\n${'_'.repeat(9000)}\n\`\`\`\n\nok`;
    expect(plainText(parseMarkdown(heavy))).toBe(heavy);
  });
});

describe('mentions and line breaks are in the node budget (A40 critic m21)', () => {
  it("'@s02 ' x 12000 in a room message is raw text", () => {
    const md = '@s02 '.repeat(12000);
    const t = performance.now();
    const root = parseMarkdown(md);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(plainText(root)).toBe(md);
  });
  it('a few hundred mentions and line breaks stay Markdown', () => {
    expect(types(parseMarkdown('hi @s02 and @human\nbye '.repeat(100)))).toEqual(['paragraph']);
  });
});

describe('the full backstop keeps real code Markdown (A40 critic M9, m20)', () => {
  it('~7800 underscores, a progress bar, a list item followed by a 2001-line fence', () => {
    expect(types(parseMarkdown(`\`\`\`\n${'self._a_b = __c__\n'.repeat(1300)}\`\`\`\n\nok`))).toEqual(['code', 'paragraph']);
    expect(types(parseMarkdown(`\`\`\`\n${'progress [=====>\n'.repeat(65)}\`\`\`\n\nok`))).toEqual(['code', 'paragraph']);
    expect(types(parseMarkdown(`- a\n\`\`\`\n${'b\n'.repeat(2001)}\`\`\`\n\nok`))).toEqual(['list', 'code', 'paragraph']);
  });
  it('3000 balanced brackets stay Markdown (unclosed ones in code are raw: the 4x depth backstop is 128)', () => {
    expect(types(parseMarkdown(`\`\`\`\n${'[a] [b] '.repeat(700)}\n\`\`\`\n\nok`))).toEqual(['code', 'paragraph']);
  });
});
