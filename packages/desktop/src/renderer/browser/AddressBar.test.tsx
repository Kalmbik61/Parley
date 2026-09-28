/**
 * Тест 2 куска 9.2a: адресная строка — `normalizeUrl` (9.1) и ошибка под полем по коду.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AddressBar } from './AddressBar.js';

afterEach(cleanup);

function field(): HTMLInputElement {
  return screen.getByRole('textbox', { name: 'Address' }) as HTMLInputElement;
}

function enter(value: string): void {
  fireEvent.change(field(), { target: { value } });
  fireEvent.keyDown(field(), { key: 'Enter' });
}

describe('AddressBar (тест 2)', () => {
  it('Enter с example.com — навигация на https://example.com', () => {
    const onNavigate = vi.fn();
    render(<AddressBar url="" onNavigate={onNavigate} />);
    enter('example.com');
    expect(onNavigate).toHaveBeenCalledWith('https://example.com');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('привет — ошибка поиска; file:///x — локальные файлы; навигации нет; правка ввода снимает ошибку', () => {
    const onNavigate = vi.fn();
    render(<AddressBar url="" onNavigate={onNavigate} />);
    enter('привет');
    expect(screen.getByRole('alert').textContent).toBe("Enter an address — search isn't supported");
    enter('file:///x');
    expect(screen.getByRole('alert').textContent).toBe("Local files can't be opened here");
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.change(field(), { target: { value: 'file:///' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('показывает адрес страницы, пока поле не правят; длинный адрес — целиком в title', () => {
    const long = `https://example.com/${'a'.repeat(300)}`;
    const { rerender } = render(<AddressBar url="http://localhost:5173/a" onNavigate={() => {}} />);
    expect(field().value).toBe('http://localhost:5173/a');
    rerender(<AddressBar url={long} onNavigate={() => {}} />);
    expect(field().value).toBe(long);
    expect(field().title).toBe(long);
  });

  it('autoFocus — фокус в поле', () => {
    render(<AddressBar url="" onNavigate={() => {}} autoFocus />);
    expect(document.activeElement).toBe(field());
  });
});
