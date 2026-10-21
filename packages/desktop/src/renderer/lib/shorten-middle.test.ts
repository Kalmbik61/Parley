import { describe, expect, it } from 'vitest';
import { shortenMiddle } from './shorten-middle.js';

describe('shortenMiddle', () => {
  it('короткий текст не меняется, ровно max — тоже', () => {
    expect(shortenMiddle('/Users/me/app')).toBe('/Users/me/app');
    expect(shortenMiddle('a'.repeat(56))).toBe('a'.repeat(56));
  });

  it('длинный путь сокращается до ровно max кодовых точек с «…» посередине', () => {
    const path = `/Users/someone/Desktop/projects/${'nested/'.repeat(20)}final-folder`;
    const shortened = shortenMiddle(path);
    expect(Array.from(shortened)).toHaveLength(56);
    expect(shortened).toContain('…');
    expect(shortened.startsWith(path.slice(0, 10))).toBe(true);
    expect(shortened.endsWith('final-folder')).toBe(true);
  });

  it('max задаётся параметром: голова около 40 %, хвост около 60 %', () => {
    expect(shortenMiddle('0123456789ABCDEFGHIJ', 10)).toBe('012…EFGHIJ');
  });

  it('суррогатные пары считаются кодовыми точками, а не единицами UTF-16', () => {
    const text = '😀'.repeat(30);
    const shortened = shortenMiddle(text, 10);
    expect(Array.from(shortened)).toHaveLength(10);
    expect(shortened).toBe(`${'😀'.repeat(3)}…${'😀'.repeat(6)}`);
    expect(shortenMiddle('😀'.repeat(10), 10)).toBe('😀'.repeat(10));
  });
});
