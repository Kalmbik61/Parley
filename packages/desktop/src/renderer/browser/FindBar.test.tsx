/**
 * Тест 3 куска 9.2b (полоса): поиск по странице — `browser.find` main, счётчик `active/matches`,
 * Enter / ⇧Enter — вперёд и назад, Esc и × — `stopFind` и закрытие. Отказ — только в консоль.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { FindBar } from './FindBar.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

let bridge: FakeBridge;

beforeEach(() => {
  bridge = createFakeBridge();
  vi.mocked(toast).mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function field(): HTMLInputElement {
  return screen.getByPlaceholderText('Find…');
}

describe('FindBar (тест 3 куска 9.2b)', () => {
  it('ввод abc — find(id, abc, true); ⇧Enter — назад; счётчик 2/5; Esc — stopFind и onClose', async () => {
    bridge.browser.find = vi.fn(async (id: number, text: string, forward: boolean) => {
      bridge.browserCalls.push({ method: 'find', args: [id, text, forward] });
      return { matches: 5, active: 2 };
    });
    const onClose = vi.fn();
    render(<FindBar bridge={bridge} webContentsId={7} onClose={onClose} />);
    expect(screen.getByRole('search', { name: 'Find in page' })).toBeTruthy();
    expect(document.activeElement).toBe(field());

    fireEvent.change(field(), { target: { value: 'abc' } });
    await flush();
    expect(bridge.browserCalls).toEqual([{ method: 'find', args: [7, 'abc', true] }]);
    expect(screen.getByText('2/5')).toBeTruthy();

    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });
    await flush();
    expect(bridge.browserCalls.at(-1)).toEqual({ method: 'find', args: [7, 'abc', false] });
    fireEvent.keyDown(field(), { key: 'Enter' });
    await flush();
    expect(bridge.browserCalls.at(-1)).toEqual({ method: 'find', args: [7, 'abc', true] });

    fireEvent.keyDown(field(), { key: 'Escape' });
    await flush();
    expect(bridge.browserCalls.at(-1)).toEqual({ method: 'stopFind', args: [7] });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('↑ и ↓ — назад и вперёд; × — stopFind и onClose; пустое поле find не зовёт', async () => {
    const onClose = vi.fn();
    render(<FindBar bridge={bridge} webContentsId={3} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(bridge.browserCalls).toEqual([]);

    fireEvent.change(field(), { target: { value: 'x' } });
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    await flush();
    expect(bridge.browserCalls.map((call) => call.args[2])).toEqual([true, false, true]);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await flush();
    expect(bridge.browserCalls.at(-1)).toEqual({ method: 'stopFind', args: [3] });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('стёртый запрос — stopFind и счётчик пропал', async () => {
    bridge.browser.find = vi.fn(async () => ({ matches: 1, active: 1 }));
    render(<FindBar bridge={bridge} webContentsId={3} onClose={vi.fn()} />);
    fireEvent.change(field(), { target: { value: 'x' } });
    await flush();
    expect(screen.getByText('1/1')).toBeTruthy();
    fireEvent.change(field(), { target: { value: '' } });
    await flush();
    expect(bridge.browserCalls.at(-1)).toEqual({ method: 'stopFind', args: [3] });
    expect(screen.queryByText('1/1')).toBeNull();
  });

  it('поздний ответ старого запроса счётчик не перебивает', async () => {
    const answers: Array<(value: { matches: number; active: number }) => void> = [];
    bridge.browser.find = vi.fn(() => new Promise<{ matches: number; active: number }>((resolve) => answers.push(resolve)));
    render(<FindBar bridge={bridge} webContentsId={3} onClose={vi.fn()} />);
    fireEvent.change(field(), { target: { value: 'a' } });
    fireEvent.change(field(), { target: { value: 'ab' } });
    await act(async () => {
      answers[1]?.({ matches: 3, active: 1 });
      await Promise.resolve();
      answers[0]?.({ matches: 9, active: 9 });
      await Promise.resolve();
    });
    expect(screen.getByText('1/3')).toBeTruthy();
  });

  it('отказ find и stopFind — в консоль, без тоста; запрос не длиннее 1000 символов', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.browser.find = vi.fn(async () => {
      throw new Error('gone');
    });
    bridge.browser.stopFind = vi.fn(async () => {
      throw new Error('gone');
    });
    const onClose = vi.fn();
    render(<FindBar bridge={bridge} webContentsId={3} onClose={onClose} />);
    expect(field().maxLength).toBe(1000);
    fireEvent.change(field(), { target: { value: 'x' } });
    await flush();
    fireEvent.keyDown(field(), { key: 'Escape' });
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });
});
