import { describe, expect, it } from 'vitest';
import { splitTaskText } from './task-text.js';

describe('splitTaskText', () => {
  it('перевод строки в заголовке: остаток уходит в начало деталей', () => {
    expect(splitTaskText('First\nSecond', 'More')).toEqual({ title: 'First', details: 'Second\n\nMore' });
  });

  it('пустые строки в начале пропускаются, края обрезаются', () => {
    expect(splitTaskText('\n\n  Title  \n', '  ')).toEqual({ title: 'Title', details: '' });
    expect(splitTaskText('  \n ', 'x')).toEqual({ title: '', details: 'x' });
  });

  it('заголовок длиннее 4096 символов режется, хвост уходит в детали', () => {
    const result = splitTaskText('a'.repeat(4100), 'd');
    expect(result.title).toBe('a'.repeat(4096));
    expect(result.details).toBe('aaaa\n\nd');
  });
});
