import { afterEach, describe, expect, it } from 'vitest';
import { focusComposer, registerComposer, setVisibilityCheck, shouldTypeToFocus } from './type-to-focus.js';

const key = (init: Partial<KeyboardEvent> = {}) => ({
  key: 'a',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  isComposing: false,
  repeat: false,
  ...init,
});

describe('shouldTypeToFocus', () => {
  it('печатный символ без модификаторов вне полей — да, в том числе пробел и Shift', () => {
    expect(shouldTypeToFocus(key(), 'other', false, false)).toBe(true);
    expect(shouldTypeToFocus(key({ key: ' ' }), 'other', false, false)).toBe(true);
    expect(shouldTypeToFocus(key({ key: 'A' }), 'other', false, false)).toBe(true);
  });

  it('пробел на кнопке, role=button или summary — нет (нажимает её); другие символы и прочие элементы — да', () => {
    const on = (html: string): Element => {
      const host = document.createElement('div');
      host.innerHTML = html;
      return host.firstElementChild!.querySelector('span') ?? host.firstElementChild!;
    };
    for (const html of ['<button></button>', '<button><span></span></button>', '<div role="button"></div>', '<summary></summary>']) {
      expect(shouldTypeToFocus(key({ key: ' ' }), 'other', false, false, on(html)), html).toBe(false);
    }
    expect(shouldTypeToFocus(key({ key: 'a' }), 'other', false, false, on('<button></button>'))).toBe(true);
    expect(shouldTypeToFocus(key({ key: ' ' }), 'other', false, false, on('<div></div>'))).toBe(true);
  });

  it('⌘, ⌃, ⌥ — нет', () => {
    expect(shouldTypeToFocus(key({ metaKey: true }), 'other', false, false)).toBe(false);
    expect(shouldTypeToFocus(key({ ctrlKey: true }), 'other', false, false)).toBe(false);
    expect(shouldTypeToFocus(key({ altKey: true }), 'other', false, false)).toBe(false);
  });

  it('поле, терминал, редактор и диалог по контексту — нет', () => {
    for (const context of ['input', 'terminal', 'monaco', 'dialog'] as const) {
      expect(shouldTypeToFocus(key(), context, false, false)).toBe(false);
    }
  });

  it('набор IME, автоповтор, открытая палитра, открытый диалог — нет', () => {
    expect(shouldTypeToFocus(key({ isComposing: true }), 'other', false, false)).toBe(false);
    expect(shouldTypeToFocus(key({ repeat: true }), 'other', false, false)).toBe(false);
    expect(shouldTypeToFocus(key(), 'other', true, false)).toBe(false);
    expect(shouldTypeToFocus(key(), 'other', false, true)).toBe(false);
  });

  it('непечатная клавиша (Enter, Tab, стрелки) — нет', () => {
    for (const name of ['Enter', 'Tab', 'ArrowDown', 'Escape']) {
      expect(shouldTypeToFocus(key({ key: name }), 'other', false, false)).toBe(false);
    }
  });
});

describe('focusComposer', () => {
  const unregisters: Array<() => void> = [];
  function field(html = '<textarea></textarea>'): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.append(host);
    const element = host.firstElementChild as HTMLElement;
    unregisters.push(registerComposer(element));
    return element;
  }

  afterEach(() => {
    unregisters.splice(0).forEach((unregister) => unregister());
    setVisibilityCheck();
    document.body.innerHTML = '';
  });

  it('без зарегистрированных полей — false', () => {
    expect(focusComposer()).toBe(false);
  });

  it('берёт видимое поле и фокусирует его', () => {
    const hidden = field();
    const shown = field();
    setVisibilityCheck((element) => element === shown);
    expect(focusComposer()).toBe(true);
    expect(document.activeElement).toBe(shown);
    expect(document.activeElement).not.toBe(hidden);
  });

  it('все поля скрыты — false', () => {
    field();
    setVisibilityCheck(() => false);
    expect(focusComposer()).toBe(false);
  });

  it('предпочитает поле сфокусированной группы', () => {
    field();
    const host = document.createElement('div');
    host.setAttribute('data-group-focused', 'true');
    host.innerHTML = '<textarea></textarea>';
    document.body.append(host);
    const inGroup = host.firstElementChild as HTMLElement;
    unregisters.push(registerComposer(inGroup));
    setVisibilityCheck(() => true);
    expect(focusComposer()).toBe(true);
    expect(document.activeElement).toBe(inGroup);
  });

  it('после отмены регистрации поле не выбирается', () => {
    const element = field();
    setVisibilityCheck(() => true);
    unregisters.splice(0).forEach((unregister) => unregister());
    expect(focusComposer()).toBe(false);
    expect(document.activeElement).not.toBe(element);
  });
});
