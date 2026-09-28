/** Кусок 8.3: панель вкладки диффа сообщает о нажатиях — состояние держит `DiffTab`. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiffToolbar, type DiffToolbarProps } from './DiffToolbar.js';

afterEach(cleanup);

function setup(extra: Partial<DiffToolbarProps> = {}): DiffToolbarProps {
  const props: DiffToolbarProps = {
    view: 'split',
    onView: vi.fn(),
    wrap: false,
    onWrap: vi.fn(),
    onCollapseAll: vi.fn(),
    onExpandAll: vi.fn(),
    listMode: 'list',
    onListMode: vi.fn(),
    ...extra,
  };
  render(<DiffToolbar {...props} />);
  return props;
}

describe('DiffToolbar', () => {
  it('колонки, свернуть и развернуть всё, перенос строк, список и дерево', () => {
    const props = setup();
    expect(screen.getByRole('radio', { name: 'Side by side' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Inline' }));
    expect(props.onView).toHaveBeenCalledWith('inline');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(props.onCollapseAll).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(props.onExpandAll).toHaveBeenCalledTimes(1);
    const wrap = screen.getByRole('button', { name: 'Wrap lines' });
    expect(wrap.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(wrap);
    expect(props.onWrap).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Tree' }));
    expect(props.onListMode).toHaveBeenCalledWith('tree');
  });

  it('раунд fix-live, D4: «Wrap lines» — тумблер `ui/toggle`: включённый несёт тот же признак, что выбранный пункт группы', () => {
    setup({ wrap: true });
    const wrap = screen.getByRole('button', { name: 'Wrap lines' });
    expect(wrap.getAttribute('aria-pressed')).toBe('true');
    expect(wrap.getAttribute('data-state')).toBe('on');
    expect(wrap.className).toContain('data-[state=on]:ring-toggle-on-edge');
  });

  it('повторный клик по выбранной колонке выбор не снимает', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('radio', { name: 'Side by side' }));
    expect(props.onView).not.toHaveBeenCalled();
  });
});
