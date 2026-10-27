/**
 * Проводка сигналов острова (#9 T4): исходы показа и свои фронты идут в политику, её решение — в граф окна. Граф
 * подменён, политика настоящая, часы поддельные. S1 — ключ звучит один раз; S2 — Done по «Sound when an agent
 * finishes» и `expand`, тихий Done молчит; настройки `needs` и `ui`; фазы помощника; решение с острова; зазор и
 * правила под речью (§6.4).
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IslandPresentationOutcome, IslandSoundConfig } from '../../shared/island.js';
import { HOST_IDLE, useAssistantStore } from './assistant/store.js';
import { useConsentsStore } from './consents/store.js';
import { useIslandRequests } from './requests.js';
import { CUE_COOLDOWN_MS, CUE_GAP_MS } from './sound/cues.js';
import { islandSound } from './sound/graph.js';
import { useIslandCues, type IslandCueInput } from './useIslandCues.js';

vi.mock('./sound/graph.js', () => ({
  islandSound: { graph: vi.fn(() => null), play: vi.fn(), setVolume: vi.fn(), setPalette: vi.fn(), duckVoice: vi.fn() },
}));

const play = vi.mocked(islandSound.play);
/** Что сыграл граф: виды сигналов по порядку. */
const played = (): string[] => play.mock.calls.map(([kind]) => kind);

const SOUND: IslandSoundConfig = { needs: true, finished: false, palette: 'soft', volume: 0.6, ui: false };

function outcome(kind: IslandPresentationOutcome['kind'], key: string, extra: Partial<IslandPresentationOutcome> = {}): IslandPresentationOutcome {
  return { key, kind, fresh: true, expand: true, soundEligible: kind !== 'done', ...extra };
}

function mount(input: Partial<IslandCueInput> = {}) {
  return renderHook((props: IslandCueInput) => useIslandCues(props), {
    initialProps: { sound: SOUND, active: false, hovered: false, ...input },
  });
}

/** Сдвиг поддельных часов: остывание и зазор политики считаются по `Date.now`. */
const advance = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useAssistantStore.setState({ host: HOST_IDLE, input: 'idle' });
  useIslandRequests.setState({ items: [], applied: 0 });
  useConsentsStore.setState({ items: [], deciding: null, note: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useIslandCues: исходы показа', () => {
  it('S1: ключ запроса звучит один раз, повтор того же ключа молчит', () => {
    const { result } = mount();
    result.current.present([outcome('permission', 'feed:a')]);
    advance(CUE_COOLDOWN_MS.permission!);
    result.current.present([outcome('permission', 'feed:a')]);
    expect(played()).toEqual(['permission']);
  });

  it('виды исходов: согласие и терминал — permission, предложение комнаты — question, план — plan', () => {
    const { result } = mount();
    const kinds: IslandPresentationOutcome['kind'][] = ['consent', 'room-proposal', 'plan', 'terminal-request', 'question', 'permission'];
    kinds.forEach((kind, at) => {
      result.current.present([outcome(kind, `k-${at}`)]);
      advance(CUE_COOLDOWN_MS.permission!);
    });
    expect(played()).toEqual(['permission', 'question', 'plan', 'permission', 'question', 'permission']);
  });

  it('без «Sound when you’re needed» запрос молчит; soundEligible: false не переопределяется', () => {
    const silent = mount({ sound: { ...SOUND, needs: false } });
    silent.result.current.present([outcome('permission', 'a')]);
    const loud = mount();
    loud.result.current.present([outcome('question', 'b', { soundEligible: false })]);
    expect(play).not.toHaveBeenCalled();
  });

  it('S2: выдвинутый Done звучит done только с «Sound when an agent finishes»', () => {
    const off = mount({ sound: { ...SOUND, finished: false } });
    off.result.current.present([outcome('done', 'd-1')]);
    expect(play).not.toHaveBeenCalled();
    const on = mount({ sound: { ...SOUND, finished: true } });
    on.result.current.present([outcome('done', 'd-2')]);
    expect(played()).toEqual(['done']);
  });

  it('S2: тихий Done (expand: false) молчит и при включённой настройке', () => {
    const { result } = mount({ sound: { ...SOUND, finished: true } });
    result.current.present([outcome('done', 'd-1', { expand: false })]);
    expect(play).not.toHaveBeenCalled();
  });

  it('настройки читаются в момент исхода: включили needs — следующий запрос звучит', () => {
    const view = mount({ sound: { ...SOUND, needs: false } });
    view.result.current.present([outcome('permission', 'a')]);
    view.rerender({ sound: SOUND, active: false, hovered: false });
    view.result.current.present([outcome('permission', 'b')]);
    expect(played()).toEqual(['permission']);
  });

  it('пачка: менее важный сигнал ждёт зазор, размонтирование снимает ожидание', () => {
    const view = mount({ sound: { ...SOUND, finished: true } });
    view.result.current.present([outcome('done', 'd-1'), outcome('permission', 'p-1')]);
    expect(played()).toEqual(['permission']);
    advance(CUE_GAP_MS);
    expect(played()).toEqual(['permission', 'done']);
    view.result.current.present([outcome('question', 'q-1'), outcome('done', 'd-2')]);
    advance(CUE_COOLDOWN_MS.done!);
    view.result.current.present([outcome('question', 'q-2'), outcome('done', 'd-3')]);
    expect(played()).toEqual(['permission', 'done', 'question', 'question']);
    view.unmount();
    advance(CUE_GAP_MS);
    expect(played()).toEqual(['permission', 'done', 'question', 'question']);
  });

  it('под речью (§6.4): внимание в полную силу и приглушает голос, итог тише, интерфейс молчит', () => {
    const { result, rerender } = mount({ sound: { ...SOUND, finished: true, ui: true }, speaking: () => true });
    result.current.present([outcome('permission', 'p-1')]);
    expect(play).toHaveBeenLastCalledWith('permission', { quiet: false });
    expect(islandSound.duckVoice).toHaveBeenCalledOnce();
    advance(CUE_GAP_MS);
    result.current.present([outcome('done', 'd-1')]);
    expect(play).toHaveBeenLastCalledWith('done', { quiet: true });
    advance(CUE_GAP_MS);
    rerender({ sound: { ...SOUND, ui: true }, active: false, hovered: true, speaking: () => true });
    expect(played()).toEqual(['permission', 'done']);
    expect(islandSound.duckVoice).toHaveBeenCalledOnce();
  });
});

describe('useIslandCues: свои фронты', () => {
  it('без «Interface sounds» наведение, открыть, закрыть и начало работы молчат', () => {
    const { result, rerender } = mount();
    rerender({ sound: SOUND, active: true, hovered: true });
    result.current.open();
    result.current.close();
    expect(play).not.toHaveBeenCalled();
  });

  it('с «Interface sounds»: фронт наведения и начала работы, открыть и закрыть; значение при монтировании — база', () => {
    const ui = { ...SOUND, ui: true };
    const { result, rerender } = mount({ sound: ui, active: true, hovered: true });
    expect(play).not.toHaveBeenCalled();
    rerender({ sound: ui, active: false, hovered: false });
    rerender({ sound: ui, active: true, hovered: false });
    advance(CUE_GAP_MS);
    rerender({ sound: ui, active: true, hovered: true });
    rerender({ sound: ui, active: true, hovered: true });
    advance(CUE_GAP_MS);
    result.current.open();
    advance(CUE_GAP_MS);
    result.current.close();
    expect(played()).toEqual(['start', 'hover', 'open', 'close']);
  });

  it('фазы помощника: начал и кончил слушать, ошибка', () => {
    mount();
    act(() => useAssistantStore.setState({ input: 'listening' }));
    advance(CUE_GAP_MS);
    act(() => useAssistantStore.setState({ input: 'transcribing' }));
    advance(CUE_GAP_MS);
    act(() => useAssistantStore.setState({ host: { ...HOST_IDLE, phase: 'error', error: 'boom' } }));
    act(() => useAssistantStore.setState({ host: { ...HOST_IDLE, phase: 'error', error: 'boom again' } }));
    expect(played()).toEqual(['listen-start', 'listen-end', 'error']);
  });

  it('решение с острова: запрос, применённый хостом, и согласие с пометкой done; неудача и обрыв связи молчат', () => {
    mount();
    const item = { key: 'feed:a', deciding: true, note: null } as unknown as ReturnType<typeof useIslandRequests.getState>['items'][number];
    act(() => useIslandRequests.setState({ items: [item] }));
    act(() => useIslandRequests.setState({ items: [{ ...item, deciding: false, note: 'failed' }] }));
    act(() => useIslandRequests.setState({ items: [] }));
    // Обрыв связи посреди решения: очередь пуста, но решения не было (критик m-1477).
    act(() => useIslandRequests.setState({ items: [item] }));
    act(() => useIslandRequests.setState({ items: [] }));
    expect(play).not.toHaveBeenCalled();
    act(() => useIslandRequests.setState({ items: [item] }));
    act(() => useIslandRequests.setState((state) => ({ items: [], applied: state.applied + 1 })));
    advance(CUE_GAP_MS);
    act(() => useConsentsStore.setState({ deciding: 'c-1', note: null }));
    act(() => useConsentsStore.setState({ deciding: null, note: 'elsewhere' }));
    act(() => useConsentsStore.setState({ deciding: null, note: null }));
    act(() => useConsentsStore.setState({ deciding: null, note: 'done' }));
    expect(played()).toEqual(['decide', 'decide']);
  });

  it('после размонтирования подписки на сторы сняты', () => {
    const { unmount } = mount();
    unmount();
    act(() => useAssistantStore.setState({ input: 'listening' }));
    act(() => useConsentsStore.setState({ note: 'done' }));
    expect(play).not.toHaveBeenCalled();
  });
});

describe('useIslandCues: громкость и палитра', () => {
  it('громкость и палитра из настроек уходят в граф окна', () => {
    const { rerender } = mount();
    expect(islandSound.setVolume).toHaveBeenLastCalledWith(0.6);
    expect(islandSound.setPalette).toHaveBeenLastCalledWith('soft');
    rerender({ sound: { ...SOUND, volume: 0.25, palette: 'warm' }, active: false, hovered: false });
    expect(islandSound.setVolume).toHaveBeenLastCalledWith(0.25);
    expect(islandSound.setPalette).toHaveBeenLastCalledWith('warm');
  });
});
