/**
 * Ссылки Markdown (кусок 7.5, тест 2 и fix-7.5): куда ведёт ссылка (`resolveMarkdownLink`) и какие адреса
 * `react-markdown` пропускает (`safeUrlTransform`). Функции вынесены из `files/preview/MarkdownPreview.tsx`
 * (0.2.0): их зовут и превью файлов, и лента комнаты (`components/rooms/RoomMarkdown.tsx`) — правила
 * безопасности ссылок у них одни. Поведение не менялось: тесты перенесены как были.
 */

import { describe, expect, it } from 'vitest';
import { resolveMarkdownLink, safeUrlTransform } from './markdown-links.js';

describe('safeUrlTransform (fix-7.5)', () => {
  it('http(s), относительные пути и #якоря — как есть', () => {
    expect(safeUrlTransform('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
    expect(safeUrlTransform('HTTP://example.com')).toBe('HTTP://example.com');
    expect(safeUrlTransform('./img/a.png')).toBe('./img/a.png');
    expect(safeUrlTransform('../README.md#usage')).toBe('../README.md#usage');
    expect(safeUrlTransform('/src/a.ts')).toBe('/src/a.ts');
    expect(safeUrlTransform('notes/a:b.md')).toBe('notes/a:b.md');
    expect(safeUrlTransform('my%20notes.md?raw=1')).toBe('my%20notes.md?raw=1');
    expect(safeUrlTransform('#section')).toBe('#section');
  });

  it('javascript:, data:, file:, vbscript:, mailto: и прочие схемы — пустая строка', () => {
    for (const url of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      '\u0001javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:image/png;base64,AAAA',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
      'mailto:a@b.c',
      'blob:https://example.com/x',
    ]) {
      expect(safeUrlTransform(url), url).toBe('');
    }
  });

  it('адрес без схемы на другой хост (//хост, \\\\хост) — пустая строка', () => {
    expect(safeUrlTransform('//evil.example/x')).toBe('');
    expect(safeUrlTransform('\\\\evil.example/x')).toBe('');
    expect(safeUrlTransform('/\\evil.example/x')).toBe('');
  });
});

describe('resolveMarkdownLink (тест 2)', () => {
  it('https — external; ./img/a.png от docs/x.md — docs/img/a.png; #section — anchor; javascript: — null', () => {
    expect(resolveMarkdownLink('https://example.com/a?b=1', 'docs/x.md')).toEqual({
      kind: 'external',
      url: 'https://example.com/a?b=1',
    });
    expect(resolveMarkdownLink('./img/a.png', 'docs/x.md')).toEqual({
      kind: 'file',
      path: 'docs/img/a.png',
    });
    expect(resolveMarkdownLink('#section', 'docs/x.md')).toEqual({ kind: 'anchor', id: 'section' });
    expect(resolveMarkdownLink('javascript:alert(1)', 'docs/x.md')).toBeNull();
  });

  it('http — external; file:, data:, mailto: и //хост — null; выход выше корня — null', () => {
    expect(resolveMarkdownLink('http://example.com', 'x.md')).toEqual({
      kind: 'external',
      url: 'http://example.com',
    });
    expect(resolveMarkdownLink('file:///etc/passwd', 'x.md')).toBeNull();
    expect(resolveMarkdownLink('data:text/html,x', 'x.md')).toBeNull();
    expect(resolveMarkdownLink('mailto:a@b.c', 'x.md')).toBeNull();
    expect(resolveMarkdownLink('//evil.example/x', 'x.md')).toBeNull();
    expect(resolveMarkdownLink('../../etc/passwd', 'docs/x.md')).toBeNull();
    expect(resolveMarkdownLink('', 'x.md')).toBeNull();
  });

  it('../, пробелы %20 и кириллица, хвост #якорь и ?запрос отбрасываются; /путь — от корня', () => {
    expect(resolveMarkdownLink('../README.md#usage', 'docs/x.md')).toEqual({
      kind: 'file',
      path: 'README.md',
    });
    expect(resolveMarkdownLink('my%20notes.md', 'docs/x.md')).toEqual({
      kind: 'file',
      path: 'docs/my notes.md',
    });
    expect(resolveMarkdownLink('заметки.md?raw=1', 'x.md')).toEqual({
      kind: 'file',
      path: 'заметки.md',
    });
    expect(resolveMarkdownLink('/src/a.ts', 'docs/x.md')).toEqual({
      kind: 'file',
      path: 'src/a.ts',
    });
    expect(resolveMarkdownLink('#%D0%B0', 'x.md')).toEqual({ kind: 'anchor', id: 'а' });
  });
});
