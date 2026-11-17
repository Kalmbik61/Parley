/**
 * Шапка комнаты в низкой панели вида Board (спека доски комнаты 4.1): `compact` убирает ряд режима и ленту участников.
 * Высоту меряет `RoomPanel` (его тесты), здесь — только разметка шапки.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { RoomHeader, type RoomHeaderProps } from './RoomHeader.js';

afterEach(cleanup);

const props = (patch: Partial<RoomHeaderProps> = {}): RoomHeaderProps => ({
  title: 'Delivery',
  subtitle: 'Created by you · 2 agents',
  participants: [],
  onOpenSession: vi.fn(),
  modeControl: <div data-test-mode="">Mode</div>,
  usageChip: <span data-test-usage="">Usage</span>,
  viewSwitch: <div data-test-switch="">Switch</div>,
  browserToggle: <button type="button" data-test-browser="">Browser</button>,
  now: new Date('2026-11-17T12:00:00.000Z'),
  ...patch,
});
const q = (selector: string): Element | null => document.querySelector(selector);

describe('RoomHeader — compact', () => {
  it('без compact ряд режима и лента участников на месте', () => {
    render(<RoomHeader {...props()} />);
    expect(q('[data-test-mode]')).toBeTruthy();
    expect(q('[data-test-usage]')).toBeTruthy();
    expect(q('[data-participant-strip]')).toBeTruthy();
  });

  it('разметка без compact и с compact: false одна и та же', () => {
    const plain = render(<RoomHeader {...props()} />).container.innerHTML;
    cleanup();
    expect(render(<RoomHeader {...props({ compact: false })} />).container.innerHTML).toBe(plain);
  });

  it('с compact их нет, а название, подзаголовок, переключатель вида и кнопка Browser есть', () => {
    render(<RoomHeader {...props({ compact: true })} />);
    expect(q('[data-test-mode]')).toBeNull();
    expect(q('[data-test-usage]')).toBeNull();
    expect(q('[data-participant-strip]')).toBeNull();
    expect(q('h3')?.textContent).toBe('Delivery');
    expect(q('span[title="Created by you · 2 agents"]')).toBeTruthy();
    expect(q('[data-test-switch]')).toBeTruthy();
    expect(q('[data-test-browser]')).toBeTruthy();
  });

  it('ряд режима без чипов тоже уходит', () => {
    const { usageChip: _usage, ...rest } = props({ compact: true });
    void _usage;
    render(<RoomHeader {...rest} />);
    expect(q('[data-test-mode]')).toBeNull();
  });
});
