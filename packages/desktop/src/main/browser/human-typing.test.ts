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
    input(input: { type: string; key?: string; isAutoRepeat?: boolean }): void {
      for (const listener of [...listeners]) listener({}, input);
    },
    size: (): number => listeners.size,
  };
}

afterEach(() => vi.useRealTimers());

describe('тишина клавиатуры человека (рецензия M3)', () => {
  it('keyDown окна или любого гостя сбрасывает тишину; keyUp, автоповтор и события игнорируемого гостя — нет', () => {
    let now = 0;
    const clock = createTypingClock({ now: () => now });
    const win = fakeContents(1), guest = fakeContents(7);
    clock.track(win as never); clock.track(guest as never);
    expect(clock.idleFor(1_000)).toBe(true);
    now = 1_000; win.input({ type: 'keyDown', key: 'h' });
    now = 1_500; expect(clock.idleFor(1_000)).toBe(false);
    now = 2_001; expect(clock.idleFor(1_000)).toBe(true);
    clock.ignore(7, true); guest.input({ type: 'keyDown', key: 'a' });
    expect(clock.idleFor(1_000)).toBe(true);
    clock.ignore(7, false); guest.input({ type: 'keyDown', key: 'a' });
    expect(clock.idleFor(1_000)).toBe(false);
    now = 4_000;
    win.input({ type: 'keyUp', key: 'h' });
    win.input({ type: 'keyDown', key: 'h', isAutoRepeat: true });
    expect(clock.idleFor(1_000)).toBe(true);
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
