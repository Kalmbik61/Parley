/** Вырез острова (#9 §12, B26 F-B26-3): сдвиг к центру выреза с точностью до половины точки, ширины капсулы и выдвинутого вида. */

import { describe, expect, it } from 'vitest';
import { capsuleWidth, droppedMinWidth, notchShift, type Notch } from './notch.js';

/** Вырез MacBook Pro 14″ (замер спеки §12.2): 185 × 32 pt, центр в кадре окна 480 pt — на половине точки. */
const NOTCH: Notch = { width: 185, height: 32, centerX: 239.5 };

describe('вырез острова', () => {
  it('сдвиг формы от середины кадра к центру выреза — с точностью до половины точки', () => {
    const before = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 480 });
    try {
      expect(notchShift(NOTCH)).toBe(-0.5);
      expect(notchShift({ ...NOTCH, centerX: 240 })).toBe(0);
      expect(notchShift({ ...NOTCH, centerX: 240.5 })).toBe(0.5);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: before });
    }
  });

  it('выдвинутый вид не уже выреза и полей h + 4 по бокам', () => {
    expect(droppedMinWidth(NOTCH)).toBe(185 + 2 * 36);
  });

  it('капсула — вырез и по 80 pt с каждой стороны', () => {
    expect(capsuleWidth(NOTCH)).toBe(345);
  });
});
