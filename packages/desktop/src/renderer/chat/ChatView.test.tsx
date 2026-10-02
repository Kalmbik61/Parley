/**
 * Тело вкладки сессии и вид «Chat» (план 2026-10-01, Task 3): какой вид рисует `TerminalBody`, сегмент
 * «Chat | Terminal» (3a); лента с автопрокруткой и «Jump to latest», поле ввода (Enter, Shift+Enter,
 * Queue и серый элемент очереди), модель и Stop в тулбаре (3b).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FeedItem, WorkSession } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import type { TerminalView } from '../../shared/layout-types.js';
import { TerminalBody } from '../layout/bodies/TerminalBody.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { useHostStore } from '../store/host.js';
import { useProvidersStore } from '../store/providers.js';
import { useUiStore } from '../store/ui.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { makeSession } from '../test-utils/work-fixtures.js';
import type { SendWithToastDeps } from '../terminal/send.js';
import { resetFeedStoreForTests, useFeedStore } from './store.js';

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const FEED_METHODS = [...REQUIRED_METHODS, 'feed.snapshot', 'feed.subscribe', 'feed.unsubscribe'];

function hostWith(methods: string[]): void {
  useHostStore.setState({ status: { state: 'connected', hostVersion: '0.3.0', methods } });
}

let bridge: FakeBridge;
let sendDeps: SendWithToastDeps;

function renderBody(session: WorkSession, view?: TerminalView): void {
  const tab = view === undefined
    ? { kind: 'terminal' as const, id: 'terminal:s-01', sessionId: 's-01' }
    : { kind: 'terminal' as const, id: 'terminal:s-01', sessionId: 's-01', view };
  render(
    <TerminalBody workKey="/tmp/p w-01" tab={tab} session={session} sessionRef={REF} active bridge={bridge} sendDeps={sendDeps} />,
  );
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
  hostWith(FEED_METHODS);
  useProvidersStore.setState({ providers: [] });
  useUiStore.setState({ visibleSessionRefs: {} });
});

afterEach(() => {
  cleanup();
  if (originalOffsetHeight !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
  resetFeedStoreForTests();
  useHostStore.setState({ status: { state: 'connecting' } });
  useProvidersStore.setState({ providers: [] });
});

describe('TerminalBody — вид вкладки', () => {
  it('Claude без поля view — ChatView с тулбаром, выбран Chat; сессия видима', () => {
    renderBody(makeSession('s-01', 'S01'));
    expect(screen.getByTestId('chat-view')).toBeTruthy();
    expect(screen.queryByTestId('terminal-body')).toBeNull();
    expect(segment('Chat').getAttribute('aria-checked')).toBe('true');
    expect(segment('Terminal').getAttribute('aria-checked')).toBe('false');
    expect(useUiStore.getState().visibleSessionRefs[refKey(REF)]).toBe(true);
  });

  it('view terminal — заглушка под поверхность с тулбаром, выбран Terminal', () => {
    renderBody(makeSession('s-01', 'S01'), 'terminal');
    expect(screen.queryByTestId('chat-view')).toBeNull();
    expect(screen.getByTestId('terminal-body')).toBeTruthy();
    expect(segment('Terminal').getAttribute('aria-checked')).toBe('true');
    // Видимость сессии в терминале ставит поверхность, не тело.
    expect(useUiStore.getState().visibleSessionRefs[refKey(REF)]).toBeUndefined();
  });

  it('codex — терминал, сегмент выключен с подсказкой', () => {
    renderBody(makeSession('s-01', 'S01', { provider: 'codex' }), 'chat');
    expect(screen.getByTestId('terminal-body')).toBeTruthy();
    expect((segment('Chat') as HTMLButtonElement).disabled).toBe(true);
    expect((segment('Terminal') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTitle(S.chat.terminalOnly)).toBeTruthy();
  });

  it('старый claude (2.1.280) — терминал с выключенным сегментом', () => {
    useProvidersStore.setState({
      providers: [{ id: 'claude', label: 'Claude Code', available: true, version: '2.1.280', limits: null }],
    });
    renderBody(makeSession('s-01', 'S01'));
    expect(screen.getByTestId('terminal-body')).toBeTruthy();
    expect((segment('Chat') as HTMLButtonElement).disabled).toBe(true);
  });

  it('хост без feed.snapshot — заглушка без тулбара и сегмента', () => {
    hostWith([...REQUIRED_METHODS]);
    renderBody(makeSession('s-01', 'S01'), 'chat');
    expect(screen.getByTestId('terminal-body')).toBeTruthy();
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
    useFeedStore.setState({ feeds: { [refKey(REF)]: { items, revision, status: 'ready' } } });
  });
}

/** Прокрутчик ленты в jsdom: высоты задаются руками, `scrollTop` запоминается (у jsdom он всегда 0). */
function fakeScroller(): { el: HTMLElement; top: () => number; scrollTo: (value: number) => void } {
  const el = screen.getByTestId('chat-feed');
  let top = 0;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 2000 });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 });
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { top = value; } });
  return {
    el,
    top: () => top,
    scrollTo: (value) => {
      top = value;
      fireEvent.scroll(el);
    },
  };
}

describe('ChatView — лента', () => {
  it('пока снимка нет — Loading; ошибка — подсказка открыть терминал', () => {
    renderBody(makeSession('s-01', 'S01'));
    expect(screen.getByText(S.chat.loading)).toBeTruthy();
    act(() => {
      useFeedStore.setState({ feeds: { [refKey(REF)]: { items: [], revision: 0, status: 'error', error: 'boom' } } });
    });
    expect(screen.getByText(S.chat.feedUnavailable)).toBeTruthy();
  });

  it('элементы ленты рисуются своими видами', () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'hi'), text('t1', 'hello there'), turn('u1')]);
    expect(screen.getByTestId('chat-prompt').textContent).toContain('hi');
    expect(screen.getByTestId('chat-text').textContent).toContain('hello there');
    expect(screen.getByTestId('chat-turn')).toBeTruthy();
  });

  it('у низа — новое прижимается к низу; прокрутили вверх — не дёргаем, «Jump to latest» возвращает', () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'one')]);
    const scroller = fakeScroller();

    setFeed([prompt('p1', 'one'), text('t1', 'two')], 2);
    expect(scroller.top()).toBe(2000);
    expect(screen.queryByRole('button', { name: S.chat.jumpToLatest })).toBeNull();

    scroller.scrollTo(100);
    const jump = screen.getByRole('button', { name: S.chat.jumpToLatest });
    setFeed([prompt('p1', 'one'), text('t1', 'two'), turn('u1')], 3);
    expect(scroller.top()).toBe(100);

    fireEvent.click(jump);
    expect(scroller.top()).toBe(2000);
    expect(screen.queryByRole('button', { name: S.chat.jumpToLatest })).toBeNull();
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
    expect(screen.getByTestId('chat-queued')).toBeTruthy();

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
});
