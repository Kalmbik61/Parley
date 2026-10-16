import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createToastInsetPublisher as createPublisher,
  type ToastInsetPublisher,
  TOAST_BASE_REM,
  TOAST_GAP,
  TOAST_INSET_VAR,
  TOAST_SIDE_OFFSET,
  TOAST_WIDTH_REM,
  toastInsetAbove,
} from './toast-inset.js';

const inset = (): string => document.documentElement.style.getPropertyValue(TOAST_INSET_VAR);

// Заявки издателей лежат в модуле: издатель, не ушедший к концу теста, остался бы в следующем.
const created: ToastInsetPublisher[] = [];
function createToastInsetPublisher(): ToastInsetPublisher {
  const publisher = createPublisher();
  created.push(publisher);
  return publisher;
}

afterEach(() => {
  for (const publisher of created.splice(0)) publisher.release();
  document.documentElement.style.removeProperty(TOAST_INSET_VAR);
  vi.restoreAllMocks();
});

/**
 * Угол окна делят несколько плавающих блоков (карточки решений `WindowNotes`, лоток аннотаций браузера), а переменная на
 * `<html>` одна. Каждый издатель заявляет свой отступ, переменная держит наибольший из заявленных: прежняя запись «поставил —
 * снял» затирала бы чужую.
 */
describe('издатели отступа тостов (--toast-inset-bottom)', () => {
  it('никто не заявил — переменной нет', () => {
    createToastInsetPublisher();
    expect(inset()).toBe('');
  });

  it('один издатель: значение — его отступ в px, уход снимает переменную', () => {
    const publisher = createToastInsetPublisher();
    publisher.set(180);
    expect(inset()).toBe('180px');
    publisher.set(366);
    expect(inset()).toBe('366px');
    publisher.release();
    expect(inset()).toBe('');
  });

  it('два издателя: переменная — максимум; уход одного не стирает отступ другого', () => {
    const cards = createToastInsetPublisher();
    const tray = createToastInsetPublisher();
    cards.set(180);
    tray.set(260);
    expect(inset()).toBe('260px');
    // Карточки пересчитались, а лоток остался: его отступ не затёрт чужим set.
    cards.set(366);
    expect(inset()).toBe('366px');
    cards.set(100);
    expect(inset()).toBe('260px');
    // Карточки ушли целиком (WindowNotes размонтировался): лоток всё ещё стоит.
    cards.release();
    expect(inset()).toBe('260px');
    tray.release();
    expect(inset()).toBe('');
  });

  it('отступ 0 — «мешать нечему»: издатель не держит переменную', () => {
    const publisher = createToastInsetPublisher();
    publisher.set(120);
    publisher.set(0);
    expect(inset()).toBe('');
    publisher.set(120);
    expect(inset()).toBe('120px');
  });

  it('ушедший издатель не возвращается поздним set (таймер или наблюдатель после размонтирования)', () => {
    const publisher = createToastInsetPublisher();
    publisher.set(120);
    publisher.release();
    publisher.set(300);
    expect(inset()).toBe('');
    publisher.release();
  });

  it('то же значение переменную на <html> не переписывает: пересчёт стиля всего окна ни к чему', () => {
    const publisher = createToastInsetPublisher();
    publisher.set(180);
    const setProperty = vi.spyOn(document.documentElement.style, 'setProperty');
    publisher.set(180);
    expect(setProperty).not.toHaveBeenCalled();
    publisher.set(181);
    expect(setProperty).toHaveBeenCalledTimes(1);
  });
});

describe('toastInsetAbove — насколько поднять тосты над блоком, лежащим где-то в окне', () => {
  const REM = 16;
  const WINDOW = { width: 1400, height: 900 };
  const base = TOAST_BASE_REM * REM;
  // Столбец тостов: ширина 26rem, правый отступ 24 px.
  const columnRight = WINDOW.width - TOAST_SIDE_OFFSET;
  const columnLeft = columnRight - TOAST_WIDTH_REM * REM;

  it('блок под столбцом тостов: тост встаёт над его верхом с зазором; база 2.5rem уже в формуле Toaster', () => {
    const rect = { left: 1040, right: 1360, top: 700 };
    expect(toastInsetAbove(rect, WINDOW, REM)).toBe(WINDOW.height - 700 + TOAST_GAP - base);
  });

  it('блок слева от столбца (браузер в левой группе): тостам нечего обходить — 0', () => {
    expect(toastInsetAbove({ left: 100, right: columnLeft - 1, top: 700 }, WINDOW, REM)).toBe(0);
  });

  it('блок справа от столбца (между правым краем столбца и окном): 0', () => {
    expect(toastInsetAbove({ left: columnRight + 1, right: columnRight + 20, top: 700 }, WINDOW, REM)).toBe(0);
  });

  it('край в край — это не пересечение', () => {
    expect(toastInsetAbove({ left: 10, right: columnLeft, top: 700 }, WINDOW, REM)).toBe(0);
    expect(toastInsetAbove({ left: columnRight, right: columnRight + 50, top: 700 }, WINDOW, REM)).toBe(0);
  });

  it('хоть на пиксель в столбце — поднимать', () => {
    expect(toastInsetAbove({ left: 10, right: columnLeft + 1, top: 700 }, WINDOW, REM)).toBeGreaterThan(0);
  });

  it('блок у самого низа (его верх ниже базы тостов) — отрицательное не бывает: 0', () => {
    expect(toastInsetAbove({ left: 1040, right: 1360, top: WINDOW.height - 10 }, WINDOW, REM)).toBe(0);
  });

  it('узкое окно 800 px: столбец шире окна минус 32 px сжимается вместе с ним (--width: min(26rem, 100vw − 32px))', () => {
    const narrow = { width: 440, height: 500 };
    // Ширина столбца 440 − 32 = 408 < 416: левый край 440 − 24 − 408 = 8.
    expect(toastInsetAbove({ left: 0, right: 7, top: 300 }, narrow, REM)).toBe(0);
    expect(toastInsetAbove({ left: 0, right: 9, top: 300 }, narrow, REM)).toBe(narrow.height - 300 + TOAST_GAP - base);
  });

  it('rem окна другой: база 2.5rem и ширина 26rem считаются от него', () => {
    const rem = 20;
    const left = WINDOW.width - TOAST_SIDE_OFFSET - TOAST_WIDTH_REM * rem;
    expect(toastInsetAbove({ left: left - 5, right: left - 1, top: 600 }, WINDOW, rem)).toBe(0);
    expect(toastInsetAbove({ left: left - 5, right: left + 1, top: 600 }, WINDOW, rem)).toBe(WINDOW.height - 600 + TOAST_GAP - TOAST_BASE_REM * rem);
  });
});
