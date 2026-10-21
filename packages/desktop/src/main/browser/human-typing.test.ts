// packages/desktop/src/main/browser/human-typing.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTypingClock } from './human-typing.js';

type Listener = (event: unknown, input: { type: string; key?: string; isAutoRepeat?: boolean }) => void;

function fakeContents(id: number) {
  const listeners = new Set<Listener>();
  return {
    id,
    on: vi.fn((_name: string, listener: Listener) => { listeners.add(listener); }),
    off: vi.fn((_name: string, listener: Listener) => { listeners.delete(listener); }),
    /** Возвращает `true`, если слушатель погасил событие (`preventDefault`). */
    input(input: { type: string; key?: string; isAutoRepeat?: boolean }): boolean {
      let prevented = false;
      for (const listener of [...listeners]) listener({ preventDefault: () => { prevented = true; } }, input);
      return prevented;
    },
    size: (): number => listeners.size,
  };
}

afterEach(() => vi.useRealTimers());

describe('тишина клавиатуры человека (рецензия M3)', () => {
  it('keyDown окна или любого гостя сбрасывает тишину; keyUp и автоповтор — нет', () => {
    let now = 0;
    const clock = createTypingClock({ now: () => now });
    const win = fakeContents(1), guest = fakeContents(7);
    clock.track(win as never); clock.track(guest as never);
    expect(clock.idleFor(1_000)).toBe(true);
    now = 1_000; win.input({ type: 'keyDown', key: 'h' });
    now = 1_500; expect(clock.idleFor(1_000)).toBe(false);
    now = 2_001; expect(clock.idleFor(1_000)).toBe(true);
    guest.input({ type: 'keyDown', key: 'a' });
    expect(clock.idleFor(1_000)).toBe(false);
    now = 4_000;
    win.input({ type: 'keyUp', key: 'h' });
    win.input({ type: 'keyDown', key: 'h', isAutoRepeat: true });
    expect(clock.idleFor(1_000)).toBe(true);
  });

  it('одолженный фокус (D1): keyDown, rawKeyDown, char и автоповтор гостя гасятся, сбрасывают тишину и зовут onHuman; keyUp, другой гость и окно — нет; после снятия — как обычно', () => {
    let now = 0;
    const clock = createTypingClock({ now: () => now });
    const win = fakeContents(1), guest = fakeContents(7), other = fakeContents(8);
    clock.track(win as never); clock.track(guest as never); clock.track(other as never);
    const onHuman = vi.fn();
    const unlend = clock.lend(7, onHuman);

    now = 5_000;
    expect(guest.input({ type: 'keyUp', key: 'x' })).toBe(false);
    expect(onHuman).not.toHaveBeenCalled();
    expect(clock.idleFor(1_000)).toBe(true);
    for (const press of [{ type: 'keyDown', key: 'x' }, { type: 'rawKeyDown', key: 'x' }, { type: 'char', key: 'x' }, { type: 'keyDown', key: 'x', isAutoRepeat: true }]) {
      expect(guest.input(press), press.type).toBe(true);
    }
    expect(onHuman).toHaveBeenCalledTimes(4);
    expect(clock.idleFor(1_000)).toBe(false);

    // Чужой гость и окно не гасятся: это ввод человека туда, где у него фокус.
    expect(other.input({ type: 'keyDown', key: 'y' })).toBe(false);
    expect(win.input({ type: 'keyDown', key: 'y' })).toBe(false);
    expect(onHuman).toHaveBeenCalledTimes(4);

    unlend();
    now = 10_000;
    expect(guest.input({ type: 'keyDown', key: 'z' })).toBe(false);
    expect(onHuman).toHaveBeenCalledTimes(4);
    // Одолжения нет: нажатие проходит в страницу и, как любое нажатие человека, сбрасывает тишину.
    expect(clock.idleFor(1_000)).toBe(false);
  });

  it('снятие старого одалживания не снимает новое на том же госте', () => {
    const clock = createTypingClock();
    const guest = fakeContents(7);
    clock.track(guest as never);
    const first = vi.fn(), second = vi.fn();
    const unlendFirst = clock.lend(7, first);
    clock.lend(7, second);
    unlendFirst();
    expect(guest.input({ type: 'keyDown', key: 'x' })).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('track возвращает отписку', () => {
    const clock = createTypingClock();
    const win = fakeContents(1);
    const off = clock.track(win as never);
    expect(win.size()).toBe(1);
    off();
    expect(win.size()).toBe(0);
  });

  it('waitIdle: дожидается тишины; не дождался за limit — false; отмена signal — отказ', async () => {
    vi.useFakeTimers();
    const clock = createTypingClock();
    const win = fakeContents(1);
    clock.track(win as never);

    win.input({ type: 'keyDown', key: 'h' });
    const waited = clock.waitIdle(1_000, 5_000, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1_200);
    await expect(waited).resolves.toBe(true);

    win.input({ type: 'keyDown', key: 'x' });
    const typing = setInterval(() => win.input({ type: 'keyDown', key: 'x' }), 200);
    const limited = clock.waitIdle(1_000, 2_000, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(limited).resolves.toBe(false);
    clearInterval(typing);

    win.input({ type: 'keyDown', key: 'h' });
    const controller = new AbortController();
    const cancelled = clock.waitIdle(1_000, 5_000, controller.signal);
    const caught = expect(cancelled).rejects.toBe('stop');
    controller.abort('stop');
    await caught;
  });
});
