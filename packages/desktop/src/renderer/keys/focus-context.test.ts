import { afterEach, describe, expect, it } from 'vitest';
import { focusContext } from './focus-context.js';

afterEach(() => {
  document.body.innerHTML = '';
});

/** Разметка в body и элемент по селектору. */
function mount(html: string, selector: string): Element {
  document.body.innerHTML = html;
  const element = document.querySelector(selector);
  if (element === null) throw new Error(`нет ${selector}`);
  return element;
}

describe('focusContext (тест 3)', () => {
  it('textarea.xterm-helper-textarea внутри .xterm — terminal', () => {
    const active = mount(
      '<div class="xterm"><div class="xterm-helper"><textarea class="xterm-helper-textarea"></textarea></div></div>',
      'textarea',
    );
    expect(focusContext(active)).toBe('terminal');
  });

  it('внутри .monaco-editor — monaco', () => {
    expect(focusContext(mount('<div class="monaco-editor"><textarea class="inputarea"></textarea></div>', 'textarea'))).toBe(
      'monaco',
    );
  });

  it('input type="text", input без type и [contenteditable="true"] — input', () => {
    expect(focusContext(mount('<input type="text">', 'input'))).toBe('input');
    expect(focusContext(mount('<input>', 'input'))).toBe('input');
    expect(focusContext(mount('<input type="search">', 'input'))).toBe('input');
    expect(focusContext(mount('<textarea></textarea>', 'textarea'))).toBe('input');
    expect(focusContext(mount('<div contenteditable="true">x</div>', 'div'))).toBe('input');
  });

  it('флажок, кнопка и [contenteditable="false"] — other', () => {
    expect(focusContext(mount('<input type="checkbox">', 'input'))).toBe('other');
    expect(focusContext(mount('<button>ok</button>', 'button'))).toBe('other');
    expect(focusContext(mount('<div contenteditable="false">x</div>', 'div'))).toBe('other');
    expect(
      focusContext(mount('<div contenteditable="true"><span contenteditable="false" id="t">x</span></div>', '#t')),
    ).toBe('other');
  });

  it('поле внутри [role="dialog"] — dialog; внутри [data-palette] того же диалога — input', () => {
    expect(focusContext(mount('<div role="dialog"><input type="text"></div>', 'input'))).toBe('dialog');
    expect(focusContext(mount('<div role="alertdialog"><button>ok</button></div>', 'button'))).toBe('dialog');
    expect(focusContext(mount('<div role="dialog" data-palette><input type="text"></div>', 'input'))).toBe('input');
    expect(focusContext(mount('<div role="dialog"><div data-palette><input type="text"></div></div>', 'input'))).toBe(
      'input',
    );
  });

  it('null и body — other', () => {
    expect(focusContext(null)).toBe('other');
    expect(focusContext(document.body)).toBe('other');
  });
});
