import { describe, expect, it } from 'vitest';
import { clipText, escapeHtml, lastLines, splitText, TRUNCATED_TAIL } from './format.js';

describe('escapeHtml', () => {
  it('экранирует & < > и кавычку', () => {
    expect(escapeHtml('a & <b> "c"')).toBe('a &amp; &lt;b&gt; &quot;c&quot;');
  });
});

describe('clipText', () => {
  it('короткий текст не трогает', () => {
    expect(clipText('abc', 10)).toBe('abc');
  });
  it('обрезает ровно по лимиту вместе с хвостом', () => {
    const out = clipText('x'.repeat(5000), 1500);
    expect(out).toHaveLength(1500);
    expect(out.endsWith(TRUNCATED_TAIL)).toBe(true);
  });
  it('текст ровно в лимит остаётся целым', () => {
    expect(clipText('y'.repeat(1500))).toHaveLength(1500);
    expect(clipText('y'.repeat(1500))).not.toContain('truncated');
  });
});

describe('splitText', () => {
  it('пустой текст → []', () => {
    expect(splitText('')).toEqual([]);
  });
  it('10 000 знаков по абзацам: куски не длиннее 4096, порядок сохранён', () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => `${i}`.padStart(2, '0') + 'a'.repeat(497));
    const text = paragraphs.join('\n\n');
    const parts = splitText(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(4096);
    expect(parts.join('\n\n')).toBe(text);
  });
  it('без переводов строк режет жёстко', () => {
    const parts = splitText('z'.repeat(10_000));
    expect(parts.every((part) => part.length <= 4096)).toBe(true);
    expect(parts.join('')).toBe('z'.repeat(10_000));
  });
  it('режет по одиночному переводу строки', () => {
    const text = Array.from({ length: 10 }, () => 'b'.repeat(999)).join('\n');
    const parts = splitText(text, 4096);
    expect(parts.every((part) => part.length <= 4096)).toBe(true);
    expect(parts.join('\n')).toBe(text);
  });
});

describe('lastLines', () => {
  it('берёт две последние непустые строки', () => {
    expect(lastLines('a\nb\n\nc\n')).toBe('b\nc');
  });
  it('n задаёт число строк', () => {
    expect(lastLines('a\nb\nc', 1)).toBe('c');
  });
});
