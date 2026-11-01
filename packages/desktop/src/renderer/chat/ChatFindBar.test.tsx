/** Полоса поиска по ленте Chat (план 2026-11-01, задача 9): счётчик, переходы по кругу, закрытие, повторный ⌘F. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FeedItem } from '@parley/core';
import { S } from '../../shared/strings.js';
import { ChatFindBar, type FindView } from './ChatFindBar.js';

afterEach(cleanup);

const AT = '2026-11-01T00:00:00.000Z';
const text = (id: string, body: string): FeedItem => ({ id, at: AT, kind: 'text', messageId: id, text: body, streaming: false });
const ITEMS: FeedItem[] = [text('a', 'needle one'), text('b', 'nothing'), text('c', 'needle two needle three')];

function setUp(items: readonly FeedItem[] = ITEMS) {
  const onChange = vi.fn<(view: FindView) => void>();
  const onClose = vi.fn();
  const view = render(<ChatFindBar items={items} focusNonce={1} onChange={onChange} onClose={onClose} />);
  const input = screen.getByRole('textbox', { name: S.chat.find.label });
  const count = (): string => screen.getByTestId('chat-find-count').textContent ?? '';
  const last = (): FindView => onChange.mock.calls.at(-1)![0];
  return { ...view, onChange, onClose, input, count, last };
}

describe('ChatFindBar', () => {
  it('счётчик 0/0, пока ничего не нашлось; ввод ставит 1/m и зовёт onChange с первым совпадением', () => {
    const { input, count, last } = setUp();
    expect(count()).toBe('0/0');
    fireEvent.change(input, { target: { value: 'needle' } });
    expect(count()).toBe('1/3');
    expect(last()).toMatchObject({ query: 'needle', target: { itemId: 'a', itemNth: 0 } });
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(count()).toBe('0/0');
    expect(last().target).toBeNull();
  });

  it('Enter идёт к следующему, ⇧Enter к предыдущему, по кругу в обе стороны', () => {
    const { input, count, last } = setUp();
    fireEvent.change(input, { target: { value: 'needle' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(count()).toBe('2/3');
    expect(last().target).toMatchObject({ itemId: 'c', itemNth: 0 });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(count()).toBe('3/3');
    expect(last().target).toMatchObject({ itemId: 'c', itemNth: 1 });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(count()).toBe('1/3');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(count()).toBe('3/3');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(count()).toBe('2/3');
  });

  it('стрелки полосы ходят так же; без совпадений Enter ничего не делает', () => {
    const { input, count, onChange } = setUp();
    fireEvent.keyDown(input, { key: 'Enter' });
    const before = onChange.mock.calls.length;
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange.mock.calls.length).toBe(before);
    fireEvent.change(input, { target: { value: 'needle' } });
    fireEvent.click(screen.getByRole('button', { name: S.terminal.nextMatch }));
    expect(count()).toBe('2/3');
    fireEvent.click(screen.getByRole('button', { name: S.terminal.previousMatch }));
    expect(count()).toBe('1/3');
  });

  it('каждый шаг — новый nonce цели, даже на единственном совпадении; без шага nonce тот же', () => {
    const { input, last, rerender, onChange, onClose } = setUp([text('a', 'needle')]);
    fireEvent.change(input, { target: { value: 'needle' } });
    const first = last().target!.nonce;
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(last().target!.nonce).toBeGreaterThan(first);
    const settled = last().target!.nonce;
    rerender(<ChatFindBar items={[text('a', 'needle'), text('b', 'later')]} focusNonce={1} onChange={onChange} onClose={onClose} />);
    expect(last().target!.nonce).toBe(settled);
  });

  it('стримящийся текст растёт — выбранное совпадение остаётся на месте', () => {
    const { input, count, last, rerender, onChange, onClose } = setUp([text('a', 'needle one'), text('c', 'needle two')]);
    fireEvent.change(input, { target: { value: 'needle' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(last().target).toMatchObject({ itemId: 'c' });
    rerender(<ChatFindBar items={[text('a', 'needle one needle more'), text('c', 'needle two')]} focusNonce={1} onChange={onChange} onClose={onClose} />);
    expect(count()).toBe('3/3');
    expect(last().target).toMatchObject({ itemId: 'c', itemNth: 0 });
  });

  it('больше предела — «1000+»', () => {
    const { input, count } = setUp([text('a', 'x '.repeat(1100))]);
    fireEvent.change(input, { target: { value: 'x' } });
    expect(count()).toBe('1/1000+');
  });

  it('Esc и × закрывают', () => {
    const { input, onClose } = setUp();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: S.common.close }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('поле в фокусе при монтировании; повторный focusNonce возвращает фокус и выделяет запрос', () => {
    const { input, rerender, onChange, onClose } = setUp();
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'needle' } });
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).not.toBe(input);
    rerender(<ChatFindBar items={ITEMS} focusNonce={2} onChange={onChange} onClose={onClose} />);
    expect(document.activeElement).toBe(input);
    expect((input as HTMLInputElement).selectionStart).toBe(0);
    expect((input as HTMLInputElement).selectionEnd).toBe('needle'.length);
  });
});
