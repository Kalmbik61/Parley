/**
 * `CommandPalette` — тест 2 куска 2.3 плана окна: Enter выполняет выбранную
 * команду и закрывает палитру, Esc закрывает без выполнения.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Command } from '../../lib/commands.js';
import { CommandPalette } from './CommandPalette.js';
import { compositeOver, contrastRatio } from '../../test-utils/contrast.js';

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

describe('CommandPalette — раунд исправлений 1 куска 1.4 (ревью B, находка «подсказка активной строки нечитаема в тёмной теме»)', () => {
  it('подсказка активной (первой по умолчанию) строки — text-accent-foreground/80, а не muted-foreground', () => {
    const withHint: Command[] = [{ id: 'a', title: 'Команда', keywords: [], hint: '⌘K', run: () => {} }];
    render(<CommandPalette open commands={withHint} onOpenChange={() => {}} />);

    const hint = screen.getByText('⌘K');
    expect(hint.className).toContain('text-accent-foreground/80');
    expect(hint.className).not.toContain('text-muted-foreground');
  });

  it('контраст подсказки на подсветке активной строки — WCAG AA (≥4.5) в обеих темах, значения из tokens.css', () => {
    // Тёмная тема: строка подсвечена --accent #404040 (tokens.css:273),
    // подсказка — --accent-foreground #fafafa (tokens.css:274) с прозрачностью 80%.
    const darkHint = compositeOver([0xfa, 0xfa, 0xfa], 0.8, [0x40, 0x40, 0x40]);
    expect(contrastRatio(darkHint, [0x40, 0x40, 0x40])).toBeGreaterThanOrEqual(4.5);

    // Светлая тема: --accent #f5f5f5, --accent-foreground #171717 (tokens.css:150-151).
    const lightHint = compositeOver([0x17, 0x17, 0x17], 0.8, [0xf5, 0xf5, 0xf5]);
    expect(contrastRatio(lightHint, [0xf5, 0xf5, 0xf5])).toBeGreaterThanOrEqual(4.5);
  });
});
