/**
 * Слоты живых иконок роя (спека роя v1, 7.5): в окне одновременно анимируются не больше `SWARM_ICON_SLOTS` иконок.
 * Первые по порядку монтирования получают слот, остальные рисуются статично и получают слот, когда он освободится.
 * Остров — отдельный процесс со своим модулем, поэтому у него свой предел. Счёт — в памяти модуля, не в сторе:
 * иконке нужно знать только своё место в очереди.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';

export const SWARM_ICON_SLOTS = 3;

let nextId = 0;
const queue: number[] = [];
const listeners = new Set<() => void>();

const emit = (): void => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Занимает место в очереди, пока `wanted` (иконка нетерминальная, не «still» и не Reduce motion); `true` — слот есть,
 * иконка анимируется.
 */
export function useSwarmIconSlot(wanted: boolean): boolean {
  const id = useRef<number | null>(null);
  if (id.current === null) id.current = nextId++;
  const mine = id.current;
  useEffect(() => {
    if (!wanted) return undefined;
    queue.push(mine);
    emit();
    return () => {
      queue.splice(queue.indexOf(mine), 1);
      emit();
    };
  }, [wanted, mine]);
  return useSyncExternalStore(subscribe, () => queue.indexOf(mine) !== -1 && queue.indexOf(mine) < SWARM_ICON_SLOTS);
}

/** Для тестов: сколько иконок сейчас стоят в очереди. */
export function swarmIconQueueLength(): number {
  return queue.length;
}
