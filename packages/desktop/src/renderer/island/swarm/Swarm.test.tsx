/** Обёртка роя в jsdom: canvas с учётом DPR, нет 2d-контекста — не падает, форма видна в `data-shape`. */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { swarmSpecFor } from './spec.js';
import { HOST_IDLE } from '../assistant/store.js';
import { Swarm } from './Swarm.js';

const IDLE = swarmSpecFor(HOST_IDLE, 'idle', true);
const THINKING = swarmSpecFor({ ...HOST_IDLE, phase: 'thinking' }, 'idle', true);

beforeEach(() => {
  // jsdom не реализует getContext и пишет «Not implemented» — глушим, возвращая null, как в проде без контекста.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Swarm', () => {
  it('canvas: ширина с учётом devicePixelRatio, без контекста не падает', () => {
    render(<Swarm spec={IDLE} souls={20} width={28} height={28} d={17} cy={14} fps={0} />);
    const canvas = screen.getByTestId('swarm') as HTMLCanvasElement;
    expect(canvas.width).toBe(28 * (window.devicePixelRatio || 1));
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
  });

  it('смена spec меняет data-shape', () => {
    const { rerender } = render(<Swarm spec={IDLE} souls={20} width={28} height={28} d={17} cy={14} fps={0} />);
    expect(screen.getByTestId('swarm').getAttribute('data-shape')).toBe('dot');
    rerender(<Swarm spec={THINKING} souls={20} width={28} height={28} d={17} cy={14} fps={0} />);
    expect(screen.getByTestId('swarm').getAttribute('data-shape')).toBe('sphere');
  });

  it('размонтирование не оставляет цикла кадров', () => {
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');
    const ctx = {
      setTransform: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '', globalAlpha: 1, globalCompositeOperation: '',
      createRadialGradient: () => ({ addColorStop: vi.fn() }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const { unmount } = render(<Swarm spec={IDLE} souls={20} width={28} height={28} d={17} cy={14} fps={30} />);
    unmount();
    expect(cancel).toHaveBeenCalled();
  });
});
