/**
 * История выбранной комнаты (P35): хост присылает хвост писем, старше — кнопка над лентой подгружает страницы
 * `context.messages`; письма встают на свои места, счётчик на кнопке честный, а ленту это не прижимает к низу.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import type { MapCompact, Message, WorkEntry } from '@parley/core';
import { REQUIRED_METHODS } from '../../lib/capabilities.js';
import { useHostStore } from '../../store/host.js';
import { useRoomPagesStore } from '../../store/room-pages.js';
import { useUiStore } from '../../store/ui.js';
import { useWorksStore } from '../../store/works.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { makeLetter, makeRoom, makeSession, makeWork } from '../../test-utils/work-fixtures.js';
import { RoomPanel } from './RoomPanel.js';

vi.mock('sonner', async (importOriginal) => ({ ...(await importOriginal<typeof import('sonner')>()), toast: vi.fn() }));

const PROJECT = '/tmp/proj';
const note = (id: string, text: string): Message =>
  makeLetter(id, { roomId: 'r-01', to: [], from: 's-01', readBy: { human: 'x' }, text, at: `2026-09-27T09:00:${id.slice(2)}.000Z` });

function entry(messages: Message[], total: number, tailFrom: number | null): WorkEntry {
  const base = makeWork('w-01', {
    projectPath: PROJECT,
    sessions: [makeSession('s-01', 'архитектор')],
    rooms: [{ ...makeRoom('r-01', 'Возвраты'), members: ['s-01'], lead: 's-01' }],
    messages,
  });
  const compact: MapCompact = {
    version: 1,
    messages: { total, included: messages.length, latestId: `m-${total}`, rooms: { 'r-01': { total, included: messages.length, tailFrom } } },
    unread: { letters: 0, rooms: {} },
    cut: [],
    omitted: {},
  };
  return { ...base, map: { ...base.map, compact } };
}

/** Панель читает работу из стора, как в окне: подгруженные письма доходят до неё через `addMessages`. */
function Live({ bridge }: { bridge: FakeBridge }): JSX.Element | null {
  const current = useWorksStore((state) => state.entries[0]);
  if (current === undefined) return null;
  return (
    <RoomPanel
      entry={current}
      roomId="r-01"
      providers={[{ id: 'claude', label: 'Claude' }]}
      activity={{}}
      bridge={bridge}
      active
      onOpenExternal={vi.fn()}
      onOpenSession={vi.fn()}
    />
  );
}

let bridge: FakeBridge;

beforeEach(() => {
  bridge = createFakeBridge();
  useUiStore.setState({ composerDrafts: {}, windowFocused: true, documentVisible: true });
  useHostStore.setState({ status: { state: 'connected', hostVersion: 'test', methods: [...REQUIRED_METHODS, 'context.messages'] } });
  useRoomPagesStore.setState({ chains: {}, loading: {} });
  useWorksStore.setState({ entries: [], branches: {}, loading: false, error: null });
  vi.mocked(toast).mockClear();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

const earlierButton = (): HTMLElement | null => document.querySelector('[data-room-earlier]');

describe('RoomPanel: история старше хвоста', () => {
  it('кнопка называет, сколько писем ещё за окном; клик подгружает страницу перед хвостом, письма встают выше, счётчик убывает', async () => {
    const calls: unknown[] = [];
    bridge.setHandler('context.messages', (params) => {
      calls.push(params);
      return { messages: [note('m-04', 'четвёртое'), note('m-05', 'пятое')], page: { total: 7, returned: 2, complete: false, next: 'before:4', bytes: 10, cut: 0 } };
    });
    useWorksStore.setState({ entries: [entry([note('m-06', 'шестое'), note('m-07', 'седьмое')], 7, 6)] });
    render(<Live bridge={bridge} />);

    expect(earlierButton()?.textContent).toBe('Show earlier messages (5)');
    expect(screen.queryByText('четвёртое')).toBeNull();

    await act(async () => {
      fireEvent.click(earlierButton()!);
    });
    await waitFor(() => expect(screen.getByText('четвёртое')).toBeDefined());
    expect(calls).toEqual([{ projectPath: PROJECT, workId: 'w-01', roomId: 'r-01', cursor: 'before:6' }]);
    expect(earlierButton()?.textContent).toBe('Show earlier messages (3)');
    // Подгруженные письма лежат выше хвоста, по порядку.
    const order = [...document.querySelectorAll('[data-message-id]')].map((node) => (node as HTMLElement).dataset.messageId);
    expect(order).toEqual(['m-04', 'm-05', 'm-06', 'm-07']);
    // Это история, а не новое снизу: кнопки «↓N» нет.
    expect(document.querySelector('[data-room-new-below]')).toBeNull();
  });

  it('все письма комнаты уже в окне — кнопки нет; хост без context.messages — тоже', () => {
    useWorksStore.setState({ entries: [entry([note('m-01', 'раз'), note('m-02', 'два')], 2, 1)] });
    const view = render(<Live bridge={bridge} />);
    expect(earlierButton()).toBeNull();
    view.unmount();

    useWorksStore.setState({ entries: [entry([note('m-06', 'шестое')], 6, 6)] });
    useHostStore.setState({ status: { state: 'connected', hostVersion: 'test', methods: [...REQUIRED_METHODS] } });
    render(<Live bridge={bridge} />);
    expect(earlierButton()).toBeNull();
  });

  it('отказ хоста — тост с причиной, кнопка остаётся и работает снова', async () => {
    let fail = true;
    bridge.setHandler('context.messages', () => {
      if (fail) throw { code: 'internal', message: 'нет' };
      return { messages: [note('m-05', 'пятое')], page: { total: 6, returned: 1, complete: true, next: null, bytes: 1, cut: 0 } };
    });
    useWorksStore.setState({ entries: [entry([note('m-06', 'шестое')], 6, 6)] });
    render(<Live bridge={bridge} />);

    await act(async () => {
      fireEvent.click(earlierButton()!);
    });
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(String(vi.mocked(toast).mock.calls[0]?.[0])).toContain('load earlier messages');
    expect(earlierButton()?.textContent).toBe('Show earlier messages (5)');

    fail = false;
    await act(async () => {
      fireEvent.click(earlierButton()!);
    });
    await waitFor(() => expect(screen.getByText('пятое')).toBeDefined());
    expect(earlierButton()?.textContent).toBe('Show earlier messages (4)');
  });
});
