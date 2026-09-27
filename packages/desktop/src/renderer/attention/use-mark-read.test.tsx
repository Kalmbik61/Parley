import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { useHostStore } from '../store/host.js';
import { useUiStore } from '../store/ui.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { useMarkRead } from './use-mark-read.js';

/** IntersectionObserver для jsdom: пересечение тест объявляет сам (`show`). */
class FakeIntersectionObserver {
  static all: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  readonly threshold: number | number[] | undefined;
  constructor(
    private readonly callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.threshold = options?.threshold;
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
  fire(el: Element, visible: boolean): void {
    if (!this.targets.has(el)) return;
    const entry = { target: el, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as unknown as IntersectionObserverEntry;
    this.callback([entry], this as unknown as IntersectionObserver);
  }
}

function show(...ids: string[]): void {
  act(() => {
    for (const id of ids) {
      const el = document.querySelector(`[data-id="${id}"]`);
      if (el === null) throw new Error(`нет письма ${id}`);
      for (const observer of FakeIntersectionObserver.all) observer.fire(el, true);
    }
  });
}

interface Row {
  id: string;
  unread: boolean;
}

function Harness({ bridge, rows, active }: { bridge: FakeBridge; rows: Row[]; active: boolean }): JSX.Element {
  const markRead = useMarkRead({ bridge, projectPath: '/tmp/p', workId: 'w-01', active });
  return (
    <div>
      {rows.map((row) => (
        <div key={row.id} data-id={row.id} ref={markRead(row.id, row.unread)} />
      ))}
    </div>
  );
}

let bridge: FakeBridge;
let calls: string[][];

function markReadCalls(): string[][] {
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeIntersectionObserver.all = [];
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  useUiStore.setState({ windowFocused: true, documentVisible: true });
  useHostStore.setState({ status: { state: 'connected', hostVersion: 'test', methods: [...REQUIRED_METHODS] } });
  bridge = createFakeBridge();
  calls = [];
  bridge.setHandler('mail.markRead', (params) => {
    calls.push([...params.messageIds]);
    return { marked: params.messageIds.length };
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id, unread: true }));

describe('useMarkRead (тесты 3, 11, 12)', () => {
  it('тест 3: два письма видимы 1 с → один вызов mail.markRead с двумя id', async () => {
    render(<Harness bridge={bridge} rows={rows('m1', 'm2')} active />);
    expect(FakeIntersectionObserver.all[0]?.threshold).toBe(0.5);
    show('m1', 'm2');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(markReadCalls()).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1 + 500);
    });
    expect(markReadCalls()).toEqual([['m1', 'm2']]);
    expect(bridge.calls.find((call) => call.method === 'mail.markRead')?.params).toEqual({
      projectPath: '/tmp/p',
      workId: 'w-01',
      messageIds: ['m1', 'm2'],
    });
  });

  it('тест 3: окно без фокуса — вызова нет; документ скрыт — тоже', async () => {
    useUiStore.setState({ windowFocused: false });
    render(<Harness bridge={bridge} rows={rows('m1')} active />);
    show('m1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(markReadCalls()).toEqual([]);

    // Фокус вернулся — отсчёт с нуля, письмо уходит.
    act(() => useUiStore.setState({ windowFocused: true, documentVisible: false }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(markReadCalls()).toEqual([]);
    act(() => useUiStore.setState({ documentVisible: true }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(markReadCalls()).toEqual([['m1']]);
  });

  it('потеря фокуса раньше 1 с сбрасывает отсчёт', async () => {
    render(<Harness bridge={bridge} rows={rows('m1')} active />);
    show('m1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    act(() => useUiStore.setState({ windowFocused: false }));
    act(() => useUiStore.setState({ windowFocused: true }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(markReadCalls()).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(markReadCalls()).toEqual([['m1']]);
  });

  it('тест 11: работа не активна (скрытая работа LRU) — письма видимы для IO, вызова нет', async () => {
    render(<Harness bridge={bridge} rows={rows('m1')} active={false} />);
    show('m1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(markReadCalls()).toEqual([]);
  });

  it('прочитанное письмо не отправляется', async () => {
    render(<Harness bridge={bridge} rows={[{ id: 'm1', unread: false }]} active />);
    show('m1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(markReadCalls()).toEqual([]);
  });

  it('тест 12: перерисовка каждые 300 мс не мешает отметке через 1 с', async () => {
    const { rerender } = render(<Harness bridge={bridge} rows={rows('m1')} active />);
    show('m1');
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      rerender(<Harness bridge={bridge} rows={rows('m1')} active />);
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(markReadCalls()).toEqual([['m1']]);
  });

  it('тест 12: 501 непрочитанное письмо → два вызова, 500 и 1 id', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `m${i}`);
    render(<Harness bridge={bridge} rows={rows(...ids)} active />);
    show(...ids);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(markReadCalls().map((batch) => batch.length)).toEqual([500, 1]);
  });

  it('тест 12: ошибка вызова → те же id уходят следующей пачкой', async () => {
    let fail = true;
    bridge.setHandler('mail.markRead', (params) => {
      calls.push([...params.messageIds]);
      if (fail) {
        fail = false;
        throw new Error('host down');
      }
      return { marked: params.messageIds.length };
    });
    render(<Harness bridge={bridge} rows={rows('m1', 'm2')} active />);
    show('m1', 'm2');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(markReadCalls()).toEqual([['m1', 'm2']]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(markReadCalls()).toEqual([
      ['m1', 'm2'],
      ['m1', 'm2'],
    ]);
  });

  it('повторно одно письмо не отправляется, пока снимок его не обновит', async () => {
    const { rerender } = render(<Harness bridge={bridge} rows={rows('m1')} active />);
    show('m1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    // Снимок ещё не пришёл: письмо по-прежнему непрочитано и видно.
    show('m1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(markReadCalls()).toEqual([['m1']]);
    rerender(<Harness bridge={bridge} rows={[{ id: 'm1', unread: false }]} active />);
    expect(markReadCalls()).toEqual([['m1']]);
  });

  it('тест 12: хост без mail.markRead — вызова нет', async () => {
    bridge.setHostMethods(REQUIRED_METHODS.filter((method) => method !== 'mail.markRead'));
    useHostStore.setState({
      status: { state: 'connected', hostVersion: 'test', methods: REQUIRED_METHODS.filter((method) => method !== 'mail.markRead') },
    });
    render(<Harness bridge={bridge} rows={rows('m1')} active />);
    show('m1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(markReadCalls()).toEqual([]);
    expect(bridge.calls.some((call) => call.method === 'mail.markRead')).toBe(false);
  });
});
