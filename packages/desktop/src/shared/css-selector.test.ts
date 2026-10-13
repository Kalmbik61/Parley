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

  it('id тоже: `:r0:` (useId) и id с первой цифрой — как их пишет guest-dom через CSS.escape', () => {
    expect(selectorTail('main > input#\\:r0\\:')).toEqual({ tag: 'input', id: ':r0:', classes: [] });
    expect(selectorTail('div#\\31 23')).toEqual({ tag: 'div', id: '123', classes: [] });
    // Пробел после кода — часть экранирования: `1` → `\31 `, и буква за ним (`1a` → `\31 a`) в код не входит.
    expect(selectorTail('div#\\31 a')).toEqual({ tag: 'div', id: '1a', classes: [] });
    expect(selectorTail('form > div#\\31 ')).toEqual({ tag: 'div', id: '1', classes: [] });
  });
});
