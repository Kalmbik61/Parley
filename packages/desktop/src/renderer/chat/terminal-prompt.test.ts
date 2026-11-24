import { describe, expect, it } from 'vitest';
import { PROMPT_AFTER_KEY_MS, PROMPT_POLL_MS, PROMPT_ROWS_SHOWN, keyData, promptLines } from './terminal-prompt.js';

const key = (name: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
  key: name,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

describe('константы панели', () => {
  it('20 строк, опрос 400 мс, пауза после нажатия 80 мс', () => {
    expect(PROMPT_ROWS_SHOWN).toBe(20);
    expect(PROMPT_POLL_MS).toBe(400);
    expect(PROMPT_AFTER_KEY_MS).toBe(80);
  });
});

describe('promptLines', () => {
  it('срезает пустое начало и хвост, пустая строка внутри остаётся', () => {
    expect(promptLines(['', 'a', '', 'b', '', ''])).toEqual(['a', '', 'b']);
  });

  it('вопрос на пустом экране стоит вверху: пустой низ срезан', () => {
    expect(promptLines(['', 'Hooks need review', '1. Review hooks', '', '', ''])).toEqual(['Hooks need review', '1. Review hooks']);
  });

  it('строка из одних пробелов считается пустой', () => {
    expect(promptLines(['   ', 'a', '  '])).toEqual(['a']);
  });

  it('30 непустых строк и max 16 — последние 16', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`);
    expect(promptLines(lines, 16)).toEqual(lines.slice(-16));
  });

  it('без max — последние PROMPT_ROWS_SHOWN', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`);
    expect(promptLines(lines)).toEqual(lines.slice(-PROMPT_ROWS_SHOWN));
  });

  it('все пустые — пустой список', () => {
    expect(promptLines(['', '  ', ''])).toEqual([]);
    expect(promptLines([])).toEqual([]);
  });
});

describe('keyData', () => {
  it('стрелки, Enter, Esc, Tab, Backspace', () => {
    expect(keyData(key('ArrowUp'))).toBe('\u001b[A');
    expect(keyData(key('ArrowDown'))).toBe('\u001b[B');
    expect(keyData(key('ArrowRight'))).toBe('\u001b[C');
    expect(keyData(key('ArrowLeft'))).toBe('\u001b[D');
    expect(keyData(key('Enter'))).toBe('\r');
    expect(keyData(key('Escape'))).toBe('\u001b');
    expect(keyData(key('Tab'))).toBe('\t');
    expect(keyData(key('Backspace'))).toBe('\u007f');
  });

  it('пробел и одиночный печатный знак — сам знак', () => {
    expect(keyData(key(' '))).toBe(' ');
    expect(keyData(key('1'))).toBe('1');
    expect(keyData(key('y'))).toBe('y');
    expect(keyData(key('Я'))).toBe('Я');
  });

  it('сочетания с ⌘, Ctrl и Alt — null', () => {
    expect(keyData(key('a', { metaKey: true }))).toBeNull();
    expect(keyData(key('c', { ctrlKey: true }))).toBeNull();
    expect(keyData(key('ArrowUp', { altKey: true }))).toBeNull();
  });

  it('одиночный модификатор, F-клавиши и прочие именованные — null', () => {
    expect(keyData(key('Shift'))).toBeNull();
    expect(keyData(key('F5'))).toBeNull();
    expect(keyData(key('Dead'))).toBeNull();
    expect(keyData(key('Home'))).toBeNull();
  });
});
