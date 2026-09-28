/** Кусок 7.5: таблица CSV и TSV — первая строка заголовком, виртуализация, строка про 10 000 строк. */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CsvPreview } from './CsvPreview.js';

// В jsdom у элементов нет размеров: виртуализатору нужна высота области прокрутки (как в `Tree.test`).
const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('role') === 'table' ? 600 : 0;
    },
  });
});

afterEach(() => {
  cleanup();
  if (original !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original);
});

describe('CsvPreview', () => {
  it('первая строка — заголовок, дальше строки данных; поле с запятой в кавычках — одна ячейка', () => {
    render(<CsvPreview text={'name,city\nAnna,"Paris, FR"\nBob,Oslo\n'} delimiter="," />);
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers).toEqual(['name', 'city']);
    expect(screen.getByText('Paris, FR')).toBeTruthy();
    expect(screen.getByText('Oslo')).toBeTruthy();
    expect(screen.queryByText('Showing first 10,000 rows')).toBeNull();
  });

  it('TSV — табуляция; больше 10 000 строк — «Showing first 10,000 rows», в DOM не все строки', () => {
    const lines = ['a\tb', ...Array.from({ length: 10_001 }, (_, index) => `${index}\tx`)];
    const { container } = render(<CsvPreview text={lines.join('\n')} delimiter={'\t'} />);
    expect(screen.getByText('Showing first 10,000 rows')).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['a', 'b']);
    const rendered = container.querySelectorAll('[role="row"]').length;
    expect(rendered).toBeGreaterThan(1);
    expect(rendered).toBeLessThan(200);
  });

  it('длинное значение ячейки обрезается, целиком — в title', () => {
    const long = 'v'.repeat(500);
    render(<CsvPreview text={`h\n${long}`} delimiter="," />);
    const cell = screen.getByTitle(long);
    expect(cell.className).toContain('truncate');
  });

  it('CSV в 100 000 колонок рисуется быстро: 200 колонок и строка об обрезке', () => {
    const wide = Array.from({ length: 100_000 }, (_, index) => `c${index}`).join(',');
    const data = Array.from({ length: 100_000 }, () => 'v').join(',');
    const started = performance.now();
    const { container } = render(<CsvPreview text={`${wide}\n${data}\n${data}`} delimiter="," />);
    // Порог с запасом на загруженную машину: без предела здесь сотни тысяч узлов DOM и секунды.
    expect(performance.now() - started).toBeLessThan(1500);
    expect(screen.getAllByRole('columnheader')).toHaveLength(200);
    expect(screen.getByText('Showing first 200 columns')).toBeTruthy();
    const firstRow = container.querySelector('[role="row"]:not(.sticky)');
    expect(firstRow?.querySelectorAll('[role="cell"]').length).toBe(200);
  });
});

