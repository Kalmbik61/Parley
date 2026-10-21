// packages/desktop/src/main/browser/agent-input.test.ts
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { AgentOpError } from './agent-errors.js';
import { createAgentInput, inputPoint, keySpec, modifierMask, viewPoint, type MouseStep } from './agent-input.js';

describe('точка ввода и клавиши (этап 0, 0.4; спайк D, В6)', () => {
  it('inputPoint: без эмуляции — как есть; эмуляция — × scale; мобильная — × scale ÷ zoom', () => {
    expect(inputPoint({ x: 200, y: 230 }, null, 2)).toEqual({ x: 200, y: 230 });
    expect(inputPoint({ x: 200, y: 230 }, { scale: 0.6, mobile: false }, 2)).toEqual({ x: 120, y: 138 });
    const mobile = inputPoint({ x: 200, y: 230 }, { scale: 0.6, mobile: true }, 2);
    expect(mobile.x).toBeCloseTo(60);
    expect(mobile.y).toBeCloseTo(69);
  });

  it('keySpec: имена клавиш и символы; незнакомое — null; modifierMask', () => {
    expect(keySpec('Enter')).toEqual({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
    expect(keySpec('ArrowDown')).toEqual({ key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 });
    expect(keySpec('b')).toEqual({ key: 'b', code: 'KeyB', keyCode: 66, text: 'b' });
    expect(keySpec('7')).toEqual({ key: '7', code: 'Digit7', keyCode: 55, text: '7' });
    expect(keySpec('Hyper')).toBeNull();
    expect(modifierMask(['Alt', 'Shift'])).toBe(9);
    expect(modifierMask(['Meta'])).toBe(4);
  });
});

describe('AgentInput (Фокус ревью 1)', () => {
  function setup(borrow = true) {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const order: string[] = [];
    const inspector = {
      send: vi.fn(async (_id: number, method: string, params?: Record<string, unknown>) => {
        calls.push([method, params]);
        order.push(method);
        return {};
      }),
    };
    const borrowFocus = vi.fn(async () => {
      order.push('borrow');
    });
    const input = createAgentInput({ inspector, ...(borrow ? { borrowFocus } : {}) });
    const guard = { signal: new AbortController().signal, check: vi.fn() };
    const contents = { id: 7 } as unknown as WebContents;
    return { calls, order, input, guard, contents, borrowFocus };
  }

  // Путь А (решение владельца 7): 'borrow' первым; спайк В4 (3): без эмуляции фокуса страница видит blur после возврата фокуса.
  it('фокус одалживается один раз за операцию и до первой клавиши; check — перед каждым шагом', async () => {
    const { order, input, guard, contents, borrowFocus } = setup();
    await input.text(contents, 'Ann', guard);
    await input.key(contents, keySpec('Enter')!, 0, guard);
    expect(order).toEqual(['borrow', 'Emulation.setFocusEmulationEnabled', 'Input.insertText', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent']);
    expect(borrowFocus).toHaveBeenCalledTimes(1);
    // Одалживанию нужен guard операции: с просьбы о фокусе оно гасит нажатия человека и обрывает операцию (D1).
    expect(borrowFocus).toHaveBeenCalledWith(contents, guard);
    // Перед каждым из трёх шагов и ещё раз после одалживания фокуса.
    expect(guard.check).toHaveBeenCalledTimes(4);
  });

  it('check бросил (Stop) — ни одной команды Input после', async () => {
    const { calls, input, guard, contents } = setup();
    guard.check.mockImplementationOnce(() => {
      throw new AgentOpError('access_denied', 'paused by the human');
    });
    await expect(input.text(contents, 'Ann', guard)).rejects.toMatchObject({ code: 'access_denied' });
    expect(calls.filter(([method]) => method.startsWith('Input.'))).toEqual([]);
  });

  it('press Meta+A — selectAll; иные сочетания — без commands (буфер обмена агенту недоступен)', async () => {
    const { calls, input, guard, contents } = setup();
    await input.key(contents, keySpec('a')!, modifierMask(['Meta']), guard);
    await input.key(contents, keySpec('v')!, modifierMask(['Meta']), guard);
    const downs = calls.filter(([method, params]) => method === 'Input.dispatchKeyEvent' && params?.type === 'keyDown').map(([, params]) => params);
    expect(downs[0]).toEqual({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'] });
    expect(downs[1]).not.toHaveProperty('commands');
    expect(downs[1]).not.toHaveProperty('text');
  });

  it('мышь тоже одалживает фокус до первого шага (спайк В3: клик уводит фокус окна на <webview>)', async () => {
    const { order, input, guard, contents, borrowFocus } = setup();
    await input.mouse(contents, [{ type: 'mouseMoved', x: 1, y: 2 }], 0, guard);
    expect(order).toEqual(['borrow', 'Emulation.setFocusEmulationEnabled', 'Input.dispatchMouseEvent']);
    expect(borrowFocus).toHaveBeenCalledTimes(1);
  });

  it('mouse — шаги по порядку с модификаторами; отмена signal между шагами — остальные не уходят', async () => {
    const { calls, input, contents } = setup(false);
    const controller = new AbortController();
    const guard = {
      signal: controller.signal,
      check: vi.fn(() => {
        if (calls.length === 1) controller.abort();
        controller.signal.throwIfAborted();
      }),
    };
    await expect(
      input.mouse(contents, [{ type: 'mouseMoved', x: 1, y: 2 }, { type: 'mousePressed', x: 1, y: 2, button: 'left', clickCount: 1 }], 0, guard),
    ).rejects.toThrow();
    expect(calls.map(([, params]) => params?.type)).toEqual(['mouseMoved']);
  });

  it('обрыв после mousePressed — один mouseReleased мимо guard; после keyDown — один keyUp (рецензия m6, Фокус ревью 8)', async () => {
    const { calls, input, contents } = setup(false);
    const controller = new AbortController();
    const guard = {
      signal: controller.signal,
      check: vi.fn(() => {
        if (calls.some(([, p]) => p?.type === 'mousePressed')) controller.abort();
        controller.signal.throwIfAborted();
      }),
    };
    const steps: MouseStep[] = [
      { type: 'mouseMoved', x: 1, y: 2 },
      { type: 'mousePressed', x: 1, y: 2, button: 'left', buttons: 1, clickCount: 1 },
      { type: 'mouseMoved', x: 50, y: 2, buttons: 1 },
      { type: 'mouseReleased', x: 99, y: 2, button: 'left', clickCount: 1 },
    ];
    await expect(input.mouse(contents, steps, 0, guard)).rejects.toThrow();
    expect(calls.map(([, p]) => [p?.type, p?.x])).toEqual([['mouseMoved', 1], ['mousePressed', 1], ['mouseReleased', 1]]);
  });

  it('обрыв между keyDown и keyUp — один keyUp мимо guard', async () => {
    const { calls, input, contents } = setup(false);
    const controller = new AbortController();
    const guard = {
      signal: controller.signal,
      check: vi.fn(() => {
        if (calls.some(([, p]) => p?.type === 'keyDown')) controller.abort();
        controller.signal.throwIfAborted();
      }),
    };
    await expect(input.key(contents, keySpec('b')!, 0, guard)).rejects.toThrow();
    expect(calls.map(([, p]) => p?.type)).toEqual(['keyDown', 'keyUp']);
  });

  it('тишина клавиатуры — после одалживания фокуса и перед каждой командой Input; человек печатает при одолженном фокусе — ни одной команды (рецензия пачки 3)', async () => {
    const { calls, order, input, contents } = setup();
    const keyboardQuiet = vi.fn(() => {
      order.push('quiet');
      if (calls.some(([method]) => method === 'Input.insertText')) throw new AgentOpError('human_busy', 'The human is typing: retry in a moment.');
    });
    const guard = { signal: new AbortController().signal, check: vi.fn(), keyboardQuiet };
    await input.text(contents, 'Ann', guard);
    expect(order).toEqual(['borrow', 'Emulation.setFocusEmulationEnabled', 'quiet', 'Input.insertText']);
    await expect(input.key(contents, keySpec('Enter')!, 0, guard)).rejects.toMatchObject({ code: 'human_busy' });
    expect(calls.filter(([method]) => method === 'Input.dispatchKeyEvent')).toEqual([]);
  });

  it('Stop пришёл, пока окно одалживало фокус, — ни одной команды Input (рецензия пачки 2)', async () => {
    const { calls, input, contents, borrowFocus } = setup();
    const controller = new AbortController();
    const guard = { signal: controller.signal, check: vi.fn(() => controller.signal.throwIfAborted()) };
    borrowFocus.mockImplementationOnce(async () => {
      controller.abort(new AgentOpError('access_denied', 'Stopped by the human (paused by the human).'));
    });
    await expect(input.text(contents, 'Ann', guard)).rejects.toMatchObject({ code: 'access_denied' });
    expect(calls.filter(([method]) => method.startsWith('Input.'))).toEqual([]);
  });

  it('borrowFocus бросил tab_hidden (окно не поставило фокус) или human_busy (человек печатает) — ни одной команды Input (Фокус ревью 1, 2)', async () => {
    const { calls, input, guard, contents, borrowFocus } = setup();
    borrowFocus.mockRejectedValueOnce(new AgentOpError('tab_hidden', 'Page t1 could not take keyboard focus: ask the human to show the page.'));
    await expect(input.text(contents, 'Ann', guard)).rejects.toMatchObject({ code: 'tab_hidden' });
    expect(calls.filter(([method]) => method.startsWith('Input.'))).toEqual([]);
  });

  it('viewPoint — точка для окна в пикселях элемента <webview> (рецензия m8, спайк В6): × zoom без эмуляции; × scale × zoom при эмуляции; мобильная — × scale', () => {
    expect(viewPoint({ x: 200, y: 230 }, null, 2)).toEqual({ x: 400, y: 460 });
    expect(viewPoint({ x: 200, y: 230 }, { scale: 0.6, mobile: false }, 1)).toEqual({ x: 120, y: 138 });
    const zoomed = viewPoint({ x: 200, y: 230 }, { scale: 0.6, mobile: false }, 2); // масштаб страницы 2 при эмуляции — × scale × zoom (спайк: 0,864 = 0,6 × 1,44)
    expect(zoomed.x).toBeCloseTo(240);
    expect(zoomed.y).toBeCloseTo(276);
    expect(viewPoint({ x: 200, y: 230 }, { scale: 0.6, mobile: true }, 2)).toEqual({ x: 120, y: 138 }); // мобильная: масштаб страницы на раскладку не влияет
  });
});
