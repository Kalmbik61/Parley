import { describe, expect, it } from 'vitest';
import { selectorTail } from './css-selector.js';

describe('selectorTail', () => {
  it('тег, id и классы последнего звена; :nth-of-type не мешает', () => {
    expect(selectorTail('main > section.settings > button.save.primary')).toEqual({ tag: 'button', id: null, classes: ['save', 'primary'] });
    expect(selectorTail('body > form#f')).toEqual({ tag: 'form', id: 'f', classes: [] });
    expect(selectorTail('body > div.x:nth-of-type(2)')).toEqual({ tag: 'div', id: null, classes: ['x'] });
    expect(selectorTail('body')).toEqual({ tag: 'body', id: null, classes: [] });
  });

  it('экранирование CSS.escape снимается: \\: и шестнадцатеричное с пробелом', () => {
    expect(selectorTail('div.md\\:flex')).toEqual({ tag: 'div', id: null, classes: ['md:flex'] });
    expect(selectorTail('span.\\31 a')).toEqual({ tag: 'span', id: null, classes: ['1a'] });
    // Селектор guest-dom.js (задача 2, по Orca) с Tailwind-классами: `\.` и `\:` внутри имени.
    expect(selectorTail('div.md\\:flex.py-1\\.5')).toEqual({ tag: 'div', id: null, classes: ['md:flex', 'py-1.5'] });
  });
});
