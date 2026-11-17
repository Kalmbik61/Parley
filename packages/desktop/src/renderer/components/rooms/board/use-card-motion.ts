import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Длительность переезда карточки, мс (спека 5.9). */
export const CARD_MOTION_MS = 460;
const FLASH_MS = 900;

interface Place { x: number; y: number }

/**
 * Запоминает место каждой карточки (`[data-board-item]`) внутри контейнера и после отрисовки запускает переезд тем,
 * что сменили место. `version` меняется, когда меняется модель доски.
 *
 * Места хранятся по значению `data-board-item`, а не по элементу: при смене колонки React создаёт новый элемент.
 * Место считается от контейнера с учётом его прокрутки, поэтому прокрутка доски переездом не считается.
 */
export function useCardMotion(container: RefObject<HTMLElement | null>, version: unknown): void {
  const places = useRef<Map<string, Place>>(new Map());
  useLayoutEffect(() => {
    const root = container.current;
    if (root === null) return;
    const before = places.current;
    const after = new Map<string, Place>();
    const origin = root.getBoundingClientRect();
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const element of root.querySelectorAll<HTMLElement>('[data-board-item]')) {
      const id = element.getAttribute('data-board-item');
      if (id === null) continue;
      const rect = element.getBoundingClientRect();
      const place = { x: rect.left - origin.left + root.scrollLeft, y: rect.top - origin.top + root.scrollTop };
      after.set(id, place);
      const old = before.get(id);
      if (old === undefined || reduced || typeof element.animate !== 'function') continue;
      const dx = old.x - place.x;
      const dy = old.y - place.y;
      if (dx === 0 && dy === 0) continue;
      element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: CARD_MOTION_MS, easing: 'ease-out' });
      // Цвет полосы — у дочернего `[data-board-stripe]` (фон), а не у границы карточки.
      const stripe = element.querySelector<HTMLElement>('[data-board-stripe]');
      const colour = stripe === null ? 'currentColor' : getComputedStyle(stripe).backgroundColor;
      element.animate([{ boxShadow: `0 0 0 3px ${colour}` }, { boxShadow: `0 0 0 3px transparent` }], { duration: FLASH_MS, easing: 'ease-out' });
    }
    places.current = after;
  }, [container, version]);
}
