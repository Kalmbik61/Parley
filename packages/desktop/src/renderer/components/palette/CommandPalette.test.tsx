/**
 * `CommandPalette` — тест 2 куска 2.3 плана окна: Enter выполняет выбранную
 * команду и закрывает палитру, Esc закрывает без выполнения.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Command } from '../../lib/commands.js';
import { CommandPalette } from './CommandPalette.js';

afterEach(cleanup);

function commands(run: () => void): Command[] {
  return [
    { id: 'a', title: 'Первая команда', keywords: ['первая'], run },
    { id: 'b', title: 'Вторая команда', keywords: ['вторая'], run: () => {} },
  ];
}

describe('CommandPalette (тест 2)', () => {
  it('Enter выполняет выбранную (по умолчанию — первую) команду и закрывает палитру', () => {
    const run = vi.fn();
    const onOpenChange = vi.fn();
    render(<CommandPalette open commands={commands(run)} onOpenChange={onOpenChange} />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(run).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('Esc закрывает палитру, ни одна команда не выполняется', () => {
    const run = vi.fn();
    const onOpenChange = vi.fn();
    render(<CommandPalette open commands={commands(run)} onOpenChange={onOpenChange} />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });

    expect(run).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('стрелка вниз двигает выбор на вторую команду — Enter не зовёт run первой', () => {
    const run = vi.fn();
    const onOpenChange = vi.fn();
    render(<CommandPalette open commands={commands(run)} onOpenChange={onOpenChange} />);

    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(run).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
