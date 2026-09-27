/**
 * `MailPanel` — тест 6 куска 2.4 плана окна: новое письмо, пока пользователь
 * прокруткой ушёл от хвоста ленты, не двигает его позицию, а счёт `↓N` растёт.
 *
 * jsdom не считает раскладку, поэтому `scrollHeight`/`clientHeight` элемента
 * задаются вручную (`Object.defineProperty`) — `scrollTop` в jsdom и так
 * обычное читаемое/писаемое свойство.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { Message, WorkEntry, WorkSession } from '@harnas/core';
import { REQUIRED_METHODS } from '../../lib/capabilities.js';
import { useHostStore } from '../../store/host.js';
import { useUiStore } from '../../store/ui.js';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { MailPanel } from './MailPanel.js';

afterEach(cleanup);

const bridge = createFakeBridge();

function session(id: string): WorkSession {
  return {
    id,
    provider: 'claude',
    label: '',
    task: '',
    parent: null,
    contextFrom: [],
    lifecycle: 'active',
    result: null,
    resultAt: null,
    closedAt: null,
    history: [],
    startedAt: null,
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: 'host',
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: null,
  };
}

function message(id: string, at: string): Message {
  return { id, roomId: null, from: 's-01', to: ['s-02'], at, text: `письмо ${id}`, kind: 'note', readBy: {} };
}

function entryWith(messages: Message[]): WorkEntry {
  return {
    projectPath: '/tmp/w-01',
    map: {
      schemaVersion: 2,
      rooms: [],
      work: { id: 'w-01', title: 'Работа', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      sessions: [session('s-01'), session('s-02')],
      messages,
    },
  };
}

/** Задаёт метрики скролла, которых jsdom сам не считает (нет реальной раскладки). */
function setScrollMetrics(el: HTMLElement, metrics: { scrollTop: number; scrollHeight: number; clientHeight: number }): void {
  Object.defineProperty(el, 'scrollHeight', { value: metrics.scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: metrics.clientHeight, configurable: true });
  el.scrollTop = metrics.scrollTop;
}

describe('MailPanel (тест 6)', () => {
  it('прокрутка вверх: новое письмо не двигает позицию, ↓N растёт', () => {
    const initial = [message('m-1', '2026-01-01T10:00:00.000Z'), message('m-2', '2026-01-01T10:01:00.000Z')];
    const { container, rerender } = render(
      <MailPanel entry={entryWith(initial)} providers={[]} models={{}} bridge={bridge} active onOpenExternal={() => {}} />,
    );

    const scroller = container.querySelector('[data-letter-id]')?.parentElement as HTMLDivElement;
    // Пользователь ушёл от хвоста: высота ленты больше видимой области, а
    // текущая позиция — не у низа.
    setScrollMetrics(scroller, { scrollTop: 100, scrollHeight: 1000, clientHeight: 300 });
    fireEvent.scroll(scroller);

    // Обновление ленты — то же, что «пришло письмо»: ту же панель
    // перерисовывают новым `entry` (`store/works.ts#works.changed`).
    const withNewLetter = [...initial, message('m-3', '2026-01-01T10:02:00.000Z')];
    rerender(<MailPanel entry={entryWith(withNewLetter)} providers={[]} models={{}} bridge={bridge} active onOpenExternal={() => {}} />);

    expect(scroller.scrollTop).toBe(100);
    expect(container.textContent).toContain('↓1');
  });

  it('у хвоста ленты новое письмо докручивает вниз и счёт не растёт', () => {
    const initial = [message('m-1', '2026-01-01T10:00:00.000Z')];
    const { container, rerender } = render(
      <MailPanel entry={entryWith(initial)} providers={[]} models={{}} bridge={bridge} active onOpenExternal={() => {}} />,
    );

    const withNewLetter = [...initial, message('m-2', '2026-01-01T10:01:00.000Z')];
    rerender(<MailPanel entry={entryWith(withNewLetter)} providers={[]} models={{}} bridge={bridge} active onOpenExternal={() => {}} />);

    expect(container.textContent).not.toContain('↓');
  });
});

// Тест 7 куска 4.2 (часть useMarkRead): «непрочитано человеком» — isHumanUnread, а не
// LetterView.unread («хоть один адресат не прочёл»).
describe('MailPanel — отметка прочитанного (тест 7 куска 4.2)', () => {
  class FakeIntersectionObserver {
    static all: FakeIntersectionObserver[] = [];
    readonly targets = new Set<Element>();
    constructor(private readonly callback: IntersectionObserverCallback) {
      FakeIntersectionObserver.all.push(this);
    }
    observe(el: Element): void {
      this.targets.add(el);
    }
    unobserve(el: Element): void {
      this.targets.delete(el);
    }
    disconnect(): void {
      this.targets.clear();
    }
    showAll(): void {
      const entries = [...this.targets].map(
        (target) => ({ target, isIntersecting: true, intersectionRatio: 1 }) as unknown as IntersectionObserverEntry,
      );
      this.callback(entries, this as unknown as IntersectionObserver);
    }
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('письмо человеку, прочитанное S02, но не человеком, уходит в пачку; прочитанное человеком — нет', async () => {
    vi.useFakeTimers();
    FakeIntersectionObserver.all = [];
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    useUiStore.setState({ windowFocused: true, documentVisible: true });
    useHostStore.setState({ status: { state: 'connected', hostVersion: 'test', methods: [...REQUIRED_METHODS] } });
    const local = createFakeBridge();
    const batches: string[][] = [];
    local.setHandler('mail.markRead', (params) => {
      batches.push([...params.messageIds]);
      return { marked: params.messageIds.length };
    });
    const at = '2026-01-01T10:00:00.000Z';
    const messages: Message[] = [
      { id: 'm-1', roomId: null, from: 's-01', to: ['human', 's-02'], at, text: 'a', kind: 'note', readBy: { 's-02': at } },
      { id: 'm-2', roomId: null, from: 's-01', to: ['human'], at, text: 'b', kind: 'note', readBy: { human: at } },
      { id: 'm-3', roomId: null, from: 's-01', to: ['s-02'], at, text: 'c', kind: 'note', readBy: {} },
    ];
    render(<MailPanel entry={entryWith(messages)} providers={[]} models={{}} bridge={local} active onOpenExternal={() => {}} />);
    act(() => {
      for (const observer of FakeIntersectionObserver.all) observer.showAll();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(batches).toEqual([['m-1']]);
  });
});
