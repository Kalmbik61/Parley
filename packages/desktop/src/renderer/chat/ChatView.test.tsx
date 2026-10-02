/**
 * Тело вкладки сессии и вид «Chat» (план 2026-10-01, Task 3): какой вид рисует `TerminalBody`, сегмент
 * «Chat | Terminal» (3a); лента с автопрокруткой и «Jump to latest», поле ввода (Enter, Shift+Enter,
 * Queue и серый элемент очереди), модель и Stop в тулбаре (3b). Правки по ревью куска 3: версия `claude`
 * неизвестна — терминал, до ответа `providers.list` — вид не выбран; черновик, очередь и фокус поля
 * переживают смену вида; ход только у живой сессии; Retry после ошибки ленты; без тоста успеха.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FeedItem, WorkSession } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
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
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { activityMap, makeActivity, makeSession } from '../test-utils/work-fixtures.js';
import type { SendWithToastDeps } from '../terminal/send.js';
import { resetFeedStoreForTests, useFeedStore } from './store.js';
import { resetChatUiStoreForTests, useChatUiStore } from './ui-store.js';

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

  it('Stop виден только во время хода и шлёт Esc через pty.input', () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'go'), turn('u1')]);
    expect(screen.queryByRole('button', { name: S.chat.stop })).toBeNull();
    setFeed([prompt('p1', 'go'), turn('u1'), prompt('p2', 'again')], 2);
    fireEvent.click(screen.getByRole('button', { name: S.chat.stop }));
    expect(bridge.notified).toContainEqual({ method: 'pty.input', params: { ref: REF, data: '\x1b' } });
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
    setMode('bypassPermissions');
    expect(trigger().textContent).toBe('bypassPermissions');
  });

  it('пункты Manual, Accept edits, Plan; текущий отмечен; выбор зовёт sessions.setMode', async () => {
    hostWith(MODE_METHODS);
    bridge.setHandler('sessions.setMode', () => ({ mode: 'plan', verified: true }));
    renderBody(makeSession('s-01', 'S01'));
    setMode('default');
    openMenu();
    expect(options().map((option) => option.dataset.mode)).toEqual(['default', 'acceptEdits', 'plan']);
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
