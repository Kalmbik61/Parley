/**
 * Предел живых панелей и состояние окна о панелях (спека браузера 3.10, раздел 8; этап B2, часть 1): видимые живы всегда,
 * остальные — по свежести использования, всего не больше шести; виды хозяев на экране; публикация слоёв работ.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_PANELS, panelRuntimeKey, selectLive, usePanelRuntime, type LiveCandidate } from './runtime.js';

function candidate(key: string, visible: boolean, usedAt: number): LiveCandidate {
  return { key, visible, usedAt };
}

beforeEach(() => {
  usePanelRuntime.setState({ hosts: {}, usedAt: {}, published: {}, live: new Set() });
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});

afterEach(() => vi.useRealTimers());

describe('selectLive — предел живых панелей', () => {
  it('до предела живы все; предел — шесть', () => {
    expect(LIVE_PANELS).toBe(6);
    const few = [candidate('a', false, 1), candidate('b', true, 2)];
    expect([...selectLive(few)].sort()).toEqual(['a', 'b']);
  });

  it('сверх предела выгружаются самые давние из невидимых; видимые остаются при любой давности', () => {
    const all = [
      candidate('visible-old', true, 1),
      ...Array.from({ length: 7 }, (_, i) => candidate(`hidden-${i}`, false, 10 + i)),
    ];
    const live = selectLive(all);
    expect(live.size).toBe(6);
    expect(live.has('visible-old')).toBe(true);
    // Из семи невидимых остаются пять самых свежих: hidden-2…hidden-6.
    expect([...live].filter((key) => key.startsWith('hidden-')).sort()).toEqual(['hidden-2', 'hidden-3', 'hidden-4', 'hidden-5', 'hidden-6']);
  });

  it('видимых больше предела — живы все видимые, невидимые не живы', () => {
    const all = [...Array.from({ length: 8 }, (_, i) => candidate(`v${i}`, true, i)), candidate('hidden', false, 99)];
    const live = selectLive(all);
    expect(live.size).toBe(8);
    expect(live.has('hidden')).toBe(false);
  });

  it('свой предел и пустой список', () => {
    expect(selectLive([], 6).size).toBe(0);
    expect([...selectLive([candidate('a', false, 1), candidate('b', false, 2), candidate('c', false, 3)], 2)].sort()).toEqual(['b', 'c']);
    expect(selectLive([candidate('a', false, 1)], 0).size).toBe(0);
  });
});

describe('usePanelRuntime', () => {
  const state = (): ReturnType<typeof usePanelRuntime.getState> => usePanelRuntime.getState();

  it('panelRuntimeKey несёт и работу: ключ хозяина повторяется от работы к работе', () => {
    const owner = { kind: 'session', sessionId: 's-01' } as const;
    expect(panelRuntimeKey('/p w-1', owner)).not.toBe(panelRuntimeKey('/p w-2', owner));
    expect(panelRuntimeKey('/p w-1', owner)).toBe('/p w-1\nsession:s-01');
  });

  it('вид хозяина: смонтирован с узостью, узость обновляется, размонтирован — записи нет', () => {
    state().mountHost('k', false);
    expect(state().hosts).toEqual({ k: { narrow: false, measured: false } });
    const same = state().hosts;
    state().mountHost('k', false);
    expect(state().hosts).toBe(same);
    state().mountHost('k', true);
    expect(state().hosts.k?.narrow).toBe(true);
    state().unmountHost('k');
    expect(state().hosts).toEqual({});
    const empty = state().hosts;
    state().unmountHost('k');
    expect(state().hosts).toBe(empty);
  });

  it('measurement change updates a wide host even when narrow is unchanged', () => {
    state().mountHost('wide', false);
    const unknown = state().hosts;
    state().mountHost('wide', false, true);
    expect(state().hosts).not.toBe(unknown);
    expect(state().hosts.wide).toEqual({ narrow: false, measured: true });
    const measured = state().hosts;
    state().mountHost('wide', false, true);
    expect(state().hosts).toBe(measured);
  });

  it('публикация слоя работы даёт живые панели; другая работа добавляет своё, предел общий на окно', () => {
    state().publish('w1', [{ key: 'w1/a', visible: true }, { key: 'w1/b', visible: false }, { key: 'w1/c', visible: false }]);
    expect([...state().live].sort()).toEqual(['w1/a', 'w1/b', 'w1/c']);
    vi.setSystemTime(2_000);
    state().publish('w2', Array.from({ length: 5 }, (_, i) => ({ key: `w2/${i}`, visible: i === 0 })));
    // Восемь панелей на два слоя, мест шесть: видимые обеих работ живы, из остальных — самые свежие (w2: опубликованы позже).
    expect(state().live.size).toBe(6);
    expect(state().live.has('w1/a')).toBe(true);
    expect(state().live.has('w2/0')).toBe(true);
    expect(state().live.has('w1/c')).toBe(false);
  });

  it('touch ставит панель в конец очереди на выгрузку', () => {
    state().publish('w1', Array.from({ length: 7 }, (_, i) => ({ key: `p${i}`, visible: false })));
    // Все опубликованы в один момент: выгружена последняя по порядку; касание старой меняет это.
    expect(state().live.size).toBe(6);
    const unloaded = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'].find((key) => !state().live.has(key)) as string;
    vi.setSystemTime(5_000);
    state().touch(unloaded);
    expect(state().live.has(unloaded)).toBe(true);
    expect(state().live.size).toBe(6);
  });

  it('показанная панель становится свежей: после ухода с экрана выгружается не она', () => {
    const keys = Array.from({ length: 7 }, (_, i) => `p${i}`);
    state().publish('w1', keys.map((key) => ({ key, visible: false })));
    // Все опубликованы в один момент, седьмой места не хватило.
    expect(state().live.has('p6')).toBe(false);
    vi.setSystemTime(2_000);
    state().publish('w1', keys.map((key) => ({ key, visible: key === 'p6' })));
    expect(state().live.has('p6')).toBe(true);
    vi.setSystemTime(3_000);
    state().publish('w1', keys.map((key) => ({ key, visible: false })));
    // Ушла с экрана, но показана позже остальных (2000 против 1000): живая осталась она, а не прежняя.
    expect(state().live.has('p6')).toBe(true);
    expect(state().live.size).toBe(6);
  });

  it('состав живых не изменился — ссылка на множество прежняя (подписчики не перерисовываются)', () => {
    state().publish('w1', [{ key: 'a', visible: true }]);
    const before = state().live;
    state().touch('a');
    state().publish('w1', [{ key: 'a', visible: true }]);
    expect(state().live).toBe(before);
  });

  it('слой работы ушёл (retract) — его панели больше не считаются, других это не трогает', () => {
    state().publish('w1', [{ key: 'w1/a', visible: true }]);
    state().publish('w2', [{ key: 'w2/a', visible: true }]);
    state().retract('w1');
    expect([...state().live]).toEqual(['w2/a']);
    const published = state().published;
    state().retract('w1');
    expect(state().published).toBe(published);
  });
});
