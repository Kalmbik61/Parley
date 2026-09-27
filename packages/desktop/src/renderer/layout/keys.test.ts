/**
 * Тест 4 куска 2.4: ⌃2 → индекс 1, ⌃Tab → MRU вперёд, ⌘⇧] → шаг вкладки
 * вперёд, ⌘J → ничего (палитра ⌘J — этап 6, тут не занята).
 */

import { describe, expect, it } from 'vitest';
import { layoutKeyAction } from './keys.js';

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
