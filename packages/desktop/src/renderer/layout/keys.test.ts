/**
 * Тест 4 куска 2.4: ⌃2 → индекс 1, ⌃Tab → MRU вперёд, ⌘⇧] → шаг вкладки
 * вперёд, ⌘J → ничего (палитра ⌘J — этап 6, тут не занята).
 */

import { describe, expect, it } from 'vitest';
import { isTextEntryTarget, layoutKeyAction, neighborInOrder } from './keys.js';

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init);
}

describe('layoutKeyAction — тест 4', () => {
  it('⌃2 → выбор вкладки по индексу 1 (0-based)', () => {
    expect(layoutKeyAction(key({ key: '2', ctrlKey: true }))).toEqual({ kind: 'tab-index', index: 1 });
  });

  it('⌃Tab → MRU вперёд', () => {
    expect(layoutKeyAction(key({ key: 'Tab', ctrlKey: true }))).toEqual({ kind: 'mru', step: 1 });
  });

  it('⌃⇧Tab → MRU назад', () => {
    expect(layoutKeyAction(key({ key: 'Tab', ctrlKey: true, shiftKey: true }))).toEqual({ kind: 'mru', step: -1 });
  });

  it('⌘⇧] → шаг вкладки вперёд', () => {
    expect(layoutKeyAction(key({ key: ']', metaKey: true, shiftKey: true }))).toEqual({ kind: 'tab-step', step: 1 });
  });

  it('⌘⇧[ → шаг вкладки назад', () => {
    expect(layoutKeyAction(key({ key: '[', metaKey: true, shiftKey: true }))).toEqual({ kind: 'tab-step', step: -1 });
  });

  it('⌘J → ничего', () => {
    expect(layoutKeyAction(key({ key: 'j', metaKey: true }))).toBeNull();
  });

  it('⌃0 и ⌃⇧2 — вне диапазона 1–9 или с ⇧, ничего', () => {
    expect(layoutKeyAction(key({ key: '0', ctrlKey: true }))).toBeNull();
    expect(layoutKeyAction(key({ key: '2', ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('обычная буква без модификаторов — ничего', () => {
    expect(layoutKeyAction(key({ key: 'a' }))).toBeNull();
  });
});

describe('⌘⇧↑↓ — соседняя работа (кусок 3.4)', () => {
  it('⌘⇧↓ — work-step 1, ⌘⇧↑ — work-step −1; без ⇧ или с ⌃ — ничего', () => {
    expect(layoutKeyAction(key({ key: 'ArrowDown', metaKey: true, shiftKey: true }))).toEqual({ kind: 'work-step', step: 1 });
    expect(layoutKeyAction(key({ key: 'ArrowUp', metaKey: true, shiftKey: true }))).toEqual({ kind: 'work-step', step: -1 });
    expect(layoutKeyAction(key({ key: 'ArrowDown', metaKey: true }))).toBeNull();
    expect(layoutKeyAction(key({ key: 'ArrowDown', metaKey: true, shiftKey: true, ctrlKey: true }))).toBeNull();
  });

  it('neighborInOrder: соседняя по кругу; активной нет в порядке — ↓ первая, ↑ последняя (тест 20); пусто — null', () => {
    expect(neighborInOrder(['a', 'b', 'c'], 'b', 1)).toBe('c');
    expect(neighborInOrder(['a', 'b', 'c'], 'b', -1)).toBe('a');
    expect(neighborInOrder(['a', 'b', 'c'], 'c', 1)).toBe('a');
    expect(neighborInOrder(['a', 'b', 'c'], 'x', 1)).toBe('a');
    expect(neighborInOrder(['a', 'b', 'c'], null, -1)).toBe('c');
    expect(neighborInOrder([], 'a', 1)).toBeNull();
  });

  it('isTextEntryTarget: input, textarea и contenteditable — да; помощник xterm и прочее — нет (спека 9.6)', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const inner = document.createElement('span');
    editable.appendChild(inner);
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    const helper = document.createElement('textarea');
    helper.className = 'xterm-helper-textarea';
    xterm.appendChild(helper);
    expect([input, textarea, editable, inner].map(isTextEntryTarget)).toEqual([true, true, true, true]);
    expect(isTextEntryTarget(helper)).toBe(false);
    expect(isTextEntryTarget(document.createElement('button'))).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});
