/**
 * Держатель порядка сайдбара (кусок 3.4, спека 6.2): пока открыто меню карточки, строки,
 * секции или комнат либо идёт переименование на месте, пересортировка ждёт — как под
 * указателем. Уход указателя в портал меню — не уход с сайдбара: иначе карточка уехала бы
 * из-под меню, а виртуализация перемонтировала бы поле ввода.
 */

import { useEffect } from 'react';
import { useUiStore } from '../store/ui.js';

/** Держит порядок, пока `on`; размонтирование отпускает. `id` — свой у каждого держателя. */
export function useSidebarHold(id: string, on: boolean): void {
  const setHold = useUiStore((state) => state.setSidebarHold);
  useEffect(() => {
    if (!on) return undefined;
    setHold(id, true);
    return () => setHold(id, false);
  }, [id, on, setHold]);
}
