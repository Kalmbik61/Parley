import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SessionRef } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { useLayoutStore } from '../layout/store.js';
import { emptyLayout, groups, openTab } from '../layout/tree.js';
import { TerminalPromptPanel } from './TerminalPromptPanel.js';

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };

let bridge: FakeBridge;
let lines: string[];
let screenCalls: () => number;

function setup(active = true): ReturnType<typeof render> {
  return render(<TerminalPromptPanel workKey="/tmp/p w-01" tabId="terminal:s-01" sessionRef={REF} bridge={bridge} title="Waiting for your approval" active={active} />);
}

const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const panel = (): HTMLElement => screen.getByTestId('chat-terminal-prompt');
const inputs = (): unknown[] => bridge.notified.filter((n) => n.method === 'pty.input').map((n) => n.params);

beforeEach(() => {
  vi.useFakeTimers();
  lines = ['', 'Would you like to run the following command?', '', '1. Yes, proceed (y)', ''];
  bridge = createFakeBridge();
  bridge.setHandler('pty.screenText', () => ({ lines }));
  screenCalls = () => bridge.calls.filter((c) => c.method === 'pty.screenText').length;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TerminalPromptPanel — опрос экрана', () => {
  it('при active первый запрос сразу (без rows), второй через 400 мс; строки ответа видны в <pre>', async () => {
    setup();
    await advance(0);
    expect(screenCalls()).toBe(1);
    expect(bridge.calls[0]).toEqual({ method: 'pty.screenText', params: { ref: REF } });
    expect(screen.getByTestId('chat-terminal-prompt-screen').textContent).toBe('Would you like to run the following command?\n\n1. Yes, proceed (y)');
    await advance(399);
    expect(screenCalls()).toBe(1);
    await advance(1);
    expect(screenCalls()).toBe(2);
  });

  it('экран пуст — подпись «ничего нет»', async () => {
    lines = ['', ''];
    setup();
    await advance(0);
    expect(screen.getByTestId('chat-terminal-prompt-screen').textContent).toBe(S.chat.terminalPrompt.empty);
  });

  it('active: false — запросов нет', async () => {
    setup(false);
    await advance(2000);
    expect(screenCalls()).toBe(0);
  });

  it('смена active на false снимает таймер', async () => {
    const view = setup();
    await advance(0);
    expect(screenCalls()).toBe(1);
    view.rerender(<TerminalPromptPanel workKey="/tmp/p w-01" tabId="terminal:s-01" sessionRef={REF} bridge={bridge} title="t" active={false} />);
    await advance(2000);
    expect(screenCalls()).toBe(1);
  });

  it('размонтирование снимает таймер', async () => {
    const view = setup();
    await advance(0);
    view.unmount();
    await advance(2000);
    expect(screenCalls()).toBe(1);
  });

  it('ответ опоздавшего запроса после размонтирования отбрасывается без ошибки', async () => {
    let release: (value: { lines: string[] }) => void = () => undefined;
    bridge.setHandler('pty.screenText', () => new Promise((resolve) => { release = resolve; }));
    const view = setup();
    await advance(0);
    view.unmount();
    await act(async () => {
      release({ lines: ['late'] });
      await Promise.resolve();
    });
    expect(screenCalls()).toBe(1);
  });

  it('отказ запроса не роняет панель: прошлые строки на месте, повтор по расписанию', async () => {
    setup();
    await advance(0);
    bridge.setHandler('pty.screenText', () => { throw new Error('host is gone'); });
    await advance(400);
    expect(screenCalls()).toBe(2);
    expect(screen.getByTestId('chat-terminal-prompt-screen').textContent).toContain('Would you like to run');
  });
});

describe('TerminalPromptPanel — клавиши и кнопки', () => {
  it('ArrowDown на панели → pty.input и внеочередное чтение экрана через 80 мс', async () => {
    setup();
    await advance(0);
    fireEvent.keyDown(panel(), { key: 'ArrowDown' });
    expect(inputs()).toEqual([{ ref: REF, data: '\u001b[B' }]);
    expect(screenCalls()).toBe(1);
    await advance(80);
    expect(screenCalls()).toBe(2);
  });

  it('нажатие с ⌘ — pty.input не вызван, preventDefault не вызван', async () => {
    setup();
    await advance(0);
    const notPrevented = fireEvent.keyDown(panel(), { key: 'c', metaKey: true });
    expect(notPrevented).toBe(true);
    expect(inputs()).toEqual([]);
  });

  it('перехваченная клавиша отменяет действие браузера', async () => {
    setup();
    await advance(0);
    expect(fireEvent.keyDown(panel(), { key: 'Tab' })).toBe(false);
  });

  it('при active: false клавиши в терминал не уходят', async () => {
    setup(false);
    fireEvent.keyDown(panel(), { key: 'y' });
    fireEvent.click(screen.getByTestId('chat-terminal-prompt-enter'));
    expect(inputs()).toEqual([]);
  });

  it('клик по кнопкам Enter, Up, Down, Esc шлёт те же байты, что клавиши', async () => {
    setup();
    await advance(0);
    fireEvent.click(screen.getByTestId('chat-terminal-prompt-enter'));
    fireEvent.click(screen.getByTestId('chat-terminal-prompt-up'));
    fireEvent.click(screen.getByTestId('chat-terminal-prompt-down'));
    fireEvent.click(screen.getByTestId('chat-terminal-prompt-escape'));
    expect(inputs()).toEqual([
      { ref: REF, data: '\r' },
      { ref: REF, data: '\u001b[A' },
      { ref: REF, data: '\u001b[B' },
      { ref: REF, data: '\u001b' },
    ]);
  });

  it('подпись: без фокуса — focusHint, в фокусе — keysHint', async () => {
    setup();
    await advance(0);
    expect(screen.getByTestId('chat-terminal-prompt-hint').textContent).toBe(S.chat.terminalPrompt.focusHint);
    fireEvent.focus(panel());
    expect(screen.getByTestId('chat-terminal-prompt-hint').textContent).toBe(S.chat.terminalPrompt.keysHint);
  });
});

describe('TerminalPromptPanel — потеря фокуса', () => {
  it('в фокусе клавиши идут в терминал; фокус ушёл наружу — подпись сброшена и клавиши снаружи в терминал не попадают', async () => {
    render(
      <div>
        <button type="button" data-testid="outside">outside</button>
        <TerminalPromptPanel workKey="/tmp/p w-01" tabId="terminal:s-01" sessionRef={REF} bridge={bridge} title="t" active />
      </div>,
    );
    await advance(0);
    const outside = screen.getByTestId('outside');
    act(() => panel().focus());
    expect(document.activeElement).toBe(panel());
    expect(screen.getByTestId('chat-terminal-prompt-hint').textContent).toBe(S.chat.terminalPrompt.keysHint);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(inputs()).toEqual([{ ref: REF, data: '\u001b[B' }]);

    act(() => outside.focus());
    expect(document.activeElement).toBe(outside);
    expect(screen.getByTestId('chat-terminal-prompt-hint').textContent).toBe(S.chat.terminalPrompt.focusHint);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'y' });
    expect(inputs()).toEqual([{ ref: REF, data: '\u001b[B' }]);
  });

  it('фокус перешёл с панели на её же кнопку — подпись остаётся «Keys go to the terminal»', async () => {
    setup();
    await advance(0);
    act(() => panel().focus());
    act(() => screen.getByTestId('chat-terminal-prompt-up').focus());
    expect(screen.getByTestId('chat-terminal-prompt-hint').textContent).toBe(S.chat.terminalPrompt.keysHint);
  });
});

describe('TerminalPromptPanel — поле «Type an answer»', () => {
  it('текст → pty.input с текстом, через 80 мс — отдельным сообщением \\r; поле очищается', async () => {
    setup();
    await advance(0);
    const input = screen.getByTestId('chat-terminal-prompt-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'yes please' } });
    fireEvent.click(screen.getByTestId('chat-terminal-prompt-send'));
    expect(inputs()).toEqual([{ ref: REF, data: 'yes please' }]);
    expect(input.value).toBe('');
    await advance(79);
    expect(inputs()).toHaveLength(1);
    await advance(1);
    expect(inputs()).toEqual([{ ref: REF, data: 'yes please' }, { ref: REF, data: '\r' }]);
  });

  it('Enter в поле отправляет так же', async () => {
    setup();
    await advance(0);
    const input = screen.getByTestId('chat-terminal-prompt-input');
    fireEvent.change(input, { target: { value: 'ok' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await advance(80);
    expect(inputs()).toEqual([{ ref: REF, data: 'ok' }, { ref: REF, data: '\r' }]);
  });

  it('пустое поле — только один \\r', async () => {
    setup();
    await advance(0);
    fireEvent.click(screen.getByTestId('chat-terminal-prompt-send'));
    await advance(500);
    expect(inputs()).toEqual([{ ref: REF, data: '\r' }]);
  });

  it('нажатие клавиши внутри поля не даёт pty.input до отправки', async () => {
    setup();
    await advance(0);
    const input = screen.getByTestId('chat-terminal-prompt-input');
    fireEvent.keyDown(input, { key: 'a' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Backspace' });
    await advance(500);
    expect(inputs()).toEqual([]);
  });

  it('Enter после текста не уходит, если панель скрыта до паузы', async () => {
    const view = setup();
    await advance(0);
    fireEvent.change(screen.getByTestId('chat-terminal-prompt-input'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('chat-terminal-prompt-send'));
    view.rerender(<TerminalPromptPanel workKey="/tmp/p w-01" tabId="terminal:s-01" sessionRef={REF} bridge={bridge} title="t" active={false} />);
    await advance(500);
    expect(inputs()).toEqual([{ ref: REF, data: 'x' }]);
  });
});

describe('TerminalPromptPanel — прочее', () => {
  it('в console ничего не пишется', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setup();
    await advance(0);
    bridge.setHandler('pty.screenText', () => { throw new Error('boom'); });
    await advance(400);
    fireEvent.keyDown(panel(), { key: 'y' });
    await advance(200);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('заголовок виден, кнопка «Open terminal» на месте', async () => {
    setup();
    await advance(0);
    expect(screen.getByTestId('chat-terminal-prompt-title').textContent).toBe('Waiting for your approval');
    expect(screen.getByTestId('chat-terminal-prompt-open').textContent).toBe(S.chat.terminalPrompt.open);
  });
});

describe('TerminalPromptPanel — Codex follow-up queue', () => {
  const header = '• Queued follow-up inputs';
  const collapsed = [header, '  ? 1 question · 13s', '    ⇧← to answer', '', '› Ask Codex to do anything', '  ? for shortcuts'];
  const editor = [header, '', 'Which color?', '', '  › 1. Blue', '    2. Green', '    3. Other', '', 'enter submit   ⌃] skip   ⇧→ main prompt'];

  it.each([collapsed, editor].map(queue => [queue]))('hides the queue screen and keyboard controls while awaiting the feed: %j', async (queue) => {
    lines = queue;
    setup();
    await advance(0);
    expect(screen.queryByTestId('chat-terminal-prompt-screen')).toBeNull();
    expect(screen.queryByTestId('chat-terminal-prompt-enter')).toBeNull();
    expect(screen.queryByTestId('chat-terminal-prompt-input')).toBeNull();
    const banner = screen.getByTestId('chat-waiting-banner');
    expect(banner.textContent).toContain('Waiting for your approval');
    fireEvent.keyDown(banner, { key: 'ArrowDown' });
    await advance(2000);
    expect(inputs()).toEqual([]);
    expect(screen.queryByTestId('chat-terminal-prompt-screen')).toBeNull();
  });

  it('retains a working Terminal route when the transcript remains unavailable', async () => {
    const workKey = '/tmp/p w-01';
    const layout = openTab(emptyLayout(), { kind: 'terminal', id: 'terminal:s-01', sessionId: 's-01', view: 'chat' });
    useLayoutStore.getState().hydrate(workKey, layout);
    lines = collapsed;
    setup();
    await advance(0);
    fireEvent.click(screen.getByTestId('chat-waiting-open'));
    expect(groups(useLayoutStore.getState().layouts[workKey]!).flatMap(group => group.tabs)).toContainEqual(
      expect.objectContaining({ id: 'terminal:s-01', view: 'terminal' }),
    );
    useLayoutStore.getState().drop(workKey);
  });

  it('restores the raw fallback for another prompt after a queue, including stale queue scrollback', async () => {
    lines = collapsed;
    setup();
    await advance(0);
    expect(screen.queryByTestId('chat-terminal-prompt-screen')).toBeNull();
    lines = [...collapsed, '', 'Would you like to run the following command?', '1. Yes, proceed (y)', 'Enter to confirm'];
    await advance(400);
    expect(screen.getByTestId('chat-terminal-prompt-screen').textContent).toContain('Would you like to run');
    fireEvent.click(screen.getByTestId('chat-terminal-prompt-enter'));
    expect(inputs()).toEqual([{ ref: REF, data: '\r' }]);
  });
});
