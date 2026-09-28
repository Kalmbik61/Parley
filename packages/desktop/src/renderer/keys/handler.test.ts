import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionId, KeyLike } from '../../shared/keybindings.js';
import type { FocusContext } from './focus-context.js';
import { IMPLEMENTED_ACTIONS, installKeyHandler, isActionAvailable, resolveAction } from './handler.js';

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

  it('открытая палитра: ⌘D, ⌘N, ⌘W, ⌘T, ⌃Tab, ⌘B за ней не выполняются — только ⌘1–9 и ⌘J (решение контролёра 2 куска 6.2)', () => {
    const CMD_N = cmd('n', 'KeyN');
    const CMD_B = cmd('b', 'KeyB');
    for (const context of ['input', 'other'] as const) {
      for (const event of [CMD_D, CMD_N, CMD_W, CMD_T, CTRL_TAB, CMD_B, CMD_SHIFT_DOWN, CMD_BRACKET]) {
        expect(resolveAction(event, context, true)).toBeNull();
      }
      expect(resolveAction(CMD_J, context, true)).toBe('palette.open');
      expect(resolveAction(CMD_1, context, true)).toEqual({ kind: 'palette.row', index: 0 });
    }
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
    overrides: Partial<{
      context: FocusContext;
      palette: boolean;
      available: (id: ActionId) => boolean;
      run: (id: ActionId) => void;
    }> = {},
  ) {
    const run = vi.fn<(id: ActionId) => void>(overrides.run);
    const pickPaletteRow = vi.fn<(index: number) => void>();
    const endMruCycle = vi.fn<() => void>();
    uninstall = installKeyHandler({
      run,
      pickPaletteRow,
      endMruCycle,
      context: () => overrides.context ?? 'other',
      paletteOpen: () => overrides.palette ?? false,
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
    const { run, pickPaletteRow } = install({ context: 'input', palette: true });
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

  it('удержание ⌘N: автоповтор погашен, но run один (раунд исправлений 1)', () => {
    const { run } = install();
    const first = keydown({ key: 'n', code: 'KeyN', metaKey: true });
    const repeats = [1, 2, 3].map(() => keydown({ key: 'n', code: 'KeyN', metaKey: true, repeat: true }));
    expect(run.mock.calls).toEqual([['work.new']]);
    // Погашен и повтор: иначе необработанное ⌘N сработало бы пунктом меню.
    expect([first, ...repeats].every((event) => event.defaultPrevented)).toBe(true);
  });

  it('удержание ⌘⇧]: шаг навигации повторяется', () => {
    const { run } = install();
    keydown({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true });
    keydown({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true, repeat: true });
    keydown({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true, repeat: true });
    expect(run.mock.calls).toEqual([['tab.next'], ['tab.next'], ['tab.next']]);
  });

  it('исключение действия ловится (console.error) и не ломает следующее нажатие', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const uncaught = vi.fn();
    window.addEventListener('error', uncaught);
    let calls = 0;
    const { run } = install({
      run: () => {
        calls += 1;
        if (calls === 1) throw new Error('boom from run()');
      },
    });
    const first = keydown({ key: 'd', code: 'KeyD', metaKey: true });
    const second = keydown({ key: 'd', code: 'KeyD', metaKey: true });
    window.removeEventListener('error', uncaught);
    expect(run).toHaveBeenCalledTimes(2);
    expect(first.defaultPrevented && second.defaultPrevented).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    expect(uncaught).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('isActionAvailable (тест 2 куска 6.1b)', () => {
  it('group.splitRight, works.showArchived (6.3), sidebar.right.toggle и sidebar.files (7.2), files.quickOpen и files.search (7.4) — да', () => {
    const methods = new Set<string>();
    expect(isActionAvailable('group.splitRight', methods)).toBe(true);
    expect(isActionAvailable('works.showArchived', methods)).toBe(true);
    expect(isActionAvailable('files.quickOpen', methods)).toBe(true);
    expect(isActionAvailable('files.search', methods)).toBe(true);
    expect(isActionAvailable('sidebar.right.toggle', methods)).toBe(true);
    expect(isActionAvailable('sidebar.files', methods)).toBe(true);
  });

  it('ветки run 6.1b — все реализованы; browser.* и палитровые — нет', () => {
    for (const id of ['palette.open', 'work.new', 'session.new', 'settings.open', 'sidebar.left.toggle', 'work.goto.1', 'work.goto.9', 'work.prev', 'work.next', 'history.back', 'history.forward', 'group.splitRight', 'group.splitDown', 'group.prev', 'group.next', 'tab.close', 'tab.reopen', 'tab.prev', 'tab.next', 'tab.goto.1', 'tab.goto.9', 'tab.mruNext', 'tab.mruPrev', 'find', 'terminal.clear'] as const) {
      expect(IMPLEMENTED_ACTIONS.has(id)).toBe(true);
    }
    for (const id of ['browser.find', 'browser.newTab', 'sidebar.changes'] as const) {
      expect(IMPLEMENTED_ACTIONS.has(id)).toBe(false);
    }
  });

  it('действия 6.3 реализованы; wake.toggle доступен только с wake.pause и wake.resume хоста', () => {
    for (const id of ['works.showArchived', 'attention.next', 'wake.toggle', 'host.restart', 'appearance.system', 'appearance.dark', 'appearance.light', 'room.new'] as const) {
      expect(IMPLEMENTED_ACTIONS.has(id)).toBe(true);
    }
    expect(isActionAvailable('wake.toggle', new Set(['wake.pause']))).toBe(false);
    expect(isActionAvailable('wake.toggle', new Set(['wake.pause', 'wake.resume']))).toBe(true);
  });
});
