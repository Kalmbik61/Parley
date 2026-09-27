import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionId, KeyLike } from '../../shared/keybindings.js';
import type { FocusContext } from './focus-context.js';
import { installKeyHandler, resolveAction } from './handler.js';

/** ⌘-нажатие буквы или цифры; `extra` дописывает модификаторы и прочее. */
function press(keyName: string, code: string, extra: Partial<KeyLike> = {}): KeyLike {
  return {
    key: keyName,
    code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    ...extra,
  };
}
const cmd = (keyName: string, code: string, extra: Partial<KeyLike> = {}): KeyLike =>
  press(keyName, code, { metaKey: true, ...extra });

const CMD_D = cmd('d', 'KeyD');
const CMD_BRACKET = cmd('[', 'BracketLeft');
const CMD_L = cmd('l', 'KeyL');
const CMD_SHIFT_DOWN = cmd('ArrowDown', 'ArrowDown', { shiftKey: true });
const CMD_J = cmd('j', 'KeyJ');
const CMD_K = cmd('k', 'KeyK');
const CTRL_C = press('c', 'KeyC', { ctrlKey: true });
const CTRL_TAB = press('Tab', 'Tab', { ctrlKey: true });
const CMD_1 = cmd('1', 'Digit1');
const CMD_A = cmd('a', 'KeyA');
const CMD_0 = cmd('0', 'Digit0');
const CMD_W = cmd('w', 'KeyW');
const CMD_T = cmd('t', 'KeyT');

describe('resolveAction (тест 4)', () => {
  it('⌘D: в monaco — null, в other — group.splitRight', () => {
    expect(resolveAction(CMD_D, 'monaco', false)).toBeNull();
    expect(resolveAction(CMD_D, 'other', false)).toBe('group.splitRight');
  });

  it('⌘[ и ⌘L в monaco — null, ⌘[ в other — group.prev', () => {
    expect(resolveAction(CMD_BRACKET, 'monaco', false)).toBeNull();
    expect(resolveAction(CMD_L, 'monaco', false)).toBeNull();
    expect(resolveAction(CMD_BRACKET, 'other', false)).toBe('group.prev');
  });

  it('⌘⇧↓: в input — null, в other и terminal — work.next (тест 11 куска 3.4)', () => {
    expect(resolveAction(CMD_SHIFT_DOWN, 'input', false)).toBeNull();
    expect(resolveAction(CMD_SHIFT_DOWN, 'other', false)).toBe('work.next');
    expect(resolveAction(CMD_SHIFT_DOWN, 'terminal', false)).toBe('work.next');
    expect(resolveAction(CMD_SHIFT_DOWN, 'monaco', false)).toBeNull();
  });

  it('⌘J в terminal — palette.open', () => {
    expect(resolveAction(CMD_J, 'terminal', false)).toBe('palette.open');
  });

  it('⌘K: в terminal — terminal.clear, в other и input — null', () => {
    expect(resolveAction(CMD_K, 'terminal', false)).toBe('terminal.clear');
    expect(resolveAction(CMD_K, 'other', false)).toBeNull();
    expect(resolveAction(CMD_K, 'input', false)).toBeNull();
  });

  it('⌘F: в terminal — find, в other — null (browser.find ловит только гость)', () => {
    expect(resolveAction(cmd('f', 'KeyF'), 'terminal', false)).toBe('find');
    expect(resolveAction(cmd('f', 'KeyF'), 'other', false)).toBeNull();
  });

  it('⌃C в terminal — null', () => {
    expect(resolveAction(CTRL_C, 'terminal', false)).toBeNull();
  });

  it('⌃Tab: в terminal — tab.mruNext, в input — null; ⌃⇧Tab — tab.mruPrev; ⌃2 — tab.goto.2', () => {
    expect(resolveAction(CTRL_TAB, 'terminal', false)).toBe('tab.mruNext');
    expect(resolveAction(CTRL_TAB, 'input', false)).toBeNull();
    expect(resolveAction(CTRL_TAB, 'monaco', false)).toBe('tab.mruNext');
    expect(resolveAction({ ...CTRL_TAB, shiftKey: true }, 'other', false)).toBe('tab.mruPrev');
    expect(resolveAction(press('2', 'Digit2', { ctrlKey: true }), 'terminal', false)).toBe('tab.goto.2');
    expect(resolveAction(press('2', 'Digit2', { ctrlKey: true }), 'input', false)).toBeNull();
  });

  it('⌘1 при открытой палитре — palette.row 0; при закрытой — work.goto.1', () => {
    expect(resolveAction(CMD_1, 'input', true)).toEqual({ kind: 'palette.row', index: 0 });
    expect(resolveAction(cmd('9', 'Digit9'), 'input', true)).toEqual({ kind: 'palette.row', index: 8 });
    expect(resolveAction(CMD_1, 'other', false)).toBe('work.goto.1');
  });

  it('⌘A в input — null', () => {
    expect(resolveAction(CMD_A, 'input', false)).toBeNull();
  });

  it('⌘0 в other — null: действия browser.* рендерер не ловит', () => {
    expect(resolveAction(CMD_0, 'other', false)).toBeNull();
    expect(resolveAction(cmd('=', 'Equal'), 'other', false)).toBeNull();
  });

  it('⌘W, ⌘T, ⌘1 и ⌃Tab в dialog — null', () => {
    for (const event of [CMD_W, CMD_T, CMD_1, CTRL_TAB]) expect(resolveAction(event, 'dialog', false)).toBeNull();
    expect(resolveAction(CMD_1, 'dialog', true)).toBeNull();
  });

  it('⌘J с isComposing — null', () => {
    expect(resolveAction({ ...CMD_J, isComposing: true }, 'terminal', false)).toBeNull();
  });
});

describe('installKeyHandler (тест 5)', () => {
  let uninstall: (() => void) | null = null;

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    document.body.innerHTML = '';
  });

  function install(
    overrides: Partial<{ context: FocusContext; paletteOpen: boolean; available: (id: ActionId) => boolean }> = {},
  ) {
    const run = vi.fn<(id: ActionId) => void>();
    const pickPaletteRow = vi.fn<(index: number) => void>();
    const endMruCycle = vi.fn<() => void>();
    uninstall = installKeyHandler({
      run,
      pickPaletteRow,
      endMruCycle,
      context: () => overrides.context ?? 'other',
      paletteOpen: () => overrides.paletteOpen ?? false,
      available: overrides.available ?? (() => true),
    });
    return { run, pickPaletteRow, endMruCycle };
  }

  function keydown(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  }

  it('совпадение — defaultPrevented и run(id)', () => {
    const { run } = install();
    const event = keydown({ key: 'd', code: 'KeyD', metaKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledWith('group.splitRight');
  });

  it('palette.row — defaultPrevented и pickPaletteRow(0), run не вызван', () => {
    const { run, pickPaletteRow } = install({ context: 'input', paletteOpen: true });
    const event = keydown({ key: '1', code: 'Digit1', metaKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(pickPaletteRow).toHaveBeenCalledWith(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('null и недоступное действие — событие идёт дальше без preventDefault', () => {
    const { run } = install({ available: (id) => id !== 'group.splitRight' });
    const unknown = keydown({ key: 'q', code: 'KeyQ', ctrlKey: true });
    const unavailable = keydown({ key: 'd', code: 'KeyD', metaKey: true });
    expect(unknown.defaultPrevented).toBe(false);
    expect(unavailable.defaultPrevented).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('⌘K в terminal — run(terminal.clear), defaultPrevented, поле xterm события не получило (тест 10 куска 5.3)', () => {
    document.body.innerHTML = '<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>';
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    const fieldListener = vi.fn();
    textarea.addEventListener('keydown', fieldListener);
    const { run } = install({ context: 'terminal' });

    const event = keydown({ key: 'k', code: 'KeyK', metaKey: true }, textarea);

    expect(run).toHaveBeenCalledWith('terminal.clear');
    expect(event.defaultPrevented).toBe(true);
    expect(fieldListener).not.toHaveBeenCalled();
  });

  it('keyup Control и blur окна зовут endMruCycle, keyup другой клавиши — нет', () => {
    const { endMruCycle } = install();
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }));
    expect(endMruCycle).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }));
    expect(endMruCycle).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new FocusEvent('blur'));
    expect(endMruCycle).toHaveBeenCalledTimes(2);
  });

  it('blur поля внутри окна — не конец цикла', () => {
    document.body.innerHTML = '<input type="text">';
    const { endMruCycle } = install();
    (document.querySelector('input') as HTMLInputElement).dispatchEvent(new FocusEvent('blur'));
    expect(endMruCycle).not.toHaveBeenCalled();
  });

  it('отписка снимает все три слушателя', () => {
    const { run, endMruCycle } = install();
    uninstall?.();
    uninstall = null;
    const event = keydown({ key: 'd', code: 'KeyD', metaKey: true });
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }));
    window.dispatchEvent(new FocusEvent('blur'));
    expect(event.defaultPrevented).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(endMruCycle).not.toHaveBeenCalled();
  });
});
