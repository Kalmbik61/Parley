import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostOf, isOpenableUrl, parseInline, parseMarkdown } from './parse';

afterEach(() => vi.unstubAllGlobals());

describe('markdown: no remote images, no HTML', () => {
  it('![](https://…) and <img src=https://…> become a placeholder and make no network request', () => {
    const fetchSpy = vi.fn();
    const imageSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('Image', imageSpy);
    const md = '![alt](https://tracker.example.com/p.png) and <img src="https://evil.example.org/x.gif" width=1>';
    const blocks = parseMarkdown(md);
    expect(blocks).toEqual([
      {
        t: 'paragraph',
        inline: [
          { t: 'image', host: 'tracker.example.com' },
          { t: 'text', text: ' and ' },
          { t: 'image', host: 'evil.example.org' },
        ],
      },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(imageSpy).not.toHaveBeenCalled();
    // The model never mentions a loadable URL: nothing in the tree is an openable src.
    expect(JSON.stringify(blocks)).not.toContain('https://');
  });

  it('strips raw HTML tags and comments but keeps the text', () => {
    expect(parseInline('a <b>bold</b><script>x()</script> <!-- c --> z')).toEqual([{ t: 'text', text: 'a boldx()  z' }]);
  });

  it('only http(s) links are links', () => {
    expect(parseInline('[ok](https://example.com/a) [bad](javascript:alert)')).toEqual([
      { t: 'link', url: 'https://example.com/a', children: [{ t: 'text', text: 'ok' }] },
      { t: 'text', text: ' ' },
      { t: 'text', text: 'bad' },
    ]);
    expect(isOpenableUrl('javascript:alert')).toBe(false);
    expect(hostOf('https://User@Example.com:8080/x')).toBe('example.com');
  });
});

describe('link host spoofing', () => {
  it('refuses backslash, userinfo and whitespace forms; they stay text', () => {
    for (const bad of ['https://evil.com\\@good.com/x', 'https://user@good.com/', 'https://good.com\\x', 'https://good .com']) {
      expect(isOpenableUrl(bad)).toBe(false);
    }
    expect(parseInline('[x](https://evil.com\\@good.com/x)').some((n) => n.t === 'link')).toBe(false);
    expect(parseInline('see https://evil.com\\@good.com/x now').some((n) => n.t === 'link')).toBe(false);
  });
  it('plain https links and ports are fine, and the dialog host is the real host', () => {
    expect(isOpenableUrl('https://example.com:8443/a?b=1#c')).toBe(true);
    expect(hostOf('https://Example.com/a')).toBe('example.com');
  });
});

describe('markdown blocks', () => {
  it('parses headings, lists, code fences, quotes and rules', () => {
    const md = '# T\n\nPara **b** `c` *i*\nsecond line\n\n- one\n- two\n\n1. a\n2. b\n\n```ts\nconst x = 1;\n```\n\n> quoted\n\n---';
    const b = parseMarkdown(md);
    expect(b.map((x) => x.t)).toEqual(['heading', 'paragraph', 'list', 'list', 'code', 'quote', 'rule']);
    expect(b[3]).toMatchObject({ t: 'list', ordered: true });
    expect(b[4]).toEqual({ t: 'code', lang: 'ts', text: 'const x = 1;' });
    expect(b[1]).toMatchObject({ t: 'paragraph', inline: expect.arrayContaining([{ t: 'bold', children: [{ t: 'text', text: 'b' }] }]) });
  });
  it('an unterminated fence runs to the end', () => {
    expect(parseMarkdown('```\nabc')).toEqual([{ t: 'code', lang: null, text: 'abc' }]);
  });
});

describe('the renderer cannot load anything', () => {
  it('Markdown.tsx imports no Image, WebView or fetch', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/markdown/Markdown.tsx', 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const rnImport = /import\s*\{([^}]*)\}\s*from 'react-native'/.exec(src)?.[1] ?? '';
    expect(rnImport).not.toMatch(/\bImage\b|WebView/);
    expect(src).not.toMatch(/fetch\(|expo-image|<Image/);
  });
});
