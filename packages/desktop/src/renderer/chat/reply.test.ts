import { afterEach, describe, expect, it } from 'vitest';
import { REPLY_QUOTE_MAX, isSlashCommand, replyQuote, selectedTextIn, splitQuote, withQuote } from './reply.js';

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe('replyQuote', () => {
  it(`без выделения — текст целиком, если он не длиннее ${REPLY_QUOTE_MAX} знаков, иначе начало и «…»`, () => {
    expect(REPLY_QUOTE_MAX).toBe(300);
    expect(replyQuote('  короткий ответ\n', '')).toBe('короткий ответ');
    const exact = 'я'.repeat(REPLY_QUOTE_MAX);
    expect(replyQuote(exact, '')).toBe(exact);
    const long = `${'a'.repeat(REPLY_QUOTE_MAX - 1)} ${'b'.repeat(50)}`;
    expect(replyQuote(long, '')).toBe(`${'a'.repeat(REPLY_QUOTE_MAX - 1)}…`);
    // Эмодзи (суррогатная пара) не режется пополам.
    expect(replyQuote('😀'.repeat(REPLY_QUOTE_MAX + 1), '')).toBe(`${'😀'.repeat(REPLY_QUOTE_MAX)}…`);
  });

  it('выделенный фрагмент — целиком, какой бы длины ни был', () => {
    const fragment = 'x'.repeat(REPLY_QUOTE_MAX * 2);
    expect(replyQuote('весь ответ', `  ${fragment} `)).toBe(fragment);
  });
});

describe('selectedTextIn', () => {
  it('выделение внутри элемента — его текст; вне элемента или пустое — пусто', () => {
    document.body.innerHTML = '<div id="a"><p>первый абзац</p></div><div id="b">чужой</div>';
    const a = document.getElementById('a') as HTMLElement;
    const b = document.getElementById('b') as HTMLElement;
    expect(selectedTextIn(a)).toBe('');
    const range = document.createRange();
    range.selectNodeContents(a.querySelector('p') as HTMLElement);
    window.getSelection()?.addRange(range);
    expect(selectedTextIn(a)).toBe('первый абзац');
    expect(selectedTextIn(b)).toBe('');
    expect(selectedTextIn(null)).toBe('');
  });
});

describe('withQuote и splitQuote', () => {
  it('цитата — блоком «> …» перед текстом (пустая строка цитаты — «>»); splitQuote возвращает её обратно', () => {
    const sent = withQuote('строка 1\n\nстрока 3', 'мой вопрос');
    expect(sent).toBe('> строка 1\n>\n> строка 3\n\nмой вопрос');
    expect(splitQuote(sent)).toEqual({ quote: 'строка 1\n\nстрока 3', text: 'мой вопрос' });
    expect(withQuote('только цитата', '')).toBe('> только цитата');
  });

  it('текст без цитаты в начале — как есть', () => {
    expect(splitQuote('привет\n> не цитата')).toEqual({ quote: null, text: 'привет\n> не цитата' });
  });
});

describe('isSlashCommand', () => {
  it('команда CLI — да; абсолютный путь в начале и обычный текст — нет', () => {
    for (const text of ['/compact', '  /model opus', '/mcp__server:tool x']) expect(isSlashCommand(text), text).toBe(true);
    for (const text of ['/Users/me/x.ts почему падает?', 'текст /compact', '//x']) expect(isSlashCommand(text), text).toBe(false);
  });
});
