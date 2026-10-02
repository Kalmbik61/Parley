/**
 * Лента вида «Chat» (ревью куска 3): дельта, меняющая один текст, перерисовывает одну строку (строка —
 * `memo`, обработчики стабильны); транскрипт субагента лента держит по `id` карточки — строка ушла из
 * DOM и вернулась, а транскрипт на месте без второго запроса; показ — последние 200 с пометкой.
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

function feed(items: readonly FeedItem[], working?: { since: string | null }): JSX.Element {
  return (
    <ChatEnvContext.Provider value={{ bridge, sessionRef: REF }}>
      <FeedList items={items} queued={[]} note={null} {...(working === undefined ? {} : { working })} />
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
