/**
 * Лента вида «Chat» (ревью куска 3): дельта, меняющая один текст, перерисовывает одну строку (строка —
 * `memo`, обработчики стабильны); транскрипт субагента лента держит по `id` карточки — строка ушла из
 * DOM и вернулась, а транскрипт на месте без второго запроса; показ — последние 200 с пометкой.
 * Кусок 4b: просьба показать карточку агента — прокрутка к ней, снятое прилипание к низу, просьба гаснет.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { FeedAgent, FeedItem } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { ChatEnvContext } from './chat-env.js';
import { FeedList } from './FeedList.js';
import { TRANSCRIPT_TAIL } from './items/AgentItem.js';

/** Сколько раз рисовался текст каждого элемента — по `id`. */
const textRenders = vi.hoisted(() => new Map<string, number>());

vi.mock('./items/TextItem.js', () => ({
  TextItem: ({ item }: { item: { id: string; text: string } }) => {
    textRenders.set(item.id, (textRenders.get(item.id) ?? 0) + 1);
    return <div data-testid="chat-text">{item.text}</div>;
  },
}));

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const AT = '2026-10-01T00:00:00.000Z';
const text = (id: string, body: string): FeedItem => ({ id, at: AT, kind: 'text', messageId: id, text: body, streaming: false });

let bridge: FakeBridge;

function feed(
  items: readonly FeedItem[],
  working?: { since: string | null },
  reveal?: { request: { agentId: string; nonce: number }; onRevealed: (nonce: number) => void },
): JSX.Element {
  return (
    <ChatEnvContext.Provider value={{ bridge, sessionRef: REF }}>
      <FeedList
        items={items}
        queued={[]}
        note={null}
        {...(working === undefined ? {} : { working })}
        {...(reveal === undefined ? {} : { reveal: reveal.request, onRevealed: reveal.onRevealed })}
      />
    </ChatEnvContext.Provider>
  );
}

const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
beforeEach(() => {
  // virtual-core мерит прокрутчик `offsetHeight` (в jsdom — 0, и список был бы пуст).
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('data-testid') === 'chat-feed' ? 600 : 0;
    },
  });
  bridge = createFakeBridge();
  textRenders.clear();
});

afterEach(() => {
  cleanup();
  if (originalOffsetHeight !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
});

describe('FeedList — перерисовка по дельте', () => {
  it('дельта меняет один текст — перерисована одна строка, остальные нет', () => {
    const first = [text('a', 'one'), text('b', 'two'), text('c', 'three')];
    const view = render(feed(first));
    expect(Object.fromEntries(textRenders)).toEqual({ a: 1, b: 1, c: 1 });
    textRenders.clear();
    // Как `applyDelta`: новый массив, у нетронутых элементов — прежние ссылки.
    view.rerender(feed([first[0]!, text('b', 'two, longer'), first[2]!]));
    expect(Object.fromEntries(textRenders)).toEqual({ b: 1 });
    expect(screen.getAllByTestId('chat-text').map((row) => row.textContent)).toEqual(['one', 'two, longer', 'three']);
  });
});

function agent(): FeedAgent {
  return {
    id: 'ag',
    at: AT,
    kind: 'agent',
    toolUseId: 'tu-a',
    agentId: 'sub1',
    agentType: 'Explore',
    description: 'Look around',
    prompt: null,
    model: null,
    background: false,
    status: 'done',
    toolCount: 0,
    children: [],
  };
}

describe('FeedList — транскрипт субагента', () => {
  it('держится по id: строка ушла из DOM и вернулась — транскрипт показан без второго feed.snapshot', async () => {
    bridge.setHandler('feed.snapshot', () => ({ items: [text('s1', 'sub says hi')], revision: 0, schemaVersion: 1 }));
    const view = render(feed([agent()]));
    fireEvent.click(screen.getByRole('button', { name: S.chat.agent.details }));
    fireEvent.click(screen.getByRole('button', { name: S.chat.showTranscript }));
    expect((await screen.findByTestId('chat-agent-transcript')).textContent).toBe('sub says hi');

    view.rerender(feed([text('x', 'other')]));
    expect(screen.queryByTestId('chat-agent')).toBeNull();
    view.rerender(feed([agent()]));
    expect(screen.getByTestId('chat-agent-transcript').textContent).toBe('sub says hi');
    expect(bridge.calls.filter((call) => call.method === 'feed.snapshot')).toHaveLength(1);
  });

  it(`длинный транскрипт — последние ${TRANSCRIPT_TAIL} с пометкой «Showing the last 200 of N»`, async () => {
    const items = Array.from({ length: 250 }, (_, at) => text(`s${at}`, `line ${at}`));
    bridge.setHandler('feed.snapshot', () => ({ items, revision: 0, schemaVersion: 1 }));
    render(feed([agent()]));
    fireEvent.click(screen.getByRole('button', { name: S.chat.agent.details }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: S.chat.showTranscript }));
    });
    const area = await screen.findByTestId('chat-agent-transcript');
    expect(within(area).getByTestId('chat-agent-transcript-tail').textContent).toBe('Showing the last 200 of 250');
    const rows = [...area.children].slice(1).map((row) => row.textContent);
    expect(rows).toHaveLength(TRANSCRIPT_TAIL);
    expect(rows[0]).toBe('line 50');
    expect(rows.at(-1)).toBe('line 249');
  });
});

describe('FeedList — строка «Working…» (живая проверка 2026-10-02)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('без working строки нет; с working — спиннер, подпись и прошедшее время, раз в секунду', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:13.000Z'));
    const view = render(feed([text('a', 'one')]));
    expect(screen.queryByTestId('chat-working')).toBeNull();
    view.rerender(feed([text('a', 'one')], { since: AT }));
    expect(screen.getByTestId('chat-working').textContent).toBe(`${S.chat.working} 13s`);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId('chat-working').textContent).toBe(`${S.chat.working} 15s`);
    // Прокручивается вместе с лентой: строка внутри прокручиваемой области.
    expect(screen.getByTestId('chat-feed').contains(screen.getByTestId('chat-working'))).toBe(true);
  });

  it('since null — без времени', () => {
    render(feed([text('a', 'one')], { since: null }));
    expect(screen.getByTestId('chat-working').textContent).toBe(S.chat.working);
  });
});

describe('FeedList — просьба показать карточку агента (кусок 4b)', () => {
  const ROW_PX = 100;
  const card = (id: string, agentId: string | null, status: FeedAgent['status'] = 'running'): FeedAgent => ({ ...agent(), id, agentId, status });
  const items = (): FeedItem[] => [text('a', 'one'), text('b', 'two'), text('c', 'three'), card('ag1', 'sub1'), text('d', 'four'), card('ag2', 'sub2', 'done')];

  /**
   * Прокрутчик в jsdom: высоты строк и ленты задаются руками, `scrollTo` запоминает смещение и шлёт `scroll`, как браузер
   * (виртуализатор после прокрутки сверяет положение по событию, иначе повторял бы её до предела попыток). Событие — позже
   * самой прокрутки, не внутри неё: браузер шлёт его отдельной задачей, а синхронное событие внутри эффекта ленты
   * заставило бы виртуализатор перерисовываться из жизненного цикла React.
   */
  function fakeScroller(): { scrollTo: ReturnType<typeof vi.fn>; top: () => number } {
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
  const settle = (): Promise<void> => act(async () => {});

  // Высота строки — `offsetHeight` (так её мерит virtual-core): внешний `beforeEach` оставил её только прокрутчику.
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute('data-testid') === 'chat-feed' ? 600 : this.hasAttribute('data-index') ? ROW_PX : 0;
      },
    });
  });

  it('находит карточку по agentId среди строк, прокручивает к ней (начало карточки у верха) и гасит просьбу с её nonce', async () => {
    const onRevealed = vi.fn();
    const view = render(feed(items()));
    const scroller = fakeScroller();
    view.rerender(feed(items(), undefined, { request: { agentId: 'sub2', nonce: 7 }, onRevealed }));
    await settle();
    // Строки 0–4 по 100px до карточки sub2 — она шестая.
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 5 * ROW_PX }));
    expect(onRevealed).toHaveBeenCalledTimes(1);
    expect(onRevealed).toHaveBeenCalledWith(7);
  });

  it('прилипание к низу снято: «Jump to latest» появилась, а новый элемент ленту обратно не уводит', async () => {
    const view = render(feed(items()));
    const scroller = fakeScroller();
    view.rerender(feed(items(), undefined, { request: { agentId: 'sub1', nonce: 1 }, onRevealed: vi.fn() }));
    await settle();
    expect(scroller.top()).toBe(3 * ROW_PX);
    expect(screen.getByRole('button', { name: S.chat.jumpToLatest })).toBeTruthy();
    view.rerender(feed([...items(), text('e', 'five')]));
    await settle();
    expect(scroller.top()).toBe(3 * ROW_PX);
  });

  it('карточки ещё нет (снимок вкладки не пришёл) — просьба ждёт: ни прокрутки, ни onRevealed; карточка пришла — исполняется', async () => {
    const onRevealed = vi.fn();
    const request = { agentId: 'sub1', nonce: 3 };
    const view = render(feed([text('a', 'one')], undefined, { request, onRevealed }));
    const scroller = fakeScroller();
    view.rerender(feed([text('a', 'one'), text('b', 'two')], undefined, { request, onRevealed }));
    expect(scroller.scrollTo).not.toHaveBeenCalled();
    expect(onRevealed).not.toHaveBeenCalled();
    view.rerender(feed([text('a', 'one'), text('b', 'two'), card('ag1', 'sub1')], undefined, { request, onRevealed }));
    await settle();
    expect(scroller.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 2 * ROW_PX }));
    expect(onRevealed).toHaveBeenCalledWith(3);
  });

  it('чужой agentId, карточка без agentId и не агент с таким же id — не та карточка: просьба ждёт', () => {
    const onRevealed = vi.fn();
    const view = render(feed([card('ag1', null), card('ag2', 'other'), text('sub1', 'sub1')]));
    const scroller = fakeScroller();
    view.rerender(feed([card('ag1', null), card('ag2', 'other'), text('sub1', 'sub1')], undefined, { request: { agentId: 'sub1', nonce: 1 }, onRevealed }));
    expect(scroller.scrollTo).not.toHaveBeenCalled();
    expect(onRevealed).not.toHaveBeenCalled();
  });

  it('без просьбы лента сама не прокручивается к карточкам', () => {
    const view = render(feed(items()));
    const scroller = fakeScroller();
    view.rerender(feed(items()));
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });
});
