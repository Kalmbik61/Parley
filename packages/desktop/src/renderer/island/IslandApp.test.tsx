/**
 * Проводка острова на подставном мосту: новый запрос выбирается в карточке (а не остаётся прежний), «×» прячет окно, а
 * новый запрос возвращает его, корень заполняет кадр окна и выравнивает форму по точке, окно ловит мышь только над
 * формой (и не отпускает её посреди перетаскивания). Настоящие таймеры: цепочка «событие → снимок ленты → карточка»
 * идёт через промисы и React, пауза кнопок решения и анимация формы проверены в `IslandView.test.tsx`.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedCard } from '@parley/core';
import type { IslandApi, IslandBridge, IslandConfig } from '../../shared/island.js';
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

// jsdom не знает ResizeObserver — форма острова заводит его при монтировании, чтобы замерять содержимое.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function islandApi(config: Partial<IslandConfig> = {}): IslandApi {
  return {
    config: vi.fn(async (): Promise<IslandConfig> => ({ sound: false, hintShown: true, topInset: 0, anchor: 'center', ...config })),
    onConfig: vi.fn(() => () => undefined),
    setInteractive: vi.fn(), setVisible: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(), open: vi.fn(), beep: vi.fn(), hintShown: vi.fn(), failed: vi.fn(),
  };
}

/** Мост острова поверх подставного моста окна: хост «подключён», `works.list` и `feed.snapshot` отвечают из таблиц выше. */
function setup(config: Partial<IslandConfig> = {}) {
  const fake = createFakeBridge();
  fake.setHandler('works.list', () => ({ entries: ENTRIES, branches: {} }) as never);
  fake.setHandler('feed.snapshot', ({ ref: target }) => ({ items: CARDS[target.sessionId] ?? [], revision: 1, mode: null, decisions: 'window' }) as never);
  const island = islandApi(config);
  const bridge: IslandBridge = { call: fake.call, on: fake.on, onStatus: fake.onStatus, activitySnapshot: fake.activitySnapshot, island };
  const blocked = (sessionId: string): void => {
    act(() => {
      fake.emit('activity.changed', makeActivity(ref(sessionId), 'blocked'));
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
  return { island, bridge, blocked, disconnect, reconnect };
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

  it('хост отключился — остров спрятан: пилюля с устаревшими счётчиками не висит', async () => {
    const { island, bridge, blocked, disconnect } = setup();
    render(<IslandApp bridge={bridge} />);
    blocked('s-01');
    await screen.findByTitle('Run: rm -rf build');
    await waitFor(() => expect(island.setVisible).toHaveBeenLastCalledWith(true));
    disconnect();
    await waitFor(() => expect(island.setVisible).toHaveBeenLastCalledWith(false));
    expect(useIslandRequests.getState().items).toEqual([]);
  });

  it('после переподключения всё ещё ждущая карточка — новая: возвращает спрятанный «×» остров', async () => {
    const { island, bridge, blocked, disconnect, reconnect } = setup();
    render(<IslandApp bridge={bridge} />);
    blocked('s-01');
    await screen.findByTitle('Run: rm -rf build');
    await waitFor(() => expect(island.setVisible).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole('button', { name: 'Hide until the next request' }));
    expect(island.setVisible).toHaveBeenLastCalledWith(false);
    disconnect();
    reconnect();
    await screen.findByTitle('Run: rm -rf build');
    await waitFor(() => expect(island.setVisible).toHaveBeenLastCalledWith(true));
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

  it('курсор над формой — окно ловит мышь, ушёл — снова сквозное, а список закрыт', () => {
    const { island, bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    const shape = screen.getByTestId('island');
    fireEvent.mouseEnter(screen.getByTestId('island-pill'));
    expect(island.setInteractive).toHaveBeenLastCalledWith(true);
    expect(screen.queryByTestId('island-list')).not.toBeNull();
    fireEvent.mouseLeave(shape);
    expect(island.setInteractive).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId('island-list')).toBeNull();
  });

  describe('перетаскивание', () => {
    /** Событие указателя с точкой на экране: `MouseEvent` нужного типа — не зависит от того, знает ли jsdom `PointerEvent`. */
    const pointer = (type: string): MouseEvent => new MouseEvent(type, { bubbles: true, screenX: 10, screenY: 20 });

    it('уход курсора с формы посреди жеста не делает окно сквозным и не закрывает список', () => {
      const { island, bridge } = setup();
      render(<IslandApp bridge={bridge} />);
      fireEvent.mouseEnter(screen.getByTestId('island-pill'));
      fireEvent(screen.getByTestId('island-drag'), pointer('pointerdown'));
      vi.mocked(island.setInteractive).mockClear();
      fireEvent.mouseLeave(screen.getByTestId('island'));
      expect(island.setInteractive).not.toHaveBeenCalled();
      expect(screen.queryByTestId('island-list')).not.toBeNull();
    });

    it('после жеста курсор не над формой — окно снова сквозное и список закрыт', () => {
      const { island, bridge } = setup();
      render(<IslandApp bridge={bridge} />);
      fireEvent.mouseEnter(screen.getByTestId('island-pill'));
      const handle = screen.getByTestId('island-drag');
      fireEvent(handle, pointer('pointerdown'));
      fireEvent.mouseLeave(screen.getByTestId('island'));
      // jsdom не считает `:hover`: курсор «не над формой».
      fireEvent(handle, pointer('pointerup'));
      expect(island.setInteractive).toHaveBeenLastCalledWith(false);
      expect(screen.queryByTestId('island-list')).toBeNull();
    });

    it('после жеста курсор всё ещё над формой — окно остаётся интерактивным', () => {
      const { island, bridge } = setup();
      render(<IslandApp bridge={bridge} />);
      const handle = screen.getByTestId('island-drag');
      fireEvent(handle, pointer('pointerdown'));
      vi.mocked(island.setInteractive).mockClear();
      const original = Element.prototype.matches;
      const spy = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
        return selector === ':hover' ? true : original.call(this, selector);
      });
      try {
        fireEvent(handle, pointer('pointerup'));
      } finally {
        spy.mockRestore();
      }
      expect(island.setInteractive).not.toHaveBeenCalled();
    });

    it('жест закончен — следующий уход курсора снова делает окно сквозным', () => {
      const { island, bridge } = setup();
      render(<IslandApp bridge={bridge} />);
      const handle = screen.getByTestId('island-drag');
      fireEvent(handle, pointer('pointerdown'));
      fireEvent(handle, pointer('pointerup'));
      vi.mocked(island.setInteractive).mockClear();
      fireEvent.mouseLeave(screen.getByTestId('island'));
      expect(island.setInteractive).toHaveBeenCalledWith(false);
    });
  });
});
