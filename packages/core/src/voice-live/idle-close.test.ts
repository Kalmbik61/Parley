import { describe, expect, it } from 'vitest';
import { createIdleCloser, IDLE_CLOSE_MS } from './idle-close.js';

function setup(initialBusy = false) {
  const state = { now: 0, busy: initialBusy, closed: 0 };
  const closer = createIdleCloser({ now: () => state.now, busy: () => state.busy, onIdle: () => void (state.closed += 1) });
  return { state, closer, advance: (ms: number) => void ((state.now += ms), closer.step()) };
}

describe('IdleCloser (VA-12)', () => {
  it('3 минуты тишины без открытого: сессия закрывается один раз', () => {
    const { state, closer, advance } = setup();
    closer.start();
    advance(IDLE_CLOSE_MS - 1);
    expect(state.closed).toBe(0);
    advance(1);
    expect(state.closed).toBe(1);
    advance(IDLE_CLOSE_MS);
    expect(state.closed).toBe(1);
  });

  it('открытый Request или речь в очереди держат сессию, отсчёт начинается после них', () => {
    const { state, closer, advance } = setup(true);
    closer.start();
    advance(IDLE_CLOSE_MS * 2);
    expect(state.closed).toBe(0);
    state.busy = false;
    advance(IDLE_CLOSE_MS - 1);
    expect(state.closed).toBe(0);
    advance(1);
    expect(state.closed).toBe(1);
  });

  it('речь человека и воспроизведение модели сбрасывают отсчёт и держат сессию, пока идут', () => {
    const { state, closer, advance } = setup();
    closer.start();
    advance(IDLE_CLOSE_MS - 1000);
    closer.humanSpeaking(true);
    advance(IDLE_CLOSE_MS * 2);
    expect(state.closed).toBe(0);
    closer.humanSpeaking(false);
    closer.modelPlaying(true);
    advance(IDLE_CLOSE_MS * 2);
    expect(state.closed).toBe(0);
    closer.modelPlaying(false);
    advance(IDLE_CLOSE_MS - 1);
    expect(state.closed).toBe(0);
    advance(1);
    expect(state.closed).toBe(1);
  });

  it('делегация считается активностью', () => {
    const { state, closer, advance } = setup();
    closer.start();
    advance(IDLE_CLOSE_MS - 1);
    closer.activity();
    advance(IDLE_CLOSE_MS - 1);
    expect(state.closed).toBe(0);
  });

  it('до старта и после остановки не закрывает; новая сессия снова может закрыться', () => {
    const { state, closer, advance } = setup();
    advance(IDLE_CLOSE_MS * 2);
    expect(state.closed).toBe(0);
    closer.start();
    closer.stop();
    advance(IDLE_CLOSE_MS * 2);
    expect(state.closed).toBe(0);
    closer.start();
    advance(IDLE_CLOSE_MS);
    expect(state.closed).toBe(1);
  });
});
