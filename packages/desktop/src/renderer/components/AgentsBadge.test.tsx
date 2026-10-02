/**
 * Бейдж агентов с поповером (кусок 4b плана 2026-10-01, решение 13): число и подпись, поповер со строкой на агента
 * (тип, описание, `background`), клик по строке — `onOpen`, длинное описание не распирает поповер, бейдж внутри
 * кликабельной строки не передаёт ей свои события.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { LiveTask } from '@parley/protocol';
import { AgentsBadge } from './AgentsBadge.js';

afterEach(cleanup);

const task = (id: string, extra: Partial<LiveTask> = {}): LiveTask => ({
  id,
  agentType: 'Explore',
  description: `Task ${id}`,
  background: false,
  ...extra,
});

function renderBadge(tasks: LiveTask[], props: Partial<Parameters<typeof AgentsBadge>[0]> = {}) {
  const onOpen = vi.fn();
  const view = render(<AgentsBadge tasks={tasks} onOpen={onOpen} {...props} />);
  return { onOpen, ...view };
}

const badge = (): HTMLElement => screen.getByTestId('agents-badge');
const open = (): void => {
  fireEvent.click(badge());
};
const rows = (): HTMLElement[] => screen.getAllByTestId('agents-popover-row');

describe('AgentsBadge — подпись', () => {
  it('число агентов: «1 agent», «2 agents»; по умолчанию поповер закрыт', () => {
    renderBadge([task('a')]);
    expect(badge().textContent).toBe('1 agent');
    expect(screen.queryByTestId('agents-popover')).toBeNull();
    cleanup();
    renderBadge([task('a'), task('b')]);
    expect(badge().textContent).toBe('2 agents');
  });

  it('tabIndex владельца доходит до кнопки; без него — обычный порядок Tab', () => {
    renderBadge([task('a')], { tabIndex: -1 });
    expect(badge().getAttribute('tabindex')).toBe('-1');
    cleanup();
    renderBadge([task('a')]);
    expect(badge().hasAttribute('tabindex')).toBe(false);
  });

  it('своя подпись и подсказка заменяют «N agents»; вид задаёт владелец', () => {
    renderBadge([task('a'), task('b')], { label: '2 subagents: Docs lookup', title: '2 subagents\n• Docs lookup', className: 'truncate text-xs' });
    expect(badge().textContent).toBe('2 subagents: Docs lookup');
    expect(badge().getAttribute('title')).toBe('2 subagents\n• Docs lookup');
    expect(badge().className).toBe('truncate text-xs');
    expect(badge().tagName).toBe('BUTTON');
  });
});

describe('AgentsBadge — поповер', () => {
  it('клик по бейджу открывает поповер: строка на агента, у строки тип, описание, у фонового — «background»', () => {
    renderBadge([
      task('a', { agentType: 'Explore', description: 'Look around', background: true }),
      task('b', { agentType: 'general-purpose', description: 'Write the docs', background: false }),
    ]);
    open();
    const popover = screen.getByTestId('agents-popover');
    expect(popover.getAttribute('aria-label')).toBe('Agents');
    expect(rows()).toHaveLength(2);
    const [first, second] = rows() as [HTMLElement, HTMLElement];
    expect(first.textContent).toBe('Explorebackground' + 'Look around');
    expect(within(first).getByText('background')).toBeTruthy();
    expect(second.textContent).toBe('general-purpose' + 'Write the docs');
    expect(within(second).queryByText('background')).toBeNull();
    // Подпись строки для скринридера — «Open <тип>».
    expect(first.getAttribute('aria-label')).toBe('Open Explore');
    expect(second.getAttribute('aria-label')).toBe('Open general-purpose');
  });

  it('тип неизвестен — «Agent»; описания нет — строки описания нет', () => {
    renderBadge([task('a', { agentType: null, description: null })]);
    open();
    const [row] = rows() as [HTMLElement];
    expect(row.textContent).toBe('Agent');
    expect(row.getAttribute('aria-label')).toBe('Open Agent');
    expect(row.getAttribute('title')).toBeNull();
  });

  it('клик по строке зовёт onOpen с этим агентом и закрывает поповер', () => {
    const { onOpen } = renderBadge([task('a'), task('b', { agentType: 'Plan' })]);
    open();
    fireEvent.click(rows()[1]!);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'b', agentType: 'Plan' }));
    expect(screen.queryByTestId('agents-popover')).toBeNull();
  });

  it('onOpenChange: true при открытии, false при закрытии строкой и по Esc', () => {
    const onOpenChange = vi.fn();
    renderBadge([task('a')], { onOpenChange });
    open();
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(rows()[0]!);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    open();
    fireEvent.keyDown(screen.getByTestId('agents-popover'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(onOpenChange.mock.calls.map((call) => call[0])).toEqual([true, false, true, false]);
  });

  it('длинное описание (200 знаков без пробелов) переносится и обрезается тремя строками, целиком — в подсказке; поповер не шире w-72', () => {
    const long = 'x'.repeat(200);
    renderBadge([task('a', { description: long })]);
    open();
    const [row] = rows() as [HTMLElement];
    const description = within(row).getByText(long);
    expect(description.className).toContain('line-clamp-3');
    expect(description.className).toContain('break-words');
    expect(row.getAttribute('title')).toBe(long);
    expect(row.className).toContain('min-w-0');
    expect(screen.getByTestId('agents-popover').className).toContain('w-72');
  });

  it('anchor — поповер отсчитывается от чужого элемента (строка сессии): лишней разметки нет, поповер открывается', () => {
    const anchor = { current: null as HTMLElement | null };
    render(
      <div ref={(node) => (anchor.current = node)} data-testid="host-row">
        <AgentsBadge tasks={[task('a')]} onOpen={() => {}} anchor={anchor} />
      </div>,
    );
    expect(screen.getByTestId('host-row').children).toHaveLength(1);
    open();
    expect(screen.getByTestId('agents-popover')).toBeTruthy();
  });

  it('много агентов: список прокручивается и не выше свободной высоты окна', () => {
    renderBadge(Array.from({ length: 12 }, (_, at) => task(`t${at}`)));
    open();
    expect(rows()).toHaveLength(12);
    const list = rows()[0]!.parentElement as HTMLElement;
    expect(list.className).toContain('overflow-y-auto');
    expect(list.className).toContain('--radix-popover-content-available-height');
  });
});

describe('AgentsBadge — внутри кликабельной строки', () => {
  it('клик, Enter и пробел на бейдже, а также нажатие мыши в поповере до строки-владельца не доходят; стрелки идут дальше', () => {
    const rowClick = vi.fn();
    const rowKey = vi.fn();
    const rowPointer = vi.fn();
    render(
      <div onClick={rowClick} onKeyDown={(event) => rowKey(event.key)} onPointerDown={rowPointer}>
        <AgentsBadge tasks={[task('a')]} onOpen={() => {}} />
      </div>,
    );
    fireEvent.click(badge());
    fireEvent.keyDown(badge(), { key: 'Enter' });
    fireEvent.keyDown(badge(), { key: ' ' });
    expect(rowClick).not.toHaveBeenCalled();
    expect(rowKey).not.toHaveBeenCalled();
    // Сайдбар ходит по строкам стрелками — с бейджа они до него доходят.
    fireEvent.keyDown(badge(), { key: 'ArrowDown' });
    expect(rowKey).toHaveBeenCalledTimes(1);
    expect(rowKey).toHaveBeenCalledWith('ArrowDown');
    // Поповер открылся и без передачи события строке.
    expect(screen.getByTestId('agents-popover')).toBeTruthy();
    // Портал: события React всплывают по дереву компонентов — мышь внутри поповера строка не должна видеть.
    fireEvent.pointerDown(screen.getByTestId('agents-popover'));
    expect(rowPointer).not.toHaveBeenCalled();
  });
});
