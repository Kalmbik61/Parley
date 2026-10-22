/**
 * Терминал входа в аккаунт подписки (спека подписок 4.1, 5.5, 10): тот же xterm, что у сессий, но без хоста PTY сессий —
 * вывод приходит событием `providers.signInOutput`, ввод и размер уходят методами `providers.signInInput` и
 * `providers.signInResize`. Реальный xterm рисует в канву, которой в jsdom нет, поэтому он подменён общим фейком.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { xtermMock } from '../../test-utils/xterm-mock.js';
import { useProvidersStore } from '../../store/providers.js';
import { SignInTerminal } from './SignInTerminal.js';

vi.mock('@xterm/xterm', async () => (await import('../../test-utils/xterm-mock.js')).xtermModule);
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }));

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverStub.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  trigger(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

let bridge: FakeBridge;
beforeEach(() => {
  vi.useFakeTimers();
  xtermMock.reset();
  ResizeObserverStub.instances = [];
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  bridge = createFakeBridge();
  bridge.setHandler('providers.signInInput', () => ({ ok: true }));
  bridge.setHandler('providers.signInResize', () => ({ ok: true }));
  window.parley = bridge;
  useProvidersStore.setState({ signInOutput: {}, signInResult: {} });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const resizes = () => bridge.calls.filter((call) => call.method === 'providers.signInResize').map((call) => call.params);

describe('SignInTerminal', () => {
  it('сначала пишет накопленный в сторе вывод, затем живые куски своего провайдера', () => {
    useProvidersStore.setState({ signInOutput: { 'custom-claude-2': 'Open https://example.test/login\r\n' } });
    const { container } = render(<SignInTerminal provider="custom-claude-2" running />);
    expect(container.querySelector('[data-sign-in-terminal]')).toBeTruthy();
    const term = xtermMock.terminals[0]!;
    expect(term.writes).toEqual(['Open https://example.test/login\r\n']);
    act(() => bridge.emit('providers.signInOutput', { provider: 'custom-claude-2', data: 'Paste code: ' }));
    act(() => bridge.emit('providers.signInOutput', { provider: 'custom-claude-3', data: 'чужой' }));
    expect(term.writes).toEqual(['Open https://example.test/login\r\n', 'Paste code: ']);
  });

  it('пустой буфер ничего не пишет', () => {
    render(<SignInTerminal provider="custom-claude-2" running />);
    expect(xtermMock.terminals[0]!.writes).toEqual([]);
  });

  it('ввод человека уходит в providers.signInInput', () => {
    render(<SignInTerminal provider="custom-claude-2" running />);
    act(() => xtermMock.terminals[0]!.onDataHandler?.('abc-123\r'));
    expect(bridge.calls.filter((call) => call.method === 'providers.signInInput')).toEqual([
      { method: 'providers.signInInput', params: { provider: 'custom-claude-2', data: 'abc-123\r' } },
    ]);
  });

  it('размер уходит хосту после монтирования и после изменения контейнера, с тишиной 50 мс', () => {
    render(<SignInTerminal provider="custom-claude-2" running />);
    expect(resizes()).toEqual([{ provider: 'custom-claude-2', cols: 80, rows: 24 }]);
    xtermMock.terminals[0]!.cols = 60;
    xtermMock.terminals[0]!.rows = 10;
    act(() => ResizeObserverStub.instances[0]!.trigger());
    act(() => ResizeObserverStub.instances[0]!.trigger());
    expect(resizes()).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(60));
    expect(resizes()).toEqual([
      { provider: 'custom-claude-2', cols: 80, rows: 24 },
      { provider: 'custom-claude-2', cols: 60, rows: 10 },
    ]);
  });

  it('процесс входа поднялся уже после монтирования — размер уходит ещё раз', () => {
    const { rerender } = render(<SignInTerminal provider="custom-claude-2" running={false} />);
    expect(resizes()).toHaveLength(0);
    rerender(<SignInTerminal provider="custom-claude-2" running />);
    expect(resizes()).toHaveLength(1);
  });

  it('при размонтировании xterm освобождается и событий больше не слушает', () => {
    const { unmount } = render(<SignInTerminal provider="custom-claude-2" running />);
    const term = xtermMock.terminals[0]!;
    unmount();
    expect(term.disposed).toBe(true);
    bridge.emit('providers.signInOutput', { provider: 'custom-claude-2', data: 'late' });
    expect(term.writes).toEqual([]);
  });

  it('отказ хоста на ввод или размер не роняет терминал', async () => {
    bridge.setHandler('providers.signInInput', () => {
      throw new Error('нет входа');
    });
    bridge.setHandler('providers.signInResize', () => {
      throw new Error('нет входа');
    });
    render(<SignInTerminal provider="custom-claude-2" running />);
    act(() => xtermMock.terminals[0]!.onDataHandler?.('x'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(xtermMock.terminals[0]!.disposed).toBe(false);
  });
});
