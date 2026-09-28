/** Кусок 7.5, тест 4: картинка из Blob, «Fit / 100%», размер в пикселях, `revokeObjectURL` при размонтировании. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImagePreview } from './ImagePreview.js';

const created: Blob[] = [];
const revoked: string[] = [];

beforeEach(() => {
  created.length = 0;
  revoked.length = 0;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    created.push(blob);
    return `blob:harnas/${created.length}`;
  });
  URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url));
});

afterEach(() => cleanup());

describe('ImagePreview (тест 4)', () => {
  it('<img> из Blob; revokeObjectURL при размонтировании', () => {
    const { container, unmount } = render(<ImagePreview bytes={new Uint8Array([1, 2, 3])} path="img/a.png" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:harnas/1');
    expect(created[0]?.type).toBe('image/png');
    expect(revoked).toEqual([]);
    unmount();
    expect(revoked).toEqual(['blob:harnas/1']);
  });

  it('svg — image/svg+xml: <img> не исполняет скрипты svg, а без типа не покажет его вовсе', () => {
    render(<ImagePreview bytes={new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')} path="logo.SVG" />);
    expect(created[0]?.type).toBe('image/svg+xml');
  });

  it('после загрузки — размер «1280 × 720 px»; Fit по умолчанию, 100% — натуральный размер', () => {
    const { container } = render(<ImagePreview bytes={new Uint8Array([1])} path="a.webp" />);
    const img = container.querySelector('img');
    if (img === null) throw new Error('нет img');
    Object.defineProperty(img, 'naturalWidth', { value: 1280 });
    Object.defineProperty(img, 'naturalHeight', { value: 720 });
    fireEvent.load(img);
    expect(screen.getByText('1280 × 720 px')).toBeTruthy();
    expect(img.className).toContain('max-w-full');
    fireEvent.click(screen.getByRole('radio', { name: '100%' }));
    expect(img.className).not.toContain('max-w-full');
    fireEvent.click(screen.getByRole('radio', { name: 'Fit' }));
    expect(img.className).toContain('max-w-full');
  });
});
