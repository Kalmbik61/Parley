/**
 * Проводка острова на подставном мосту: новый запрос выбирается в карточке (а не остаётся прежний) и выдвигает убранный
 * остров, стрелка ⌃ внизу формы (видна только под курсором, `onHover`) и смахивание вверх убирают его (окно при этом
 * остаётся видимым, пока хост подключён), покой в 4 с убирает сам, язычок выдвигает остров кликом или потяжкой вниз, корень заполняет кадр окна и выравнивает форму по точке, наведение приходит
 * от main (`onHover`) и открывает список, а область под мышь (форма или язычок) уходит main и не повторяется. Где нужна
 * цепочка «событие → снимок ленты → карточка», таймеры настоящие; отсчёт покоя идёт на подставных таймерах и на заранее заполненных сторах (без обмена с хостом).
 * Строки Done: новый конец хода выдвигает остров (без звука), конец хода до подключения — нет, удержание `DONE_HOLD_MS`
 * вместо покоя, Clear прячет строки до нового конца хода и отмечает непросмотренные сессии просмотренными (`markSeen`; удержанные
 * просмотренные хосту не шлются). Показанная строка Done держится до конца показа: сессию отметили
 * просмотренной (`idle` с прежним концом хода) — строка остаётся, пока курсор не ушёл с острова; при уборке острова она
 * держится ещё `RETRACT_MORPH_MS` (пока форма сжимается), выдвинули раньше — уходит в тот же миг. Убранный остров — та же
 * форма, сжатая в брусок; с непросмотренными Done (просмотренные в число не входят) вместо бруска в ней «✅ N». Поверх
 * убранной формы лежит прозрачная зона нажатия `island-tab` (подпись, размер, клик и потяжка вниз).
 * Карточки согласия на папку: начальный `consents.list` и событие `consents.changed` показывают карточку раньше запросов
 * ленты, она выдвигает остров и звучит один раз, не даёт острову убраться в покое, Trust уходит в `consents.decide`.
 * Пауза кнопок решения и анимация формы проверены в `IslandView.test.tsx`.
 * Звук (#9 T4): исходы показа идут в `useIslandCues`, граф окна подменён (`played()` — что он сыграл), политика
 * сигналов настоящая и считает остывание по `Date.now`; `island:beep` нет.
 * Речь помощника (план 3b B22): проигрыватель подменён (`speakerOf()`), порт голоса — подставной объект с `onmessage`,
 * его приносит сообщение окна (`sendPort`).
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedCard, FeedPlanCard, FeedQuestionCard } from '@parley/core';
import { encodeIpcError } from '../../shared/ipc-error.js';
import { refKey, type ConsentCard, type ProgressResult } from '@parley/protocol';
import { ISLAND_TTS_PORT, type IslandApi, type IslandBridge, type IslandConfig, type IslandPresentationOutcome, type IslandSpeakRequest, type IslandTtsMessage, type TtsEngineState } from '../../shared/island.js';
import { useActivityStore } from '../store/activity.js';
import { useWorksStore } from '../store/works.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { makeActivity, makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { DONE_HOLD_MS, IDLE_RETRACT_MS, INITIAL_CONFIG, IslandApp, presentationEvent, RETRACT_MORPH_MS } from './IslandApp.js';
import { createSpeaker } from './assistant/speaker.js';
import { HOST_IDLE, useAssistantStore } from './assistant/store.js';
import { createVoiceAnalysis } from './assistant/voice-features.js';
import { useConsentsStore } from './consents/store.js';
import { sessionLabels } from './model.js';
import { PULL_EXPAND_PX } from './IslandTab.js';
import { useIslandReplies } from './replies.js';
import { useIslandRequests } from './requests.js';
import { CUE_COOLDOWN_MS, CUE_GAP_MS } from './sound/cues.js';
import { islandSound } from './sound/graph.js';
import * as engineModule from './swarm/engine.js';

vi.mock('./sound/graph.js', () => ({
  islandSound: { graph: vi.fn(() => null), play: vi.fn(), setVolume: vi.fn(), setPalette: vi.fn(), duckVoice: vi.fn() },
}));
vi.mock('./assistant/speaker.js', () => ({
  createSpeaker: vi.fn(() => {
    const starts: Array<(utteranceId: string) => void> = [];
    return {
      starts,
      enqueue: vi.fn(),
      expect: vi.fn(),
      stop: vi.fn(),
      discard: vi.fn(),
      mouth: vi.fn(() => 0),
      speaking: vi.fn(() => false),
      onIdle: vi.fn(() => () => undefined),
      onStart: vi.fn((cb: (utteranceId: string) => void) => {
        starts.push(cb);
        return () => undefined;
      }),
      read: vi.fn(() => false),
    };
  }),
}));
vi.mock('./assistant/voice-features.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./assistant/voice-features.js')>();
  return { ...actual, createVoiceAnalysis: vi.fn(actual.createVoiceAnalysis) };
});

/** Подменённый проигрыватель речи последнего смонтированного острова. */
interface FakeSpeaker {
  starts: Array<(utteranceId: string) => void>;
  enqueue: ReturnType<typeof vi.fn>;
  expect: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  discard: ReturnType<typeof vi.fn>;
  speaking: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
}
const speakerOf = (): FakeSpeaker => vi.mocked(createSpeaker).mock.results.at(-1)!.value as unknown as FakeSpeaker;

/** Подставной порт голоса: остров ставит ему `onmessage`. */
function voicePort(): { onmessage: ((event: { data: IslandTtsMessage }) => void) | null; start: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return { onmessage: null, start: vi.fn(), close: vi.fn() };
}
/** Сообщение окна, которым preload передаёт порт голоса; поля можно испортить. */
function sendPort(ports: unknown[], init: { source?: unknown; data?: unknown } = {}): void {
  const event = new Event('message');
  Object.defineProperties(event, {
    source: { value: 'source' in init ? init.source : window },
    data: { value: 'data' in init ? init.data : ISLAND_TTS_PORT },
    ports: { value: ports },
  });
  window.dispatchEvent(event);
}

/** Что сыграл граф острова: виды сигналов по порядку. */
const played = (): string[] => vi.mocked(islandSound.play).mock.calls.map(([kind]) => kind);
/** Подмена `Date.now` для `skipCooldown`; снимается после теста. */
let clock: { mockRestore(): void } | null = null;
/**
 * На настоящих таймерах: часы политики сигналов уходят вперёд за остывание вида (#9 §3.5), следующий сигнал того же
 * вида звучит, а не сливается с прошлым.
 */
function skipCooldown(): void {
  const now = Date.now.bind(Date);
  clock?.mockRestore();
  const shift = CUE_COOLDOWN_MS.done!;
  clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + shift);
}
/** На поддельных таймерах: время остывания вида проходит. */
async function waitCooldown(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(CUE_COOLDOWN_MS.done!); });
}

const PROJECT = '/tmp/proj';
const ref = (sessionId: string) => ({ projectPath: PROJECT, workId: 'w-1', sessionId });
const ENTRIES = [makeWork('w-1', { projectPath: PROJECT, sessions: [makeSession('s-01', 'a'), makeSession('s-02', 'b')] })];

const proposalWork = (rev = 1, projectPath = PROJECT) => makeWork('w-1', { projectPath, sessions: ENTRIES[0]!.map.sessions,
  rooms: [{ ...makeRoom('r-1', 'Room one'), members: ['s-01', 's-02'], lead: 's-02',
    proposal: { id: 'p-1', from: 's-01', text: 'SECRET-proposal', at: '2026-10-27T00:00:00.000Z', rev } }],
});

function permission(cardId: string, command: string): FeedCard {
  return {
    id: cardId, at: '2026-10-12T10:00:00.000Z', kind: 'permission', cardId, state: 'pending', toolUseId: null,
    toolName: 'Bash', toolInput: { command }, suggestions: [], notified: false,
  };
}

const CARDS: Record<string, FeedCard[]> = { 's-01': [permission('c-1', 'rm -rf build')], 's-02': [permission('c-2', 'ls')] };

/** Колбэки живых подставных `ResizeObserver` и то, что они наблюдают: тест «шевелит» замер, вызывая последний колбэк. */
let resizeCallbacks: Array<() => void> = [];
let observed: Element[] = [];

// jsdom не знает ResizeObserver — форма острова заводит его при монтировании, чтобы замерять содержимое.
class ResizeObserverStub {
  private readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
    resizeCallbacks.push(callback);
  }
  observe(element: Element): void {
    observed.push(element);
  }
  unobserve(): void {}
  disconnect(): void {
    resizeCallbacks = resizeCallbacks.filter((callback) => callback !== this.callback);
  }
}

/** Звук острова (#9 §5): по умолчанию в тестах молчит; `SOUND_ON` — включено «Sound when you're needed». */
const SOUND_OFF: IslandConfig['islandSound'] = { needs: false, finished: false, palette: 'soft', volume: 0.6, ui: false };
const SOUND_ON: IslandConfig['islandSound'] = { ...SOUND_OFF, needs: true };
/** Нейроголос (план 3b, B15): в тестах выключен и не скачан. */
const SPEECH_OFF = { enabled: false, voice: 'qwen3-0.6b/serena', gender: 'female', available: false } as const;

function islandApi(config: Partial<IslandConfig> = {}): IslandApi {
  return {
    config: vi.fn(async (): Promise<IslandConfig> => ({ islandEnabled: true, assistant: { enabled: false, provider: null, model: null, language: 'en', hotkey: 'Alt+Space', voice: { enabled: false, model: null }, speech: SPEECH_OFF }, islandSound: SOUND_OFF, motion: 'system', topInset: 0, anchor: 'center', ...config })),
    onConfig: vi.fn(() => () => undefined),
    visibility: vi.fn(async () => ({ version: 0, refs: [] })),
    onVisibility: vi.fn(() => () => undefined),
    onHover: vi.fn(() => () => undefined), setHitRect: vi.fn(), setVisible: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(), open: vi.fn(), markSeen: vi.fn(), failed: vi.fn(),
    keyboard: vi.fn(),
    onAssistantOpen: vi.fn(() => () => undefined),
    onNavigatePending: vi.fn((listener: () => void) => { pendingNavigationHandler = listener; return () => { pendingNavigationHandler = null; }; }),
    onKeyboardBlur: vi.fn(() => () => undefined),
    voice: { transcribe: vi.fn(), micStatus: vi.fn(), requestMic: vi.fn() },
    speech: { connect: vi.fn(), speak: vi.fn(async () => ({ state: 'not-downloaded' as const })), cancel: vi.fn(), warmup: vi.fn(async () => ({ state: 'not-downloaded' as const })), setSpeak: vi.fn(async () => undefined) },
  };
}
let pendingNavigationHandler: (() => void) | null = null;

/** Мост острова поверх подставного моста окна: хост «подключён», `works.list` и `feed.snapshot` отвечают из таблиц выше. */
function setup(config: Partial<IslandConfig> = {}, entries = ENTRIES, consents: ConsentCard[] = []) {
  const fake = createFakeBridge();
  fake.setHandler('works.list', () => ({ entries, branches: {} }) as never);
  fake.setHandler('consents.list', () => ({ items: consents }));
  fake.setHandler('feed.snapshot', ({ ref: target }) => ({ items: CARDS[target.sessionId] ?? [], revision: 1, mode: null, decisions: 'window' }) as never);
  const island = islandApi(config);
  const bridge: IslandBridge = { call: fake.call, on: fake.on, onStatus: fake.onStatus, activitySnapshot: fake.activitySnapshot, island };
  const blocked = (sessionId: string): void => {
    act(() => {
      fake.emit('activity.changed', makeActivity(ref(sessionId), 'blocked'));
    });
  };
  const working = (sessionId: string): void => {
    act(() => {
      fake.emit('activity.changed', makeActivity(ref(sessionId), 'working'));
    });
  };
  const disconnect = (): void => {
    act(() => {
      fake.emitStatus({ state: 'disconnected', reason: 'host gone' });
    });
  };
  const reconnect = (): void => {
    act(() => {
      fake.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: [] });
    });
  };
  /** Main сообщает «курсор над областью острова» / «ушёл»: вызывает всех, кто подписан на `onHover`. */
  const hover = (over: boolean): void => {
    act(() => {
      for (const [listener] of vi.mocked(island.onHover).mock.calls) listener(over);
    });
  };
  /** Main просит открыть режим помощника / сообщает о потере фокуса панели: зовёт последнего подписанного слушателя. */
  const assistantOpen = (request: { listen: boolean }): void => {
    act(() => {
      vi.mocked(island.onAssistantOpen).mock.calls.at(-1)![0](request);
    });
  };
  const assistantBlur = (): void => {
    act(() => {
      vi.mocked(island.onKeyboardBlur).mock.calls.at(-1)![0]();
    });
  };
  return { fake, island, bridge, blocked, working, disconnect, reconnect, hover, assistantOpen, assistantBlur };
}

/** Помощник включён в настройках острова. */
const ASSISTANT_ON = { enabled: true, provider: null, model: null, language: 'en' as const, hotkey: 'Alt+Space', voice: { enabled: false, model: null }, speech: SPEECH_OFF };
/** Помощник говорит ответы: «Speak answers» включено, голос скачан. */
const ASSISTANT_SPEAKS = { ...ASSISTANT_ON, speech: { ...SPEECH_OFF, enabled: true, available: true } };

/** Работа идёт к моменту открытия острова: сторы заполнены заранее, обмена с хостом ждать не надо. */
function seedWorking(): void {
  useWorksStore.setState({ entries: ENTRIES, branches: {}, loading: false, error: null });
  useActivityStore.setState({ byRef: { [refKey(ref('s-01'))]: makeActivity(ref('s-01'), 'working') }, loaded: true });
}

/** Работа кончилась: активности нет. */
function seedIdle(): void {
  useActivityStore.setState({ byRef: {}, loaded: true });
}

/** Событие указателя с точкой на экране: `MouseEvent` нужного типа — не зависит от того, знает ли jsdom `PointerEvent`. */
const pointer = (type: string, screenX = 10, screenY = 20, buttons = 1): MouseEvent => new MouseEvent(type, { bubbles: true, screenX, screenY, buttons });

const isRetracted = (): boolean => screen.getByTestId('island').getAttribute('data-retracted') === 'true';
/** Убирает остров стрелкой ⌃: она есть только под курсором, поэтому сначала main сообщает «над областью». */
const tuck = (hover: (over: boolean) => void): void => {
  hover(true);
  fireEvent.click(screen.getByTestId('island-tuck'));
};
/** Выдвигает убранный остров кликом по язычку. */
const expand = (): void => {
  fireEvent.click(screen.getByTestId('island-tab'));
};

beforeEach(() => {
  vi.mocked(islandSound.play).mockClear();
  resizeCallbacks = [];
  observed = [];
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  useIslandRequests.getState().clear();
  useIslandReplies.getState().prune(new Set());
  useConsentsStore.getState().replace([]);
  useWorksStore.setState({ entries: [], branches: {}, loading: true, error: null });
  useActivityStore.setState({ byRef: {}, loaded: false });
  useAssistantStore.setState({ host: HOST_IDLE, open: false, collapsed: false, byHover: false, input: 'idle', level: 0, draft: '', notice: null, cardError: null });
});

afterEach(() => {
  cleanup();
  clock?.mockRestore();
  clock = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('проводка острова', () => {
  it('shows a brief empty-queue message and immediately returns keyboard focus', async () => {
    const { bridge, fake, island } = setup();
    render(<IslandApp bridge={bridge} />);
    await act(async () => { await Promise.resolve(); });
    const callsBefore = fake.calls.length;
    act(() => pendingNavigationHandler?.());
    expect(await screen.findByTestId('island-no-pending')).toBeTruthy();
    expect(island.keyboard).toHaveBeenCalledWith(false);
    expect(fake.calls).toHaveLength(callsBefore);
  });

  it('global queue activation opens a feed target, while navigation keys never decide', async () => {
    const { bridge, blocked, fake } = setup();
    render(<IslandApp bridge={bridge} />);
    blocked('s-01');
    blocked('s-02');
    await waitFor(() => expect(fake.calls.filter((call) => call.method === 'feed.snapshot').length).toBeGreaterThanOrEqual(2));
    act(() => pendingNavigationHandler?.());
    await waitFor(() => expect(screen.getByTestId('island').getAttribute('data-navigation-key')).toMatch(/^feed:/));
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    const selected = screen.getByTestId('island').getAttribute('data-navigation-key');
    act(() => pendingNavigationHandler?.());
    expect(screen.getByTestId('island').getAttribute('data-navigation-key')).toBe(selected);
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    expect(bridge.island.open).toHaveBeenCalled();
    expect(fake.calls.some((call) => call.method === 'feed.decide')).toBe(false);
  });

  it.each(['close', 'collapse', 'hidden', 'disconnect', 'assistant', 'pending', 'room'] as const)('progress polls only the selected detail and stops on %s', async (pause) => {
    vi.useFakeTimers();
    const { fake, bridge, hover, disconnect, blocked } = setup({ assistant: ASSISTANT_ON });
    fake.setHostMethods(['feed.progress']);
    fake.setActivitySnapshot(['s-01', 's-02'].map((id) => makeActivity(ref(id), 'working')));
    const result: ProgressResult = { revision: 1, availability: 'available', current: null, recent: [], truncated: false };
    const read = vi.fn<() => ProgressResult | Promise<ProgressResult>>().mockReturnValue(result);
    fake.setHandler('feed.progress', read);
    render(<IslandApp bridge={bridge} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    hover(true);
    expect(read).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Show recent actions' })[0]!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(read).toHaveBeenCalledOnce();
    expect(fake.calls.filter((call) => call.method === 'feed.progress')[0]?.params).toEqual({ ref: ref('s-01') });
    let resolveLate!: (value: ProgressResult) => void;
    read.mockReturnValueOnce(new Promise<ProgressResult>((resolve) => { resolveLate = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(read).toHaveBeenCalledTimes(2);
    let hidden: ReturnType<typeof vi.spyOn> | undefined;
    if (pause === 'close') fireEvent.click(screen.getByRole('button', { name: 'Close history' }));
    else if (pause === 'collapse') tuck(hover);
    else if (pause === 'hidden') {
      hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      act(() => document.dispatchEvent(new Event('visibilitychange')));
    } else if (pause === 'disconnect') disconnect();
    else if (pause === 'assistant') act(() => useAssistantStore.setState({ open: true }));
    else if (pause === 'pending') blocked('s-01');
    else act(() => fake.emit('works.changed', { entries: [proposalWork()], branches: {} }));
    resolveLate({ ...result, revision: 99, recent: [{ id: 'late', at: '2026-10-26T10:00:00.000Z', category: 'execute', status: 'done' }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const count = read.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(read).toHaveBeenCalledTimes(count);
    expect(screen.queryByText('Run command')).toBeNull();
    if (pause === 'room') {
      expect(screen.getByText('Update delayed')).toBeTruthy();
      act(() => fake.emit('works.changed', { entries: ENTRIES, branches: {} }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(read).toHaveBeenCalledTimes(count + 1);
      expect(fake.calls.filter((call) => call.method === 'feed.progress').at(-1)?.params).toEqual({ ref: ref('s-01') });
    }
    hidden?.mockRestore();
  });

  it('room proposals reveal once per full revision identity and only open the current room', async () => {
    vi.useFakeTimers();
    const { fake, bridge, island, hover } = setup({ islandSound: SOUND_ON });
    render(<IslandApp bridge={bridge} />);
    const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
    await settle();
    expect(isRetracted()).toBe(true);
    const update = async (entries = [proposalWork()]) => {
      act(() => fake.emit('works.changed', { entries, branches: {} })); await settle();
    };
    await update();
    expect(isRetracted()).toBe(false);
    expect(played()).toEqual(['question']);
    hover(true);
    expect(screen.getByText('Lead: S02 b')).toBeTruthy();
    expect(document.body.textContent).not.toContain('SECRET');
    fireEvent.click(screen.getByRole('button', { name: 'Open room' }));
    expect(island.open).toHaveBeenCalledWith({ kind: 'room', projectPath: PROJECT, workId: 'w-1', roomId: 'r-1' });
    tuck(hover); await update();
    expect(isRetracted()).toBe(true);
    expect(played()).toEqual(['question']);
    await waitCooldown();
    await update([proposalWork(2)]);
    expect(isRetracted()).toBe(false);
    expect(played()).toEqual(['question', 'question']);
    await waitCooldown();
    await update([proposalWork(2), proposalWork(2, '/other/proj')]);
    expect(played()).toEqual(['question', 'question', 'question']);
    await update(ENTRIES);
    expect(screen.queryByRole('button', { name: 'Open room' })).toBeNull();
    expect(fake.calls.filter((call) => /resolveProposal|resumeAutonomous|feed.decide/.test(call.method))).toEqual([]);
  });

  it('parent removal and disconnect clear child rows; an empty reconnect cannot restore stale children', async () => {
    vi.useFakeTimers();
    const { fake, bridge, hover, disconnect, reconnect } = setup();
    const child = makeActivity(ref('s-01'), 'idle', { heldByBackground: true, metrics: { tokensIn: null, tokensOut: null,
      durationMs: null, unread: 0, model: null, subagents: 1, tasks: [{ id: 'a'.repeat(64), agentType: 'worker', description: 'child one', background: true }] } });
    fake.setActivitySnapshot([child]);
    render(<IslandApp bridge={bridge} />);
    const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
    await settle(); hover(true);
    expect(screen.getByText('child one')).toBeTruthy();
    expect(screen.queryByTestId('island-done')).toBeNull();
    act(() => fake.emit('works.changed', { entries: [makeWork('w-1', { projectPath: PROJECT })], branches: {} }));
    await settle();
    expect(screen.queryByText('child one')).toBeNull();
    act(() => fake.emit('works.changed', { entries: ENTRIES, branches: {} })); await settle();
    disconnect(); await settle();
    expect(useActivityStore.getState().byRef).toEqual({});
    fake.setActivitySnapshot([]); reconnect(); await settle(); hover(true);
    expect(screen.queryByText('child one')).toBeNull();
    expect(useActivityStore.getState().byRef).toEqual({});
  });

  it.each([null, []])('progress old host %j shows unavailable with no periodic calls', async (methods) => {
    vi.useFakeTimers();
    const { fake, bridge, hover } = setup();
    fake.setHostMethods(methods); fake.setActivitySnapshot([makeActivity(ref('s-01'), 'working')]);
    render(<IslandApp bridge={bridge} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); hover(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show recent actions' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText('Recent actions unavailable')).toBeTruthy();
    expect(fake.calls.filter((call) => call.method === 'feed.progress')).toHaveLength(0);
  });

  it.each(['selection', 'process'] as const)('progress drops the old %s response before showing a new detail', async (change) => {
    vi.useFakeTimers();
    const { fake, bridge, hover } = setup();
    fake.setHostMethods(['feed.progress']); fake.setActivitySnapshot(['s-01', 's-02'].map((id) => makeActivity(ref(id), 'working')));
    let resolveOld!: (value: ProgressResult) => void;
    const first = new Promise<ProgressResult>((resolve) => { resolveOld = resolve; });
    const read = vi.fn<() => ProgressResult | Promise<ProgressResult>>().mockResolvedValue({ revision: 1, availability: 'available', current: null,
      recent: [{ id: 'fresh', at: '2026-10-26T10:00:00.000Z', category: 'read', status: 'done' }], truncated: false }).mockReturnValueOnce(first);
    fake.setHandler('feed.progress', read);
    render(<IslandApp bridge={bridge} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); hover(true);
    fireEvent.click(screen.getAllByRole('button', { name: 'Show recent actions' })[0]!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    if (change === 'selection') fireEvent.click(screen.getAllByRole('button', { name: 'Show recent actions' })[1]!);
    else act(() => fake.emit('works.changed', { entries: ENTRIES.map((entry) => ({ ...entry, map: { ...entry.map,
      sessions: entry.map.sessions.map((session) => session.id === 's-01' ? { ...session, pid: 77, startedAtProcess: 'process-new' } : session),
    } })), branches: {} }));
    expect(read).toHaveBeenCalledOnce();
    resolveOld({ revision: 99, availability: 'available', current: null,
      recent: [{ id: 'old', at: '2026-10-26T10:00:00.000Z', category: 'execute', status: 'done' }], truncated: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByText('Run command')).toBeNull(); expect(screen.getByText('Loading recent actions…')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByText('Read files')).toBeTruthy(); expect(read).toHaveBeenCalledTimes(2);
  });

  it('Codex без карточки: действие в терминале выдвигает Island, открывает сессию и уходит после ответа', async () => {
    const entries = [makeWork('w-1', { projectPath: PROJECT, sessions: [makeSession('s-03', 'codex', { provider: 'codex' })] })];
    const { island, bridge, blocked, working, hover } = setup({ islandSound: SOUND_ON }, entries);
    render(<IslandApp bridge={bridge} />);
    await act(async () => { await Promise.resolve(); });
    blocked('s-03');
    expect(await screen.findByTitle('Codex needs your attention in the terminal')).toBeTruthy();
    await waitFor(() => expect(isRetracted()).toBe(false));
    expect(played()).toEqual(['permission']);
    expect(screen.queryByTestId('island-allow')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
    expect(island.open).toHaveBeenCalledWith({ kind: 'session', ref: ref('s-03') });
    blocked('s-03');
    expect(played()).toEqual(['permission']);
    working('s-03');
    await waitFor(() => expect(screen.queryByTestId('island-card')).toBeNull());
    tuck(hover);
    skipCooldown();
    blocked('s-03');
    await screen.findByTitle('Codex needs your attention in the terminal');
    await waitFor(() => expect(isRetracted()).toBe(false));
    expect(played()).toEqual(['permission', 'permission']);
  });

  it('новый запрос выбирается в карточке: прежний на экране не остаётся', async () => {
    const { bridge, blocked } = setup();
    render(<IslandApp bridge={bridge} />);
    blocked('s-01');
    expect(await screen.findByTitle('Run: rm -rf build')).toBeTruthy();
    blocked('s-02');
    expect(await screen.findByTitle('Run: ls')).toBeTruthy();
    expect(screen.getByText('2 of 2')).toBeTruthy();
    expect(useIslandRequests.getState().selectedKey).toBe(useIslandRequests.getState().items[1]!.key);
  });

  it('новый запрос выдвигает убранный остров: язычок уходит, форма на месте', async () => {
    const { bridge, blocked } = setup();
    render(<IslandApp bridge={bridge} />);
    expect(isRetracted()).toBe(true);
    expect(screen.getByTestId('island-tab')).toBeTruthy();
    blocked('s-01');
    await screen.findByTitle('Run: rm -rf build');
    await waitFor(() => expect(isRetracted()).toBe(false));
    expect(screen.queryByTestId('island-tab')).toBeNull();
  });

  it('стрелка ⌃ убирает остров, но окно остаётся видимым; новый запрос выдвигает его снова', async () => {
    const { island, bridge, blocked, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    blocked('s-01');
    await screen.findByTitle('Run: rm -rf build');
    await waitFor(() => expect(isRetracted()).toBe(false));
    await waitFor(() => expect(island.setVisible).toHaveBeenLastCalledWith(true));
    vi.mocked(island.setVisible).mockClear();
    tuck(hover);
    expect(isRetracted()).toBe(true);
    expect(screen.getByTestId('island-tab')).toBeTruthy();
    // Окно не прячется: убирается только то, что нарисовано.
    expect(island.setVisible).not.toHaveBeenCalled();
    blocked('s-02');
    await screen.findByTitle('Run: ls');
    await waitFor(() => expect(isRetracted()).toBe(false));
    expect(screen.queryByTestId('island-tab')).toBeNull();
  });

  it('окно видно, пока хост подключён, даже в покое; хост отключился — окно спрятано, очередь пуста', async () => {
    const { island, bridge, blocked, disconnect, reconnect } = setup();
    render(<IslandApp bridge={bridge} />);
    await waitFor(() => expect(island.setVisible).toHaveBeenLastCalledWith(true));
    expect(isRetracted()).toBe(true);
    blocked('s-01');
    await screen.findByTitle('Run: rm -rf build');
    disconnect();
    await waitFor(() => expect(island.setVisible).toHaveBeenLastCalledWith(false));
    expect(useIslandRequests.getState().items).toEqual([]);
    reconnect();
    await waitFor(() => expect(island.setVisible).toHaveBeenLastCalledWith(true));
  });

  it('после переподключения всё ещё ждущая карточка — новая: выдвигает убранный стрелкой остров', async () => {
    const { fake, island, bridge, blocked, disconnect, reconnect, hover } = setup();
    fake.setActivitySnapshot([makeActivity(ref('s-01'), 'blocked')]);
    render(<IslandApp bridge={bridge} />);
    blocked('s-01');
    await screen.findByTitle('Run: rm -rf build');
    await waitFor(() => expect(isRetracted()).toBe(false));
    tuck(hover);
    expect(isRetracted()).toBe(true);
    disconnect();
    await waitFor(() => expect(island.setVisible).toHaveBeenLastCalledWith(false));
    reconnect();
    await screen.findByTitle('Run: rm -rf build');
    await waitFor(() => expect(island.setVisible).toHaveBeenLastCalledWith(true));
    await waitFor(() => expect(isRetracted()).toBe(false));
  });

  it('корень заполняет кадр окна, а форма по умолчанию стоит по центру', () => {
    const { bridge } = setup();
    const { container } = render(<IslandApp bridge={bridge} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('fixed');
    expect(root.className).toContain('inset-0');
    expect(root.className).toContain('flex');
    expect(root.className).toContain('items-start');
    expect(root.className).toContain('justify-center');
  });

  it('точка справа — форма прижата вправо кадра, слева — влево', async () => {
    const right = setup({ anchor: 'right' });
    const first = render(<IslandApp bridge={right.bridge} />);
    await waitFor(() => expect(first.container.firstElementChild?.className).toContain('justify-end'));
    first.unmount();
    const left = setup({ anchor: 'left' });
    const second = render(<IslandApp bridge={left.bridge} />);
    await waitFor(() => expect(second.container.firstElementChild?.className).toContain('justify-start'));
  });

  it('наведение приходит от main: над областью список открыт, ушёл — закрыт', async () => {
    const { bridge, working, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    working('s-01');
    await screen.findByText('1 working');
    expect(screen.queryByTestId('island-list')).toBeNull();
    hover(true);
    expect(screen.queryByTestId('island-list')).not.toBeNull();
    hover(false);
    expect(screen.queryByTestId('island-list')).toBeNull();
  });

  it('DOM-наведение остров не слушает: mouseenter и mouseleave по форме список не трогают', async () => {
    const { bridge, working } = setup();
    render(<IslandApp bridge={bridge} />);
    working('s-01');
    await screen.findByText('1 working');
    fireEvent.mouseEnter(screen.getByTestId('island-pill'));
    fireEvent.mouseEnter(screen.getByTestId('island'));
    expect(screen.queryByTestId('island-list')).toBeNull();
  });

  it('подписка на наведение снимается при размонтировании', () => {
    const { island, bridge } = setup();
    const off = vi.fn();
    vi.mocked(island.onHover).mockReturnValue(off);
    render(<IslandApp bridge={bridge} />).unmount();
    expect(island.onHover).toHaveBeenCalledTimes(1);
    expect(off).toHaveBeenCalledTimes(1);
  });

  describe('перетаскивание', () => {
    /** Нажимает на пилюле и уводит указатель дальше порога: жест идёт. */
    function startDrag(): HTMLElement {
      const pill = screen.getByTestId('island-pill');
      fireEvent(pill, pointer('pointerdown', 10, 20));
      fireEvent(pill, pointer('pointermove', 40, 20));
      return pill;
    }

    /** Остров с работой и открытым списком: main сообщил, что курсор над формой. */
    async function openedList() {
      const rig = setup();
      render(<IslandApp bridge={rig.bridge} />);
      rig.working('s-01');
      await screen.findByText('1 working');
      rig.hover(true);
      return rig;
    }

    it('жест уходит main: старт с точкой нажатия, отпускание с точкой отпускания; окно едет за курсором без участия renderer', async () => {
      const { island } = await openedList();
      const pill = startDrag();
      expect(island.dragStart).toHaveBeenCalledWith({ screenX: 10, screenY: 20 });
      expect(island.dragMove).toHaveBeenCalledWith({ screenX: 40, screenY: 20 });
      fireEvent(pill, pointer('pointerup', 41, 20, 0));
      expect(island.dragEnd).toHaveBeenCalledWith({ screenX: 41, screenY: 20 });
    });

    it('посреди жеста список остаётся открытым: main сообщает «над» и во время жеста', async () => {
      await openedList();
      startDrag();
      expect(screen.queryByTestId('island-list')).not.toBeNull();
    });

    it('после жеста main сообщает «вне» — список закрыт; сам renderer список по отпусканию не трогает', async () => {
      const { hover } = await openedList();
      const pill = startDrag();
      fireEvent(pill, pointer('pointerup', 41, 20, 0));
      expect(screen.queryByTestId('island-list')).not.toBeNull();
      hover(false);
      expect(screen.queryByTestId('island-list')).toBeNull();
    });

    it('нажатие без сдвига за порог — не жест', async () => {
      const { island } = await openedList();
      fireEvent(screen.getByTestId('island-pill'), pointer('pointerdown', 10, 20));
      fireEvent(screen.getByTestId('island-pill'), pointer('pointermove', 12, 20));
      expect(island.dragStart).not.toHaveBeenCalled();
    });

    it('нажатие на стрелке остров не тащит и не смахивает, куда ни веди указатель', async () => {
      const { island } = await openedList();
      const arrow = screen.getByTestId('island-tuck');
      fireEvent(arrow, pointer('pointerdown', 10, 100));
      fireEvent(arrow, pointer('pointermove', 80, 100));
      fireEvent(arrow, pointer('pointermove', 80, 20));
      fireEvent(arrow, pointer('pointerup', 80, 20, 0));
      expect(island.dragStart).not.toHaveBeenCalled();
      expect(isRetracted()).toBe(false);
    });
  });

  describe('стрелка ⌃ и смахивание вверх', () => {
    it('стрелка есть только под курсором (по main): ушёл — пропала; убранный остров стрелки не показывает', async () => {
      const { bridge, working, hover } = setup();
      render(<IslandApp bridge={bridge} />);
      working('s-01');
      await screen.findByText('1 working');
      expect(screen.queryByTestId('island-tuck')).toBeNull();
      hover(true);
      expect(screen.getByTestId('island-tuck')).toBeTruthy();
      hover(false);
      expect(screen.queryByTestId('island-tuck')).toBeNull();
      // Курсор остался над областью (над язычком), а остров убран: стрелки нет.
      tuck(hover);
      expect(isRetracted()).toBe(true);
      expect(screen.queryByTestId('island-tuck')).toBeNull();
    });

    it('смахивание вверх по острову убирает его в язычок: перетаскивания нет, окно остаётся видимым', async () => {
      const { island, bridge, working } = setup();
      render(<IslandApp bridge={bridge} />);
      working('s-01');
      await screen.findByText('1 working');
      await waitFor(() => expect(island.setVisible).toHaveBeenLastCalledWith(true));
      vi.mocked(island.setVisible).mockClear();
      const pill = screen.getByTestId('island-pill');
      fireEvent(pill, pointer('pointerdown', 100, 40));
      // Вверх меньше порога смахивания: остров на месте.
      fireEvent(pill, pointer('pointermove', 100, 35));
      expect(isRetracted()).toBe(false);
      fireEvent(pill, pointer('pointermove', 100, 30));
      expect(isRetracted()).toBe(true);
      expect(screen.getByTestId('island-tab')).toBeTruthy();
      expect(island.dragStart).not.toHaveBeenCalled();
      expect(island.setVisible).not.toHaveBeenCalled();
      fireEvent(pill, pointer('pointerup', 100, 30, 0));
      expect(island.dragEnd).not.toHaveBeenCalled();
    });

    it('смахивание по карточке запроса тоже убирает остров; по кнопке решения — нет', async () => {
      const { island, bridge, blocked } = setup();
      render(<IslandApp bridge={bridge} />);
      blocked('s-01');
      await screen.findByTitle('Run: rm -rf build');
      await waitFor(() => expect(isRetracted()).toBe(false));
      const allow = screen.getByTestId('island-allow');
      fireEvent(allow, pointer('pointerdown', 100, 100));
      fireEvent(allow, pointer('pointermove', 100, 40));
      expect(isRetracted()).toBe(false);
      fireEvent(allow, pointer('pointerup', 100, 40, 0));
      const summary = screen.getByTitle('Run: rm -rf build');
      fireEvent(summary, pointer('pointerdown', 100, 100));
      fireEvent(summary, pointer('pointermove', 100, 40));
      expect(isRetracted()).toBe(true);
      expect(island.dragStart).not.toHaveBeenCalled();
    });
  });

  describe('помощник', () => {
    /** Рисует остров с включённым помощником и ждёт, пока мост подписан на события main. */
    async function renderAssistant(config: Partial<IslandConfig> = {}) {
      const ctx = setup({ assistant: ASSISTANT_ON, ...config });
      render(<IslandApp bridge={ctx.bridge} />);
      await waitFor(() => expect(ctx.island.onAssistantOpen).toHaveBeenCalled());
      return ctx;
    }

    it('onAssistantOpen показывает вид помощника и берёт клавиатуру', async () => {
      const { island, assistantOpen } = await renderAssistant();
      assistantOpen({ listen: false });
      expect(await screen.findByTestId('assistant-view')).toBeTruthy();
      expect(island.keyboard).toHaveBeenCalledWith(true);
    });

    it('an empty pending shortcut keeps keyboard ownership with the open assistant', async () => {
      const { island, assistantOpen } = await renderAssistant();
      assistantOpen({ listen: false });
      await screen.findByTestId('assistant-view');
      island.keyboard.mockClear();
      act(() => pendingNavigationHandler?.());
      expect(island.keyboard).not.toHaveBeenCalledWith(false);
      expect(screen.getByTestId('assistant-view')).toBeTruthy();
    });

    it('Esc закрывает вид и отдаёт клавиатуру', async () => {
      const { island, assistantOpen } = await renderAssistant();
      assistantOpen({ listen: false });
      await screen.findByTestId('assistant-view');
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByTestId('assistant-view')).toBeNull();
      expect(island.keyboard).toHaveBeenLastCalledWith(false);
    });

    it('потеря фокуса панели без хода закрывает вид и отдаёт клавиатуру', async () => {
      const { island, assistantOpen, assistantBlur } = await renderAssistant();
      assistantOpen({ listen: false });
      await screen.findByTestId('assistant-view');
      assistantBlur();
      expect(screen.queryByTestId('assistant-view')).toBeNull();
      expect(island.keyboard).toHaveBeenLastCalledWith(false);
    });

    it('потеря фокуса панели во время хода сворачивает вид в мини-вид', async () => {
      const { island, assistantOpen, assistantBlur } = await renderAssistant();
      assistantOpen({ listen: false });
      await screen.findByTestId('assistant-view');
      act(() => {
        useAssistantStore.getState().applyHost({ ...HOST_IDLE, phase: 'thinking', turn: 1 });
      });
      assistantBlur();
      expect(screen.queryByTestId('assistant-view')).toBeNull();
      expect(screen.getByTestId('assistant-mini').textContent).toBe('Thinking·');
      expect(island.keyboard).toHaveBeenLastCalledWith(false);
    });

    it('строка needs you прячется, когда карточка помощника решает запрос первой ждущей сессии', async () => {
      const { assistantOpen, blocked } = await renderAssistant();
      blocked('s-01');
      assistantOpen({ listen: false });
      await screen.findByTestId('assistant-view');
      expect(await screen.findByTestId('assistant-pending')).toBeTruthy();
      const name = sessionLabels(ENTRIES).get(refKey(ref('s-01')))!.session;
      const card = { cardId: 'c-1', kind: 'permission', summary: 'Run a shell command', detail: 'rm -rf build' } as const;
      act(() => {
        useAssistantStore.getState().applyHost({
          ...HOST_IDLE,
          phase: 'awaiting-confirm',
          turn: 1,
          proposal: { id: 'p1', target: name, where: 'Parley · proj', text: 'Allow?', action: 'decision', card, decision: { kind: 'permission', behavior: 'allow' } },
        });
      });
      expect(screen.getByTestId('assistant-card')).toBeTruthy();
      expect(screen.queryByTestId('assistant-pending')).toBeNull();
    });

    it('строка needs you остаётся, если карточка решения — про другую сессию', async () => {
      const { assistantOpen, blocked } = await renderAssistant();
      blocked('s-01');
      assistantOpen({ listen: false });
      await screen.findByTestId('assistant-view');
      const card = { cardId: 'c-2', kind: 'permission', summary: 'ls', detail: null } as const;
      act(() => {
        useAssistantStore.getState().applyHost({
          ...HOST_IDLE,
          phase: 'awaiting-confirm',
          turn: 1,
          proposal: { id: 'p2', target: 'S99 Nobody', where: 'Parley · proj', text: 'Allow?', action: 'decision', card, decision: { kind: 'permission', behavior: 'allow' } },
        });
      });
      expect(await screen.findByTestId('assistant-pending')).toBeTruthy();
    });

    it('ответ после хода остаётся на острове, пока человек сам его не закроет', async () => {
      const { assistantOpen } = await renderAssistant();
      assistantOpen({ listen: false });
      await screen.findByTestId('assistant-view');
      vi.useFakeTimers();
      act(() => {
        useAssistantStore.getState().applyHost({ ...HOST_IDLE, phase: 'thinking', turn: 1 });
      });
      act(() => {
        useAssistantStore.getState().applyHost({ ...HOST_IDLE, answer: 'Two sessions are working.', turn: 1 });
      });
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByTestId('assistant-view')).toBeTruthy();
      expect(useAssistantStore.getState().open).toBe(true);
    });

    it('потеря фокуса панели при закрытом виде ничего не делает', async () => {
      const { island, assistantBlur } = await renderAssistant();
      assistantBlur();
      expect(island.keyboard).not.toHaveBeenCalled();
      expect(useAssistantStore.getState().open).toBe(false);
    });

    it('остров выключен: окно скрыто, после onAssistantOpen — видно', async () => {
      const { island, assistantOpen } = await renderAssistant({ islandEnabled: false });
      await waitFor(() => expect(island.setVisible).toHaveBeenLastCalledWith(false));
      assistantOpen({ listen: false });
      await waitFor(() => expect(island.setVisible).toHaveBeenLastCalledWith(true));
    });
  });
});

describe('речь помощника (план 3b B22)', () => {
  /** Остров с говорящим помощником; порт голоса приходит в ответ на `connect`, движок готов, режим открыт. */
  async function renderSpeaking(config: Partial<IslandConfig> = {}) {
    const ctx = setup({ assistant: ASSISTANT_SPEAKS, ...config });
    const port = voicePort();
    vi.mocked(ctx.island.speech.connect).mockImplementation(() => sendPort([port]));
    vi.mocked(ctx.island.speech.speak).mockImplementation(() => new Promise<TtsEngineState>(() => {}));
    render(<IslandApp bridge={ctx.bridge} />);
    await waitFor(() => expect(ctx.island.onAssistantOpen).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    act(() => port.onmessage!({ data: { type: 'state', state: { state: 'ready' } } }));
    ctx.assistantOpen({ listen: false });
    await screen.findByTestId('assistant-view');
    return { ...ctx, port };
  }
  /** Ход 1 с ответом из одного предложения: ответ дописан, предложение ушло на синтез. */
  function answer(island: IslandApi): IslandSpeakRequest {
    for (const state of [{ phase: 'thinking' }, { phase: 'answering', answer: 'Two agents are busy.' }, { phase: 'idle', answer: 'Two agents are busy.' }] as const) {
      act(() => useAssistantStore.getState().applyHost({ ...HOST_IDLE, turn: 1, ...state }));
    }
    return vi.mocked(island.speech.speak).mock.calls.at(-1)![0];
  }

  it('порт голоса: принят только от своего окна, с меткой и одним портом; connect — после подписки на message', async () => {
    const ctx = setup({ assistant: ASSISTANT_SPEAKS });
    const port = voicePort();
    const foreign = voicePort();
    vi.mocked(ctx.island.speech.connect).mockImplementation(() => {
      sendPort([foreign], { source: null });
      sendPort([foreign], { data: 'other' });
      sendPort([foreign, voicePort()]);
      sendPort([port]);
    });
    render(<IslandApp bridge={ctx.bridge} />);
    await waitFor(() => expect(ctx.island.speech.connect).toHaveBeenCalledTimes(1));
    expect(port.onmessage).toEqual(expect.any(Function));
    expect(foreign.onmessage).toBeNull();
  });

  it('кусок из порта — в проигрыватель после конца ответа, срыв — discard; expect раньше tts-speak; прогрев при открытии', async () => {
    const { island, port } = await renderSpeaking();
    expect(island.speech.warmup).toHaveBeenCalledTimes(1);
    const request = answer(island);
    expect(request).toMatchObject({ text: 'Two agents are busy.', voice: 'qwen3-0.6b/serena', language: 'en' });
    const speaker = speakerOf();
    expect(speaker.expect).toHaveBeenCalledWith(request.utteranceId);
    act(() => port.onmessage!({ data: { type: 'chunk', chunk: { utteranceId: request.utteranceId, seq: 0, sampleRate: 24000, channels: 1, format: 'f32', pcm: new Float32Array(4), final: false } } }));
    expect(speaker.enqueue).toHaveBeenCalledWith(expect.objectContaining({ utteranceId: request.utteranceId, seq: 0 }));
    act(() => port.onmessage!({ data: { type: 'discard', utteranceId: request.utteranceId, fromSeq: 1 } }));
    expect(speaker.discard).toHaveBeenCalledWith(request.utteranceId, 1);
  });

  it('Esc во время речи: проигрыватель глушится, в main уходит отмена всей очереди (E3)', async () => {
    const { island } = await renderSpeaking();
    const request = answer(island);
    act(() => { for (const cb of speakerOf().starts) cb(request.utteranceId); });
    expect(useAssistantStore.getState().input).toBe('speaking');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(speakerOf().stop).toHaveBeenCalled();
    expect(island.speech.cancel).toHaveBeenCalledWith();
    expect(useAssistantStore.getState().input).toBe('idle');
  });

  it('лицо: анализ голоса с частотой графа острова и reduced motion — системным или настройкой Parley', async () => {
    vi.mocked(islandSound.graph).mockReturnValueOnce({ context: { sampleRate: 44100 } } as never);
    await renderSpeaking({ motion: 'reduce' });
    speakerOf().read.mockReturnValue(true);
    act(() => { useAssistantStore.getState().voiceFrame(); });
    const options = vi.mocked(createVoiceAnalysis).mock.calls.at(-1)![0]!;
    expect(options.sampleRate).toBe(44100);
    expect(options.reducedMotion!()).toBe(true);
    cleanup();

    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
    await renderSpeaking({ motion: 'system' });
    speakerOf().read.mockReturnValue(true);
    act(() => { useAssistantStore.getState().voiceFrame(); });
    const system = vi.mocked(createVoiceAnalysis).mock.calls.at(-1)![0]!;
    expect(system.reducedMotion!()).toBe(false);
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    expect(system.reducedMotion!()).toBe(true);
  });

  it('под речью разрешение звучит и опускает голос (V2)', async () => {
    vi.mocked(islandSound.duckVoice).mockClear();
    const { bridge, blocked } = setup({ islandSound: SOUND_ON });
    render(<IslandApp bridge={bridge} />);
    await act(async () => { await Promise.resolve(); });
    speakerOf().speaking.mockReturnValue(true);
    blocked('s-01');
    await waitFor(() => expect(played()).toEqual(['permission']));
    expect(islandSound.duckVoice).toHaveBeenCalledTimes(1);
  });

  it('кадр голоса: лицо читает голос из стора в кадре роя (подставной rAF), а не при рендере (Р10)', async () => {
    const ctx2d = {
      setTransform: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '', globalAlpha: 1, globalCompositeOperation: '',
      createRadialGradient: () => ({ addColorStop: vi.fn() }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx2d as unknown as CanvasRenderingContext2D);
    let frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    try {
      const { island } = await renderSpeaking();
      const request = answer(island);
      act(() => { for (const cb of speakerOf().starts) cb(request.utteranceId); });
      expect(useAssistantStore.getState().input).toBe('speaking');
      expect(speakerOf().read).not.toHaveBeenCalled();
      act(() => {
        for (let t = 100; t < 200; t += 16) {
          const run = frames;
          frames = [];
          for (const cb of run) cb(t);
        }
      });
      expect(speakerOf().read).toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('data-emo лица идёт за эмоцией звучащего предложения (L3), а без него — за меткой хода', async () => {
    await renderSpeaking();
    const face = (): HTMLElement => within(screen.getByTestId('assistant-view')).getByTestId('swarm');
    act(() => useAssistantStore.setState({ host: { ...HOST_IDLE, mood: 'joy', turn: 1 }, input: 'speaking', sentence: { utteranceId: 'u-1', emo: 'calm', text: 'Two agents are busy.' } }));
    expect(face().getAttribute('data-shape')).toBe('face');
    expect(face().getAttribute('data-emo')).toBe('calm');
    act(() => useAssistantStore.setState({ sentence: { utteranceId: 'u-2', emo: 'sad', text: 'One has failed.' } }));
    expect(face().getAttribute('data-emo')).toBe('sad');
    act(() => useAssistantStore.setState({ sentence: null }));
    expect(face().getAttribute('data-emo')).toBe('joy');
  });

  it('значок динамика: aria-pressed по «Speak answers», клик переключает его через main', async () => {
    const { island } = await renderSpeaking();
    const button = screen.getByTestId('assistant-speak');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(island.speech.setSpeak).toHaveBeenCalledWith(false);
  });

  it('до прихода настроек речь выключена и голоса нет', () => {
    expect(INITIAL_CONFIG.assistant.speech).toEqual({ enabled: false, voice: 'qwen3-0.6b/serena', gender: 'female', available: false });
  });
});

describe('область под мышь', () => {
  const SHAPE = { x: 100, y: 0, width: 280, height: 40 };
  const TAB = { x: 208, y: 0, width: 64, height: 16 };
  /** Что вернёт `getBoundingClientRect` форме и язычку; тест меняет, как будто форма выросла или уехала. */
  let rects = { shape: SHAPE, tab: TAB };
  let spy: { mockRestore(): void } | null = null;

  beforeEach(() => {
    rects = { shape: SHAPE, tab: TAB };
    spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const id = (this as HTMLElement).dataset.testid;
      // Язычок стоит там же, где форма: у правой точки кадра он правее.
      const shifted = this.parentElement?.className.includes('justify-end') === true ? 208 : 0;
      const rect = id === 'island' ? rects.shape : id === 'island-tab' ? { ...rects.tab, x: rects.tab.x + shifted } : { x: 0, y: 0, width: 0, height: 0 };
      return rect as DOMRect;
    });
  });

  afterEach(() => {
    spy?.mockRestore();
    spy = null;
  });

  /** Последний вызов `setHitRect`. */
  const lastRect = (island: IslandApi): unknown => vi.mocked(island.setHitRect).mock.calls.at(-1)?.[0];
  /** Наблюдатели замера пересчитали размер: вызывает последний живой колбэк. */
  const resized = (): void => {
    act(() => {
      resizeCallbacks.at(-1)?.();
    });
  };

  it('до подключения хоста область null, потом язычок убранного острова; хост отключился — снова null', () => {
    const { island, bridge, disconnect, reconnect } = setup();
    render(<IslandApp bridge={bridge} />);
    expect(vi.mocked(island.setHitRect).mock.calls[0]).toEqual([null]);
    expect(lastRect(island)).toEqual(TAB);
    disconnect();
    expect(lastRect(island)).toBeNull();
    reconnect();
    expect(lastRect(island)).toEqual(TAB);
  });

  it('выдвинутый остров сообщает область формы, убранный — язычка', () => {
    const { island, bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    expand();
    expect(lastRect(island)).toEqual(SHAPE);
    tuck(hover);
    expect(lastRect(island)).toEqual(TAB);
  });

  it('форму и язычок замеряет ResizeObserver', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expect(observed).toContain(screen.getByTestId('island'));
    expect(observed).toContain(screen.getByTestId('island-tab'));
  });

  it('форма выросла — уходит новая область; равная прежней не повторяется', () => {
    const { island, bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expand();
    const before = vi.mocked(island.setHitRect).mock.calls.length;
    resized();
    resized();
    expect(vi.mocked(island.setHitRect).mock.calls).toHaveLength(before);
    rects.shape = { x: 40, y: 0, width: 400, height: 220 };
    resized();
    expect(lastRect(island)).toEqual({ x: 40, y: 0, width: 400, height: 220 });
    expect(vi.mocked(island.setHitRect).mock.calls).toHaveLength(before + 1);
    resized();
    expect(vi.mocked(island.setHitRect).mock.calls).toHaveLength(before + 1);
  });

  it('форма доехала до места (transitionend), размер при этом не менялся — область обновляется', () => {
    const { island, bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expand();
    // Начало выдвижения: форма ещё ниже места (отступ сверху доезжает переходом).
    rects.shape = { x: 100, y: 40, width: 280, height: 40 };
    fireEvent.transitionEnd(screen.getByTestId('island'));
    expect(lastRect(island)).toEqual({ x: 100, y: 40, width: 280, height: 40 });
    rects.shape = SHAPE;
    fireEvent.transitionEnd(screen.getByTestId('island'));
    expect(lastRect(island)).toEqual(SHAPE);
  });

  it('M2: рост с перелётом — область во время перехода крупнее, после transitionend уходит итоговая', () => {
    const { island, bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expand();
    // Пружинная кривая роста на миг раздувает форму на ≈ 4 % больше итоговой.
    const overshoot = { x: 94, y: 0, width: 291, height: 42 };
    rects.shape = overshoot;
    resized();
    expect(lastRect(island)).toEqual(overshoot);
    rects.shape = SHAPE;
    fireEvent.transitionEnd(screen.getByTestId('island'));
    expect(lastRect(island)).toEqual(SHAPE);
  });

  it('точка острова сменилась — область замеряется заново', async () => {
    const { island, bridge } = setup({ anchor: 'right' });
    render(<IslandApp bridge={bridge} />);
    await waitFor(() => expect(lastRect(island)).toEqual({ ...TAB, x: 416 }));
  });

  it('смена вида пересоздаёт наблюдателя: прежний отключён, новый следит за формой, а не за ушедшим язычком', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    const before = resizeCallbacks.length;
    expand();
    // Язычок ушёл — остался один живой наблюдатель, а колбэк прежнего вида не сработает.
    expect(resizeCallbacks).toHaveLength(before);
    expect(observed.at(-1)).toBe(screen.getByTestId('island'));
  });
});

describe('движение формы', () => {
  const morph = (): string | undefined => screen.getByTestId('island').className.split(' ').find((name) => name.startsWith('island-morph-'));

  it('RETRACT_MORPH_MS — длина сжатия формы, 300 мс', () => {
    expect(RETRACT_MORPH_MS).toBe(300);
  });

  it('M2: стрелка ⌃ сжимает форму кривой сжатия, язычок выдвигает кривой роста', () => {
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    expand();
    expect(morph()).toBe('island-morph-grow');
    tuck(hover);
    expect(morph()).toBe('island-morph-shrink');
    expand();
    expect(morph()).toBe('island-morph-grow');
  });

  it('M3: настройка «Reduce motion» из island:config — форма без перехода', async () => {
    const { bridge } = setup({ motion: 'reduce' });
    render(<IslandApp bridge={bridge} />);
    await waitFor(() => expect(screen.getByTestId('island').getAttribute('data-motion')).toBe('reduce'));
    expect(morph()).toBeUndefined();
    expand();
    expect(morph()).toBeUndefined();
  });

  it('M3: «Reduce motion» включили на лету — переход снимается; вернули «system» — переход снова есть', async () => {
    const { island, bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    await waitFor(() => expect(island.onConfig).toHaveBeenCalled());
    const push = (config: IslandConfig): void => {
      act(() => {
        vi.mocked(island.onConfig).mock.calls.at(-1)![0](config);
      });
    };
    const base = await island.config();
    push({ ...base, motion: 'reduce' });
    expect(morph()).toBeUndefined();
    push({ ...base, motion: 'system' });
    expect(morph()).toBe('island-morph-grow');
  });
});

describe('язычок убранного острова', () => {
  it.each([[true, ['open', 'hover', 'close']], [false, []]])('«Interface sounds» %s: язычок — open, наведение — hover, стрелка ⌃ — close', async (ui, expected) => {
    vi.useFakeTimers();
    const { bridge, hover } = setup({ islandSound: { ...SOUND_OFF, ui } });
    render(<IslandApp bridge={bridge} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(isRetracted()).toBe(true);
    expand();
    await act(async () => { await vi.advanceTimersByTimeAsync(CUE_GAP_MS); });
    tuck(hover);
    expect(isRetracted()).toBe(true);
    expect(played()).toEqual(expected);
  });

  it('в покое при открытии остров убран: форма сжата в брусок, прозрачная зона «Show the island» поверх неё', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expect(isRetracted()).toBe(true);
    const tab = screen.getByRole('button', { name: 'Show the island' });
    expect(tab).toBe(screen.getByTestId('island-tab'));
    // Зона нажатия 64×16 ничего не рисует: ни полоски, ни текста, ни цвета «закончено».
    expect(tab.className).toContain('w-16');
    expect(tab.className).toContain('h-4');
    expect(tab.childElementCount).toBe(0);
    expect(tab.textContent).toBe('');
    // Чёрный брусок 40×5 со светлой обводкой (видна и на светлом фоне) рисует сама форма.
    const shape = screen.getByTestId('island');
    expect(shape.className).toContain('rounded-[3px]');
    expect(shape.className).toContain('bg-black');
    expect(shape.className).toContain('ring-1');
    expect(shape.className).toContain('ring-white/50');
    expect(shape.className).not.toContain('bg-[var(--state-done)]');
    const bar = screen.getByTestId('island-content').firstElementChild as HTMLElement;
    expect(bar.className).toContain('h-[5px]');
    expect(bar.className).toContain('w-10');
    expect(shape.textContent).toBe('');
  });

  it('зона лежит поверх убранной формы: позже в DOM и absolute, нажатия по форме ловит она', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    const shape = screen.getByTestId('island');
    const tab = screen.getByTestId('island-tab');
    expect(shape.compareDocumentPosition(tab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(shape.contains(tab)).toBe(false);
    expect((tab.parentElement as HTMLElement).className).toContain('absolute');
    expect(tab.className).toContain('cursor-pointer');
  });

  it('язычок стоит там же, где форма: по точке и под чёлкой', async () => {
    const { bridge } = setup({ anchor: 'right', topInset: 38 });
    render(<IslandApp bridge={bridge} />);
    const wrapper = screen.getByTestId('island-tab').parentElement as HTMLElement;
    await waitFor(() => {
      expect(wrapper.className).toContain('justify-end');
      expect(wrapper.style.top).toBe('38px');
    });
  });

  it('клик выдвигает остров: язычок уходит, в покое пилюля «No agents running»', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expand();
    expect(isRetracted()).toBe(false);
    expect(screen.queryByTestId('island-tab')).toBeNull();
    expect(screen.getByTestId('island-idle').textContent).toBe('No agents running');
  });

  it('потяжка вниз дальше 8 px выдвигает остров; ровно 8 px, вверх и без нажатия — нет; окно при этом не тащится', () => {
    const { island, bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    const tab = screen.getByTestId('island-tab');
    fireEvent(tab, pointer('pointermove', 100, 100));
    fireEvent(tab, pointer('pointermove', 100, 200));
    expect(isRetracted()).toBe(true);
    fireEvent(tab, pointer('pointerdown', 100, 10));
    fireEvent(tab, pointer('pointermove', 100, 10 + PULL_EXPAND_PX));
    fireEvent(tab, pointer('pointermove', 100, 0));
    expect(isRetracted()).toBe(true);
    fireEvent(tab, pointer('pointermove', 100, 10 + PULL_EXPAND_PX + 1));
    expect(isRetracted()).toBe(false);
    expect(island.dragStart).not.toHaveBeenCalled();
  });

  it('потяжка отпущена до порога — остров не выдвигается, а новое нажатие считает заново', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    const tab = screen.getByTestId('island-tab');
    fireEvent(tab, pointer('pointerdown', 100, 10));
    fireEvent(tab, pointer('pointermove', 100, 14));
    fireEvent(tab, pointer('pointerup', 100, 14, 0));
    fireEvent(tab, pointer('pointermove', 100, 40));
    expect(isRetracted()).toBe(true);
    fireEvent(tab, pointer('pointerdown', 100, 30));
    fireEvent(tab, pointer('pointermove', 100, 40));
    expect(isRetracted()).toBe(false);
  });
});

describe('убирание острова в покое', () => {
  /** Подставные таймеры: четыре секунды покоя проходят за один вызов. */
  const advance = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('покой 4 с — остров убирается; за мгновение до срока ещё нет', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expand();
    advance(IDLE_RETRACT_MS - 1);
    expect(isRetracted()).toBe(false);
    advance(1);
    expect(isRetracted()).toBe(true);
    expect(screen.getByTestId('island-tab')).toBeTruthy();
  });

  it('курсор над формой (по main) посреди отсчёта — остров не убирается; ушёл — отсчёт заново', () => {
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    expand();
    advance(IDLE_RETRACT_MS - 1000);
    hover(true);
    advance(IDLE_RETRACT_MS * 3);
    expect(isRetracted()).toBe(false);
    hover(false);
    advance(IDLE_RETRACT_MS - 1);
    expect(isRetracted()).toBe(false);
    advance(1);
    expect(isRetracted()).toBe(true);
  });

  it('форму тащат — остров не убирается; отпустили — отсчёт заново', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expand();
    const pill = screen.getByTestId('island-pill');
    fireEvent(pill, pointer('pointerdown', 10, 20));
    fireEvent(pill, pointer('pointermove', 40, 20));
    advance(IDLE_RETRACT_MS * 3);
    expect(isRetracted()).toBe(false);
    fireEvent(pill, pointer('pointerup', 41, 20, 0));
    advance(IDLE_RETRACT_MS - 1);
    expect(isRetracted()).toBe(false);
    advance(1);
    expect(isRetracted()).toBe(true);
  });

  it('работа идёт к открытию — остров на месте с первого кадра и не убирается', () => {
    seedWorking();
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expect(isRetracted()).toBe(false);
    expect(screen.queryByTestId('island-tab')).toBeNull();
    expect(screen.getByTestId('island-pill').textContent).toContain('1 working');
    advance(IDLE_RETRACT_MS * 3);
    expect(isRetracted()).toBe(false);
  });

  it('работа кончилась — через 4 с остров убирается', () => {
    seedWorking();
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    advance(IDLE_RETRACT_MS * 2);
    act(seedIdle);
    expect(screen.getByTestId('island-idle').textContent).toBe('No agents running');
    advance(IDLE_RETRACT_MS - 1);
    expect(isRetracted()).toBe(false);
    advance(1);
    expect(isRetracted()).toBe(true);
  });

  it('работа началась, пока остров убран, — он выдвигается сам', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expect(isRetracted()).toBe(true);
    act(seedWorking);
    expect(isRetracted()).toBe(false);
    expect(screen.queryByTestId('island-tab')).toBeNull();
  });

  it('стрелка среди работы убирает остров, и сама по себе работа его не возвращает — только новая работа после покоя', () => {
    seedWorking();
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    tuck(hover);
    expect(isRetracted()).toBe(true);
    // Работа идёт и дальше (другое событие того же признака) — убранный остров остаётся убранным.
    act(() => {
      useActivityStore.setState({ byRef: { [refKey(ref('s-01'))]: makeActivity(ref('s-01'), 'working', { lastEventAt: '2026-09-27T09:05:00.000Z' }) } });
    });
    advance(IDLE_RETRACT_MS);
    expect(isRetracted()).toBe(true);
    // Покой и снова работа: признак сменился с нет на да.
    act(seedIdle);
    act(seedWorking);
    expect(isRetracted()).toBe(false);
  });

  it('стрелка посреди отсчёта покоя убирает остров сразу', () => {
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    expand();
    advance(1000);
    tuck(hover);
    expect(isRetracted()).toBe(true);
    // Отсчёт отменён: повторного убирания нет, язычок не мигает.
    advance(IDLE_RETRACT_MS * 2);
    expect(isRetracted()).toBe(true);
    expect(screen.getByTestId('island-tab')).toBeTruthy();
  });
});

describe('единый keyboard owner T1c', () => {
  beforeEach(() => vi.useFakeTimers());
  const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const takeRequest = (): void => { fireEvent(screen.getByTestId('island-card'), pointer('pointerdown')); };

  it.each(['island-allow', 'island-deny'])('мышь pointerdown/focus/click по %s не берёт OS keyboard при оставшихся pending', async (id) => {
    const { fake, bridge, island, blocked } = setup();
    fake.setHandler('feed.decide', () => ({ applied: true, state: 'allowed' }));
    render(<IslandApp bridge={bridge} />);
    await flush();
    blocked('s-01');
    blocked('s-02');
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const button = screen.getByTestId(id);
    const label = document.createElement('span');
    label.textContent = 'nested button target';
    button.append(label);
    fireEvent(label, pointer('pointerdown'));
    act(() => button.focus());
    fireEvent.click(label, { detail: 1 });
    await flush();
    expect(fake.calls.filter((call) => call.method === 'feed.decide')).toHaveLength(1);
    expect(useIslandRequests.getState().items).toHaveLength(1);
    expect(island.keyboard).not.toHaveBeenCalled();
  });

  it('мышь pointerdown/focus/click по Open in Parley не берёт OS keyboard', async () => {
    const { fake, bridge, island, blocked } = setup();
    fake.setHandler('feed.snapshot', () => ({ items: [{
      id: 'plan', cardId: 'plan', at: '2026-10-26T10:00:00.000Z', kind: 'plan', state: 'pending', toolUseId: null,
      toolName: 'ExitPlanMode', toolInput: {}, plan: 'A plan', planFilePath: null,
    }], revision: 1, mode: null, decisions: 'window' }));
    render(<IslandApp bridge={bridge} />);
    await flush();
    blocked('s-01');
    await flush();
    const button = screen.getByRole('button', { name: 'Open in Parley' });
    fireEvent(button, pointer('pointerdown'));
    act(() => button.focus());
    fireEvent.click(button, { detail: 1 });
    expect(island.open).toHaveBeenCalledWith({ kind: 'session', ref: ref('s-01'), cardId: 'plan' });
    expect(island.keyboard).not.toHaveBeenCalled();
  });

  it.each(['Enter', ' '])('failed mouse decide не получает повторный ответ от %j без keyboard owner', async (key) => {
    const { fake, bridge, island, blocked } = setup();
    fake.setHandler('feed.decide', () => ({ applied: false, state: 'pending' }));
    render(<IslandApp bridge={bridge} />);
    await flush();
    blocked('s-01');
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const button = screen.getByTestId('island-allow') as HTMLButtonElement;
    fireEvent(button, pointer('pointerdown'));
    act(() => button.focus());
    fireEvent.click(button, { detail: 1 });
    await flush();
    expect(fake.calls.filter((call) => call.method === 'feed.decide')).toHaveLength(1);
    const nativeDefault = fireEvent.keyDown(button, { key });
    fireEvent.keyUp(button, { key });
    if (nativeDefault && document.activeElement === button && !button.disabled) fireEvent.click(button, { detail: 0 });
    await flush();
    expect(fake.calls.filter((call) => call.method === 'feed.decide')).toHaveLength(1);
    expect(island.keyboard).not.toHaveBeenCalled();
  });

  it('snapshot сам не берёт клавиатуру; явное взаимодействие берёт один раз, Escape отдаёт без решения', async () => {
    const { fake, bridge, island, blocked } = setup();
    render(<IslandApp bridge={bridge} />);
    await flush();
    blocked('s-01');
    await flush();
    expect(island.keyboard).not.toHaveBeenCalled();
    takeRequest();
    takeRequest();
    expect(vi.mocked(island.keyboard).mock.calls).toEqual([[true]]);
    expect(document.activeElement).toBe(screen.getByTestId('island-card'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(island.keyboard).toHaveBeenLastCalledWith(false);
    expect(document.activeElement).not.toBe(screen.getByTestId('island-card'));
    expect(fake.calls.filter((call) => call.method === 'feed.decide')).toHaveLength(0);
  });

  it.each(['blur', 'collapse', 'disconnect', 'unmount'])('request owner отдаёт клавиатуру по %s', async (reason) => {
    const { bridge, island, blocked, hover, disconnect, assistantBlur } = setup();
    const mounted = render(<IslandApp bridge={bridge} />);
    await flush();
    blocked('s-01');
    await flush();
    takeRequest();
    expect(island.keyboard).toHaveBeenLastCalledWith(true);
    if (reason === 'blur') assistantBlur();
    if (reason === 'collapse') tuck(hover);
    if (reason === 'disconnect') disconnect();
    if (reason === 'unmount') mounted.unmount();
    expect(vi.mocked(island.keyboard).mock.calls).toEqual([[true], [false]]);
  });

  it('assistant/request передают одного owner без повторного OS focus и чужого release', async () => {
    const { bridge, island, blocked, assistantOpen } = setup({ assistant: ASSISTANT_ON });
    render(<IslandApp bridge={bridge} />);
    await flush();
    blocked('s-01');
    await flush();
    takeRequest();
    assistantOpen({ listen: false });
    expect(vi.mocked(island.keyboard).mock.calls).toEqual([[true]]);
    act(() => useAssistantStore.getState().close());
    takeRequest();
    vi.mocked(island.keyboard).mockClear();
    // Запоздалый release помощника не принадлежит уже активному request owner.
    act(() => useAssistantStore.getState().collapse());
    expect(island.keyboard).not.toHaveBeenCalled();
  });

  it('WATCH: deciding → same-id fingerprint change → после 500ms Enter не отправляет новое решение без фокуса', async () => {
    const { bridge, fake, island, blocked } = setup();
    let finish!: (value: { applied: boolean; state: 'allowed' }) => void;
    fake.setHandler('feed.decide', () => new Promise((resolve) => { finish = resolve; }));
    render(<IslandApp bridge={bridge} />);
    await flush();
    blocked('s-01');
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    takeRequest();
    act(() => screen.getByTestId('island-allow').focus());
    fireEvent.click(screen.getByTestId('island-allow'));
    await flush();
    expect(fake.calls.filter((call) => call.method === 'feed.decide')).toHaveLength(1);
    fake.setHandler('feed.snapshot', () => ({ items: [permission('c-1', 'new command')], revision: 2, mode: null, decisions: 'window' }));
    fireEvent.focus(window);
    await flush();
    expect(document.activeElement).toBe(screen.getByTestId('island-card'));
    expect((screen.getByTestId('island-allow') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const active = document.activeElement!;
    fireEvent.keyDown(active, { key: 'Enter' });
    if (active instanceof HTMLButtonElement && !active.disabled) fireEvent.click(active);
    await flush();
    expect(fake.calls.filter((call) => call.method === 'feed.decide')).toHaveLength(1);
    expect(vi.mocked(island.keyboard).mock.calls).toEqual([[true]]);
    await act(async () => { finish({ applied: true, state: 'allowed' }); });
  });
});

describe('перепроверка выбранного запроса T1a', () => {
  beforeEach(() => vi.useFakeTimers());
  const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

  it('новый pending не уводит уже сфокусированную карточку', async () => {
    const { bridge, blocked } = setup();
    render(<IslandApp bridge={bridge} />);
    await flush();
    blocked('s-01');
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    act(() => screen.getByTestId('island-allow').focus());
    blocked('s-02');
    await flush();
    expect(screen.queryByTitle('Run: rm -rf build')).not.toBeNull();
    expect(screen.getByText('1 of 2')).toBeTruthy();
  });

  it('раз в 1000ms замечает ответ извне, хотя та же сессия всё ещё ждёт другую карточку', async () => {
    const { fake, bridge, blocked } = setup();
    let cards = [permission('c-1', 'first'), permission('c-2', 'second')];
    fake.setHandler('feed.snapshot', () => ({ items: cards, revision: 1, mode: null, decisions: 'window' }));
    render(<IslandApp bridge={bridge} />);
    await flush();
    blocked('s-01');
    await flush();
    expect(screen.queryByTitle('Run: first')).not.toBeNull();
    cards = [cards[1]!];
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(screen.queryByTitle('Run: first')).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.queryByTitle('Run: first')).toBeNull();
    expect(screen.queryByTitle('Run: second')).not.toBeNull();
    expect(fake.calls.filter((call) => call.method === 'feed.decide')).toHaveLength(0);
  });

  it('возврат фокуса сразу перепроверяет payload same cardId', async () => {
    const { fake, bridge, blocked } = setup();
    render(<IslandApp bridge={bridge} />);
    await flush();
    blocked('s-01');
    await flush();
    fake.setHandler('feed.snapshot', () => ({ items: [permission('c-1', 'changed')], revision: 2, mode: null, decisions: 'window' }));
    fireEvent.focus(window);
    await flush();
    expect(screen.queryByTitle('Run: changed')).not.toBeNull();
  });

  it('collapse останавливает polling, повторное открытие сразу обновляет и disconnect снимает timer/focus', async () => {
    const { fake, bridge, blocked, hover, disconnect } = setup();
    render(<IslandApp bridge={bridge} />);
    await flush();
    blocked('s-01');
    await flush();
    tuck(hover);
    const snapshots = () => fake.calls.filter((call) => call.method === 'feed.snapshot').length;
    const collapsed = snapshots();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    fireEvent.focus(window);
    await flush();
    expect(snapshots()).toBe(collapsed);
    expand();
    await flush();
    expect(snapshots()).toBe(collapsed + 1);
    disconnect();
    const disconnected = snapshots();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    fireEvent.focus(window);
    await flush();
    expect(snapshots()).toBe(disconnected);
  });

  it('focus и timer делят один in-flight snapshot на ref; network error сохраняет карточку', async () => {
    const { fake, bridge, blocked } = setup();
    render(<IslandApp bridge={bridge} />);
    await flush();
    blocked('s-01');
    await flush();
    let reject!: (error: Error) => void;
    const snapshot = vi.fn(() => new Promise<never>((_resolve, fail) => { reject = fail; }));
    fake.setHandler('feed.snapshot', snapshot);
    fireEvent.focus(window);
    fireEvent.focus(window);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(snapshot).toHaveBeenCalledTimes(1);
    await act(async () => { reject(new Error('disconnected')); });
    expect(screen.queryByTitle('Run: rm -rf build')).not.toBeNull();
    expect(fake.calls.filter((call) => call.method === 'feed.decide')).toHaveLength(0);
  });

  it('snapshot выбранной карточки, завершившийся после collapse, не запускает фоновые retries', async () => {
    const { fake, bridge, blocked, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    await flush();
    blocked('s-01');
    await flush();
    let resolve!: (result: { items: FeedCard[]; revision: number; mode: null; decisions: 'window' }) => void;
    const snapshot = vi.fn(() => new Promise<{ items: FeedCard[]; revision: number; mode: null; decisions: 'window' }>((done) => { resolve = done; }));
    fake.setHandler('feed.snapshot', snapshot);
    fireEvent.focus(window);
    tuck(hover);
    await act(async () => { resolve({ items: [], revision: 2, mode: null, decisions: 'window' }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(snapshot).toHaveBeenCalledTimes(1);
  });
});

describe('PlanView — настоящая проводка острова', () => {
  const plan = (): FeedPlanCard => ({ kind: 'plan', id: 'p-1', cardId: 'p-1', state: 'pending', at: '', toolUseId: null, toolName: 'ExitPlanMode', toolInput: {}, plan: 'First step\nLast step', planFilePath: '/unread/plan.md' });
  const settle = async (): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
  async function mount(decisions: 'window' | 'terminal' = 'window') {
    const state = setup(); let current = plan();
    state.fake.setHandler('feed.snapshot', () => ({ items: [current], revision: 1, mode: null, decisions }));
    render(<IslandApp bridge={state.bridge} />); await settle(); state.blocked('s-01'); await settle();
    return { ...state, update: async (next: FeedPlanCard) => { current = next; act(() => useIslandRequests.getState().revalidate()); await settle(); } };
  }
  beforeEach(() => vi.useFakeTimers());

  it.each([['Approve, auto-accept edits', 'auto-accept'], ['Approve, approve each edit', 'manual']])('%s has exact %s payload, duplicate guard, retry and elsewhere state', async (label, choice) => {
    const state = await mount();
    let resolve!: (value: { applied: false; state: 'pending' }) => void;
    state.fake.setHandler('feed.decide', () => new Promise((done) => { resolve = done; }));
    const button = screen.getByRole('button', { name: label }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    fireEvent(button, pointer('pointerdown')); act(() => button.focus());
    fireEvent.click(button, { detail: 1 }); fireEvent.click(button, { detail: 1 });
    expect(state.island.keyboard).not.toHaveBeenCalled();
    expect(state.fake.calls.filter((call) => call.method === 'feed.decide')).toEqual([{ method: 'feed.decide', params: { ref: ref('s-01'), cardId: 'p-1', decision: { kind: 'plan', choice } } }]);
    await act(async () => resolve({ applied: false, state: 'pending' }));
    expect(button.disabled).toBe(false);
    expect(screen.getByText("Couldn't send — try again")).toBeTruthy();
    const allowed = fireEvent.keyDown(button, { key: 'Enter' }); fireEvent.keyUp(button, { key: 'Enter' });
    if (allowed && document.activeElement === button && !button.disabled) fireEvent.click(button, { detail: 0 });
    expect(state.fake.calls.filter((call) => call.method === 'feed.decide')).toHaveLength(1);
    state.fake.setHandler('feed.decide', () => ({ applied: false, state: 'answered' } as never));
    fireEvent.click(button); await settle();
    expect(screen.getByText('Answered elsewhere')).toBeTruthy(); expect(button.disabled).toBe(true);
  });

  it('terminal-only plan remains readable; Change plan is only navigation with no host mutation', async () => {
    const state = await mount('terminal');
    expect(screen.getByRole('region', { name: 'Plan' }).textContent).toBe(plan().plan);
    expect(screen.queryByRole('button', { name: 'Approve, auto-accept edits' })).toBeNull();
    const before = state.fake.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Change plan in terminal' }));
    expect(state.island.open).toHaveBeenCalledWith({ kind: 'session', ref: ref('s-01'), view: 'terminal' });
    expect(state.fake.calls.slice(before)).toEqual([]);
    expect(state.fake.notified).toEqual([]);
    expect(state.island.keyboard).not.toHaveBeenCalled();
  });

  it('same cardId/new plan text resets owned focus and arms again on a real snapshot', async () => {
    const state = await mount(); await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    act(() => screen.getByRole('region', { name: 'Plan' }).focus()); await settle();
    act(() => screen.getByRole('button', { name: 'Approve, auto-accept edits' }).focus());
    await state.update({ ...plan(), plan: 'Revised plan text' });
    expect(document.activeElement).toBe(screen.getByTestId('island-card'));
    const button = screen.getByRole('button', { name: 'Approve, auto-accept edits' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(state.fake.calls.filter((call) => call.method === 'feed.decide')).toEqual([]);
  });
});

describe('QuestionForm — настоящая проводка острова', () => {
  const card = (): FeedQuestionCard => ({
    id: 'q-1', cardId: 'q-1', at: '2026-10-12T10:00:00.000Z', kind: 'question', state: 'pending',
    toolUseId: null, toolName: 'AskUserQuestion', toolInput: {}, notified: false,
    questions: [
      { question: 'Which DB?', header: null, multiSelect: false, options: [{ label: 'Postgres', description: null }, { label: 'SQLite', description: null }] },
      { question: 'Which checks?', header: null, multiSelect: true, options: [{ label: 'Lint', description: null }, { label: 'Test', description: null }] },
      { question: 'Anything else?', header: null, multiSelect: false, options: [] },
    ],
  });
  const settle = async (): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
  const next = (): void => { fireEvent.click(screen.getByRole('button', { name: 'Next' })); };
  const other = (): HTMLInputElement => screen.getByRole('textbox', { name: 'Your answer' });
  const submit = (): HTMLButtonElement => screen.getByRole('button', { name: 'Submit' });
  const fill = (): void => {
    fireEvent.click(screen.getByRole('radio', { name: 'Postgres' })); next();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lint' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Test' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Other' }));
    fireEvent.change(other(), { target: { value: '  Extra check  ' } }); next();
    fireEvent.click(screen.getByRole('radio', { name: 'Other' }));
    fireEvent.change(other(), { target: { value: '  Custom answer  ' } });
  };
  async function mount(decisions: 'window' | 'terminal' = 'window', config: Partial<IslandConfig> = {}) {
    const state = setup({ assistant: ASSISTANT_ON, ...config });
    let current: FeedQuestionCard | null = card();
    state.fake.setHandler('feed.snapshot', ({ ref: target }) => ({ items: target.sessionId === 's-01' ? current === null ? [] : [current] : CARDS[target.sessionId] ?? [], revision: 1, mode: null, decisions }));
    const root = render(<IslandApp bridge={state.bridge} />);
    await settle(); state.blocked('s-01'); await settle();
    return { ...state, root, update: async (value: FeedQuestionCard | null) => { current = value; act(() => useIslandRequests.getState().revalidate()); await settle(); } };
  }
  beforeEach(() => vi.useFakeTimers());

  it('single/multi/Other serialize exactly once; typing, IME and navigation do not decide', async () => {
    const { fake, island } = await mount();
    fake.setHandler('feed.decide', () => ({ applied: false, state: 'pending' }));
    fill();
    act(() => other().focus());
    fireEvent.compositionStart(other());
    fireEvent.keyDown(other(), { key: 'Enter', isComposing: true });
    fireEvent.compositionEnd(other());
    fireEvent.keyDown(other(), { key: 'Enter' });
    fireEvent.keyUp(other(), { key: 'Enter' });
    expect(fake.calls.filter((call) => call.method === 'feed.decide')).toEqual([]);
    expect(island.keyboard).toHaveBeenCalledWith(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    fireEvent.click(submit()); await settle();
    expect(fake.calls.filter((call) => call.method === 'feed.decide')).toEqual([{ method: 'feed.decide', params: {
      ref: ref('s-01'), cardId: 'q-1', decision: { kind: 'question', answers: { 'Which DB?': 'Postgres', 'Which checks?': 'Lint, Test, Extra check', 'Anything else?': 'Custom answer' } },
    } }]);
    expect(other().value).toBe('  Custom answer  ');
  });

  it('Escape in the Other answer field releases request keyboard without submitting', async () => {
    const { fake, island } = await mount();
    fill();
    act(() => other().focus());
    expect(island.keyboard).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(other(), { key: 'Escape' });
    expect(island.keyboard).toHaveBeenLastCalledWith(false);
    expect(fake.calls.some((call) => call.method === 'feed.decide')).toBe(false);
  });

  it('mouse focus starts keyboard navigation from the currently shown feed item', async () => {
    await mount();
    fill();
    act(() => other().focus());
    expect(screen.getByTestId('island').getAttribute('data-navigation-key')).toMatch(/^feed:/);
  });

  it.each(['collapse', 'assistant', 'consent'])('%s preserves choices/Other/page while rearming on reopen', async (mode) => {
    const state = await mount(); fill(); act(() => other().focus());
    if (mode === 'collapse') { tuck(state.hover); expand(); }
    if (mode === 'assistant') { state.assistantOpen({ listen: false }); state.assistantBlur(); }
    if (mode === 'consent') {
      act(() => useConsentsStore.getState().replace([{ id: 'retain', kind: 'folder-trust', folder: PROJECT, projectPath: PROJECT, requestedBy: { source: 'agent', sessionId: 's-01', label: 'S01' }, at: '', state: 'pending' }]));
      act(() => useConsentsStore.getState().replace([]));
    }
    expect(screen.getByText('Question 3 of 3')).toBeTruthy();
    expect(other().value).toBe('  Custom answer  ');
    expect(submit().disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(499); });
    expect(submit().disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(submit().disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect((screen.getByRole('checkbox', { name: 'Lint' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Test' }) as HTMLInputElement).checked).toBe(true);
    expect(other().value).toBe('  Extra check  ');
  });

  it('new pending preserves the active draft; A -> B -> A really clears it', async () => {
    const { blocked } = await mount(); fill(); act(() => other().focus());
    blocked('s-02'); await settle();
    expect(other().value).toBe('  Custom answer  ');
    fireEvent.click(screen.getByRole('button', { name: 'Next request' }));
    expect(screen.getByTestId('island-allow')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous request' }));
    expect(screen.getByText('Question 1 of 3')).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'Postgres' }) as HTMLInputElement).checked).toBe(false);
  });

  it('new room proposal preserves the question draft, page, selection and keyboard owner', async () => {
    const state = await mount('window', { islandSound: SOUND_ON }); fill(); act(() => other().focus());
    const selected = useIslandRequests.getState().selectedKey;
    const input = other();
    await waitCooldown();
    vi.mocked(islandSound.play).mockClear(); vi.mocked(state.island.keyboard).mockClear();
    act(() => state.fake.emit('works.changed', { entries: [proposalWork()], branches: {} })); await settle();
    expect(useIslandRequests.getState().selectedKey).toBe(selected);
    expect(useIslandRequests.getState().items).toHaveLength(1);
    expect(screen.getByText('Question 3 of 3')).toBeTruthy();
    expect(other()).toBe(input);
    expect(other().value).toBe('  Custom answer  ');
    expect(document.activeElement).toBe(input);
    expect(state.island.keyboard).not.toHaveBeenCalled();
    expect(played()).toEqual(['question']);
    expect(document.body.textContent).not.toContain('SECRET');
    fireEvent.click(screen.getByRole('button', { name: 'Open room' }));
    expect(state.island.open).toHaveBeenCalledWith({ kind: 'room', projectPath: PROJECT, workId: 'w-1', roomId: 'r-1' });
    expect(state.fake.calls.filter((call) => /resolveProposal|resumeAutonomous|feed.decide/.test(call.method))).toEqual([]);
    expect(other().value).toBe('  Custom answer  ');
  });

  it.each(['blur', 'retract', 'blur and retract'])('new pending after %s preserves selected question, draft and page; still expands and sounds', async (mode) => {
    const state = await mount('window', { islandSound: SOUND_ON }); fill(); act(() => other().focus());
    const selected = useIslandRequests.getState().selectedKey;
    await waitCooldown();
    vi.mocked(islandSound.play).mockClear();
    if (mode.includes('blur')) state.assistantBlur();
    if (mode.includes('retract')) tuck(state.hover);
    expect(document.activeElement).not.toBe(screen.queryByRole('textbox'));
    vi.mocked(state.island.keyboard).mockClear();
    state.blocked('s-02'); await settle();
    expect(useIslandRequests.getState().selectedKey).toBe(selected);
    expect(useIslandRequests.getState().items).toHaveLength(2);
    expect(isRetracted()).toBe(false);
    expect(screen.getByText(/^[12] of 2$/)).toBeTruthy();
    expect(screen.getByText('Question 3 of 3')).toBeTruthy();
    expect(other().value).toBe('  Custom answer  ');
    expect(played()).toEqual(['permission']);
    expect(state.island.keyboard).not.toHaveBeenCalled();
  });

  it('an empty selected pending question also stays selected; removing it selects the remaining request', async () => {
    const state = await mount('window', { islandSound: SOUND_ON });
    const selected = useIslandRequests.getState().selectedKey;
    tuck(state.hover);
    await waitCooldown();
    vi.mocked(state.island.keyboard).mockClear(); vi.mocked(islandSound.play).mockClear();
    state.blocked('s-02'); await settle();
    expect(useIslandRequests.getState().selectedKey).toBe(selected);
    expect(screen.getByText('Question 1 of 3')).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'Postgres' }) as HTMLInputElement).checked).toBe(false);
    expect(useIslandRequests.getState().items).toHaveLength(2);
    expect(state.island.keyboard).not.toHaveBeenCalled();
    expect(played()).toEqual(['permission']);
    await state.update(null);
    expect(useIslandRequests.getState().selectedKey).not.toBe(selected);
    expect(screen.getByTestId('island-allow')).toBeTruthy();
  });

  it.each(['card', 'questions', 'ref', 'resolved', 'disconnect'])('%s change resets the retained draft and page', async (mode) => {
    const state = await mount(); fill();
    if (mode === 'card') await state.update({ ...card(), id: 'q-2', cardId: 'q-2' });
    if (mode === 'questions') await state.update({ ...card(), questions: card().questions.map((question, at) => at === 0 ? { ...question, header: 'Changed' } : question) });
    if (mode === 'ref') {
      const changed = { ...ref('s-01'), projectPath: '/other' };
      act(() => {
        useWorksStore.setState({ entries: ENTRIES.map((entry) => ({ ...entry, projectPath: changed.projectPath })) });
        useActivityStore.setState({ byRef: { [refKey(changed)]: makeActivity(changed, 'blocked') } });
      });
      await settle();
    }
    if (mode === 'resolved') { await state.update(null); await state.update(card()); state.blocked('s-01'); await settle(); }
    if (mode === 'disconnect') {
      state.fake.setActivitySnapshot([makeActivity(ref('s-01'), 'blocked')]);
      state.disconnect(); state.reconnect(); await settle();
    }
    expect(screen.getByText('Question 1 of 3')).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'Postgres' }) as HTMLInputElement).checked).toBe(false);
  });

  it('terminal-only shows question text and a terminal target without a local decision', async () => {
    const { island, fake } = await mount('terminal');
    expect(screen.getByText('Which DB?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
    fireEvent.click(screen.getByTestId('island-open'));
    expect(island.open).toHaveBeenCalledWith({ kind: 'session', ref: ref('s-01') });
    expect(fake.calls.filter((call) => call.method === 'feed.decide')).toEqual([]);
  });

  it('failed decide retains draft and the store blocks duplicate send', async () => {
    const { fake } = await mount(); fill();
    let resolve!: (result: { applied: false; state: 'pending' }) => void;
    fake.setHandler('feed.decide', () => new Promise((done) => { resolve = done; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    fireEvent.click(submit()); fireEvent.click(submit());
    expect(fake.calls.filter((call) => call.method === 'feed.decide')).toHaveLength(1);
    await act(async () => resolve({ applied: false, state: 'pending' }));
    expect(other().value).toBe('  Custom answer  ');
    expect(submit().disabled).toBe(false);
  });

  it.each(['elsewhere', 'not_found'])('%s clears the form without reopening a settled question', async (mode) => {
    const { fake } = await mount(); fill();
    fake.setHandler('feed.decide', () => {
      if (mode === 'not_found') throw encodeIpcError({ code: 'not_found', message: 'gone' });
      return { applied: false, state: 'answered' } as never;
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    fireEvent.click(submit()); await settle();
    expect(screen.getByText('Answered elsewhere')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('Done на острове', () => {
  /** Момент подключения; конец хода не раньше него — свежий, раньше — остров застал его уже готовым. */
  const CONNECTED_AT = new Date('2026-10-13T10:00:00.000Z');
  const FRESH = '2026-10-13T10:00:05.000Z';
  const FRESHER = '2026-10-13T10:00:10.000Z';
  const STALE = '2026-10-13T09:59:00.000Z';

  /** Сессия s-01 закончила ход в `endedAt`: ждёт, пока на неё посмотрят в Parley. */
  function seedDone(endedAt: string, entries = ENTRIES): void {
    useWorksStore.setState({ entries, branches: {}, loading: false, error: null });
    useActivityStore.setState({ byRef: { [refKey(ref('s-01'))]: makeActivity(ref('s-01'), 'unseen', { turnEndedAt: endedAt }) }, loaded: true });
  }
  /** Сессию s-01 посмотрели в Parley: хост перевёл её в idle, конец хода остался прежним. */
  function seedSeen(endedAt: string): void {
    useActivityStore.setState({ byRef: { [refKey(ref('s-01'))]: makeActivity(ref('s-01'), 'idle', { turnEndedAt: endedAt }) }, loaded: true });
  }
  const advance = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(CONNECTED_AT);
  });

  it('новый конец хода выдвигает убранный остров: в пилюле «✅ 1 done», язычка нет', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expect(isRetracted()).toBe(true);
    act(() => seedDone(FRESH));
    expect(isRetracted()).toBe(false);
    expect(screen.queryByTestId('island-tab')).toBeNull();
    expect(screen.getByTestId('island-counters').textContent).toBe('✅ 1 done');
  });

  it.each(['claude', 'codex'])('exact visible %s Done stays quiet, keeps badge, sends no seen and is consumed before blur', async (provider) => {
    const entries = [makeWork('w-1', { projectPath: PROJECT, sessions: [makeSession('s-01', 'a', { provider })] })];
    const { bridge, island, blocked, hover } = setup({ islandSound: SOUND_ON }, entries);
    vi.mocked(island.visibility).mockResolvedValue({ version: 1, refs: [ref('s-01')] });
    render(<IslandApp bridge={bridge} />);
    await act(async () => {});
    act(() => seedDone(FRESH, entries));
    expect(isRetracted()).toBe(true);
    expect(screen.getByTestId('island-tab').textContent).toContain('1');
    expect(island.markSeen).not.toHaveBeenCalled();
    expect(played()).toEqual([]);
    act(() => vi.mocked(island.onVisibility).mock.calls.at(-1)![0]({ version: 2, refs: [] }));
    expect(isRetracted()).toBe(true);
    act(() => seedDone(FRESHER, entries));
    expect(isRetracted()).toBe(false);
    tuck(hover);
    act(() => vi.mocked(island.onVisibility).mock.calls.at(-1)![0]({ version: 3, refs: [ref('s-01')] }));
    blocked('s-01');
    await act(async () => {});
    expect(isRetracted()).toBe(false);
  });

  it('quiet Codex Done never suppresses consent or its terminal-request presentation', async () => {
    const entries = [makeWork('w-1', { projectPath: PROJECT, sessions: [makeSession('s-01', 'a', { provider: 'codex' })] })];
    const { bridge, island, blocked, fake, hover } = setup({}, entries);
    fake.setHandler('feed.snapshot', () => ({ items: [], revision: 1, mode: null, decisions: 'terminal' }));
    vi.mocked(island.visibility).mockResolvedValue({ version: 1, refs: [ref('s-01')] });
    const onPresentation = vi.fn();
    render(<IslandApp bridge={bridge} onPresentation={onPresentation} />);
    await act(async () => {});
    act(() => seedDone(FRESH, entries));
    expect(isRetracted()).toBe(true);
    act(() => useConsentsStore.getState().replace([{
      id: 'quiet-consent', kind: 'folder-trust', folder: PROJECT, projectPath: PROJECT,
      requestedBy: { source: 'agent', sessionId: 's-01', label: 'S01 a' }, at: FRESH, state: 'pending',
    }]));
    expect(isRetracted()).toBe(false);
    expect(onPresentation).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'consent', expand: true, soundEligible: true }));
    act(() => useConsentsStore.getState().replace([]));
    tuck(hover);
    blocked('s-01');
    await act(async () => {});
    expect(isRetracted()).toBe(false);
    expect(onPresentation).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'terminal-request', expand: true, soundEligible: true }));
    expect(island.markSeen).not.toHaveBeenCalled();
  });

  it('a same-id ref in another worktree never suppresses Done', async () => {
    const { bridge, island } = setup();
    vi.mocked(island.visibility).mockResolvedValue({ version: 1, refs: [{ ...ref('s-01'), projectPath: '/another-worktree' }] });
    render(<IslandApp bridge={bridge} />);
    await act(async () => {});
    act(() => seedDone(FRESH));
    expect(isRetracted()).toBe(false);
  });

  it.each([{ version: 1, refs: [] }, { version: NaN, refs: [] }, null])('event before getter wins over %j; stale versions cannot overwrite it and malformed events fall back', async (getterReply) => {
    const { bridge, island } = setup();
    let resolve!: (value: { version: number; refs: ReturnType<typeof ref>[] }) => void;
    vi.mocked(island.visibility).mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<IslandApp bridge={bridge} />);
    expect(vi.mocked(island.onVisibility).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(island.visibility).mock.invocationCallOrder[0]!);
    const publish = vi.mocked(island.onVisibility).mock.calls[0]![0];
    act(() => publish({ version: 9, refs: [ref('s-01')] }));
    await act(async () => resolve(getterReply as never));
    act(() => publish({ version: 8, refs: [] }));
    act(() => seedDone(FRESH));
    expect(isRetracted()).toBe(true);
    act(() => publish({ version: NaN, refs: [ref('s-01')] }));
    act(() => seedDone(FRESHER));
    expect(isRetracted()).toBe(false);
  });

  it('quiet Done neither closes an open island nor rearms its existing hold timer; outcome preserves r-05 seam', async () => {
    const { bridge, island, hover } = setup();
    const onPresentation = vi.fn();
    render(<IslandApp bridge={bridge} onPresentation={onPresentation} />);
    await act(async () => {});
    act(() => seedDone(FRESH));
    expect(onPresentation).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'done', fresh: true, expand: true, soundEligible: false }));
    advance(DONE_HOLD_MS / 2);
    act(() => vi.mocked(island.onVisibility).mock.calls.at(-1)![0]({ version: 1, refs: [ref('s-01')] }));
    act(() => seedDone(FRESHER));
    expect(isRetracted()).toBe(false);
    expect(onPresentation).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'done', fresh: true, expand: false, soundEligible: false }));
    advance(DONE_HOLD_MS / 2);
    expect(isRetracted()).toBe(true);
    hover(false);
  });

  it('выдвигает без звука, если включён только «Sound when you’re needed»', async () => {
    const { bridge } = setup({ islandSound: SOUND_ON });
    render(<IslandApp bridge={bridge} />);
    await act(async () => {
      await Promise.resolve();
    });
    act(() => seedDone(FRESH));
    expect(isRetracted()).toBe(false);
    expect(played()).toEqual([]);
  });

  it('S2: с «Sound when an agent finishes» выдвинутый Done звучит done один раз', async () => {
    const { bridge } = setup({ islandSound: { ...SOUND_OFF, finished: true } });
    render(<IslandApp bridge={bridge} />);
    await act(async () => {
      await Promise.resolve();
    });
    act(() => seedDone(FRESH));
    expect(isRetracted()).toBe(false);
    expect(played()).toEqual(['done']);
    act(() => seedDone(FRESH));
    expect(played()).toEqual(['done']);
  });

  it('S2: тихий Done (сессия видна в окне) молчит и с «Sound when an agent finishes», остров не выдвигает', async () => {
    const { bridge, island } = setup({ islandSound: { ...SOUND_OFF, finished: true } });
    vi.mocked(island.visibility).mockResolvedValue({ version: 1, refs: [ref('s-01')] });
    render(<IslandApp bridge={bridge} />);
    await act(async () => {});
    act(() => seedDone(FRESH));
    expect(isRetracted()).toBe(true);
    expect(played()).toEqual([]);
  });

  it('Done застали готовым (конец хода до подключения) — остров не выдвигается, убранный выглядывает «✅ 1», в список строка попадает', () => {
    seedDone(STALE);
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    expect(isRetracted()).toBe(true);
    // Текст `✅ 1` и вид выглядывающего острова — у самой формы: маленькая чёрная форма со скруглением снизу и светлой
    // обводкой, без тени и без зелёной полоски.
    const peek = screen.getByTestId('island');
    expect(peek.textContent).toBe('✅ 1');
    expect(peek.className).toContain('bg-black');
    expect(peek.className).toContain('rounded-b-[14px]');
    expect(peek.className).toContain('ring-1');
    expect(peek.className).toContain('ring-white/50');
    expect(peek.className).not.toContain('shadow-lg');
    expect(peek.className).not.toContain('bg-[var(--state-done)]');
    // `island-tab` — прозрачная зона с подписью: видимого текста нет, невидимый тот же текст задаёт её размер.
    const tab = screen.getByTestId('island-tab');
    expect(tab.getAttribute('aria-label')).toBe('Agents finished — show the island');
    expect(tab.title).toBe('Agents finished — show the island');
    const sizer = tab.firstElementChild as HTMLElement;
    expect(sizer.textContent).toBe('✅ 1');
    expect(sizer.className).toContain('opacity-0');
    for (const name of ['whitespace-nowrap', 'px-3', 'py-1', 'text-sm']) expect(sizer.className).toContain(name);
    // Размер кнопки — размер формы: невидимой области 64×16 у выглядывающего острова нет.
    expect(tab.className).not.toContain('w-16');
    expect(tab.className).not.toContain('h-4');
    expand();
    hover(true);
    expect(screen.getByTestId('island-done')).toBeTruthy();
  });

  it('два непросмотренных Done — «✅ 2»; клик по выглядывающему острову выдвигает его', () => {
    useWorksStore.setState({ entries: ENTRIES, branches: {}, loading: false, error: null });
    useActivityStore.setState({
      byRef: {
        [refKey(ref('s-01'))]: makeActivity(ref('s-01'), 'unseen', { turnEndedAt: STALE }),
        [refKey(ref('s-02'))]: makeActivity(ref('s-02'), 'unseen', { turnEndedAt: STALE }),
      },
      loaded: true,
    });
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expect(isRetracted()).toBe(true);
    expect(screen.getByTestId('island').textContent).toBe('✅ 2');
    expect((screen.getByTestId('island-tab').firstElementChild as HTMLElement).textContent).toBe('✅ 2');
    expand();
    expect(isRetracted()).toBe(false);
    expect(screen.queryByTestId('island-tab')).toBeNull();
  });

  it('зона выглядывающего «✅ N»: потяжка вниз дальше 8 px тоже выдвигает остров', () => {
    seedDone(STALE);
    const { island, bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    const tab = screen.getByTestId('island-tab');
    fireEvent(tab, pointer('pointerdown', 100, 10));
    fireEvent(tab, pointer('pointermove', 100, 10 + PULL_EXPAND_PX));
    expect(isRetracted()).toBe(true);
    fireEvent(tab, pointer('pointermove', 100, 10 + PULL_EXPAND_PX + 1));
    expect(isRetracted()).toBe(false);
    expect(screen.queryByTestId('island-tab')).toBeNull();
    expect(island.dragStart).not.toHaveBeenCalled();
  });

  it('конец хода раньше подключения, но пришедший после, тоже не выдвигает', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(STALE));
    expect(isRetracted()).toBe(true);
    expect(screen.getByTestId('island-tab').getAttribute('aria-label')).toBe('Agents finished — show the island');
    expect(screen.getByTestId('island').textContent).toBe('✅ 1');
  });

  it('с Done остров убирается через DONE_HOLD_MS, а не через IDLE_RETRACT_MS', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(FRESH));
    advance(IDLE_RETRACT_MS * 2);
    expect(isRetracted()).toBe(false);
    advance(DONE_HOLD_MS - IDLE_RETRACT_MS * 2 - 1);
    expect(isRetracted()).toBe(false);
    advance(1);
    expect(isRetracted()).toBe(true);
    const tab = screen.getByTestId('island-tab');
    expect(tab.getAttribute('aria-label')).toBe('Agents finished — show the island');
    expect(screen.getByTestId('island').textContent).toBe('✅ 1');
  });

  it('новый конец хода при выдвинутом острове заводит удержание заново', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(FRESH));
    advance(DONE_HOLD_MS - 5000);
    act(() => seedDone(FRESHER));
    advance(DONE_HOLD_MS - 1);
    expect(isRetracted()).toBe(false);
    advance(1);
    expect(isRetracted()).toBe(true);
  });

  it('Clear прячет строки Done, пилюля снова «No agents running», язычок обычный; тот же конец хода не возвращается, новый — да', () => {
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(FRESH));
    hover(true);
    fireEvent.click(screen.getByTestId('island-clear'));
    expect(screen.queryByTestId('island-done')).toBeNull();
    expect(screen.queryByTestId('island-clear')).toBeNull();
    expect(screen.getByTestId('island-idle').textContent).toBe('No agents running');
    // Done нет — покой обычный, 4 с.
    hover(false);
    advance(IDLE_RETRACT_MS);
    expect(isRetracted()).toBe(true);
    const tab = screen.getByTestId('island-tab');
    expect(tab.getAttribute('aria-label')).toBe('Show the island');
    expect(tab.textContent).toBe('');
    expect(screen.getByTestId('island').textContent).toBe('');
    expect(screen.getByTestId('island').className).toContain('rounded-[3px]');
    // Хост прислал ту же активность заново — тот же ключ, строка скрыта.
    act(() => seedDone(FRESH));
    expect(isRetracted()).toBe(true);
    expect(screen.getByTestId('island-tab').getAttribute('aria-label')).toBe('Show the island');
    // Новый конец хода — новый ключ: остров выдвигается.
    act(() => seedDone(FRESHER));
    expect(isRetracted()).toBe(false);
    expect(screen.getByTestId('island-counters').textContent).toBe('✅ 1 done');
  });

  it('Clear отмечает просмотренными сессии непросмотренных Done-строк: markSeen с их ref', () => {
    const { island, bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(FRESH));
    hover(true);
    expect(island.markSeen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('island-clear'));
    expect(island.markSeen).toHaveBeenCalledTimes(1);
    expect(island.markSeen).toHaveBeenCalledWith([ref('s-01')]);
    expect(screen.queryByTestId('island-done')).toBeNull();
  });

  it('Clear не шлёт удержанные просмотренные строки: в markSeen только ref непросмотренных', () => {
    const { island, bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    const activity = (state: 'unseen' | 'idle', sessionId: string) => [refKey(ref(sessionId)), makeActivity(ref(sessionId), state, { turnEndedAt: FRESH })] as const;
    const seed = (first: 'unseen' | 'idle', second: 'unseen' | 'idle'): void => {
      act(() => {
        useWorksStore.setState({ entries: ENTRIES, branches: {}, loading: false, error: null });
        useActivityStore.setState({ byRef: Object.fromEntries([activity(first, 's-01'), activity(second, 's-02')]), loaded: true });
      });
    };
    seed('unseen', 'unseen');
    hover(true);
    // s-01 посмотрели в Parley: её строка удержана (`seen` истинно), s-02 всё ещё ждёт.
    seed('idle', 'unseen');
    expect(screen.getAllByTestId('island-done')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('island-clear'));
    expect(island.markSeen).toHaveBeenCalledTimes(1);
    expect(island.markSeen).toHaveBeenCalledWith([ref('s-02')]);
    expect(screen.queryByTestId('island-done')).toBeNull();
  });

  it('Clear при одних удержанных просмотренных строках прячет их, а markSeen не зовёт', () => {
    const { island, bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(FRESH));
    act(() => seedSeen(FRESH));
    hover(true);
    expect(screen.getByTestId('island-done')).toBeTruthy();
    fireEvent.click(screen.getByTestId('island-clear'));
    expect(screen.queryByTestId('island-done')).toBeNull();
    expect(island.markSeen).not.toHaveBeenCalled();
  });

  it('активность сессии пропала (конца хода нет) — строка уходит сама', () => {
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(FRESH));
    hover(true);
    expect(screen.getByTestId('island-done')).toBeTruthy();
    act(seedIdle);
    expect(screen.queryByTestId('island-done')).toBeNull();
    expect(screen.getByTestId('island-idle').textContent).toBe('No agents running');
  });

  it('показанную строку не убирает отметка «просмотрено» (idle, тот же конец хода): остаётся, пока курсор не ушёл с острова', () => {
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(FRESH));
    expect(screen.getByTestId('island-counters').textContent).toBe('✅ 1 done');
    act(() => seedSeen(FRESH));
    expect(screen.getByTestId('island-counters').textContent).toBe('✅ 1 done');
    hover(true);
    expect(screen.getByTestId('island-done')).toBeTruthy();
    hover(false);
    expect(screen.queryByTestId('island-done')).toBeNull();
    expect(screen.getByTestId('island-idle').textContent).toBe('No agents running');
  });

  it('удержанная строка не сокращает показ: остров убирается через DONE_HOLD_MS, а строка уходит, когда форма сжалась', () => {
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(FRESH));
    act(() => seedSeen(FRESH));
    advance(IDLE_RETRACT_MS * 2);
    expect(isRetracted()).toBe(false);
    advance(DONE_HOLD_MS - IDLE_RETRACT_MS * 2);
    expect(isRetracted()).toBe(true);
    // Содержимое убранной формы меняется сразу: у неё числа нет (просмотренная строка не считается), это обычный брусок.
    advance(RETRACT_MORPH_MS - 1);
    expect(screen.queryByTestId('island-counters')).toBeNull();
    const tab = screen.getByTestId('island-tab');
    expect(tab.getAttribute('aria-label')).toBe('Show the island');
    expect(tab.textContent).toBe('');
    expect(screen.getByTestId('island').textContent).toBe('');
    expect(screen.getByTestId('island').className).toContain('rounded-[3px]');
    advance(1);
    expect(screen.getByTestId('island').textContent).toBe('');
    expand();
    expect(screen.getByTestId('island-idle').textContent).toBe('No agents running');
    hover(true);
    expect(screen.queryByTestId('island-done')).toBeNull();
  });

  it('стрелка тоже кончает показ: удержанная строка после неё не возвращается', () => {
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(FRESH));
    act(() => seedSeen(FRESH));
    tuck(hover);
    expect(isRetracted()).toBe(true);
    expect(screen.getByTestId('island-tab').getAttribute('aria-label')).toBe('Show the island');
    advance(RETRACT_MORPH_MS);
    expand();
    hover(true);
    expect(screen.queryByTestId('island-done')).toBeNull();
  });

  it('выдвинули язычком раньше RETRACT_MORPH_MS — показ всё равно кончился: просмотренной строки нет', () => {
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(FRESH));
    act(() => seedSeen(FRESH));
    tuck(hover);
    advance(RETRACT_MORPH_MS - 1);
    expect(screen.queryByTestId('island-counters')).toBeNull();
    expand();
    hover(true);
    expect(screen.queryByTestId('island-done')).toBeNull();
    expect(screen.getByTestId('island-idle').textContent).toBe('No agents running');
  });

  it('число в «✅ N» — только непросмотренные: просмотренная удержанная строка не считается, пока форма сжимается и после', () => {
    useWorksStore.setState({ entries: ENTRIES, branches: {}, loading: false, error: null });
    const both = (first: 'unseen' | 'idle'): void => {
      useActivityStore.setState({
        byRef: {
          [refKey(ref('s-01'))]: makeActivity(ref('s-01'), first, { turnEndedAt: FRESH }),
          [refKey(ref('s-02'))]: makeActivity(ref('s-02'), 'unseen', { turnEndedAt: FRESH }),
        },
        loaded: true,
      });
    };
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => both('unseen'));
    expect(isRetracted()).toBe(false);
    // s-01 посмотрели: пилюля держит обе строки.
    act(() => both('idle'));
    expect(screen.getByTestId('island-counters').textContent).toBe('✅ 2 done');
    tuck(hover);
    expect(screen.getByTestId('island').textContent).toBe('✅ 1');
    expect(screen.queryByTestId('island-counters')).toBeNull();
    advance(RETRACT_MORPH_MS);
    expect(screen.getByTestId('island').textContent).toBe('✅ 1');
    // Выдвинули: просмотренная удержанная строка s-01 уже ушла, осталась непросмотренная.
    expand();
    expect(screen.getByTestId('island-counters').textContent).toBe('✅ 1 done');
  });

  it('unseen после ухода курсора остаётся: уходят только просмотренные', () => {
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(FRESH));
    hover(true);
    hover(false);
    expect(screen.getByTestId('island-counters').textContent).toBe('✅ 1 done');
    hover(true);
    expect(screen.getByTestId('island-done')).toBeTruthy();
  });

  it('Done, что убранный остров застал готовым, не удерживается: просмотрели до выдвижения — после него строки нет', () => {
    seedDone(STALE);
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    expect(isRetracted()).toBe(true);
    act(() => seedSeen(STALE));
    expand();
    hover(true);
    expect(screen.queryByTestId('island-done')).toBeNull();
    expect(screen.getByTestId('island-idle').textContent).toBe('No agents running');
  });

  it('сессия заработала снова — удержание не нужно: строка в работе, потом новый конец хода — новая Done', () => {
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(FRESH));
    act(() => seedSeen(FRESH));
    act(seedWorking);
    expect(screen.getByTestId('island-pill').textContent).toContain('1 working');
    expect(screen.getByTestId('island-pill').textContent).not.toContain('done');
    act(() => seedDone(FRESHER));
    hover(true);
    expect(screen.getByTestId('island-done')).toBeTruthy();
    expect(screen.getByTestId('island-counters').textContent).toBe('✅ 1 done');
  });
});

describe('согласия на папку', () => {
  const CONSENT: ConsentCard = {
    id: 'c-01', kind: 'folder-trust', folder: '/tmp/proj', projectPath: '/tmp/proj',
    requestedBy: { source: 'agent', sessionId: 's-01', label: 'S01 a' }, at: '2026-10-21T10:00:00.000Z', state: 'pending',
  };
  const SECOND: ConsentCard = { ...CONSENT, id: 'c-02', folder: '/tmp/other', projectPath: '/tmp/other' };

  it.each(['island-consent-trust', 'island-consent-deny'])('consent mouse pointerdown/focus/click по %s не берёт OS keyboard', async (id) => {
    vi.useFakeTimers();
    const { bridge, fake, island } = setup({}, ENTRIES, [CONSENT]);
    fake.setHandler('consents.decide', () => ({ applied: true, state: 'allowed' }));
    render(<IslandApp bridge={bridge} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const button = screen.getByTestId(id);
    fireEvent(button, pointer('pointerdown'));
    act(() => button.focus());
    fireEvent.click(button, { detail: 1 });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fake.calls.filter((call) => call.method === 'consents.decide')).toHaveLength(1);
    expect(island.keyboard).not.toHaveBeenCalled();
  });

  it.each(['Escape', 'blur', 'collapse', 'disconnect'])('consent явный request owner и release по %s без решения', async (reason) => {
    vi.useFakeTimers();
    const { bridge, fake, island, hover, disconnect, assistantBlur } = setup({}, ENTRIES, [CONSENT]);
    render(<IslandApp bridge={bridge} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(island.keyboard).not.toHaveBeenCalled();
    fireEvent(screen.getByTestId('island-card'), pointer('pointerdown'));
    expect(island.keyboard).toHaveBeenLastCalledWith(true);
    if (reason === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
    if (reason === 'blur') assistantBlur();
    if (reason === 'collapse') tuck(hover);
    if (reason === 'disconnect') disconnect();
    expect(vi.mocked(island.keyboard).mock.calls).toEqual([[true], [false]]);
    expect(fake.calls.filter((call) => call.method === 'consents.decide')).toHaveLength(0);
  });

  it('Ctrl+Enter on a focused consent button is prevented and makes no host call, even without requester ids', async () => {
    vi.useFakeTimers();
    const consent: ConsentCard = { ...CONSENT, requestedBy: { source: 'launch' } };
    const { bridge, fake } = setup({}, ENTRIES, [consent]);
    render(<IslandApp bridge={bridge} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => pendingNavigationHandler?.());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const trust = screen.getByTestId('island-consent-trust');
    trust.focus();
    const callsBefore = fake.calls.length;
    expect(fireEvent.keyDown(trust, { key: 'Enter', ctrlKey: true })).toBe(false);
    expect(fake.calls).toHaveLength(callsBefore);
    expect(fake.calls.some((call) => call.method === 'consents.decide')).toBe(false);
  });

  it('keyboard navigation can reveal and refresh a feed item behind consent', async () => {
    const { bridge, fake, blocked } = setup({}, ENTRIES, [CONSENT]);
    render(<IslandApp bridge={bridge} />);
    await screen.findByTestId('island-consent-trust');
    blocked('s-01');
    await waitFor(() => expect(fake.calls.some((call) => call.method === 'feed.snapshot')).toBe(true));
    const snapshotsBeforeNavigation = fake.calls.filter((call) => call.method === 'feed.snapshot').length;
    act(() => pendingNavigationHandler?.());
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByTestId('island').getAttribute('data-navigation-key')).toMatch(/^feed:/));
    await waitFor(() => expect(screen.getByTestId('island-card')).toBeTruthy());
    await waitFor(() => expect(fake.calls.filter((call) => call.method === 'feed.snapshot').length).toBeGreaterThan(snapshotsBeforeNavigation));
  });


  it('начальный consents.list: карточка видна, остров выдвинут', async () => {
    const { fake, bridge } = setup({}, ENTRIES, [CONSENT]);
    render(<IslandApp bridge={bridge} />);
    expect(await screen.findByTestId('island-consent-trust')).toBeTruthy();
    expect(fake.calls.some((call) => call.method === 'consents.list')).toBe(true);
    expect(screen.getByTestId('island-consent-folder').textContent).toBe('/tmp/proj');
    await waitFor(() => expect(isRetracted()).toBe(false));
  });

  it('consents.changed: upsert показывает карточку, removed убирает', async () => {
    const { fake, bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('island-consent-trust')).toBeNull();
    act(() => fake.emit('consents.changed', { upsert: [CONSENT], removed: [] }));
    expect(await screen.findByTestId('island-consent-trust')).toBeTruthy();
    act(() => fake.emit('consents.changed', { upsert: [], removed: ['c-01'] }));
    expect(screen.queryByTestId('island-consent-trust')).toBeNull();
    expect(screen.getByTestId('island-pill')).toBeTruthy();
  });

  it('подписка на consents.changed снимается при размонтировании', async () => {
    const { fake, bridge } = setup();
    const view = render(<IslandApp bridge={bridge} />);
    await act(async () => { await Promise.resolve(); });
    view.unmount();
    act(() => fake.emit('consents.changed', { upsert: [CONSENT], removed: [] }));
    expect(useConsentsStore.getState().items).toEqual([]);
  });

  it('новая карточка выдвигает убранный остров и звучит один раз; повтор той же и решённая — без звука', async () => {
    const { fake, bridge } = setup({ islandSound: SOUND_ON });
    render(<IslandApp bridge={bridge} />);
    await act(async () => { await Promise.resolve(); });
    expect(isRetracted()).toBe(true);
    act(() => fake.emit('consents.changed', { upsert: [CONSENT], removed: [] }));
    await waitFor(() => expect(isRetracted()).toBe(false));
    expect(played()).toEqual(['permission']);
    act(() => fake.emit('consents.changed', { upsert: [{ ...CONSENT, folder: '/tmp/proj' }], removed: [] }));
    expect(played()).toEqual(['permission']);
    skipCooldown();
    act(() => fake.emit('consents.changed', { upsert: [SECOND], removed: [] }));
    await waitFor(() => expect(played()).toEqual(['permission', 'permission']));
  });

  it('без Sound карточка выдвигает остров молча', async () => {
    const { fake, bridge } = setup({ islandSound: SOUND_OFF });
    render(<IslandApp bridge={bridge} />);
    await act(async () => { await Promise.resolve(); });
    act(() => fake.emit('consents.changed', { upsert: [CONSENT], removed: [] }));
    await waitFor(() => expect(isRetracted()).toBe(false));
    expect(played()).toEqual([]);
  });

  it('звук карточки читает islandSound.needs: «Sound when an agent finishes» без «Sound when you’re needed» карточку не озвучивает', async () => {
    const { fake, bridge } = setup({ islandSound: { ...SOUND_OFF, finished: true } });
    render(<IslandApp bridge={bridge} />);
    await act(async () => { await Promise.resolve(); });
    act(() => fake.emit('consents.changed', { upsert: [CONSENT], removed: [] }));
    await waitFor(() => expect(isRetracted()).toBe(false));
    expect(played()).toEqual([]);
  });

  it('согласие раньше запроса ленты: запрос ждёт, пока карточку не закроют', async () => {
    const { fake, bridge, blocked } = setup();
    render(<IslandApp bridge={bridge} />);
    blocked('s-01');
    await screen.findByTitle('Run: rm -rf build');
    act(() => fake.emit('consents.changed', { upsert: [CONSENT], removed: [] }));
    expect(await screen.findByTestId('island-consent-trust')).toBeTruthy();
    expect(screen.queryByTestId('island-allow')).toBeNull();
    act(() => fake.emit('consents.changed', { upsert: [], removed: ['c-01'] }));
    expect(await screen.findByTestId('island-allow')).toBeTruthy();
  });

  it('Trust после паузы зовёт consents.decide и показывает «Done ✓»', async () => {
    const { fake, bridge } = setup({}, ENTRIES, [CONSENT]);
    fake.setHandler('consents.decide', () => ({ applied: true, state: 'allowed' }));
    render(<IslandApp bridge={bridge} />);
    const trust = (await screen.findByTestId('island-consent-trust')) as HTMLButtonElement;
    await waitFor(() => expect(trust.disabled).toBe(false));
    fireEvent.click(trust);
    expect((await screen.findByTestId('island-consent-done')).textContent).toBe('Done ✓');
    expect(fake.calls).toContainEqual({ method: 'consents.decide', params: { id: 'c-01', decision: 'allow' } });
  });

  it('Deny — decision: "deny"; ответили в другом месте — «Already answered»', async () => {
    const { fake, bridge } = setup({}, ENTRIES, [CONSENT]);
    fake.setHandler('consents.decide', () => ({ applied: false, state: 'allowed' }));
    render(<IslandApp bridge={bridge} />);
    const deny = (await screen.findByTestId('island-consent-deny')) as HTMLButtonElement;
    await waitFor(() => expect(deny.disabled).toBe(false));
    fireEvent.click(deny);
    expect(await screen.findByText('Already answered')).toBeTruthy();
    expect(fake.calls).toContainEqual({ method: 'consents.decide', params: { id: 'c-01', decision: 'deny' } });
  });

  it('хост отключился — карточки уходят; вернулся — список читается заново', async () => {
    const { fake, bridge, disconnect, reconnect } = setup({}, ENTRIES, [CONSENT]);
    render(<IslandApp bridge={bridge} />);
    await screen.findByTestId('island-consent-trust');
    disconnect();
    expect(useConsentsStore.getState().items).toEqual([]);
    reconnect();
    expect(await screen.findByTestId('island-consent-trust')).toBeTruthy();
    expect(fake.calls.filter((call) => call.method === 'consents.list')).toHaveLength(2);
  });

  describe('покой', () => {
    const advance = (ms: number): void => {
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    };

    it('пока карточка ждёт, остров в покое не убирается; закрыли — отсчёт обычный', () => {
      vi.useFakeTimers();
      const { bridge } = setup();
      render(<IslandApp bridge={bridge} />);
      act(() => useConsentsStore.getState().replace([CONSENT]));
      expect(isRetracted()).toBe(false);
      advance(IDLE_RETRACT_MS * 3);
      expect(isRetracted()).toBe(false);
      act(() => useConsentsStore.getState().replace([]));
      advance(IDLE_RETRACT_MS - 1);
      expect(isRetracted()).toBe(false);
      advance(1);
      expect(isRetracted()).toBe(true);
    });
  });
});

describe('presentationEvent: реакция мини-роя на исходы present() (критик m-1485)', () => {
  const outcome = (kind: IslandPresentationOutcome['kind'], fresh: boolean, expand: boolean): IslandPresentationOutcome =>
    ({ key: `${kind}:1`, kind, fresh, expand, soundEligible: true }) as IslandPresentationOutcome;

  it('свежий выдвигающий исход — его событие; уже виденный — ничего', () => {
    expect(presentationEvent([outcome('consent', true, true)], true)).toBe('permission');
    expect(presentationEvent([outcome('room-proposal', true, true)], true)).toBe('question');
    expect(presentationEvent([outcome('plan', false, false)], false)).toBeNull();
  });

  it('тихий Done: реакция только у уже выдвинутого острова (#9 §3.7)', () => {
    expect(presentationEvent([outcome('done', true, false)], true)).toBeNull();
    expect(presentationEvent([outcome('done', true, false)], false)).toBe('done');
  });

  it('несколько исходов разом — самый важный по порядку сигналов', () => {
    expect(presentationEvent([outcome('done', true, true), outcome('consent', true, true)], true)).toBe('permission');
  });
});

describe('реакции роёв помощника (#9 §4.1–§4.3, план 3b B24)', () => {
  /** Шпионы `react` движков всех роёв острова: шпион ставится при создании, до первого эффекта. */
  function spyReacts(): Array<ReturnType<typeof vi.fn>> {
    const real = engineModule.createSwarm;
    const reacts: Array<ReturnType<typeof vi.fn>> = [];
    vi.spyOn(engineModule, 'createSwarm').mockImplementation((...args) => {
      const engine = real(...args);
      reacts.push(vi.spyOn(engine, 'react') as unknown as ReturnType<typeof vi.fn>);
      return engine;
    });
    return reacts;
  }
  const reacted = (reacts: Array<ReturnType<typeof vi.fn>>): string[] => reacts.flatMap((react) => react.mock.calls.map(([reaction]) => reaction as string));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('мини-рой: начало работы — вдох (остров выдвигается, и мини-рой застаёт реакцию), наведение — наклон', async () => {
    const reacts = spyReacts();
    const { bridge, island, working, hover } = setup({ assistant: ASSISTANT_ON });
    render(<IslandApp bridge={bridge} />);
    await waitFor(() => expect(island.onAssistantOpen).toHaveBeenCalled());
    working('s-01');
    await waitFor(() => expect(reacted(reacts)).toEqual(['breathe']));
    hover(true);
    expect(reacted(reacts)).toEqual(['breathe', 'lean']);
  });

  it('рой помощника: шаг инструмента — кольцо яркости, ошибка — дрожь; пока вид свёрнут, реагирует мини-рой', async () => {
    const reacts = spyReacts();
    const { bridge, island } = setup({ assistant: ASSISTANT_ON });
    render(<IslandApp bridge={bridge} />);
    await waitFor(() => expect(island.onAssistantOpen).toHaveBeenCalled());
    act(() => vi.mocked(island.onAssistantOpen).mock.calls.at(-1)![0]({ listen: false }));
    await screen.findByTestId('assistant-view');
    act(() => useAssistantStore.getState().applyHost({ ...HOST_IDLE, phase: 'thinking', turn: 1 }));
    act(() => useAssistantStore.getState().applyHost({ ...HOST_IDLE, phase: 'tool', detail: 'works.list', turn: 1 }));
    act(() => useAssistantStore.getState().applyHost({ ...HOST_IDLE, phase: 'tool', detail: 'works.list', turn: 1 }));
    act(() => useAssistantStore.getState().applyHost({ ...HOST_IDLE, phase: 'tool', detail: 'feed.snapshot', turn: 1 }));
    expect(reacted(reacts)).toEqual(['glint', 'glint']);
    act(() => useAssistantStore.getState().collapse());
    expect(within(screen.getByTestId('assistant-dot')).getByTestId('swarm')).toBeTruthy();
    for (const react of reacts) react.mockClear();
    act(() => useAssistantStore.getState().applyHost({ ...HOST_IDLE, phase: 'error', error: 'Limit reached', turn: 1 }));
    expect(reacted(reacts)).toEqual(['shake']);
  });
});

describe('остров в вырезе (#9 §12, план 3b B28)', () => {
  /** Вырез 185 × 32 pt по центру кадра 480 pt; выдвинутый вид не уже 185 + 2·36 pt. */
  const NOTCH = { width: 185, height: 32, centerX: 240 };
  let innerWidth = 0;
  /** Колбэки подставного rAF по номеру. */
  let queued = new Map<number, FrameRequestCallback>();

  beforeEach(() => {
    innerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 480 });
    // Кадры подставные: настоящий rAF jsdom после подставных таймеров соседних тестов не срабатывает.
    queued = new Map();
    let next = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      queued.set(++next, cb);
      return next;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      queued.delete(id);
    });
    // Прямоугольники по сдвигу к центру выреза: форма — по `left` обёртки, зона нажатия — по своему.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const element = this as HTMLElement;
      const id = element.dataset.testid;
      if (id === 'island') {
        // Голый вырез — 185 pt, выдвинутый вид — по наименьшей ширине 257 pt; оба по центру кадра.
        const width = element.querySelector('[data-testid="island-notch"]') === null ? 257 : 185;
        return { x: 240 - width / 2 + (parseFloat((element.parentElement as HTMLElement).style.left) || 0), y: 0, width, height: 32 } as DOMRect;
      }
      if (id === 'island-tab') return { x: 147.5 + (parseFloat(element.style.left) || 0), y: 0, width: 185, height: 32 } as DOMRect;
      return { x: 0, y: 0, width: 0, height: 0 } as DOMRect;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
  });

  const lastRect = (island: IslandApi): unknown => vi.mocked(island.setHitRect).mock.calls.at(-1)?.[0];
  const morph = (): string | undefined => screen.getByTestId('island').className.split(' ').find((name) => name.startsWith('island-morph-'));
  /** Прогоняет два подставных кадра: после смены выреза форма возвращает класс перехода через два rAF. */
  const frames = (): void => {
    for (let frame = 0; frame < 2; frame += 1) {
      act(() => {
        const run = queued;
        queued = new Map();
        for (const cb of run.values()) cb(0);
      });
    }
  };
  /** Main прислал новые настройки острова (`island:config`). */
  const push = (island: IslandApi, config: IslandConfig): void => {
    act(() => {
      vi.mocked(island.onConfig).mock.calls.at(-1)![0](config);
    });
  };

  it('N6: убранный — голый вырез и зона нажатия ровно по нему; выдвинутый в покое — тоже голый вырез, область мыши — по нему (B26 F-B26-1)', async () => {
    const { island, bridge } = setup({ notch: NOTCH, topInset: 32 });
    render(<IslandApp bridge={bridge} />);
    await waitFor(() => expect(screen.getByTestId('island-notch')).toBeTruthy());
    const tab = screen.getByTestId('island-tab');
    expect(tab.className).not.toContain('w-16');
    expect((tab.parentElement as HTMLElement).style.top).toBe('0px');
    expect((tab.firstElementChild as HTMLElement).style.width).toBe('185px');
    expect(lastRect(island)).toEqual({ x: 147.5, y: 0, width: 185, height: 32 });
    expand();
    expect(isRetracted()).toBe(false);
    expect(screen.getByTestId('island-notch')).toBeTruthy();
    expect(screen.queryByTestId('island-pill')).toBeNull();
    expect(lastRect(island)).toEqual({ x: 147.5, y: 0, width: 185, height: 32 });
  });

  it('фон не раздвигает форму: агенты работают, помощник свёрнут после разговора — голый вырез (B26 F-B26-1)', async () => {
    const { island, bridge, working } = setup({
      notch: NOTCH, topInset: 32,
      assistant: { enabled: true, provider: null, model: null, language: 'en', hotkey: 'Alt+Space', voice: { enabled: false, model: null }, speech: SPEECH_OFF },
    });
    render(<IslandApp bridge={bridge} />);
    await waitFor(() => expect(screen.getByTestId('island-notch')).toBeTruthy());
    working('s-01');
    expect(screen.getByTestId('island-notch')).toBeTruthy();
    expect(screen.queryByTestId('island-pill')).toBeNull();
    expect(screen.queryByTestId('swarm')).toBeNull();
    act(() => useAssistantStore.setState({ open: true, collapsed: true, host: { ...HOST_IDLE, phase: 'idle', answer: 'Nothing is running.', turn: 1 } }));
    expect(isRetracted()).toBe(false);
    expect(screen.getByTestId('island-notch')).toBeTruthy();
    expect(screen.queryByTestId('assistant-view')).toBeNull();
    expect(lastRect(island)).toEqual({ x: 147.5, y: 0, width: 185, height: 32 });
  });

  it('N5: наведение выдвигает форму вниз (рост), уход курсора возвращает голый вырез (сжатие)', async () => {
    const { bridge, hover } = setup({ notch: NOTCH, topInset: 32 });
    render(<IslandApp bridge={bridge} />);
    await waitFor(() => expect(screen.getByTestId('island-notch')).toBeTruthy());
    expand();
    hover(true);
    expect(screen.getByTestId('island-pill')).toBeTruthy();
    expect(screen.queryByTestId('island-notch')).toBeNull();
    expect(screen.getByTestId('island-content').style.paddingTop).toBe('32px');
    hover(false);
    expect(screen.getByTestId('island-notch')).toBeTruthy();
    expect(screen.queryByTestId('island-pill')).toBeNull();
  });

  it('убран с непросмотренным Done — голый вырез без «✅ N»; зона нажатия — по вырезу (B26 F-B26-1)', async () => {
    useWorksStore.setState({ entries: ENTRIES, branches: {}, loading: false, error: null });
    useActivityStore.setState({ byRef: { [refKey(ref('s-01'))]: makeActivity(ref('s-01'), 'unseen', { turnEndedAt: '2026-10-13T09:59:00.000Z' }) }, loaded: true });
    const { bridge } = setup({ notch: NOTCH, topInset: 32 });
    render(<IslandApp bridge={bridge} />);
    await waitFor(() => expect(screen.getByTestId('island-tab').getAttribute('aria-label')).toBe('Agents finished — show the island'));
    expect(isRetracted()).toBe(true);
    expect(screen.getByTestId('island-notch')).toBeTruthy();
    expect(screen.queryByText('✅ 1')).toBeNull();
    expect((screen.getByTestId('island-tab').firstElementChild as HTMLElement).style.width).toBe('185px');
  });

  it('N8: новый замер выреза — область мыши уходит заново; вырез → полоса и обратно — без морфа', async () => {
    const { island, bridge } = setup({ notch: NOTCH, topInset: 32 });
    render(<IslandApp bridge={bridge} />);
    await waitFor(() => expect(screen.getByTestId('island-notch')).toBeTruthy());
    const base = await island.config();
    push(island, { ...base, notch: { ...NOTCH, centerX: 240.5 } });
    expect(lastRect(island)).toEqual({ x: 148, y: 0, width: 185, height: 32 });
    expand();
    frames();
    expect(morph()).toBe('island-morph-grow');
    push(island, { ...base, topInset: 38, notch: null });
    expect(morph()).toBeUndefined();
    expect(screen.getByTestId('island-idle')).toBeTruthy();
    frames();
    expect(morph()).toBeDefined();
    push(island, base);
    expect(morph()).toBeUndefined();
    expect(screen.getByTestId('island-notch')).toBeTruthy();
  });
});
