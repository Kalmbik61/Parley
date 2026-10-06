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

/**
 * Все ActionId: `Record<ActionId, true>` не соберётся, если член типа пропущен или лишний, —
 * так тест ниже ловит расхождение типа и таблицы (раунд исправлений 1).
 */
const ALL_ACTION_IDS: Record<ActionId, true> = {
  'palette.open': true, 'files.quickOpen': true, 'files.search': true,
  'work.new': true, 'session.new': true, 'room.new': true,
  'work.goto.1': true, 'work.goto.2': true, 'work.goto.3': true, 'work.goto.4': true, 'work.goto.5': true,
  'work.goto.6': true, 'work.goto.7': true, 'work.goto.8': true, 'work.goto.9': true,
  'work.prev': true, 'work.next': true, 'works.showArchived': true,
  'history.back': true, 'history.forward': true,
  'sidebar.left.toggle': true, 'sidebar.right.toggle': true, 'sidebar.files': true, 'sidebar.changes': true,
  'group.splitRight': true, 'group.splitDown': true, 'group.prev': true, 'group.next': true,
  'tab.close': true, 'tab.reopen': true, 'tab.prev': true, 'tab.next': true, 'tab.mruNext': true, 'tab.mruPrev': true,
  'tab.goto.1': true, 'tab.goto.2': true, 'tab.goto.3': true, 'tab.goto.4': true, 'tab.goto.5': true,
  'tab.goto.6': true, 'tab.goto.7': true, 'tab.goto.8': true, 'tab.goto.9': true,
  find: true, 'voice.toggle': true, 'terminal.clear': true, 'chat.toggleView': true, 'settings.open': true,
  'attention.next': true, 'wake.toggle': true, 'host.restart': true,
  'appearance.system': true, 'appearance.dark': true, 'appearance.light': true,
  'browser.newTab': true,
  'browser.find': true, 'browser.zoomIn': true, 'browser.zoomOut': true, 'browser.zoomReset': true,
};

describe('ACTIONS (тест 1)', () => {
  it('у каждого ActionId ровно одна запись в ACTIONS', () => {
    const ids = ACTIONS.map((action) => action.id);
    expect([...ids].sort()).toEqual(Object.keys(ALL_ACTION_IDS).sort());
  });

  it('автоповтор — только у шагов навигации и масштаба', () => {
    expect(ACTIONS.filter((action) => action.repeatable === true).map((action) => action.id).sort()).toEqual(
      ['browser.zoomIn', 'browser.zoomOut', 'group.next', 'group.prev', 'tab.next', 'tab.prev', 'work.next', 'work.prev'],
    );
  });

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

describe('voice.toggle (спека диктовки, 3.4)', () => {
  it('voice.toggle — ⌘⇧M, меню Edit, везде, в палитре; сочетание ни с чем не совпадает', () => {
    const action = ACTIONS.find((candidate) => candidate.id === 'voice.toggle');
    expect(action).toMatchObject({ keys: 'CmdOrCtrl+Shift+M', menu: 'edit', when: 'always', inPalette: true });
    expect(ACTIONS.filter((candidate) => candidate.keys === 'CmdOrCtrl+Shift+M')).toHaveLength(1);
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
