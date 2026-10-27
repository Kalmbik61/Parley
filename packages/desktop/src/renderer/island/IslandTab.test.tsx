/**
 * Зона нажатия убранного острова: без выреза — 64×16 под чёлкой (или по размеру `✅ N`); в вырезе (#9 §12.1, §12.3,
 * план 3b B28) — ровно прямоугольник выреза у верхнего края и по центру выреза, и с непросмотренными Done тоже
 * (B26 F-B26-1: ушей нет). Клик и потяжка вниз выдвигают остров.
 */

import { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S } from '../../shared/strings.js';
import { IslandTab, PULL_EXPAND_PX } from './IslandTab.js';
import type { Notch } from './notch.js';

const NOTCH: Notch = { width: 185, height: 32, centerX: 240.5 };

function tab(patch: { doneCount?: number; notch?: Notch | null; topInset?: number; capsule?: boolean } = {}) {
  const onExpand = vi.fn();
  render(
    <IslandTab anchorClass="justify-center" topInset={patch.topInset ?? 38} doneCount={patch.doneCount ?? 0} notch={patch.notch ?? null}
      capsule={patch.capsule ?? false} tabRef={createRef<HTMLButtonElement>()} onExpand={onExpand} />,
  );
  const button = screen.getByTestId('island-tab');
  return { onExpand, button, wrapper: button.parentElement as HTMLElement };
}

const pointer = (type: string, screenY: number): MouseEvent => new MouseEvent(type, { bubbles: true, screenX: 10, screenY, buttons: 1 });

let innerWidth = 0;

beforeEach(() => {
  innerWidth = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 480 });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
});

describe('язычок без выреза', () => {
  it('64×16 под чёлкой, по точке острова; ничего не рисует', () => {
    const { button, wrapper } = tab();
    expect(wrapper.style.top).toBe('38px');
    expect(wrapper.className).toContain('justify-center');
    expect(button.className).toContain('w-16');
    expect(button.className).toContain('h-4');
    expect(button.textContent).toBe('');
    expect(button.getAttribute('aria-label')).toBe(S.island.showIsland);
  });

  it('с Done — по размеру невидимого «✅ N»', () => {
    const { button } = tab({ doneCount: 2 });
    expect(button.getAttribute('aria-label')).toBe(S.island.doneTab);
    expect((button.firstElementChild as HTMLElement).textContent).toBe('✅ 2');
    expect((button.firstElementChild as HTMLElement).className).toContain('opacity-0');
  });
});

describe('язычок в вырезе (N6)', () => {
  it('голый вырез: зона — ровно прямоугольник выреза у верхнего края, по центру выреза', () => {
    const { button, wrapper } = tab({ notch: NOTCH });
    expect(wrapper.style.top).toBe('0px');
    expect(button.className).not.toContain('w-16');
    expect(button.className).not.toContain('h-4');
    // Кадр 480 pt: центр выреза на 240,5 — зона сдвинута на половину точки вправо.
    expect(button.style.left).toBe('0.5px');
    expect(button.className).toContain('relative');
    const box = button.firstElementChild as HTMLElement;
    expect(box.style.width).toBe('185px');
    expect(box.style.height).toBe('32px');
    expect(button.textContent).toBe('');
    expect(button.getAttribute('aria-label')).toBe(S.island.showIsland);
  });

  it('с непросмотренными Done — зона по капсуле (вырез и по 80 pt), подпись «агенты закончили» (B26 F-B26-3)', () => {
    const { button } = tab({ notch: NOTCH, doneCount: 2, capsule: true });
    expect(button.getAttribute('aria-label')).toBe(S.island.doneTab);
    const box = button.firstElementChild as HTMLElement;
    expect(box.getAttribute('aria-hidden')).toBe('true');
    expect(box.style.width).toBe('345px');
    expect(box.style.height).toBe('32px');
    expect(button.textContent).toBe('');
  });

  it('клик и потяжка вниз дальше порога выдвигают остров', () => {
    const { button, onExpand } = tab({ notch: NOTCH });
    fireEvent.click(button);
    expect(onExpand).toHaveBeenCalledTimes(1);
    fireEvent(button, pointer('pointerdown', 10));
    fireEvent(button, pointer('pointermove', 10 + PULL_EXPAND_PX + 1));
    expect(onExpand).toHaveBeenCalledTimes(2);
  });
});
