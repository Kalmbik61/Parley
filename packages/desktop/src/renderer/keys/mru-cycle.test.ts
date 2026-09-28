import { describe, expect, it } from 'vitest';
import { createMruCycle } from './mru-cycle.js';

describe('createMruCycle (тест 6, перенос «⌃ удержан…» и «потеря фокуса…» из LayoutView.test.tsx)', () => {
  it('MRU [C, B, A], два шага вперёд — B, затем A, а не снова C; commit — [A, C, B]', () => {
    const cycle = createMruCycle();
    expect(cycle.step('W1', ['C', 'B', 'A'], 1)).toBe('B');
    // Живой MRU после focusTab(B) уже [B, C, A] — шаг идёт по снимку, не по нему.
    expect(cycle.step('W1', ['B', 'C', 'A'], 1)).toBe('A');
    expect(cycle.commit('W1')).toEqual({ workKey: 'W1', mru: ['A', 'C', 'B'] });
  });

  it('шаг назад с начала снимка — последняя запись', () => {
    const cycle = createMruCycle();
    expect(cycle.step('W1', ['C', 'B', 'A'], -1)).toBe('A');
    expect(cycle.commit('W1')).toEqual({ workKey: 'W1', mru: ['A', 'C', 'B'] });
  });

  it('шаги в работе W1, commit(W2) — null, снимок отброшен', () => {
    const cycle = createMruCycle();
    cycle.step('W1', ['C', 'B', 'A'], 1);
    expect(cycle.commit('W2')).toBeNull();
    expect(cycle.commit('W1')).toBeNull();
  });

  it('одна запись — step null, commit null', () => {
    const cycle = createMruCycle();
    expect(cycle.step('W1', ['C'], 1)).toBeNull();
    expect(cycle.commit('W1')).toBeNull();
  });

  it('commit без цикла — null; после commit следующий шаг снимает новый снимок', () => {
    const cycle = createMruCycle();
    expect(cycle.commit('W1')).toBeNull();
    cycle.step('W1', ['C', 'B', 'A'], 1);
    cycle.commit('W1');
    expect(cycle.step('W1', ['B', 'C', 'A'], 1)).toBe('C');
  });
});
