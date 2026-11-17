/**
 * Шапка комнаты: в низкой панели в виде Board сжимается (спека доски комнаты 4.1). Размеры jsdom не считает —
 * проверяется только разметка: какие блоки несут вариант `hidden` по контейнеру `room-panel`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { RoomHeader, SHORT_PANEL_HIDDEN, type RoomHeaderProps } from './RoomHeader.js';

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

const hidden = (el: Element | null): boolean => {
  for (let node = el; node !== null; node = node.parentElement) if (node.className.includes?.('max-height:559px')) return true;
  return false;
};
const q = (selector: string): Element => document.querySelector(selector) as Element;

describe('RoomHeader — низкая панель', () => {
  it('без boardOpen у ряда режима и ленты участников нет класса сжатия', () => {
    render(<RoomHeader {...props()} />);
    expect(hidden(q('[data-test-mode]'))).toBe(false);
    expect(hidden(q('[data-participant-strip]'))).toBe(false);
    expect(document.body.innerHTML.includes('max-height:559px')).toBe(false);
  });

  it('с boardOpen класс сжатия стоит на обоих, название и переключатель без него', () => {
    render(<RoomHeader {...props({ boardOpen: true })} />);
    expect(hidden(q('[data-test-mode]'))).toBe(true);
    expect(hidden(q('[data-test-usage]'))).toBe(true);
    expect(hidden(q('[data-participant-strip]'))).toBe(true);
    expect(hidden(q('h3'))).toBe(false);
    expect(hidden(q('[data-room-header] span[title]'))).toBe(false);
    expect(hidden(q('[data-test-switch]'))).toBe(false);
    expect(hidden(q('[data-test-browser]'))).toBe(false);
    expect(q('[data-test-mode]').parentElement!.className).toContain(SHORT_PANEL_HIDDEN);
  });

  it('только ряд режима без чипов тоже прячется', () => {
    const { usageChip: _usage, ...rest } = props({ boardOpen: true });
    void _usage;
    render(<RoomHeader {...rest} />);
    expect(hidden(q('[data-test-mode]'))).toBe(true);
  });
});
