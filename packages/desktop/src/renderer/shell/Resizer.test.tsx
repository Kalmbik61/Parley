/**
 * Ручка ресайза сайдбара (кусок 2.3, спека 4.4, 5.1): `pointermove` двигает
 * ширину цели через `requestAnimationFrame`, а на сервер (`onCommit`) уходит
 * только на `pointerup` — тесты 3 и 4 куска.
 */

import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { clampWidth, Resizer } from './Resizer.js';

afterEach(cleanup);

describe('clampWidth (тест 3)', () => {
  it('держит значение в пределах [min, max]', () => {
    expect(clampWidth(600, 220, 500)).toBe(500);
    expect(clampWidth(100, 220, 500)).toBe(220);
    expect(clampWidth(300, 220, 500)).toBe(300);
  });
});

describe('Resizer — ручка не занимает места в раскладке (раунд исправлений 3, Important)', () => {
  it('обёртка нулевой ширины в потоке, зона захвата 12px абсолютным поверх шва', () => {
    const target = createRef<HTMLDivElement>();
    const { container } = render(
      <>
        <div ref={target} style={{ width: 280 }} />
        <Resizer side="left" width={280} min={220} max={500} target={target} onCommit={() => {}} />
      </>,
    );
    const handle = container.querySelector('[role="separator"]');
    if (handle === null) throw new Error('ручка ресайза не найдена');

    // Зона захвата — 12px, абсолютным позиционированием поверх шва, а не
    // элементом потока (спека 4.4: «зона ресайза — 12px над швом»).
    expect(handle.className).toMatch(/\babsolute\b/);
    expect(handle.className).toMatch(/\bw-3\b/);

    // Вклад в раскладку — нулевой: сосед слева (сайдбар) и сосед справа
    // (центр) стоят вплотную друг к другу, шов у них общий, а не разведён на
    // 12px тёмным просветом фона окна.
    const wrapper = handle.parentElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper?.className).toMatch(/\bw-0\b/);
  });
});

describe('Resizer — шов без линии (Organic, 1.1)', () => {
  // Сайдбары лежат на фоне окна, центр — лист со своей тенью: линия шва рядом с его краем читалась бы
  // границей листа. Ручка остаётся, а линия проявляется только под указателем.
  it('линия шва прозрачна, пока указатель не над ручкой; под ним — кольцо фокуса', () => {
    const target = createRef<HTMLDivElement>();
    const { container } = render(
      <>
        <div ref={target} style={{ width: 280 }} />
        <Resizer side="left" width={280} min={220} max={500} target={target} onCommit={() => {}} />
      </>,
    );
    const line = container.querySelector('[role="separator"] > div');
    expect(line?.className).toContain('bg-transparent');
    expect(line?.className).not.toMatch(/\bbg-border\b/);
    expect(line?.className).toContain('group-hover:bg-ring/50');
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

  it('во время перетаскивания в DOM есть прозрачный оверлей поверх центра, после отпускания — нет (раунд исправлений 1, Important A1)', () => {
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

    expect(screen.queryByTestId('resize-overlay')).toBeNull();

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0 });
    // Оверлей нужен, чтобы <webview>/Monaco не перехватывали мышь во время
    // перетаскивания (спека 5.1) — без него хват указателя самого `Resizer`
    // не гарантирован над гостевым процессом `<webview>`.
    expect(screen.getByTestId('resize-overlay')).toBeTruthy();

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 50 });
    expect(screen.queryByTestId('resize-overlay')).toBeNull();
  });

  it('pointercancel тоже снимает оверлей', () => {
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
    expect(screen.getByTestId('resize-overlay')).toBeTruthy();

    fireEvent.pointerCancel(handle, { pointerId: 1 });
    expect(screen.queryByTestId('resize-overlay')).toBeNull();
  });

  it('отменяет запланированный requestAnimationFrame при размонтировании (раунд исправлений 1, Minor A4)', () => {
    const target = createRef<HTMLDivElement>();
    const onCommit = vi.fn();
    const { container, unmount } = render(
      <>
        <div ref={target} style={{ width: 280 }} />
        <Resizer side="left" width={280} min={220} max={500} target={target} onCommit={onCommit} />
      </>,
    );
    const handle = container.querySelector('[role="separator"]');
    if (handle === null) throw new Error('ручка ресайза не найдена');

    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame');
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0 });
    // Планирует rAF, который к размонтированию ещё не успел сработать.
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 50 });

    unmount();

    expect(cancelSpy).toHaveBeenCalled();
    cancelSpy.mockRestore();
  });

  it('lostpointercapture без pointerup/pointercancel снимает оверлей без commit, и клик где угодно после этого не начинает перетаскивание заново (раунд исправлений 2, Important)', () => {
    const target = createRef<HTMLDivElement>();
    const onCommit = vi.fn();
    const { container } = render(
      <>
        <div ref={target} data-testid="center" style={{ width: 280 }} />
        <Resizer side="left" width={280} min={220} max={500} target={target} onCommit={onCommit} />
      </>,
    );
    const handle = container.querySelector('[role="separator"]');
    if (handle === null) throw new Error('ручка ресайза не найдена');

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0 });
    expect(screen.getByTestId('resize-overlay')).toBeTruthy();

    // Захват потерян без обычного отпускания — например, окно ушло из
    // фокуса ОС посреди перетаскивания.
    fireEvent.lostPointerCapture(handle, { pointerId: 1 });

    expect(screen.queryByTestId('resize-overlay')).toBeNull();
    // Интерфейс требует commit только на pointerup — тут его не было.
    expect(onCommit).not.toHaveBeenCalled();

    // Оверлей был бы потомком ручки в DOM и без снятия ловил бы любой клик
    // (всплытие до onPointerDown разделителя) — без оверлея обычный клик по
    // центру ничего не запускает.
    fireEvent.pointerDown(screen.getByTestId('center'), { pointerId: 2, clientX: 500 });
    fireEvent.pointerMove(screen.getByTestId('center'), { pointerId: 2, clientX: 900 });
    fireEvent.pointerUp(screen.getByTestId('center'), { pointerId: 2, clientX: 900 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('потеря фокуса окна во время перетаскивания сбрасывает состояние без commit', () => {
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
    expect(screen.getByTestId('resize-overlay')).toBeTruthy();

    fireEvent(window, new Event('blur'));

    expect(screen.queryByTestId('resize-overlay')).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
