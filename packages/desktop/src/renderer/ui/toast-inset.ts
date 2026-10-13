/**
 * Место для тостов sonner в правом нижнем углу окна. Угол делят с тостами плавающие блоки — карточки решений
 * (`attention/WindowNotes.tsx`) и лоток аннотаций вкладки браузера (`browser/annotate/AnnotationTray.tsx`): блок, что стоит в
 * углу, заявляет, сколько места снизу он занял, а тосты встают над ним (`TOAST_BOTTOM_OFFSET` в `ui/sonner.tsx`), а не на его
 * кнопки.
 *
 * Переменная `TOAST_INSET_VAR` на `<html>` одна, а блоков бывает несколько. Каждый получает свой `ToastInsetPublisher`, и
 * переменная держит наибольшее из заявленного: запись «поставил — снял» одного блока затирала бы отступ другого (карточки
 * пересчитались бы поверх лотка, а их уход снял бы переменную, пока лоток ещё стоит).
 */

import { useLayoutEffect, type RefObject } from 'react';

/** Переменная `<html>`: сколько места снизу занято блоком в углу сверх обычного отступа тостов (`px`); нет блока — не задана. */
export const TOAST_INSET_VAR = '--toast-inset-bottom';

/** Обычный нижний отступ тостов, rem: `TOAST_BOTTOM_OFFSET` в `ui/sonner.tsx` складывает его с переменной. */
export const TOAST_BASE_REM = 2.5;
/** Ширина столбца тостов, rem: `--width` у `Toaster` — меньшее из неё и ширины окна без 32 px. */
export const TOAST_WIDTH_REM = 26;
/** Отступ столбца тостов от правого края окна, px: `offset.right` у `Toaster` (у sonner он такой по умолчанию). */
export const TOAST_SIDE_OFFSET = 24;
/** Зазор между блоком в углу и поднятым над ним тостом, px (как `gap-2` между карточками). */
export const TOAST_GAP = 8;

/** Заявки издателей; пустая заявка (0) не хранится — мешать нечему. */
const insets = new Map<symbol, number>();

function apply(): void {
  const root = document.documentElement;
  const largest = Math.max(0, ...insets.values());
  if (largest === 0) {
    root.style.removeProperty(TOAST_INSET_VAR);
    return;
  }
  const value = `${largest}px`;
  // То же значение не переписываем: смена пользовательского свойства на <html> пересчитывает стиль всего окна.
  if (root.style.getPropertyValue(TOAST_INSET_VAR) !== value) root.style.setProperty(TOAST_INSET_VAR, value);
}

export interface ToastInsetPublisher {
  /** Заявить отступ, px; 0 — снять заявку, не уходя. */
  set(inset: number): void;
  /** Блока в углу больше нет. После этого `set` ничего не делает: поздний наблюдатель или таймер не воскресит заявку. */
  release(): void;
}

export function createToastInsetPublisher(): ToastInsetPublisher {
  const owner = Symbol('toast-inset');
  let released = false;
  return {
    set(inset) {
      if (released) return;
      if (inset > 0) insets.set(owner, inset);
      else insets.delete(owner);
      apply();
    },
    release() {
      released = true;
      if (insets.delete(owner)) apply();
    },
  };
}

/** Размер rem окна, px. */
function remPx(): number {
  const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) && size > 0 ? size : 16;
}

/**
 * На сколько тостам подняться над блоком, который лежит где-то в окне (лоток внутри вкладки, а не в углу окна). Столбец
 * тостов — справа, шириной 26rem (в узком окне — на 32 px уже окна); блок слева от него или справа тостам не мешает, и тогда
 * 0. Иначе нижний край тостов должен лечь над верхом блока с зазором. К отступу тостов, что уже даёт формула (2.5rem), это
 * добавка, поэтому из расстояния «от низа окна до верха блока» вычитается база.
 */
export function toastInsetAbove(rect: { left: number; right: number; top: number }, win: { width: number; height: number }, rem: number): number {
  const columnRight = win.width - TOAST_SIDE_OFFSET;
  const columnLeft = columnRight - Math.min(TOAST_WIDTH_REM * rem, win.width - 32);
  if (rect.right <= columnLeft || rect.left >= columnRight) return 0;
  return Math.max(0, win.height - rect.top + TOAST_GAP - TOAST_BASE_REM * rem);
}

/**
 * Блок `ref` лежит в окне и мешает тостам — пока `active`. Положение берётся живым (`getBoundingClientRect`) и
 * пересчитывается, когда меняется размер самого блока, его родителя (панель DevTools, сайдбары и группы двигают блок, не меняя
 * его размера) или окна. Скрытая вкладка не заявляет ничего: её блока на экране нет.
 */
export function useToastInsetAbove(ref: RefObject<HTMLElement>, active: boolean): void {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!active || node === null) return undefined;
    const publisher = createToastInsetPublisher();
    const update = (): void => {
      publisher.set(toastInsetAbove(node.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, remPx()));
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(node);
    if (node.parentElement !== null) observer?.observe(node.parentElement);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      publisher.release();
    };
  }, [ref, active]);
}
