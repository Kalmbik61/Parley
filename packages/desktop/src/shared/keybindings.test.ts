import { describe, expect, it } from 'vitest';
import { ACTIONS, matchesAccelerator } from './keybindings.js';
import type { ActionDef, ActionId, KeyLike } from './keybindings.js';
import { S } from './strings.js';

const CYRILLIC = /[Ѐ-ӿ]/;

/** Нажатие без модификаторов — тесты дописывают нужные. */
function key(partial: Partial<KeyLike> & { key: string }): KeyLike {
  return { code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...partial };
}

/** Клавиша accelerator → нажатие, как его отдаёт браузер на американской раскладке. */
const PRESS_KEY: Record<string, { key: string; code: string }> = {
  Up: { key: 'ArrowUp', code: 'ArrowUp' },
  Down: { key: 'ArrowDown', code: 'ArrowDown' },
  Left: { key: 'ArrowLeft', code: 'ArrowLeft' },
  Right: { key: 'ArrowRight', code: 'ArrowRight' },
  Tab: { key: 'Tab', code: 'Tab' },
  Plus: { key: '=', code: 'Equal' },
  '-': { key: '-', code: 'Minus' },
  ',': { key: ',', code: 'Comma' },
  '[': { key: '[', code: 'BracketLeft' },
  ']': { key: ']', code: 'BracketRight' },
};

/** Нажатие, которое человек делает ради accelerator. */
function pressFor(accelerator: string): KeyLike {
  const parts = accelerator.split('+');
  const name = parts[parts.length - 1] ?? '';
  const mods = new Set(parts.slice(0, -1));
  const base =
    PRESS_KEY[name] ??
    (/^[A-Z]$/.test(name)
      ? { key: name.toLowerCase(), code: `Key${name}` }
      : { key: name, code: /^\d$/.test(name) ? `Digit${name}` : '' });
  return key({
    ...base,
    metaKey: mods.has('CmdOrCtrl'),
    ctrlKey: mods.has('Control'),
    altKey: mods.has('Alt'),
    shiftKey: mods.has('Shift'),
  });
}

function whenOverlaps(a: ActionDef['when'], b: ActionDef['when']): boolean {
  return a === b || a === 'always' || b === 'always';
}

describe('ACTIONS (тест 1)', () => {
  it('id уникальны', () => {
    const ids = ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('у каждого сочетания matchesAccelerator находит своё нажатие', () => {
    for (const action of ACTIONS) {
      if (action.keys === null) continue;
      expect(matchesAccelerator(action.keys, pressFor(action.keys)), `${action.id} ${action.keys}`).toBe(true);
    }
  });

  it('нет двух действий с одним сочетанием и пересекающимся when', () => {
    const keyed = ACTIONS.filter((action) => action.keys !== null);
    for (const a of keyed) {
      for (const b of keyed) {
        if (a === b || !whenOverlaps(a.when, b.when)) continue;
        expect(matchesAccelerator(a.keys as string, pressFor(b.keys as string)), `${a.id} / ${b.id}`).toBe(false);
      }
    }
  });

  it('у каждого действия непустой title из S.actions, кириллицы нет; keywords английские', () => {
    const titles = new Set<string>(
      Object.values(S.actions).flatMap((value) =>
        typeof value === 'string' ? [value] : Array.from({ length: 9 }, (_, index) => value(index + 1)),
      ),
    );
    for (const action of ACTIONS) {
      expect(action.title.length, action.id).toBeGreaterThan(0);
      expect(titles.has(action.title), `${action.id}: ${action.title}`).toBe(true);
      expect(CYRILLIC.test(action.title)).toBe(false);
      for (const word of action.keywords) expect(CYRILLIC.test(word), `${action.id}: ${word}`).toBe(false);
    }
  });

  it('inPalette: false ровно у palette.open, work.goto.N, tab.goto.N, tab.mruNext, tab.mruPrev', () => {
    const hidden = ACTIONS.filter((action) => !action.inPalette).map((action) => action.id).sort();
    const expected: ActionId[] = ['palette.open', 'tab.mruNext', 'tab.mruPrev'];
    for (let n = 1; n <= 9; n += 1) expected.push(`work.goto.${n}` as ActionId, `tab.goto.${n}` as ActionId);
    expect(hidden).toEqual(expected.sort());
  });

  it('действия браузера — when browser, без меню; палитровые без сочетания — без меню', () => {
    for (const id of ['browser.find', 'browser.zoomIn', 'browser.zoomOut', 'browser.zoomReset'] as const) {
      const action = ACTIONS.find((candidate) => candidate.id === id);
      expect(action?.when).toBe('browser');
      expect(action?.menu).toBeNull();
    }
    for (const id of ['works.showArchived', 'room.new', 'attention.next', 'wake.toggle', 'host.restart'] as const) {
      const action = ACTIONS.find((candidate) => candidate.id === id);
      expect(action?.keys).toBeNull();
      expect(action?.menu).toBeNull();
    }
  });
});

describe('matchesAccelerator (тест 2)', () => {
  it("'CmdOrCtrl+Shift+[' — по key '{' с Shift и по code BracketLeft", () => {
    expect(matchesAccelerator('CmdOrCtrl+Shift+[', key({ key: '{', metaKey: true, shiftKey: true }))).toBe(true);
    expect(
      matchesAccelerator('CmdOrCtrl+Shift+[', key({ key: 'х', code: 'BracketLeft', metaKey: true, shiftKey: true })),
    ).toBe(true);
  });

  it("'CmdOrCtrl+J' в русской раскладке — key 'о' при code KeyJ", () => {
    expect(matchesAccelerator('CmdOrCtrl+J', key({ key: 'о', code: 'KeyJ', metaKey: true }))).toBe(true);
  });

  it("'CmdOrCtrl+Plus' — key '=' и key '+' при Shift", () => {
    expect(matchesAccelerator('CmdOrCtrl+Plus', key({ key: '=', code: 'Equal', metaKey: true }))).toBe(true);
    expect(matchesAccelerator('CmdOrCtrl+Plus', key({ key: '+', code: 'Equal', metaKey: true, shiftKey: true }))).toBe(
      true,
    );
  });

  it('модификаторы — точно: лишний Shift, Alt или ⌃ — не совпадение', () => {
    expect(matchesAccelerator('CmdOrCtrl+D', key({ key: 'd', code: 'KeyD', metaKey: true, shiftKey: true }))).toBe(
      false,
    );
    expect(matchesAccelerator('CmdOrCtrl+D', key({ key: 'd', code: 'KeyD', metaKey: true, altKey: true }))).toBe(false);
    expect(matchesAccelerator('CmdOrCtrl+D', key({ key: 'd', code: 'KeyD', ctrlKey: true }))).toBe(false);
    expect(matchesAccelerator('Control+Tab', key({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true }))).toBe(
      false,
    );
  });
});
