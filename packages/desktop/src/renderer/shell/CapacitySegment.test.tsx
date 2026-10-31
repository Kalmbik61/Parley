/**
 * Сегмент «Agents» строки статуса (спека сна агентов и ёмкости, 4.5): текст по снимку хоста, тон предупреждения,
 * короткая форма узкого окна, поповер с очередью запусков и кнопкой в Settings.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { queuedWord } from '@parley/core/session-state';
import type { QueuedLaunch } from '@parley/core';
import type { CapacitySnapshot } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { useCapacityStore } from '../store/capacity.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { CapacitySegment } from './CapacitySegment.js';

const queued = (patch: Partial<QueuedLaunch> = {}): QueuedLaunch => ({
  class: 'work', mode: 'launch', by: 'human', at: new Date(Date.now() - 4 * 60_000 - 5_000).toISOString(),
  reason: 'machine-limit', live: 18, limit: 18, ...patch,
});

const snapshot = (machine: Partial<CapacitySnapshot['machine']> = {}, queue: CapacitySnapshot['queue'] = []): CapacitySnapshot => ({
  machine: { live: 5, limit: null, queued: 0, pressure: 'normal', swapGb: null, sleepMinutes: 60, ...machine },
  queue,
});

const trigger = (): HTMLElement => document.querySelector<HTMLElement>('[data-capacity-segment]') as HTMLElement;
const show = (value: CapacitySnapshot | null): void => useCapacityStore.setState({ snapshot: value });

beforeEach(() => {
  useWorksStore.setState({ entries: [] });
  useUiStore.getState().closeSettingsDialog();
  show(null);
});
afterEach(cleanup);

describe('CapacitySegment', () => {
  it('без снимка ничего не рисует', () => {
    const { container } = render(<CapacitySegment />);
    expect(container.innerHTML).toBe('');
  });

  it('полный текст: Agents 17/18 · 3 queued · memory warn', () => {
    show(snapshot({ live: 17, limit: 18, queued: 3, pressure: 'warn' }));
    render(<CapacitySegment />);
    expect(trigger().textContent).toContain('Agents 17/18 · 3 queued · memory warn');
    expect(trigger().getAttribute('title')).toBe('Agents 17/18 · 3 queued · memory warn');
    expect(trigger().getAttribute('aria-label')).toBe('Agents 17/18 · 3 queued · memory warn');
  });

  it('потолок выключен, очереди нет, память normal: просто Agents 5', () => {
    show(snapshot());
    render(<CapacitySegment />);
    expect(trigger().getAttribute('title')).toBe('Agents 5');
  });

  it('давление unknown не пишется', () => {
    show(snapshot({ live: 2, limit: 4, pressure: 'unknown' }));
    render(<CapacitySegment />);
    expect(trigger().getAttribute('title')).toBe('Agents 2/4');
  });

  it('короткая форма узкого окна: 17/18 или 17, полный текст скрыт ниже 1100 px', () => {
    show(snapshot({ live: 17, limit: 18, queued: 3 }));
    const { unmount } = render(<CapacitySegment />);
    const full = screen.getByText('Agents 17/18 · 3 queued');
    const short = screen.getByText('17/18');
    expect(full.className).toContain('hidden');
    expect(full.className).toContain('min-[1100px]:inline');
    expect(short.className).toContain('min-[1100px]:hidden');
    unmount();
    show(snapshot({ live: 17 }));
    render(<CapacitySegment />);
    expect(screen.getByText('17').className).toContain('min-[1100px]:hidden');
  });

  it('тон предупреждения: critical, очередь и live > limit; в норме его нет', () => {
    const tone = (value: CapacitySnapshot): boolean => {
      show(value);
      const { unmount } = render(<CapacitySegment />);
      const warned = trigger().className.includes('text-accent-700');
      unmount();
      return warned;
    };
    expect(tone(snapshot({ pressure: 'critical' }))).toBe(true);
    expect(tone(snapshot({ pressure: 'warn' }))).toBe(true);
    expect(tone(snapshot({ queued: 1, live: 2, limit: 2 }))).toBe(true);
    expect(tone(snapshot({ live: 3, limit: 2 }))).toBe(true);
    expect(tone(snapshot({ live: 2, limit: 2 }))).toBe(false);
    expect(tone(snapshot({ pressure: 'unknown' }))).toBe(false);
  });

  it('длинное значение целиком в title', () => {
    show(snapshot({ live: 128, limit: 128, queued: 12, pressure: 'critical' }));
    render(<CapacitySegment />);
    expect(trigger().getAttribute('title')).toBe('Agents 128/128 · 12 queued · memory critical');
  });

  it('поповер: числа, память со свопом, порог сна; пустая очередь', () => {
    show(snapshot({ live: 17, limit: 18, pressure: 'warn', swapGb: 4.3, sleepMinutes: 5 }));
    render(<CapacitySegment />);
    fireEvent.click(trigger());
    const dialog = screen.getByRole('dialog', { name: S.capacity.title });
    expect(within(dialog).getByText('Live: 17 of 18')).toBeTruthy();
    expect(within(dialog).getByText('Memory: warn · swap 4.3 GB')).toBeTruthy();
    expect(within(dialog).getByText('Idle agents sleep after 5 min')).toBeTruthy();
    expect(within(dialog).getByText('No launches are waiting.')).toBeTruthy();
  });

  it('поповер без потолка и со сном выключенным', () => {
    show(snapshot({ live: 5, sleepMinutes: null }));
    render(<CapacitySegment />);
    fireEvent.click(trigger());
    expect(screen.getByText('Live: 5, no limit')).toBeTruthy();
    expect(screen.getByText('Memory: normal')).toBeTruthy();
    expect(screen.getByText('Sleep is off')).toBeTruthy();
  });

  it('очередь в порядке снимка: метка сессии, проект, слово очереди и ожидание', () => {
    useWorksStore.setState({
      entries: [makeWork('w-01', { projectPath: '/tmp/alpha', sessions: [makeSession('s-03', 'backend'), makeSession('s-04', 'tests')] })],
    });
    const first = queued();
    const second = queued({ reason: 'memory-critical', at: new Date(Date.now() - 5_000).toISOString() });
    show(snapshot({ live: 18, limit: 18, queued: 2 }, [
      { ref: { projectPath: '/tmp/alpha', workId: 'w-01', sessionId: 's-04' }, queued: first },
      { ref: { projectPath: '/tmp/alpha', workId: 'w-01', sessionId: 's-03' }, queued: second },
    ]));
    render(<CapacitySegment />);
    fireEvent.click(trigger());
    expect(screen.getByText('Waiting for a slot (2)')).toBeTruthy();
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('S04 tests');
    expect(rows[0]!.textContent).toContain('alpha');
    expect(rows[0]!.textContent).toContain(queuedWord(first));
    expect(rows[0]!.textContent).toContain('for 4 min');
    expect(rows[1]!.textContent).toContain('S03 backend');
    expect(rows[1]!.textContent).toContain(queuedWord(second));
    expect(rows[1]!.textContent).toContain('for <1 min');
    expect(screen.queryByText('No launches are waiting.')).toBeNull();
  });

  it('сессии нет в картах: строка остаётся с id сессии', () => {
    show(snapshot({ queued: 1 }, [{ ref: { projectPath: '/tmp/gone', workId: 'w-09', sessionId: 's-07' }, queued: queued() }]));
    render(<CapacitySegment />);
    fireEvent.click(trigger());
    const row = screen.getByRole('listitem');
    expect(row.textContent).toContain('s-07');
    expect(row.textContent).toContain('gone');
  });

  it('«Limits in Settings» открывает Settings на вкладке agents', () => {
    show(snapshot());
    render(<CapacitySegment />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('button', { name: S.capacity.openLimits }));
    expect(useUiStore.getState().dialogs.settings).toBe(true);
    expect(useUiStore.getState().settingsSection).toBe('agents');
  });
});
