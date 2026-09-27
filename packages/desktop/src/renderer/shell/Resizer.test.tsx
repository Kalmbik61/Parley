/**
 * Ручка ресайза сайдбара (кусок 2.3, спека 4.4, 5.1): `pointermove` двигает
 * ширину цели через `requestAnimationFrame`, а на сервер (`onCommit`) уходит
 * только на `pointerup` — тесты 3 и 4 куска.
 */

import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { clampWidth, Resizer } from './Resizer.js';

afterEach(cleanup);

describe('clampWidth (тест 3)', () => {
  it('держит значение в пределах [min, max]', () => {
    expect(clampWidth(600, 220, 500)).toBe(500);
    expect(clampWidth(100, 220, 500)).toBe(220);
    expect(clampWidth(300, 220, 500)).toBe(300);
  });
});

describe('Resizer (тест 4)', () => {
  it('pointermove не зовёт onCommit; pointerup зовёт один раз с приведённой шириной', () => {
    const target = createRef<HTMLDivElement>();
    const onCommit = vi.fn();
    const { container } = render(
      <>
        <div ref={target} style={{ width: 280 }} />
        <Resizer side="left" width={280} min={220} max={500} target={target} onCommit={onCommit} />
      </>,
    );
    const handle = container.querySelector('[role="separator"]');
    if (handle === null) throw new Error('ручка ресайза не найдена');

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400 });
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 400 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    // 280 + 400 сверх предела 500 — приведённая (`clampWidth`) ширина.
    expect(onCommit).toHaveBeenCalledWith(500);
  });

  it('сторона right двигает ширину в обратную сторону от курсора', () => {
    const target = createRef<HTMLDivElement>();
    const onCommit = vi.fn();
    const { container } = render(
      <>
        <div ref={target} style={{ width: 350 }} />
        <Resizer side="right" width={350} min={220} max={600} target={target} onCommit={onCommit} />
      </>,
    );
    const handle = container.querySelector('[role="separator"]');
    if (handle === null) throw new Error('ручка ресайза не найдена');

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 450 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 450 });

    // Курсор ушёл влево на 50 — у правого сайдбара это расширение на 50.
    expect(onCommit).toHaveBeenCalledWith(400);
  });
});
