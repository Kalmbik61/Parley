/**
 * Кусок 7.3b, тест 5: баннер по каждому состоянию буфера спеки 10.5 (14.2). «Save again» с
 * `expectedMtimeMs: null` — в `FileBody.test.tsx`: запись делает стор.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialBuffer, type BufferModel, type BufferStatus } from '../buffer.js';
import { DiskChangeBanner } from './DiskChangeBanner.js';

afterEach(cleanup);

function model(status: BufferStatus): BufferModel {
  return { ...initialBuffer(), status, text: 'a', savedText: status.endsWith('dirty') ? 'b' : 'a' };
}

function renderBanner(status: BufferStatus) {
  const handlers = { onReload: vi.fn(), onCompare: vi.fn(), onKeepMine: vi.fn(), onSaveAgain: vi.fn(), onClose: vi.fn() };
  render(<DiskChangeBanner model={model(status)} {...handlers} />);
  return handlers;
}

const buttons = (): string[] => screen.queryAllByRole('button').map((button) => button.textContent ?? '');

describe('DiskChangeBanner (тест 5)', () => {
  it('disk-changed-dirty — текст и Reload, Compare, Keep mine', () => {
    const handlers = renderBanner('disk-changed-dirty');
    expect(screen.getByTestId('disk-change-banner').textContent).toContain('File changed on disk (probably by the agent)');
    expect(buttons()).toEqual(['Reload', 'Compare', 'Keep mine']);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(handlers.onReload).toHaveBeenCalledTimes(1);
    expect(handlers.onCompare).toHaveBeenCalledTimes(1);
    expect(handlers.onKeepMine).toHaveBeenCalledTimes(1);
  });

  it('deleted — текст и Save again, Close', () => {
    const handlers = renderBanner('deleted');
    expect(screen.getByTestId('disk-change-banner').textContent).toContain('File deleted on disk');
    expect(buttons()).toEqual(['Save again', 'Close']);
    fireEvent.click(screen.getByRole('button', { name: 'Save again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(handlers.onSaveAgain).toHaveBeenCalledTimes(1);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it.each<BufferStatus>(['loading', 'clean', 'dirty', 'saving', 'disk-changed-clean', 'error'])('%s — баннера нет', (status) => {
    renderBanner(status);
    expect(screen.queryByTestId('disk-change-banner')).toBeNull();
  });

  it('в сравнении кнопки Compare нет', () => {
    render(
      <DiskChangeBanner model={model('disk-changed-dirty')} comparing onReload={vi.fn()} onCompare={vi.fn()} onKeepMine={vi.fn()} onSaveAgain={vi.fn()} onClose={vi.fn()} />,
    );
    expect(buttons()).toEqual(['Reload', 'Keep mine']);
  });
});
