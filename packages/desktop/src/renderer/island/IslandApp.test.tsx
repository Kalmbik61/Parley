/**
 * Проводка острова на подставном мосту: новый запрос выбирается в карточке (а не остаётся прежний), «×» прячет окно, а
 * новый запрос возвращает его, корень не сжимается до ширины окна. Настоящие таймеры: цепочка «событие → снимок ленты
 * → карточка» идёт через промисы и React, пауза кнопок решения проверена в `IslandView.test.tsx`.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedCard } from '@parley/core';
import type { IslandApi, IslandBridge } from '../../shared/island.js';
import { useActivityStore } from '../store/activity.js';
import { useWorksStore } from '../store/works.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { makeActivity, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { IslandApp } from './IslandApp.js';
import { useIslandRequests } from './requests.js';

const PROJECT = '/tmp/proj';
const ref = (sessionId: string) => ({ projectPath: PROJECT, workId: 'w-1', sessionId });
const ENTRIES = [makeWork('w-1', { projectPath: PROJECT, sessions: [makeSession('s-01', 'a'), makeSession('s-02', 'b')] })];

function permission(cardId: string, command: string): FeedCard {
  return {
    id: cardId, at: '2026-10-12T10:00:00.000Z', kind: 'permission', cardId, state: 'pending', toolUseId: null,
    toolName: 'Bash', toolInput: { command }, suggestions: [], notified: false,
  };
}

const CARDS: Record<string, FeedCard[]> = { 's-01': [permission('c-1', 'rm -rf build')], 's-02': [permission('c-2', 'ls')] };

// jsdom не знает ResizeObserver — корень острова заводит его при монтировании, чтобы сообщать размер в main.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function islandApi(): IslandApi {
  return {
    config: vi.fn(async () => ({ sound: false, hintShown: true, topInset: 0 })),
    onConfig: vi.fn(() => () => undefined),
    setSize: vi.fn(), setVisible: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(), open: vi.fn(), beep: vi.fn(), hintShown: vi.fn(),
  };
}

/** Мост острова поверх подставного моста окна: хост «подключён», `works.list` и `feed.snapshot` отвечают из таблиц выше. */
function setup() {
  const fake = createFakeBridge();
  fake.setHandler('works.list', () => ({ entries: ENTRIES, branches: {} }) as never);
  fake.setHandler('feed.snapshot', ({ ref: target }) => ({ items: CARDS[target.sessionId] ?? [], revision: 1, mode: null, decisions: 'window' }) as never);
  const island = islandApi();
  const bridge: IslandBridge = { call: fake.call, on: fake.on, onStatus: fake.onStatus, activitySnapshot: fake.activitySnapshot, island };
  const blocked = (sessionId: string): void => {
    act(() => {
      fake.emit('activity.changed', makeActivity(ref(sessionId), 'blocked'));
    });
  };
  return { island, bridge, blocked };
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  useIslandRequests.getState().clear();
  useWorksStore.setState({ entries: [], branches: {}, loading: true, error: null });
  useActivityStore.setState({ byRef: {}, loaded: false });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('проводка острова', () => {
  it('новый запрос выбирается в карточке: прежний на экране не остаётся', async () => {
    const { bridge, blocked } = setup();
    render(<IslandApp bridge={bridge} />);
    blocked('s-01');
    expect(await screen.findByTitle('Run: rm -rf build')).toBeTruthy();
    blocked('s-02');
    expect(await screen.findByTitle('Run: ls')).toBeTruthy();
    expect(screen.getByText('2 of 2')).toBeTruthy();
    expect(useIslandRequests.getState().index).toBe(1);
  });

  it('«×» прячет окно, новый запрос возвращает его', async () => {
    const { island, bridge, blocked } = setup();
    render(<IslandApp bridge={bridge} />);
    blocked('s-01');
    await screen.findByTitle('Run: rm -rf build');
    await waitFor(() => expect(island.setVisible).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole('button', { name: 'Hide until the next request' }));
    expect(island.setVisible).toHaveBeenLastCalledWith(false);
    blocked('s-02');
    await screen.findByTitle('Run: ls');
    await waitFor(() => expect(island.setVisible).toHaveBeenLastCalledWith(true));
  });

  it('корень не сжимается до ширины окна — w-max', () => {
    const { bridge } = setup();
    const { container } = render(<IslandApp bridge={bridge} />);
    expect(container.firstElementChild?.className).toContain('w-max');
  });
});
