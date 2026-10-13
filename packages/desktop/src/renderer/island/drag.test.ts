/**
 * Перетаскивание острова за любое место формы (`useShapeDrag`): жест начинается, когда указатель ушёл от точки
 * нажатия дальше порога, а не с самого нажатия; кнопки, ссылки, `[role="button"]` и `data-no-drag` жест не начинают;
 * отпускание, отмена и потеря захвата заканчивают его один раз. Смахивание вверх: на первом движении за порог вверх и
 * по вертикали больше, чем по горизонтали, — не перетаскивание, а один `onSwipeUp` после `SWIPE_UP_PX`. Харнесс — форма
 * с вложенными целями, без JSX.
 */

import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IslandApi } from '../../shared/island.js';
import { DRAG_THRESHOLD_PX, SWIPE_UP_PX, useShapeDrag } from './drag.js';

type DragApi = Pick<IslandApi, 'dragStart' | 'dragMove' | 'dragEnd'>;

interface Rig {
  api: DragApi;
  onDragStart: ReturnType<typeof vi.fn>;
  onDragEnd: ReturnType<typeof vi.fn>;
  onSwipeUp: ReturnType<typeof vi.fn>;
}

function Harness({ rig }: { rig: Rig }): JSX.Element {
  const drag = useShapeDrag(rig.api, { onDragStart: rig.onDragStart, onDragEnd: rig.onDragEnd, onSwipeUp: rig.onSwipeUp });
  return createElement(
    'div',
    { 'data-testid': 'shape', 'data-dragging': String(drag.dragging), ...drag.handlers },
    createElement('span', { 'data-testid': 'text' }, 'text'),
    createElement('button', { type: 'button', 'data-testid': 'button' }, 'button'),
    createElement('a', { href: '#', 'data-testid': 'link' }, 'link'),
    createElement('div', { role: 'button', 'data-testid': 'role-button' }, 'role'),
    createElement('div', { 'data-no-drag': '', 'data-testid': 'no-drag' }, createElement('span', { 'data-testid': 'no-drag-child' }, 'inner')),
  );
}

function mount(): Rig {
  const rig: Rig = {
    api: { dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn() },
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
    onSwipeUp: vi.fn(),
  };
  render(createElement(Harness, { rig }));
  return rig;
}

/** Событие указателя с точкой на экране: `MouseEvent` нужного типа — не зависит от того, знает ли jsdom `PointerEvent`. */
function pointer(type: string, screenX: number, screenY: number, init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, { bubbles: true, screenX, screenY, buttons: 1, ...init });
}

afterEach(cleanup);

describe('перетаскивание острова за форму', () => {
  it('нажатие без сдвига за порог — не жест: dragStart не зовётся, ни при отпускании', () => {
    const rig = mount();
    const target = screen.getByTestId('text');
    fireEvent(target, pointer('pointerdown', 100, 50));
    // Ровно порог и меньше — ещё клик; порог строгий («больше 4»).
    fireEvent(target, pointer('pointermove', 100 + DRAG_THRESHOLD_PX, 50));
    fireEvent(target, pointer('pointermove', 102, 52));
    fireEvent(target, pointer('pointerup', 102, 52, { buttons: 0 }));
    expect(rig.api.dragStart).not.toHaveBeenCalled();
    expect(rig.api.dragMove).not.toHaveBeenCalled();
    expect(rig.api.dragEnd).not.toHaveBeenCalled();
    expect(rig.onDragStart).not.toHaveBeenCalled();
    expect(rig.onDragEnd).not.toHaveBeenCalled();
  });

  it('сдвиг дальше порога: dragStart с точкой нажатия, затем dragMove с текущей; дальше только dragMove', () => {
    const rig = mount();
    const target = screen.getByTestId('text');
    fireEvent(target, pointer('pointerdown', 100, 50));
    fireEvent(target, pointer('pointermove', 105, 50));
    expect(rig.api.dragStart).toHaveBeenCalledTimes(1);
    expect(rig.api.dragStart).toHaveBeenCalledWith({ screenX: 100, screenY: 50 });
    expect(rig.api.dragMove).toHaveBeenLastCalledWith({ screenX: 105, screenY: 50 });
    expect(rig.onDragStart).toHaveBeenCalledTimes(1);
    fireEvent(target, pointer('pointermove', 110, 60));
    expect(rig.api.dragStart).toHaveBeenCalledTimes(1);
    expect(rig.api.dragMove).toHaveBeenCalledTimes(2);
    expect(rig.api.dragMove).toHaveBeenLastCalledWith({ screenX: 110, screenY: 60 });
    expect(rig.onDragStart).toHaveBeenCalledTimes(1);
  });

  it('порог — расстояние от точки нажатия, а не по каждой оси: по диагонали 3 + 3 уже жест', () => {
    const rig = mount();
    const target = screen.getByTestId('text');
    fireEvent(target, pointer('pointerdown', 10, 10));
    fireEvent(target, pointer('pointermove', 13, 13));
    expect(rig.api.dragStart).toHaveBeenCalledWith({ screenX: 10, screenY: 10 });
  });

  it('жест захватывает указатель — события идут, когда курсор уходит за пределы маленького окна', () => {
    mount();
    const shape = screen.getByTestId('shape');
    const capture = vi.fn();
    Object.defineProperty(shape, 'setPointerCapture', { value: capture });
    fireEvent(shape, pointer('pointerdown', 0, 0));
    fireEvent(shape, pointer('pointermove', 2, 0));
    expect(capture).not.toHaveBeenCalled();
    fireEvent(shape, pointer('pointermove', 9, 0));
    expect(capture).toHaveBeenCalledTimes(1);
    fireEvent(shape, pointer('pointermove', 12, 0));
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it.each([['button'], ['link'], ['role-button'], ['no-drag'], ['no-drag-child']])(
    'нажатие на цели %s не начинает жест, как далеко ни двигай',
    (id) => {
      const rig = mount();
      const target = screen.getByTestId(id);
      fireEvent(target, pointer('pointerdown', 100, 50));
      fireEvent(target, pointer('pointermove', 200, 150));
      fireEvent(target, pointer('pointerup', 200, 150, { buttons: 0 }));
      expect(rig.api.dragStart).not.toHaveBeenCalled();
      expect(rig.api.dragMove).not.toHaveBeenCalled();
      expect(rig.api.dragEnd).not.toHaveBeenCalled();
    },
  );

  it('не основная кнопка мыши жест не начинает', () => {
    const rig = mount();
    const target = screen.getByTestId('text');
    fireEvent(target, pointer('pointerdown', 100, 50, { button: 2 }));
    fireEvent(target, pointer('pointermove', 200, 150));
    expect(rig.api.dragStart).not.toHaveBeenCalled();
  });

  it('движение без нажатия ничего не шлёт: окно не едет за курсором, пока кнопку не нажали', () => {
    const rig = mount();
    fireEvent(screen.getByTestId('text'), pointer('pointermove', 200, 150));
    expect(rig.api.dragStart).not.toHaveBeenCalled();
    expect(rig.api.dragMove).not.toHaveBeenCalled();
  });

  it('кнопку отпустили там, где форма события не видела: следующее движение без кнопки жеста не начинает', () => {
    const rig = mount();
    const target = screen.getByTestId('text');
    fireEvent(target, pointer('pointerdown', 100, 50));
    fireEvent(target, pointer('pointermove', 200, 150, { buttons: 0 }));
    fireEvent(target, pointer('pointermove', 300, 250));
    expect(rig.api.dragStart).not.toHaveBeenCalled();
  });

  it('отпускание заканчивает жест: dragEnd с точкой отпускания и onDragEnd, потерянный после него захват второго не шлёт', () => {
    const rig = mount();
    const target = screen.getByTestId('text');
    fireEvent(target, pointer('pointerdown', 100, 50));
    fireEvent(target, pointer('pointermove', 110, 50));
    fireEvent(target, pointer('pointerup', 120, 60, { buttons: 0 }));
    expect(rig.api.dragEnd).toHaveBeenCalledTimes(1);
    expect(rig.api.dragEnd).toHaveBeenCalledWith({ screenX: 120, screenY: 60 });
    expect(rig.onDragEnd).toHaveBeenCalledTimes(1);
    fireEvent(target, pointer('lostpointercapture', 120, 60, { buttons: 0 }));
    expect(rig.api.dragEnd).toHaveBeenCalledTimes(1);
    expect(rig.onDragEnd).toHaveBeenCalledTimes(1);
  });

  it.each([['pointercancel'], ['lostpointercapture']])('%s без отпускания тоже заканчивает жест: main не остаётся в «тащим»', (type) => {
    const rig = mount();
    const target = screen.getByTestId('text');
    fireEvent(target, pointer('pointerdown', 100, 50));
    fireEvent(target, pointer('pointermove', 110, 50));
    fireEvent(target, pointer(type, 33, 44, { buttons: 0 }));
    expect(rig.api.dragEnd).toHaveBeenCalledWith({ screenX: 33, screenY: 44 });
    expect(rig.onDragEnd).toHaveBeenCalledTimes(1);
  });

  it('после конца жеста новое движение его не продолжает, а новое нажатие начинает заново', () => {
    const rig = mount();
    const target = screen.getByTestId('text');
    fireEvent(target, pointer('pointerdown', 100, 50));
    fireEvent(target, pointer('pointermove', 110, 50));
    fireEvent(target, pointer('pointerup', 110, 50, { buttons: 0 }));
    const moves = vi.mocked(rig.api.dragMove).mock.calls.length;
    fireEvent(target, pointer('pointermove', 150, 50));
    expect(rig.api.dragMove).toHaveBeenCalledTimes(moves);
    fireEvent(target, pointer('pointerdown', 150, 50));
    fireEvent(target, pointer('pointermove', 160, 50));
    expect(rig.api.dragStart).toHaveBeenCalledTimes(2);
    expect(rig.api.dragStart).toHaveBeenLastCalledWith({ screenX: 150, screenY: 50 });
  });

  it('отмена нажатия до жеста не оставляет точку нажатия: следующее движение жеста не начинает, dragEnd не шлётся', () => {
    const rig = mount();
    const target = screen.getByTestId('text');
    fireEvent(target, pointer('pointerdown', 100, 50));
    fireEvent(target, pointer('pointercancel', 100, 50, { buttons: 0 }));
    fireEvent(target, pointer('pointermove', 200, 50));
    expect(rig.api.dragStart).not.toHaveBeenCalled();
    expect(rig.api.dragEnd).not.toHaveBeenCalled();
  });

  it('dragging — только пока жест идёт: форме нужен курсор grabbing', () => {
    mount();
    const shape = screen.getByTestId('shape');
    const target = screen.getByTestId('text');
    expect(shape.getAttribute('data-dragging')).toBe('false');
    fireEvent(target, pointer('pointerdown', 100, 50));
    expect(shape.getAttribute('data-dragging')).toBe('false');
    fireEvent(target, pointer('pointermove', 110, 50));
    expect(shape.getAttribute('data-dragging')).toBe('true');
    fireEvent(target, pointer('pointerup', 110, 50, { buttons: 0 }));
    expect(shape.getAttribute('data-dragging')).toBe('false');
  });

  it('колбэки жеста необязательные', () => {
    const api: DragApi = { dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn() };
    const rig: Rig = { api, onDragStart: undefined as never, onDragEnd: undefined as never, onSwipeUp: undefined as never };
    render(createElement(Harness, { rig }));
    const target = screen.getByTestId('text');
    fireEvent(target, pointer('pointerdown', 0, 0));
    fireEvent(target, pointer('pointermove', 20, 0));
    fireEvent(target, pointer('pointerup', 20, 0, { buttons: 0 }));
    expect(api.dragStart).toHaveBeenCalledTimes(1);
    expect(api.dragEnd).toHaveBeenCalledTimes(1);
  });

  it('колбэки жеста необязательные: без onSwipeUp движение вверх — обычное перетаскивание', () => {
    const api: DragApi = { dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn() };
    const rig: Rig = { api, onDragStart: undefined as never, onDragEnd: undefined as never, onSwipeUp: undefined as never };
    render(createElement(Harness, { rig }));
    const target = screen.getByTestId('text');
    fireEvent(target, pointer('pointerdown', 100, 50));
    fireEvent(target, pointer('pointermove', 100, 30));
    expect(api.dragStart).toHaveBeenCalledWith({ screenX: 100, screenY: 50 });
  });
});

describe('смахивание острова вверх', () => {
  it('вверх дальше SWIPE_UP_PX при вертикальном преобладании: onSwipeUp ровно раз, перетаскивания нет, указатель захвачен', () => {
    const rig = mount();
    const shape = screen.getByTestId('shape');
    const capture = vi.fn();
    Object.defineProperty(shape, 'setPointerCapture', { value: capture });
    const target = screen.getByTestId('text');
    fireEvent(target, pointer('pointerdown', 100, 50));
    // 6 px вверх — уже не клик (порог 4), но до SWIPE_UP_PX не дотянуто: режим смахивания взведён, ничего не позвано.
    fireEvent(target, pointer('pointermove', 100, 50 - (SWIPE_UP_PX - 2)));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(rig.onSwipeUp).not.toHaveBeenCalled();
    fireEvent(target, pointer('pointermove', 101, 50 - SWIPE_UP_PX));
    expect(rig.onSwipeUp).toHaveBeenCalledTimes(1);
    // Жест кончен: дальше движения не делают ничего, пока не нажали заново.
    fireEvent(target, pointer('pointermove', 101, 10));
    fireEvent(target, pointer('pointermove', 160, 10));
    fireEvent(target, pointer('pointerup', 160, 10, { buttons: 0 }));
    expect(rig.onSwipeUp).toHaveBeenCalledTimes(1);
    expect(rig.api.dragStart).not.toHaveBeenCalled();
    expect(rig.api.dragMove).not.toHaveBeenCalled();
    expect(rig.api.dragEnd).not.toHaveBeenCalled();
    expect(rig.onDragStart).not.toHaveBeenCalled();
    expect(rig.onDragEnd).not.toHaveBeenCalled();
    expect(shape.getAttribute('data-dragging')).toBe('false');
  });

  it('быстрое движение: первое же событие за порог уже дальше SWIPE_UP_PX — onSwipeUp в нём же', () => {
    const rig = mount();
    const target = screen.getByTestId('text');
    fireEvent(target, pointer('pointerdown', 100, 50));
    fireEvent(target, pointer('pointermove', 100, 30));
    expect(rig.onSwipeUp).toHaveBeenCalledTimes(1);
    expect(rig.api.dragStart).not.toHaveBeenCalled();
  });

  it('вверх меньше порога и отпустили: ничего — ни смахивания, ни перетаскивания; следующее нажатие начинает заново', () => {
    const rig = mount();
    const target = screen.getByTestId('text');
    fireEvent(target, pointer('pointerdown', 100, 50));
    fireEvent(target, pointer('pointermove', 100, 50 - (SWIPE_UP_PX - 1)));
    fireEvent(target, pointer('pointerup', 100, 50 - (SWIPE_UP_PX - 1), { buttons: 0 }));
    fireEvent(target, pointer('lostpointercapture', 100, 50 - (SWIPE_UP_PX - 1), { buttons: 0 }));
    expect(rig.onSwipeUp).not.toHaveBeenCalled();
    expect(rig.api.dragStart).not.toHaveBeenCalled();
    expect(rig.api.dragEnd).not.toHaveBeenCalled();
    expect(rig.onDragEnd).not.toHaveBeenCalled();
    // Режим смахивания сброшен концом жеста: новое нажатие и горизонтальный сдвиг — перетаскивание.
    fireEvent(target, pointer('pointerdown', 100, 50));
    fireEvent(target, pointer('pointermove', 120, 50));
    expect(rig.api.dragStart).toHaveBeenCalledTimes(1);
    expect(rig.onSwipeUp).not.toHaveBeenCalled();
  });

  it('новое нажатие после смахивания работает заново', () => {
    const rig = mount();
    const target = screen.getByTestId('text');
    fireEvent(target, pointer('pointerdown', 100, 50));
    fireEvent(target, pointer('pointermove', 100, 30));
    fireEvent(target, pointer('pointerup', 100, 30, { buttons: 0 }));
    fireEvent(target, pointer('pointerdown', 100, 50));
    fireEvent(target, pointer('pointermove', 100, 30));
    expect(rig.onSwipeUp).toHaveBeenCalledTimes(2);
  });

  it.each([['pointercancel'], ['lostpointercapture']])('%s посреди смахивания сбрасывает режим, dragEnd не шлётся', (type) => {
    const rig = mount();
    const target = screen.getByTestId('text');
    fireEvent(target, pointer('pointerdown', 100, 50));
    fireEvent(target, pointer('pointermove', 100, 50 - (SWIPE_UP_PX - 2)));
    fireEvent(target, pointer(type, 100, 40, { buttons: 0 }));
    // Без сброса это движение достроило бы прежнее смахивание.
    fireEvent(target, pointer('pointermove', 100, 20));
    expect(rig.onSwipeUp).not.toHaveBeenCalled();
    expect(rig.api.dragEnd).not.toHaveBeenCalled();
    expect(rig.onDragEnd).not.toHaveBeenCalled();
  });

  it('горизонтальное движение — перетаскивание, как раньше; onSwipeUp нет', () => {
    const rig = mount();
    const target = screen.getByTestId('text');
    fireEvent(target, pointer('pointerdown', 100, 50));
    fireEvent(target, pointer('pointermove', 130, 50));
    expect(rig.api.dragStart).toHaveBeenCalledWith({ screenX: 100, screenY: 50 });
    expect(rig.onDragStart).toHaveBeenCalledTimes(1);
    expect(rig.onSwipeUp).not.toHaveBeenCalled();
  });

  it('вверх, но по горизонтали не меньше — перетаскивание: смахивание только при вертикальном преобладании', () => {
    const rig = mount();
    const target = screen.getByTestId('text');
    // Ровно по диагонали (|dy| = |dx|) — не «вертикально больше»: тащим.
    fireEvent(target, pointer('pointerdown', 100, 50));
    fireEvent(target, pointer('pointermove', 110, 40));
    expect(rig.api.dragStart).toHaveBeenCalledTimes(1);
    expect(rig.onSwipeUp).not.toHaveBeenCalled();
  });

  it('вниз вертикально — перетаскивание, а не смахивание', () => {
    const rig = mount();
    const target = screen.getByTestId('text');
    fireEvent(target, pointer('pointerdown', 100, 50));
    fireEvent(target, pointer('pointermove', 100, 80));
    expect(rig.api.dragStart).toHaveBeenCalledTimes(1);
    expect(rig.onSwipeUp).not.toHaveBeenCalled();
  });

  it('движение вверх после начавшегося перетаскивания — не смахивание', () => {
    const rig = mount();
    const target = screen.getByTestId('text');
    fireEvent(target, pointer('pointerdown', 100, 50));
    fireEvent(target, pointer('pointermove', 130, 50));
    fireEvent(target, pointer('pointermove', 130, 0));
    fireEvent(target, pointer('pointermove', 130, -40));
    expect(rig.onSwipeUp).not.toHaveBeenCalled();
    expect(rig.api.dragStart).toHaveBeenCalledTimes(1);
    expect(rig.api.dragMove).toHaveBeenLastCalledWith({ screenX: 130, screenY: -40 });
    fireEvent(target, pointer('pointerup', 130, -40, { buttons: 0 }));
    expect(rig.api.dragEnd).toHaveBeenCalledTimes(1);
  });

  it.each([['button'], ['link'], ['role-button'], ['no-drag'], ['no-drag-child']])(
    'нажатие на цели %s: ни смахивания, ни перетаскивания, как далеко ни тяни вверх',
    (id) => {
      const rig = mount();
      const target = screen.getByTestId(id);
      fireEvent(target, pointer('pointerdown', 100, 150));
      fireEvent(target, pointer('pointermove', 100, 20));
      fireEvent(target, pointer('pointerup', 100, 20, { buttons: 0 }));
      expect(rig.onSwipeUp).not.toHaveBeenCalled();
      expect(rig.api.dragStart).not.toHaveBeenCalled();
    },
  );

  it('кнопку отпустили там, где форма события не видела: движение вверх без кнопки смахиванием не становится', () => {
    const rig = mount();
    const target = screen.getByTestId('text');
    fireEvent(target, pointer('pointerdown', 100, 50));
    fireEvent(target, pointer('pointermove', 100, 20, { buttons: 0 }));
    expect(rig.onSwipeUp).not.toHaveBeenCalled();
  });
});
