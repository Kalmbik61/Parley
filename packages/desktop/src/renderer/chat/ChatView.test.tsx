/**
 * Тело вкладки сессии и вид «Chat» (план 2026-10-01, Task 3): какой вид рисует `TerminalBody`, сегмент
 * «Chat | Terminal» (3a); лента с автопрокруткой и «Jump to latest», поле ввода (Enter, Shift+Enter,
 * Queue и серый элемент очереди), модель и Stop в тулбаре (3b). Правки по ревью куска 3: версия `claude`
 * неизвестна — терминал, до ответа `providers.list` — вид не выбран; черновик, очередь и фокус поля
 * переживают смену вида; ход только у живой сессии; Retry после ошибки ленты; без тоста успеха.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FeedItem, WorkSession } from '@parley/core';
import { refKey, type Capabilities, type SendResult, type SessionRef } from '@parley/protocol';
import type { DirEntry } from '../../shared/files-types.js';
import { S } from '../../shared/strings.js';
import type { TerminalView } from '../../shared/layout-types.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { TerminalBody } from '../layout/bodies/TerminalBody.js';
import { useLayoutStore } from '../layout/store.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { useActivityStore } from '../store/activity.js';
import { useHostStore } from '../store/host.js';
import { useProvidersStore } from '../store/providers.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { fakeDictationDeps } from '../test-utils/dictation.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { activityMap, makeActivity, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import type { SendWithToastDeps } from '../terminal/send.js';
import { useDictationStore } from '../voice/dictation-store.js';
import { resetCapabilitiesStoreForTests } from './capabilities-store.js';
import { resetFeedStoreForTests, useFeedStore } from './store.js';
import { resetChatUiStoreForTests, useChatUiStore } from './ui-store.js';
import { resetThumbnailCacheForTests } from './use-thumbnail.js';

vi.mock('sonner', () => {
  const fn = Object.assign(vi.fn(), { error: vi.fn() });
  return { toast: fn };
});

/** Claude Code с лентой: версия не ниже порога, ответ `providers.list` пришёл. */
const CLAUDE_OK = { id: 'claude', label: 'Claude Code', available: true, version: '2.1.286', limits: null };

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const FEED_METHODS = [...REQUIRED_METHODS, 'feed.snapshot', 'feed.subscribe', 'feed.unsubscribe'];

function hostWith(methods: string[]): void {
  useHostStore.setState({ status: { state: 'connected', hostVersion: '0.3.0', methods } });
}

let bridge: FakeBridge;
let sendDeps: SendWithToastDeps;

function body(session: WorkSession, view?: TerminalView): JSX.Element {
  const tab = view === undefined
    ? { kind: 'terminal' as const, id: 'terminal:s-01', sessionId: 's-01' }
    : { kind: 'terminal' as const, id: 'terminal:s-01', sessionId: 's-01', view };
  return <TerminalBody workKey="/tmp/p w-01" tab={tab} session={session} sessionRef={REF} active bridge={bridge} sendDeps={sendDeps} />;
}

function renderBody(session: WorkSession, view?: TerminalView): ReturnType<typeof render> {
  return render(body(session, view));
}

const segment = (name: string): HTMLElement => screen.getByRole('radio', { name });

const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

beforeEach(() => {
  // virtual-core мерит прокрутчик ленты `offsetHeight` (в jsdom — 0, и список был бы пуст).
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('data-testid') === 'chat-feed' ? 600 : 0;
    },
  });
  bridge = createFakeBridge();
  sendDeps = { bridge, session: () => null, openSession: () => undefined };
  resetFeedStoreForTests();
  resetChatUiStoreForTests();
  resetCapabilitiesStoreForTests();
  resetThumbnailCacheForTests();
  hostWith(FEED_METHODS);
  useProvidersStore.setState({ providers: [CLAUDE_OK], loaded: true });
  useUiStore.setState({ visibleSessionRefs: {} });
  // Сессия стартовала (есть событие журнала): вид без явного выбора — чат (кусок 4a, решение М).
  useActivityStore.setState({ byRef: activityMap([makeActivity(REF, 'idle')]), loaded: true });
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  cleanup();
  if (originalOffsetHeight !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
  resetFeedStoreForTests();
  resetChatUiStoreForTests();
  useHostStore.setState({ status: { state: 'connecting' } });
  useProvidersStore.setState({ providers: [], loaded: false });
  useActivityStore.setState({ byRef: {}, loaded: false });
  useWorksStore.setState(useWorksStore.getInitialState(), true);
});

describe('TerminalBody — вид вкладки', () => {
  it('Claude без поля view — ChatView с тулбаром, выбран Chat; сессия видима', () => {
    renderBody(makeSession('s-01', 'S01'));
    expect(screen.getAllByTestId('chat-view')).toHaveLength(1);
    expect(screen.queryByTestId('terminal-body')).toBeNull();
    expect(segment('Chat').getAttribute('aria-checked')).toBe('true');
    expect(segment('Terminal').getAttribute('aria-checked')).toBe('false');
    expect(useUiStore.getState().visibleSessionRefs[refKey(REF)]).toBe(true);
  });

  it('view terminal — заглушка под поверхность с тулбаром, выбран Terminal', () => {
    renderBody(makeSession('s-01', 'S01'), 'terminal');
    expect(screen.queryByTestId('chat-view')).toBeNull();
    expect(screen.getByTestId('terminal-body').querySelector('[data-testid="chat-toolbar"]')).not.toBeNull();
    expect(segment('Terminal').getAttribute('aria-checked')).toBe('true');
    // Видимость сессии в терминале ставит поверхность, не тело.
    expect(useUiStore.getState().visibleSessionRefs[refKey(REF)]).toBeUndefined();
  });

  it('codex — терминал, сегмент выключен с подсказкой', () => {
    renderBody(makeSession('s-01', 'S01', { provider: 'codex' }), 'chat');
    expect(screen.queryByTestId('chat-view')).toBeNull();
    expect(screen.getAllByTestId('terminal-body')).toHaveLength(1);
    expect((segment('Chat') as HTMLButtonElement).disabled).toBe(true);
    expect((segment('Terminal') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTitle(S.chat.terminalOnly).contains(segment('Chat'))).toBe(true);
  });

  it('версия claude неизвестна (null) — терминал, сегмент выключен с подсказкой', () => {
    useProvidersStore.setState({ providers: [{ ...CLAUDE_OK, version: null }], loaded: true });
    renderBody(makeSession('s-01', 'S01'));
    expect(screen.queryByTestId('chat-view')).toBeNull();
    expect(screen.getAllByTestId('terminal-body')).toHaveLength(1);
    expect((segment('Chat') as HTMLButtonElement).disabled).toBe(true);
    expect(segment('Terminal').getAttribute('aria-checked')).toBe('true');
    expect(S.chat.terminalOnly).toBe('Chat needs Claude Code 2.1.286 or newer');
    expect(screen.getByTitle(S.chat.terminalOnly).contains(segment('Chat'))).toBe(true);
  });

  it('providers.list ещё не ответил — пустая заглушка: ни чата, ни терминала, ни тулбара; ответ пришёл — чат', () => {
    useProvidersStore.setState({ providers: [], loaded: false });
    renderBody(makeSession('s-01', 'S01'));
    expect(screen.getByTestId('tab-view-pending').childElementCount).toBe(0);
    expect(screen.queryByTestId('chat-view')).toBeNull();
    expect(screen.queryByTestId('terminal-body')).toBeNull();
    expect(screen.queryByTestId('chat-toolbar')).toBeNull();
    act(() => useProvidersStore.setState({ providers: [CLAUDE_OK], loaded: true }));
    expect(screen.queryByTestId('tab-view-pending')).toBeNull();
    expect(screen.getAllByTestId('chat-view')).toHaveLength(1);
  });

  it('старый claude (2.1.280) — терминал с выключенным сегментом', () => {
    useProvidersStore.setState({ providers: [{ ...CLAUDE_OK, version: '2.1.280' }], loaded: true });
    renderBody(makeSession('s-01', 'S01'));
    expect(screen.queryByTestId('chat-view')).toBeNull();
    expect(screen.getAllByTestId('terminal-body')).toHaveLength(1);
    expect((segment('Chat') as HTMLButtonElement).disabled).toBe(true);
  });

  it('хост без feed.snapshot — заглушка без тулбара и сегмента, ответа providers.list не ждёт', () => {
    hostWith([...REQUIRED_METHODS]);
    useProvidersStore.setState({ providers: [], loaded: false });
    renderBody(makeSession('s-01', 'S01'), 'chat');
    expect(screen.getByTestId('terminal-body').childElementCount).toBe(0);
    expect(screen.queryByTestId('chat-toolbar')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });
});


const AT = '2026-10-01T00:00:00.000Z';
const prompt = (id: string, text: string): FeedItem => ({ id, at: AT, kind: 'prompt', text, images: 0 });
const turn = (id: string): FeedItem => ({ id, at: AT, kind: 'turn', durationMs: 1000 });
const text = (id: string, body: string): FeedItem => ({ id, at: AT, kind: 'text', messageId: id, text: body, streaming: false });

function setFeed(items: FeedItem[], revision = 1): void {
  act(() => {
    useFeedStore.setState({ feeds: { [refKey(REF)]: { items, revision, mode: null, status: 'ready' } } });
  });
}

/**
 * Прокрутчик ленты в jsdom: высоты задаются руками, `scrollTop` запоминается (у jsdom он всегда 0).
 * Событие `scroll` в браузере приходит позже записи `scrollTop`, поэтому запись его не шлёт:
 * `settle` — пришло событие нашей же прокрутки, `scrollTo` — прокрутил человек.
 */
function fakeScroller(): {
  el: HTMLElement;
  top: () => number;
  scrollTo: (value: number) => void;
  settle: () => void;
  setHeight: (value: number) => void;
} {
  const el = screen.getByTestId('chat-feed');
  let top = 0;
  let height = 2000;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 });
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { top = value; } });
  return {
    el,
    top: () => top,
    scrollTo: (value) => {
      top = value;
      fireEvent.scroll(el);
    },
    settle: () => {
      fireEvent.scroll(el);
    },
    setHeight: (value) => {
      height = value;
    },
  };
}

describe('ChatView — лента', () => {
  it('пока снимка нет — Loading без Retry; ошибка — подсказка открыть терминал и Retry', () => {
    renderBody(makeSession('s-01', 'S01'));
    expect(screen.getByTestId('chat-feed').textContent).toBe(S.chat.loading);
    expect(screen.queryByRole('button', { name: S.common.retry })).toBeNull();
    act(() => {
      useFeedStore.setState({ feeds: { [refKey(REF)]: { items: [], revision: 0, mode: null, status: 'error', error: 'boom' } } });
    });
    expect(screen.getByTestId('chat-feed').textContent).toBe(`${S.chat.feedUnavailable}${S.common.retry}`);
  });

  it('Retry после ошибки ленты — subscribe и snapshot заново, лента готова', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = true;
    bridge.setHandler('feed.subscribe', () => {
      if (fail) throw new Error('boom');
      return { ok: true };
    });
    bridge.setHandler('feed.snapshot', () => ({ items: [prompt('p1', 'back')], revision: 3, schemaVersion: 1, mode: null }));
    const dispose = useFeedStore.getState().init(bridge);
    useFeedStore.getState().open(REF);
    renderBody(makeSession('s-01', 'S01'));
    const retry = await screen.findByRole('button', { name: S.common.retry });
    fail = false;
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByTestId('chat-prompt').textContent).toContain('back'));
    expect(bridge.calls.filter((call) => call.method === 'feed.subscribe')).toHaveLength(2);
    expect(useFeedStore.getState().feeds[refKey(REF)]).toMatchObject({ status: 'ready', revision: 3 });
    useFeedStore.getState().close(REF);
    dispose();
    vi.restoreAllMocks();
  });

  it('элементы ленты рисуются своими видами', () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'hi'), text('t1', 'hello there'), turn('u1')]);
    expect(screen.getByTestId('chat-prompt').textContent).toContain('hi');
    expect(screen.getByTestId('chat-text').textContent).toContain('hello there');
    expect(screen.getByTestId('chat-turn').textContent).toBe(S.chat.turn('1s'));
  });

  it('у низа — новое прижимается к низу; прокрутили вверх — не дёргаем, «Jump to latest» возвращает', () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'one')]);
    const scroller = fakeScroller();

    setFeed([prompt('p1', 'one'), text('t1', 'two')], 2);
    expect(scroller.top()).toBe(2000);
    scroller.settle();
    expect(screen.queryByRole('button', { name: S.chat.jumpToLatest })).toBeNull();

    scroller.scrollTo(100);
    const jump = screen.getByRole('button', { name: S.chat.jumpToLatest });
    setFeed([prompt('p1', 'one'), text('t1', 'two'), turn('u1')], 3);
    expect(scroller.top()).toBe(100);

    fireEvent.click(jump);
    expect(scroller.top()).toBe(2000);
    expect(screen.queryByRole('button', { name: S.chat.jumpToLatest })).toBeNull();
  });

  it('scroll сразу после прокрутки к низу (коррекция замера) прилипание не срывает; следующий — уже человек', () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'one')]);
    const scroller = fakeScroller();
    // Новое снизу: лента прыгает к низу (2000).
    setFeed([prompt('p1', 'one'), text('t1', 'two')], 2);
    expect(scroller.top()).toBe(2000);
    // До события нашей прокрутки виртуализатор домерил строку: дно ушло на 600 px ниже. Событие
    // «не у низа» — наше, его не считаем: «Jump to latest» нет.
    scroller.setHeight(2600);
    scroller.settle();
    expect(screen.queryByRole('button', { name: S.chat.jumpToLatest })).toBeNull();
    // Следующее событие — человек прокрутил вверх.
    scroller.scrollTo(100);
    expect(screen.getAllByRole('button', { name: S.chat.jumpToLatest })).toHaveLength(1);
  });

  it('прокрутка к низу без сдвига флага не ставит: прокрутка человека сразу после неё учитывается', () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'one')]);
    const scroller = fakeScroller();
    setFeed([prompt('p1', 'one'), text('t1', 'two')], 2);
    scroller.settle();
    // Уже у самого дна: новый элемент той же высоты дна не сдвигает — события не будет.
    setFeed([prompt('p1', 'one'), text('t1', 'two'), turn('u1')], 3);
    expect(scroller.top()).toBe(2000);
    scroller.scrollTo(100);
    expect(screen.getAllByRole('button', { name: S.chat.jumpToLatest })).toHaveLength(1);
  });
});

describe('ChatView — поле ввода и тулбар', () => {
  const field = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: S.chat.composer.label }) as HTMLTextAreaElement;
  const type = (value: string): void => {
    fireEvent.change(field(), { target: { value } });
  };
  const sends = (): unknown[] => bridge.calls.filter((call) => call.method === 'pty.send').map((call) => call.params);

  it('диктовка в поле чата: текст в поле, pty.send не звался', async () => {
    useUiStore.setState({ ui: { ...useUiStore.getState().ui, voice: { enabled: true, model: 'small', language: 'auto' } } });
    const dispose = useDictationStore.getState().configure(fakeDictationDeps('hello from voice'));
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    const mic = screen.getByTestId('mic');
    fireEvent.click(within(mic).getByRole('button'));
    await waitFor(() => expect(mic.dataset.state).toBe('recording'));
    fireEvent.click(within(mic).getByRole('button'));
    await waitFor(() => expect(field().value).toBe('hello from voice'));
    expect(sends()).toEqual([]);
    dispose();
  });

  it('Enter — pty.send с submit: true, поле пустеет; Shift+Enter — не отправляет', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    type('first line');
    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });
    expect(sends()).toEqual([]);
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(sends()).toEqual([{ ref: REF, text: 'first line', submit: true }]);
    expect(field().value).toBe('');
    // Без хода — без серого элемента: промпт придёт хуком сразу.
    expect(screen.queryByTestId('chat-queued')).toBeNull();
    // Пустое поле Enter не отправляет.
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(sends()).toHaveLength(1);
    await act(async () => {});
  });

  it('кнопка Send шлёт то же', () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    type('via button');
    fireEvent.click(screen.getByRole('button', { name: S.chat.composer.send }));
    expect(sends()).toEqual([{ ref: REF, text: 'via button', submit: true }]);
  });

  it('пока идёт ход — Queue и серый элемент; уходит, когда пришёл промпт с тем же текстом', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'go')]);
    type('next');
    fireEvent.click(screen.getByRole('button', { name: S.chat.composer.queue }));
    expect(screen.getByTestId('chat-queued').textContent).toContain('next');
    await act(async () => {});
    expect(screen.getAllByTestId('chat-queued')).toHaveLength(1);

    setFeed([prompt('p1', 'go'), turn('u1'), prompt('p2', 'next')], 2);
    expect(screen.queryByTestId('chat-queued')).toBeNull();
    expect(screen.getAllByTestId('chat-prompt')).toHaveLength(2);
  });

  it('отказ отправки (busy) — серый элемент уходит', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: false, submitted: false, reason: 'busy' }));
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'go')]);
    type('later');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(screen.queryByTestId('chat-queued')).toBeNull());
  });

  it('Stop у хоста с feed.interrupt зовёт метод, а не шлёт Esc сам (живая проверка 2026-10-02)', async () => {
    hostWith([...FEED_METHODS, 'feed.interrupt']);
    bridge.setHandler('feed.interrupt', () => ({ ok: true }));
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'go')]);
    fireEvent.click(screen.getByRole('button', { name: S.chat.stop }));
    await waitFor(() => expect(bridge.calls).toContainEqual({ method: 'feed.interrupt', params: { ref: REF } }));
    expect(bridge.notified.some((note) => note.method === 'pty.input')).toBe(false);
  });

  it('Stop виден только во время хода; хост без feed.interrupt — Esc через pty.input', () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'go'), turn('u1')]);
    expect(screen.queryByRole('button', { name: S.chat.stop })).toBeNull();
    setFeed([prompt('p1', 'go'), turn('u1'), prompt('p2', 'again')], 2);
    fireEvent.click(screen.getByRole('button', { name: S.chat.stop }));
    expect(bridge.notified).toContainEqual({ method: 'pty.input', params: { ref: REF, data: '\x1b' } });
  });

  it('Stop — в поле ввода, рядом с Queue, и не в тулбаре (живая проверка 2026-10-02)', () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'go')]);
    const stop = screen.getByTestId('chat-stop');
    expect(screen.getByTestId('chat-composer').contains(stop)).toBe(true);
    expect(screen.getByTestId('chat-toolbar').contains(stop)).toBe(false);
    expect(screen.getByTestId('chat-toolbar').querySelector('button[title="' + S.chat.stopTitle + '"]')).toBeNull();
  });

  it('модель — из notice старта сессии и смены модели; нет — ничего', () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'go')]);
    expect(screen.queryByTestId('chat-model')).toBeNull();
    setFeed([
      { id: 'n1', at: AT, kind: 'notice', notice: { type: 'session-start', source: 'startup', model: 'claude-opus-5-5' } },
      { id: 'n2', at: AT, kind: 'notice', notice: { type: 'model-switch', from: 'claude-opus-5-5', to: 'claude-sonnet-5', source: 'user' } },
    ], 2);
    expect(screen.getByTestId('chat-model').textContent).toBe('claude-sonnet-5');
  });

  it('неживая сессия (уснула) с лентой «в ходе» — Send, а не Queue, и Stop нет', () => {
    renderBody(makeSession('s-01', 'S01', { lifecycle: 'sleeping' }));
    setFeed([prompt('p1', 'go')]);
    type('hello');
    expect(screen.getAllByRole('button', { name: S.chat.composer.send })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: S.chat.composer.queue })).toBeNull();
    expect(screen.queryByRole('button', { name: S.chat.stop })).toBeNull();
  });

  it('лента кончилась /exit без конца хода (как журнал p5b) — Stop и Queue нет', () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'go'), turn('u1'), prompt('p2', '/exit')]);
    type('hello');
    expect(screen.getAllByRole('button', { name: S.chat.composer.send })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: S.chat.stop })).toBeNull();
  });

  it('набрал → Terminal → Chat: текст на месте, поле в фокусе', () => {
    const view = renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    expect(document.activeElement).toBe(field());
    type('draft text');
    view.rerender(body(makeSession('s-01', 'S01'), 'terminal'));
    expect(screen.queryByTestId('chat-view')).toBeNull();
    view.rerender(body(makeSession('s-01', 'S01'), 'chat'));
    expect(field().value).toBe('draft text');
    expect(document.activeElement).toBe(field());
  });

  it('после отправки кнопкой фокус остаётся в поле', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    type('via button');
    const send = screen.getByRole('button', { name: S.chat.composer.send });
    send.focus();
    fireEvent.click(send);
    expect(document.activeElement).toBe(field());
    await act(async () => {});
  });

  it('серый элемент очереди переживает размонтирование вида', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    const view = renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'go')]);
    type('queued one');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await act(async () => {});
    view.unmount();
    expect(useChatUiStore.getState().queued[refKey(REF)]?.map((entry) => entry.text)).toEqual(['queued one']);
    renderBody(makeSession('s-01', 'S01'));
    expect(screen.getByTestId('chat-queued').textContent).toContain('queued one');
  });

  it('успешная отправка — без тоста «Sent to»; отказ busy — тост с Retry', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    type('quiet');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await act(async () => {});
    expect(toast).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();

    bridge.setHandler('pty.send', () => ({ inserted: false, submitted: false, reason: 'busy' }));
    type('loud');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await act(async () => {});
    expect(vi.mocked(toast.error).mock.calls.map((call) => call[0])).toEqual([S.send.busy('S01')]);
  });
});

describe('автопоказ терминала до SessionStart (кусок 4a, решение М)', () => {
  it('без явного view и без событий журнала — терминал; первое событие переключает на чат', () => {
    useActivityStore.setState({ byRef: activityMap([makeActivity(REF, 'idle', { lastEventAt: null })]) });
    renderBody(makeSession('s-01', 'S01'));
    expect(screen.queryByTestId('chat-view')).toBeNull();
    expect(screen.getAllByTestId('terminal-body')).toHaveLength(1);
    act(() => useActivityStore.setState({ byRef: activityMap([makeActivity(REF, 'working')]) }));
    expect(screen.getAllByTestId('chat-view')).toHaveLength(1);
  });

  it('снимок активности ещё не пришёл (loaded ложно) — вид не выбран, заглушка; явный view побеждает', () => {
    useActivityStore.setState({ byRef: {}, loaded: false });
    const view = renderBody(makeSession('s-01', 'S01'));
    expect(screen.getAllByTestId('tab-view-pending')).toHaveLength(1);
    expect(screen.queryByTestId('terminal-body')).toBeNull();
    expect(screen.queryByTestId('chat-view')).toBeNull();
    view.unmount();
    renderBody(makeSession('s-01', 'S01'), 'chat');
    expect(screen.getAllByTestId('chat-view')).toHaveLength(1);
  });

  it('записи активности нет вовсе — терминал', () => {
    useActivityStore.setState({ byRef: {} });
    renderBody(makeSession('s-01', 'S01'));
    expect(screen.getAllByTestId('terminal-body')).toHaveLength(1);
  });

  it('явный view побеждает: chat до старта остаётся чатом, terminal после старта — терминалом', () => {
    useActivityStore.setState({ byRef: {} });
    const view = renderBody(makeSession('s-01', 'S01'), 'chat');
    expect(screen.getAllByTestId('chat-view')).toHaveLength(1);
    view.unmount();
    useActivityStore.setState({ byRef: activityMap([makeActivity(REF, 'working')]) });
    renderBody(makeSession('s-01', 'S01'), 'terminal');
    expect(screen.queryByTestId('chat-view')).toBeNull();
  });
});

describe('ChatView — баннер ожидания в терминале (кусок 4a, решение Н)', () => {
  const WORK_KEY = '/tmp/p w-01';
  const card = (state: 'pending' | 'allowed'): FeedItem => ({
    id: 'card-1',
    at: AT,
    kind: 'permission',
    cardId: 'card-1',
    state,
    toolUseId: null,
    toolName: 'Bash',
    toolInput: { command: 'ls' },
    suggestions: [],
    notified: false,
  });
  const activity = (value: 'blocked' | 'idle'): void =>
    useActivityStore.setState({ byRef: activityMap([makeActivity(REF, value)]) });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const settle = (ms = 300): void => {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };

  it('blocked без pending-карточки — баннер есть через 300 мс; клик уводит вкладку в терминал', () => {
    useLayoutStore.setState({
      activeWorkKey: WORK_KEY,
      layouts: {
        [WORK_KEY]: {
          root: { type: 'group', id: 'g1', tabs: [{ kind: 'terminal', id: 'terminal:s-01', sessionId: 's-01' }], activeTabId: 'terminal:s-01' },
          activeGroupId: 'g1',
          closedTabs: [],
        },
      },
      hydrated: { [WORK_KEY]: true },
      pending: {},
      history: EMPTY_HISTORY,
      mru: {},
      navigating: false,
    });
    activity('blocked');
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'hi')]);
    settle();
    expect(screen.getByTestId('chat-waiting-banner').textContent).toContain(S.chat.waitingBanner.text);
    fireEvent.click(screen.getByTestId('chat-waiting-open'));
    const layout = useLayoutStore.getState().layouts[WORK_KEY]!;
    const root = layout.root;
    expect(root.type === 'group' ? root.tabs[0] : null).toMatchObject({ id: 'terminal:s-01', view: 'terminal' });
  });

  it('условие держится 100 мс — баннера нет; 300 мс — есть; пропало — баннера нет сразу', () => {
    activity('blocked');
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'hi')]);
    settle(100);
    expect(screen.queryByTestId('chat-waiting-banner')).toBeNull();
    settle(200);
    expect(screen.getByTestId('chat-waiting-banner')).not.toBeNull();
    // Пропажа условия снимает баннер без ожидания.
    act(() => activity('idle'));
    expect(screen.queryByTestId('chat-waiting-banner')).toBeNull();
  });

  it('карточка PermissionRequest пришла раньше 300 мс — баннер не мелькнул', () => {
    activity('blocked');
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'hi')]);
    settle(150);
    setFeed([prompt('p1', 'hi'), card('pending')], 2);
    settle(1000);
    expect(screen.queryByTestId('chat-waiting-banner')).toBeNull();
  });

  it('blocked с pending-карточкой — баннера нет; карточка улажена — баннер появляется через 300 мс', () => {
    activity('blocked');
    renderBody(makeSession('s-01', 'S01'));
    setFeed([card('pending')]);
    settle(1000);
    expect(screen.queryByTestId('chat-waiting-banner')).toBeNull();
    setFeed([card('allowed')], 2);
    expect(screen.queryByTestId('chat-waiting-banner')).toBeNull();
    settle();
    expect(screen.getByTestId('chat-waiting-banner')).not.toBeNull();
  });

  it('idle — баннера нет', () => {
    activity('idle');
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'hi')]);
    settle(1000);
    expect(screen.queryByTestId('chat-waiting-banner')).toBeNull();
  });
});

describe('ChatView — меню режима (кусок 4a, решения К и Л)', () => {
  const MODE_METHODS = [...FEED_METHODS, 'sessions.setMode'];
  const trigger = (): HTMLElement => screen.getByTestId('chat-mode');
  const openMenu = (): void => {
    fireEvent.keyDown(trigger(), { key: 'Enter' });
  };
  const options = (): HTMLElement[] => screen.getAllByTestId('chat-mode-option');

  function setMode(mode: string | null): void {
    act(() => {
      useFeedStore.setState({ feeds: { [refKey(REF)]: { items: [], revision: 1, mode, status: 'ready' } } });
    });
  }

  it('хост без sessions.setMode — меню нет', () => {
    renderBody(makeSession('s-01', 'S01'));
    setMode('default');
    expect(screen.queryByTestId('chat-mode')).toBeNull();
  });

  it('подпись — текущий режим ленты: Manual, Accept edits, Plan, сырая строка, Mode без режима', () => {
    hostWith(MODE_METHODS);
    renderBody(makeSession('s-01', 'S01'));
    setMode(null);
    expect(trigger().textContent).toBe(S.chat.mode.unknown);
    setMode('default');
    expect(trigger().textContent).toBe('Manual');
    setMode('acceptEdits');
    expect(trigger().textContent).toBe('Accept edits');
    setMode('plan');
    expect(trigger().textContent).toBe('Plan');
    setMode('auto');
    expect(trigger().textContent).toBe('Auto');
    setMode('bypassPermissions');
    expect(trigger().textContent).toBe('bypassPermissions');
  });

  it('пункты Manual, Accept edits, Plan, Auto; текущий отмечен; выбор зовёт sessions.setMode', async () => {
    hostWith(MODE_METHODS);
    bridge.setHandler('sessions.setMode', () => ({ mode: 'plan', verified: true }));
    renderBody(makeSession('s-01', 'S01'));
    setMode('default');
    openMenu();
    expect(options().map((option) => option.dataset.mode)).toEqual(['default', 'acceptEdits', 'plan', 'auto']);
    expect(options()[0]!.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(options()[2]!);
    await act(async () => {});
    expect(bridge.calls.filter((call) => call.method === 'sessions.setMode').map((call) => call.params)).toEqual([
      { ref: REF, mode: 'plan' },
    ]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('verified false — тост «откройте терминал»; ошибка моста — тост с отказом', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    hostWith(MODE_METHODS);
    bridge.setHandler('sessions.setMode', () => ({ mode: null, verified: false }));
    renderBody(makeSession('s-01', 'S01'));
    setMode('default');
    openMenu();
    fireEvent.click(options()[1]!);
    await act(async () => {});
    expect(vi.mocked(toast).mock.calls.map((call) => call[0])).toEqual([S.chat.mode.openTerminal]);

    bridge.setHandler('sessions.setMode', () => {
      throw new Error('boom');
    });
    openMenu();
    fireEvent.click(options()[1]!);
    await act(async () => {});
    expect(toast.error).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('сессия не живая (спит) — меню выключено, sessions.setMode не зовётся', () => {
    hostWith(MODE_METHODS);
    renderBody(makeSession('s-01', 'S01', { lifecycle: 'sleeping' }));
    setMode('default');
    expect((trigger() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(trigger(), { key: 'Enter' });
    expect(screen.queryAllByTestId('chat-mode-option')).toHaveLength(0);
    expect(bridge.calls.some((call) => call.method === 'sessions.setMode')).toBe(false);
  });

  it('пока запрос в пути — меню выключено', async () => {
    hostWith(MODE_METHODS);
    let answer!: (value: { mode: string; verified: boolean }) => void;
    bridge.setHandler('sessions.setMode', () => new Promise((resolve) => (answer = resolve)));
    renderBody(makeSession('s-01', 'S01'));
    setMode('default');
    openMenu();
    fireEvent.click(options()[1]!);
    await act(async () => {});
    expect((trigger() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => answer({ mode: 'acceptEdits', verified: true }));
    expect((trigger() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('ChatView — индикатор работы, Resume и меню моделей (живая проверка 2026-10-02)', () => {
  const model = (): HTMLElement => screen.getByTestId('chat-model');

  it('shows retry attempts with Stop available, then clears the countdown on recovery or failure', () => {
    renderBody(makeSession('s-01', 'S01'));
    const retry: FeedItem = {
      id: 'retry:6', at: new Date().toISOString(), kind: 'error', error: '429',
      message: 'Usage limit reached for 5 hour.',
      retry: { delayMs: 8000, attempt: 6, maxAttempts: 10 },
    };
    setFeed([prompt('p1', 'go'), retry]);
    expect(screen.getByTestId('chat-working').textContent).toContain('attempt 6/10');
    expect(screen.getByRole('button', { name: S.chat.stop })).toBeTruthy();
    setFeed([prompt('p1', 'go'), retry, { ...text('answer', 'Recovered'), streaming: true }], 2);
    expect(screen.queryByTestId('chat-working')).toBeNull();
    setFeed([prompt('p1', 'go'), retry, {
      id: 'failed', at: retry.at, kind: 'error', error: '429', message: 'Usage limit reached',
    }], 3);
    expect(screen.queryByTestId('chat-working')).toBeNull();
    expect(screen.queryByRole('button', { name: S.chat.stop })).toBeNull();
    expect(screen.getByText(S.chat.error)).toBeTruthy();
  });

  it('ход идёт, текста нет — «Working…» со временем от последнего промпта; пишущийся текст или карточка — строки нет; конец хода — нет', () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'go')]);
    expect(screen.getByTestId('chat-working').textContent).toContain(S.chat.working);
    setFeed([prompt('p1', 'go'), { ...text('t1', 'typing'), streaming: true }], 2);
    expect(screen.queryByTestId('chat-working')).toBeNull();
    setFeed([prompt('p1', 'go'), turn('u1')], 3);
    expect(screen.queryByTestId('chat-working')).toBeNull();
    setFeed(
      [
        prompt('p1', 'go'),
        { id: 'c1', at: AT, kind: 'permission', cardId: 'c1', state: 'pending', toolUseId: null, toolName: 'Bash', toolInput: {}, suggestions: [], notified: false },
      ],
      4,
    );
    expect(screen.queryByTestId('chat-working')).toBeNull();
  });

  it('уснувшая сессия — карточка с Resume между лентой и полем; клик зовёт sessions.resume', async () => {
    useWorksStore.setState({
      entries: [makeWork('w-01', { projectPath: '/tmp/p', sessions: [makeSession('s-01', 'S01', { lifecycle: 'sleeping' })] })],
      branches: {},
      loading: false,
      error: null,
    });
    const resumes: unknown[] = [];
    bridge.setHandler('sessions.resume', (params) => {
      resumes.push(params);
      return undefined;
    });
    renderBody(makeSession('s-01', 'S01', { lifecycle: 'sleeping' }));
    setFeed([]);
    expect(screen.getByTestId('terminal-not-running')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: S.sidebar.sessionMenu.resume }));
    await act(async () => {});
    expect(resumes).toEqual([{ ref: REF }]);
    // Поле ввода остаётся.
    expect(screen.getByRole('textbox', { name: S.chat.composer.label })).not.toBeNull();
  });

  it('живая сессия — карточки нет', () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    expect(screen.queryByTestId('terminal-not-running')).toBeNull();
  });

  it('у провайдера есть модели — подпись становится меню; выбор шлёт «/model <id>» с submit: true', async () => {
    useProvidersStore.setState({
      providers: [{ ...CLAUDE_OK, models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: '' }] }],
      loaded: true,
    });
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    renderBody(makeSession('s-01', 'S01'));
    setFeed([
      { id: 'n1', at: AT, kind: 'notice', notice: { type: 'session-start', source: 'startup', model: 'opus' } },
    ]);
    expect(model().textContent).toBe('opus');
    fireEvent.keyDown(model(), { key: 'Enter' });
    const options = screen.getAllByTestId('chat-model-option');
    expect(options.map((option) => [option.dataset.model, option.textContent])).toEqual([
      ['opus', 'Opus'],
      ['sonnet', 'sonnet'],
    ]);
    expect(options[0]!.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(options[1]!);
    await act(async () => {});
    expect(bridge.calls.filter((call) => call.method === 'pty.send').map((call) => call.params)).toEqual([
      { ref: REF, text: '/model sonnet', submit: true },
    ]);
  });

  it('модель ещё не известна — триггер с подписью «Model»', () => {
    useProvidersStore.setState({ providers: [{ ...CLAUDE_OK, models: [{ id: 'opus', label: 'Opus' }] }], loaded: true });
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    expect(model().textContent).toBe(S.chat.model);
  });

  it('у провайдера нет моделей (нет поля или null) — меню нет, подпись как была', () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([{ id: 'n1', at: AT, kind: 'notice', notice: { type: 'session-start', source: 'startup', model: 'opus' } }]);
    expect(model().tagName).toBe('SPAN');
    useProvidersStore.setState({ providers: [{ ...CLAUDE_OK, models: null }], loaded: true });
    expect(model().tagName).toBe('SPAN');
    expect(screen.queryByTestId('chat-model-option')).toBeNull();
  });
});

describe('ChatView — подсказки поля ввода (живая проверка 2026-10-02)', () => {
  const field = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: S.chat.composer.label }) as HTMLTextAreaElement;
  const type = (value: string): void => {
    fireEvent.change(field(), { target: { value } });
  };
  const sends = (): unknown[] => bridge.calls.filter((call) => call.method === 'pty.send').map((call) => call.params);
  const values = (): Array<string | undefined> => screen.queryAllByTestId('chat-suggestion').map((row) => row.dataset.value);
  const entry = (name: string, kind: 'file' | 'dir' = 'file'): DirEntry => ({ name, kind, size: 0, mtimeMs: 0, ignored: false, target: null });
  const root = { workKey: '/tmp/p w-01', spec: { kind: 'project' as const } };
  const CAPS: Capabilities = {
    commands: [
      { name: 'clear', description: 'Clear the conversation', terminal: false },
      { name: 'config', description: 'Open settings', terminal: true },
    ],
    skills: [{ name: 'demo-skill', description: 'Demo skill', source: 'project', path: '/tmp/p/.claude/skills/demo-skill' }],
    agents: [{ name: 'reviewer', description: 'Reviews code', source: 'user', path: '/h/.claude/agents/reviewer.md' }],
  };

  /** Хост с `capabilities.list`: мост отдаёт CAPS; сессия и работа в сторе — корень файлов считается из них. */
  async function renderWithCapabilities(): Promise<void> {
    hostWith([...FEED_METHODS, 'capabilities.list']);
    bridge.setHandler('capabilities.list', () => CAPS);
    useProvidersStore.setState({
      providers: [{ ...CLAUDE_OK, models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] }],
      loaded: true,
    });
    const session = makeSession('s-01', 'S01');
    useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: '/tmp/p', sessions: [session] })], branches: {}, loading: false, error: null });
    renderBody(session);
    setFeed([]);
    await act(async () => {});
  }

  it('«/» — команды и скиллы с описанием; terminal — с меткой; фильтр по подстроке, точные начала первыми', async () => {
    await renderWithCapabilities();
    type('/');
    expect(values()).toEqual(['/clear ', '/config ', '/demo-skill ']);
    const rows = screen.getAllByTestId('chat-suggestion');
    expect(rows[1]!.textContent).toContain(S.chat.suggestions.terminal);
    expect(rows[2]!.textContent).toContain('Demo skill');
    expect(rows[2]!.textContent).toContain(S.chat.suggestions.source.project);
    type('/o');
    expect(values()).toEqual(['/config ', '/demo-skill ']);
    type('/cl');
    expect(values()).toEqual(['/clear ']);
    type('/zzz');
    expect(screen.queryByTestId('chat-suggestions')).toBeNull();
  });

  it('Enter при открытом попапе вставляет «/clear » и не отправляет; фокус и каретка в поле', async () => {
    await renderWithCapabilities();
    type('/cl');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(field().value).toBe('/clear ');
    expect(field().selectionStart).toBe(7);
    expect(sends()).toEqual([]);
    expect(screen.queryByTestId('chat-suggestions')).toBeNull();
    expect(document.activeElement).toBe(field());
  });

  it('вложения подсказкам не мешают: Enter при открытом попапе принимает подсказку, без попапа — отправляет с вложением', async () => {
    await renderWithCapabilities();
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    bridge.setChosenFiles(['/a/notes.txt']);
    fireEvent.click(screen.getByTestId('chat-attach'));
    await act(async () => {});
    type('/cl');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(field().value).toBe('/clear ');
    expect(sends()).toEqual([]);
    expect(screen.getAllByTestId('chat-attachment')).toHaveLength(1);
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(sends()).toEqual([{ ref: REF, text: '/clear @"/a/notes.txt" ', submit: true }]);
    await act(async () => {});
  });

  it('↑/↓ двигают выбор, Tab и клик принимают, Esc закрывает до следующей буквы', async () => {
    await renderWithCapabilities();
    type('/');
    const selected = (): string | undefined => screen.getAllByTestId('chat-suggestion').find((row) => row.getAttribute('aria-selected') === 'true')?.dataset.value;
    expect(selected()).toBe('/clear ');
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(selected()).toBe('/config ');
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    expect(selected()).toBe('/demo-skill ');
    fireEvent.keyDown(field(), { key: 'Tab' });
    expect(field().value).toBe('/demo-skill ');

    type('/c');
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(screen.queryByTestId('chat-suggestions')).toBeNull();
    // Закрытые подсказки не перехватывают Enter: он отправляет.
    type('/cl');
    expect(screen.getByTestId('chat-suggestions')).toBeTruthy();
    fireEvent.click(screen.getAllByTestId('chat-suggestion')[0]!);
    expect(field().value).toBe('/clear ');
  });

  it('«/model » — модели провайдера; выбор вставляет «/model <id>» без пробела и без отправки', async () => {
    await renderWithCapabilities();
    type('/model ');
    expect(values()).toEqual(['/model opus', '/model sonnet']);
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(field().value).toBe('/model sonnet');
    expect(sends()).toEqual([]);
    // Теперь попап закрыт, Enter отправляет.
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    type('/model sonnet');
    fireEvent.keyDown(field(), { key: 'Escape' });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(sends()).toEqual([{ ref: REF, text: '/model sonnet', submit: true }]);
  });

  it('«@» — субагенты и файлы корня; каталог продолжает подсказки, файл вставляется с пробелом', async () => {
    await renderWithCapabilities();
    bridge.setDir(root, '', [entry('src', 'dir'), entry('notes.txt'), entry('.git', 'dir'), entry('my file.txt')]);
    bridge.setDir(root, 'src', [entry('components', 'dir'), entry('index.ts')]);
    type('@');
    await act(async () => {});
    expect(values()).toEqual(['@reviewer ', '@src/', '@notes.txt ']);
    type('@s');
    await act(async () => {});
    expect(values()).toEqual(['@src/']);
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(field().value).toBe('@src/');
    await act(async () => {});
    expect(values()).toEqual(['@src/components/', '@src/index.ts ']);
    type('@src/in');
    expect(values()).toEqual(['@src/index.ts ']);
    fireEvent.keyDown(field(), { key: 'Tab' });
    expect(field().value).toBe('@src/index.ts ');
  });

  it('Esc закрывает попап «@»', async () => {
    await renderWithCapabilities();
    bridge.setDir(root, '', [entry('notes.txt')]);
    type('@no');
    await act(async () => {});
    expect(values()).toEqual(['@notes.txt ']);
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(screen.queryByTestId('chat-suggestions')).toBeNull();
  });

  it('хост без capabilities.list — метод не зовётся, команд нет, модели работают', async () => {
    useProvidersStore.setState({ providers: [{ ...CLAUDE_OK, models: [{ id: 'opus', label: 'Opus' }] }], loaded: true });
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    await act(async () => {});
    type('/');
    expect(screen.queryByTestId('chat-suggestions')).toBeNull();
    type('/model ');
    expect(values()).toEqual(['/model opus']);
    expect(bridge.calls.filter((call) => call.method === 'capabilities.list')).toEqual([]);
  });

  it('capabilities.list не чаще раза в 60 с на проект: повторное монтирование берёт готовое', async () => {
    await renderWithCapabilities();
    cleanup();
    renderBody(makeSession('s-01', 'S01'));
    await act(async () => {});
    expect(bridge.calls.filter((call) => call.method === 'capabilities.list')).toEqual([
      { method: 'capabilities.list', params: { projectPath: '/tmp/p', provider: 'claude' } },
    ]);
  });
});

describe('ChatView — вложения в поле ввода (живая проверка 2026-10-02)', () => {
  const field = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: S.chat.composer.label }) as HTMLTextAreaElement;
  const type = (value: string): void => {
    fireEvent.change(field(), { target: { value } });
  };
  const sends = (): unknown[] => bridge.calls.filter((call) => call.method === 'pty.send').map((call) => call.params);
  const imageData = { items: [{ kind: 'file', type: 'image/png' }], getData: () => '' };
  const chips = (): HTMLElement[] => screen.queryAllByTestId('chat-attachment');
  const chipPaths = (): Array<string | null> => chips().map((chip) => chip.getAttribute('data-path'));
  const chip = (path: string): HTMLElement => {
    const found = chips().find((item) => item.getAttribute('data-path') === path);
    if (found === undefined) throw new Error(`нет чипа ${path}`);
    return found;
  };
  const sendButton = (): HTMLButtonElement => screen.getByRole('button', { name: S.chat.composer.send }) as HTMLButtonElement;
  /** Скрепка: диалог отвечает `paths`, чипы встают после ответа. */
  async function attach(...paths: string[]): Promise<void> {
    bridge.setChosenFiles(paths);
    fireEvent.click(screen.getByTestId('chat-attach'));
    await act(async () => {});
  }

  it('вставка картинки без текста — saveDropImage, чип над полем, текст поля не меняется, браузерная вставка отменена', async () => {
    bridge.setSaveDropImage('/h/drops/a b.png');
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    type('ab');
    const notCancelled = fireEvent.paste(field(), { clipboardData: imageData });
    expect(notCancelled).toBe(false);
    await act(async () => {});
    expect(bridge.saveDropImageCalls).toEqual(['clipboard']);
    expect(field().value).toBe('ab');
    expect(chipPaths()).toEqual(['/h/drops/a b.png']);
    // Чип стоит над полем, внутри блока поля ввода.
    expect(within(screen.getByTestId('chat-attachments')).getByTestId('chat-attachment')).toBe(chips()[0]);
    expect(screen.getByTestId('chat-composer').contains(screen.getByTestId('chat-attachments'))).toBe(true);
  });

  it('вставка с текстом в буфере — saveDropImage не зовётся, вставка не отменяется, чипов нет', async () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    const notCancelled = fireEvent.paste(field(), {
      clipboardData: { items: [{ kind: 'string', type: 'text/plain' }, { kind: 'file', type: 'image/png' }], getData: () => 'text' },
    });
    expect(notCancelled).toBe(true);
    await act(async () => {});
    expect(bridge.saveDropImageCalls).toEqual([]);
    expect(chips()).toEqual([]);
  });

  it('отказ saveDropImage — тост: слишком большая картинка отдельным текстом; поле и чипы пусты', async () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    bridge.setSaveDropImage({ code: 'drops:too-large', message: 'big' });
    fireEvent.paste(field(), { clipboardData: imageData });
    await act(async () => {});
    expect(toast.error).toHaveBeenCalledWith(S.terminal.imageTooLarge);
    expect(field().value).toBe('');
    expect(chips()).toEqual([]);
  });

  it('бросок файлов на вид: подсветка data-dropping, чипы без дублей, текст поля не меняется; бросок без файлов не принимается', async () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    type('draft');
    const view = screen.getByTestId('chat-view');
    fireEvent.dragOver(view, { dataTransfer: { types: ['Files'] } });
    expect(view.hasAttribute('data-dropping')).toBe(true);
    fireEvent.drop(view, { dataTransfer: { types: ['Files'], files: [new File([], 'one.png'), new File([], 'two words.txt')] } });
    expect(view.hasAttribute('data-dropping')).toBe(false);
    expect(chipPaths()).toEqual(['/fake/one.png', '/fake/two words.txt']);
    expect(field().value).toBe('draft');
    // Поле снова в фокусе: вопрос дописывают сразу.
    expect(document.activeElement).toBe(field());

    // Тот же файл ещё раз — без дубля; файл без пути на диске (синтетический) пропускается.
    fireEvent.drop(view, { dataTransfer: { types: ['Files'], files: [new File([], 'one.png'), new File([], ''), new File([], 'three.txt')] } });
    expect(chipPaths()).toEqual(['/fake/one.png', '/fake/two words.txt', '/fake/three.txt']);

    fireEvent.dragOver(view, { dataTransfer: { types: ['text/plain'] } });
    expect(view.hasAttribute('data-dropping')).toBe(false);
    fireEvent.drop(view, { dataTransfer: { types: ['text/plain'], files: [] } });
    expect(chipPaths()).toHaveLength(3);
  });

  it('скрепка — chooseFiles, чипы без дублей, текст поля не меняется; отмена диалога ничего не добавляет', async () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    const attachButton = screen.getByTestId('chat-attach');
    expect(attachButton.getAttribute('title')).toBe(S.chat.composer.attach);
    fireEvent.click(attachButton);
    await act(async () => {});
    expect(field().value).toBe('');
    expect(chips()).toEqual([]);
    expect(screen.queryByTestId('chat-attachments')).toBeNull();

    await attach('/a/notes.txt');
    expect(chipPaths()).toEqual(['/a/notes.txt']);
    expect(field().value).toBe('');
    expect(document.activeElement).toBe(field());
    await attach('/a/notes.txt', '/a/more.txt');
    expect(chipPaths()).toEqual(['/a/notes.txt', '/a/more.txt']);
  });

  it('чип картинки — миниатюра из app.imageThumbnail, файла — значок и имя; миниатюру просят только у картинок', async () => {
    bridge.setThumbnail('/h/drops/shot.png', 'data:image/png;base64,AAAA');
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    await attach('/h/drops/shot.png', '/a/notes.txt', '/h/drops/gone.png');
    await waitFor(() => expect(chip('/h/drops/shot.png').hasAttribute('data-thumbnail')).toBe(true));

    const image = within(chip('/h/drops/shot.png')).getByRole('img', { name: 'shot.png' });
    expect(image.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(image.getAttribute('title')).toBe('/h/drops/shot.png');
    // Файл — чип с именем и полным путём в title, без картинки.
    expect(chip('/a/notes.txt').textContent).toBe('notes.txt');
    expect(chip('/a/notes.txt').getAttribute('title')).toBe('/a/notes.txt');
    expect(chip('/a/notes.txt').querySelector('img')).toBeNull();
    // Картинка без миниатюры (файла уже нет) — тоже чип с именем.
    expect(chip('/h/drops/gone.png').textContent).toBe('gone.png');
    expect(chip('/h/drops/gone.png').hasAttribute('data-thumbnail')).toBe(false);
    expect([...bridge.thumbnailCalls].sort()).toEqual(['/h/drops/gone.png', '/h/drops/shot.png']);
  });

  it('крестик убирает чип и возвращает фокус в поле; без текста и без чипов Send снова выключена', async () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    expect(sendButton().disabled).toBe(true);
    await attach('/a/one.txt', '/a/two.txt');
    expect(sendButton().disabled).toBe(false);
    screen.getByTestId('chat-attach').focus();

    fireEvent.click(screen.getByRole('button', { name: S.chat.composer.removeAttachment('one.txt') }));
    expect(chipPaths()).toEqual(['/a/two.txt']);
    expect(document.activeElement).toBe(field());
    fireEvent.click(screen.getByRole('button', { name: S.chat.composer.removeAttachment('two.txt') }));
    expect(chips()).toEqual([]);
    expect(screen.queryByTestId('chat-attachments')).toBeNull();
    expect(sendButton().disabled).toBe(true);
    expect(useChatUiStore.getState().attachments[refKey(REF)]).toEqual([]);
  });

  it('Enter с текстом и вложениями — pty.send «текст @"путь" … » с submit: true; поле и чипы очищаются', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    await attach('/a/b c.png', '/a/notes.txt');
    type('what is this?');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(sends()).toEqual([{ ref: REF, text: 'what is this? @"/a/b c.png" @"/a/notes.txt" ', submit: true }]);
    expect(field().value).toBe('');
    expect(chips()).toEqual([]);
    expect(document.activeElement).toBe(field());
    // Без хода — без серого элемента: промпт придёт хуком сразу.
    expect(screen.queryByTestId('chat-queued')).toBeNull();
    await act(async () => {});
  });

  it('одни вложения без текста отправляются: Send доступна, уходят только упоминания, Enter в пустом поле — то же', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    await attach('/a/b c.png');
    fireEvent.click(sendButton());
    expect(sends()).toEqual([{ ref: REF, text: '@"/a/b c.png" ', submit: true }]);
    expect(chips()).toEqual([]);
    expect(sendButton().disabled).toBe(true);

    await attach('/a/d.txt');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(sends()).toHaveLength(2);
    expect(sends()[1]).toEqual({ ref: REF, text: '@"/a/d.txt" ', submit: true });
    await act(async () => {});
  });

  it('путь, который нельзя упомянуть (#), уходит в shell-кавычках', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    await attach('/a/Shot #1.png');
    type('look');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(sends()).toEqual([{ ref: REF, text: "look '/a/Shot #1.png' ", submit: true }]);
    await act(async () => {});
  });

  it('во время хода: Queue — серый элемент с чипом и текстом без пути; настоящий промпт его заменяет, тоже чипом', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'go')]);
    await attach('/a/notes.txt');
    type('next');
    fireEvent.click(screen.getByRole('button', { name: S.chat.composer.queue }));
    const grey = screen.getByTestId('chat-queued');
    expect(within(grey).getByTestId('chat-attachment').getAttribute('data-path')).toBe('/a/notes.txt');
    expect(grey.textContent).toContain('next');
    expect(grey.textContent).not.toContain('/a/notes.txt');
    await act(async () => {});
    expect(sends()).toEqual([{ ref: REF, text: 'next @"/a/notes.txt" ', submit: true }]);

    // Хук отдаёт промпт как набран — с упоминанием; серый уходит, чип остаётся уже в настоящем.
    setFeed([prompt('p1', 'go'), turn('u1'), prompt('p2', 'next @"/a/notes.txt" ')], 2);
    expect(screen.queryByTestId('chat-queued')).toBeNull();
    const real = screen.getAllByTestId('chat-prompt')[1]!;
    expect(within(real).getByTestId('chat-attachment').getAttribute('data-path')).toBe('/a/notes.txt');
    expect(real.textContent).toContain('next');
    expect(real.textContent).not.toContain('/a/notes.txt');
  });

  it('вложения живут в сторе по сессии: переживают Chat → Terminal → Chat и размонтирование вида', async () => {
    const view = renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    await attach('/a/notes.txt');
    view.rerender(body(makeSession('s-01', 'S01'), 'terminal'));
    expect(screen.queryByTestId('chat-view')).toBeNull();
    expect(useChatUiStore.getState().attachments[refKey(REF)]).toEqual(['/a/notes.txt']);
    view.rerender(body(makeSession('s-01', 'S01'), 'chat'));
    expect(chipPaths()).toEqual(['/a/notes.txt']);

    view.unmount();
    renderBody(makeSession('s-01', 'S01'));
    expect(chipPaths()).toEqual(['/a/notes.txt']);
  });
});

describe('ChatView — отказ отправки не теряет набранное', () => {
  const field = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: S.chat.composer.label }) as HTMLTextAreaElement;
  const type = (value: string): void => {
    fireEvent.change(field(), { target: { value } });
  };
  const chipPaths = (): Array<string | null> => screen.queryAllByTestId('chat-attachment').map((chip) => chip.getAttribute('data-path'));
  const KEY = refKey(REF);
  /** Скрепка: диалог отвечает `paths`, чипы встают после ответа. */
  async function attach(...paths: string[]): Promise<void> {
    bridge.setChosenFiles(paths);
    fireEvent.click(screen.getByTestId('chat-attach'));
    await act(async () => {});
  }
  const draft = (): string => useChatUiStore.getState().drafts[KEY] ?? '';
  const staged = (): readonly string[] => useChatUiStore.getState().attachments[KEY] ?? [];

  /** Хост отвечает на `pty.send` исходом `outcome` не сразу: до `answer()` поле уже очищено, как у любой отправки. */
  function holdSend(): { answer: (outcome: SendResult) => Promise<void> } {
    let resolve!: (value: SendResult) => void;
    bridge.setHandler(
      'pty.send',
      () =>
        new Promise<SendResult>((done) => {
          resolve = done;
        }),
    );
    return {
      answer: async (outcome) => {
        resolve(outcome);
        await act(async () => {});
      },
    };
  }

  it('поле и вложения очищаются сразу, до ответа хоста', async () => {
    const send = holdSend();
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    await attach('/a/notes.txt');
    type('draft text');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(field().value).toBe('');
    expect(chipPaths()).toEqual([]);
    expect(draft()).toBe('');
    expect(staged()).toEqual([]);
    await send.answer({ inserted: true, submitted: true, reason: null });
  });

  it.each(['blocked', 'busy', 'no-paste-mode'] as const)('хост ничего не вставил (%s) — текст и вложения вернулись в поле', async (reason) => {
    const send = holdSend();
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    await attach('/a/b c.png', '/a/notes.txt');
    type('what is this?');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(field().value).toBe('');
    await send.answer({ inserted: false, submitted: false, reason });
    // Вернулось набранное как есть: текст без упоминаний, вложения — чипами.
    expect(field().value).toBe('what is this?');
    expect(chipPaths()).toEqual(['/a/b c.png', '/a/notes.txt']);
    expect(draft()).toBe('what is this?');
    expect(staged()).toEqual(['/a/b c.png', '/a/notes.txt']);
    // Тост отказа прежний: из поля его ничто не убирает.
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('вернулось, и отправить можно снова — теперь удачно: поле пусто, вернуть больше нечего', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: false, submitted: false, reason: 'busy' }));
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    type('again please');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await act(async () => {});
    expect(field().value).toBe('again please');
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    fireEvent.keyDown(field(), { key: 'Enter' });
    await act(async () => {});
    expect(field().value).toBe('');
    expect(bridge.calls.filter((call) => call.method === 'pty.send').map((call) => call.params)).toEqual([
      { ref: REF, text: 'again please', submit: true },
      { ref: REF, text: 'again please', submit: true },
    ]);
  });

  it('ошибка вызова (хост недоступен, сессия не запущена) — тоже возврат', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.setHandler('pty.send', () => {
      throw new Error('boom');
    });
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    await attach('/a/notes.txt');
    type('lost?');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await act(async () => {});
    expect(field().value).toBe('lost?');
    expect(chipPaths()).toEqual(['/a/notes.txt']);
    vi.restoreAllMocks();
  });

  it('человек за это время начал новое сообщение — его текст не трогаем, прежнее не возвращается', async () => {
    const send = holdSend();
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    await attach('/a/old.txt');
    type('first message');
    fireEvent.keyDown(field(), { key: 'Enter' });
    type('second, typed meanwhile');
    await send.answer({ inserted: false, submitted: false, reason: 'blocked' });
    expect(field().value).toBe('second, typed meanwhile');
    // Вложения прежнего сообщения тоже не вернулись: возврат — всё или ничего.
    expect(chipPaths()).toEqual([]);
    expect(staged()).toEqual([]);
  });

  it('человек успел прикрепить файл (текст пуст) — поле занято: прежнее не возвращается', async () => {
    const send = holdSend();
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    type('first message');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await attach('/a/new.txt');
    await send.answer({ inserted: false, submitted: false, reason: 'busy' });
    expect(field().value).toBe('');
    expect(chipPaths()).toEqual(['/a/new.txt']);
  });

  it.each(['draft', 'input', 'blocked-before-enter', 'restarted'] as const)('вставлено без Enter (%s) — текст уже в поле ввода терминала: поле остаётся пустым', async (reason) => {
    const send = holdSend();
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    await attach('/a/notes.txt');
    type('pasted without enter');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await send.answer({ inserted: true, submitted: false, reason });
    expect(field().value).toBe('');
    expect(chipPaths()).toEqual([]);
    expect(draft()).toBe('');
    expect(staged()).toEqual([]);
  });

  it('успех — поле пустое; серый элемент очереди при отказе уходит, как и прежде', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    type('fine');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await act(async () => {});
    expect(field().value).toBe('');

    // Ход идёт, отказ busy: серого элемента нет, а набранное вернулось в поле.
    bridge.setHandler('pty.send', () => ({ inserted: false, submitted: false, reason: 'busy' }));
    setFeed([prompt('p1', 'go')]);
    type('queued then refused');
    fireEvent.click(screen.getByRole('button', { name: S.chat.composer.queue }));
    await waitFor(() => expect(screen.queryByTestId('chat-queued')).toBeNull());
    expect(field().value).toBe('queued then refused');
  });

  it('вид размонтирован до ответа хоста — набранное возвращается в стор и ждёт нового монтирования', async () => {
    const send = holdSend();
    const view = renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    type('typed before leaving');
    fireEvent.keyDown(field(), { key: 'Enter' });
    view.unmount();
    await send.answer({ inserted: false, submitted: false, reason: 'blocked' });
    expect(draft()).toBe('typed before leaving');
    renderBody(makeSession('s-01', 'S01'));
    expect(field().value).toBe('typed before leaving');
  });
});

describe('ChatView — агенты: тулбар, прокрутка к карточке, heldByBackground (кусок 4b)', () => {
  const KEY = refKey(REF);
  const field = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: S.chat.composer.label }) as HTMLTextAreaElement;
  const agent = (id: string, agentId: string | null, status: 'running' | 'done' | 'failed' = 'running'): FeedItem => ({
    id,
    at: AT,
    kind: 'agent',
    toolUseId: `tu-${id}`,
    agentId,
    agentType: 'Explore',
    description: `Agent ${id}`,
    prompt: null,
    model: null,
    background: true,
    status,
    toolCount: 0,
    children: [],
  });
  const running = (): HTMLElement | null => screen.queryByTestId('chat-agents-running');

  /** Строки ленты по 100px: с ними видно, к какой именно карточке прокрутили (`offsetHeight` — так мерит virtual-core). */
  function rowHeights(): void {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute('data-testid') === 'chat-feed' ? 600 : this.hasAttribute('data-index') ? 100 : 0;
      },
    });
  }
  /** Прокрутчик: `scrollTo` запоминает смещение; событие `scroll` — отдельной задачей, как в браузере. */
  function scroller(): { scrollTo: ReturnType<typeof vi.fn>; top: () => number } {
    const el = screen.getByTestId('chat-feed');
    let top = 0;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 5000 });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 });
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { top = value; } });
    const scrollTo = vi.fn((options: { top: number }) => {
      top = options.top;
      queueMicrotask(() => el.dispatchEvent(new Event('scroll')));
    });
    (el as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo;
    return { scrollTo, top: () => top };
  }
  const feedWithAgents = (): FeedItem[] => [
    prompt('p1', 'go'),
    text('t1', 'one'),
    agent('a0', 'g0', 'done'),
    agent('a1', 'g1'),
    text('t2', 'two'),
    agent('a2', 'g2'),
    turn('u1'),
  ];

  it('«N agents running» — по карточкам со статусом running: «1 agent running», «2 agents running»; готовые не в счёт; нет работающих — кнопки нет', () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'go'), agent('a0', 'g0', 'done'), agent('a9', 'g9', 'failed'), turn('u1')]);
    expect(running()).toBeNull();
    setFeed([prompt('p1', 'go'), agent('a1', 'g1'), turn('u1')], 2);
    expect(running()?.textContent).toBe('1 agent running');
    setFeed(feedWithAgents(), 3);
    expect(running()?.textContent).toBe('2 agents running');
    expect(screen.getByTestId('chat-toolbar').contains(running())).toBe(true);
    setFeed([...feedWithAgents().slice(0, 3), agent('a1', 'g1', 'done'), agent('a2', 'g2', 'done'), turn('u1')], 4);
    expect(running()).toBeNull();
  });

  it('клик по «N agents running» ставит просьбу про первую работающую карточку, и лента прокручивает к ней, погасив просьбу', async () => {
    rowHeights();
    renderBody(makeSession('s-01', 'S01'));
    setFeed(feedWithAgents());
    const feed = scroller();
    const request = vi.spyOn(useChatUiStore.getState(), 'requestReveal');
    fireEvent.click(running()!);
    await act(async () => {});
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(KEY, 'g1');
    // Первая работающая — четвёртая строка: три по 100px над ней.
    expect(feed.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 300 }));
    expect(useChatUiStore.getState().reveal).toBeNull();
    // Прилипание к низу снято: человек читает выше.
    expect(screen.getByRole('button', { name: S.chat.jumpToLatest })).toBeTruthy();
  });

  it('у первой работающей карточки agentId ещё нет (SubagentStart не пришёл) — берётся следующая; ни у одной нет — просьбы нет', async () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'go'), agent('a1', null), agent('a2', 'g2'), turn('u1')]);
    const request = vi.spyOn(useChatUiStore.getState(), 'requestReveal');
    fireEvent.click(running()!);
    expect(request).toHaveBeenCalledWith(KEY, 'g2');
    setFeed([prompt('p1', 'go'), agent('a1', null), turn('u1')], 2);
    request.mockClear();
    fireEvent.click(running()!);
    expect(request).not.toHaveBeenCalled();
    await act(async () => {});
  });

  it('просьба, поставленная до монтирования вида (вкладку только что открыли), исполняется, когда лента готова', async () => {
    rowHeights();
    useChatUiStore.getState().requestReveal(KEY, 'g2');
    renderBody(makeSession('s-01', 'S01'));
    const feed = scroller();
    // Снимок ещё не пришёл — просьба ждёт.
    expect(useChatUiStore.getState().reveal).toMatchObject({ sessionKey: KEY, agentId: 'g2' });
    expect(feed.scrollTo).not.toHaveBeenCalled();
    act(() => {
      useFeedStore.setState({ feeds: { [KEY]: { items: feedWithAgents(), revision: 1, mode: null, status: 'ready' } } });
    });
    await act(async () => {});
    // Строки только что появились и не измерены — точное смещение виртуализатор доведёт сам, здесь важно, что прокрутка была.
    expect(feed.scrollTo).toHaveBeenCalledTimes(1);
    expect(useChatUiStore.getState().reveal).toBeNull();
    expect(screen.getByRole('button', { name: S.chat.jumpToLatest })).toBeTruthy();
  });

  it('просьба про другую сессию лентой этой сессии не исполняется и не гасится', async () => {
    rowHeights();
    useChatUiStore.getState().requestReveal(refKey({ ...REF, sessionId: 's-99' }), 'g1');
    renderBody(makeSession('s-01', 'S01'));
    setFeed(feedWithAgents());
    const feed = scroller();
    await act(async () => {});
    expect(feed.scrollTo).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: S.chat.jumpToLatest })).toBeNull();
    expect(useChatUiStore.getState().reveal).toMatchObject({ sessionKey: refKey({ ...REF, sessionId: 's-99' }), agentId: 'g1' });
  });

  it('просьба про карточку, которой в этой ленте нет, ждёт: ни прокрутки, ни «Jump to latest»; карточка появилась — прокрутка', async () => {
    rowHeights();
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'go'), turn('u1')]);
    const feed = scroller();
    act(() => useChatUiStore.getState().requestReveal(KEY, 'g1'));
    await act(async () => {});
    expect(feed.scrollTo).not.toHaveBeenCalled();
    expect(useChatUiStore.getState().reveal).toMatchObject({ agentId: 'g1' });
    setFeed([prompt('p1', 'go'), agent('a1', 'g1'), turn('u1')], 2);
    await act(async () => {});
    expect(feed.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 100 }));
    expect(useChatUiStore.getState().reveal).toBeNull();
  });

  it('heldByBackground: лента кончилась turn, сессию держат фоновые субагенты — Stop нет, «Send» а не «Queue», поле открыто и отправляет', async () => {
    useActivityStore.setState({ byRef: activityMap([makeActivity(REF, 'working', { heldByBackground: true })]), loaded: true });
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'explore'), agent('a1', 'g1'), agent('a2', 'g2'), turn('u1')]);
    expect(running()?.textContent).toBe('2 agents running');
    expect(screen.queryByTestId('chat-stop')).toBeNull();
    expect(screen.queryByTestId('chat-working')).toBeNull();
    expect(field().disabled).toBe(false);
    expect(screen.getAllByRole('button', { name: S.chat.composer.send })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: S.chat.composer.queue })).toBeNull();

    fireEvent.change(field(), { target: { value: 'meanwhile, a question' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    await act(async () => {});
    expect(bridge.calls.filter((call) => call.method === 'pty.send').map((call) => call.params)).toEqual([
      { ref: REF, text: 'meanwhile, a question', submit: true },
    ]);
    // Без хода — без серого элемента: промпт придёт хуком сразу.
    expect(screen.queryByTestId('chat-queued')).toBeNull();
  });

  it('родитель проснулся по <task-notification> и работает сам (идущий вызов) — Stop на месте, как у любого хода', () => {
    useActivityStore.setState({ byRef: activityMap([makeActivity(REF, 'working')]), loaded: true });
    renderBody(makeSession('s-01', 'S01'));
    setFeed([
      prompt('p1', 'explore'),
      agent('a1', 'g1', 'done'),
      turn('u1'),
      { id: 'tool1', at: AT, kind: 'tool', toolUseId: 'tu1', name: 'Bash', input: {}, status: 'running' },
    ]);
    expect(screen.getByTestId('chat-stop')).toBeTruthy();
    expect(running()).toBeNull();
  });
});
