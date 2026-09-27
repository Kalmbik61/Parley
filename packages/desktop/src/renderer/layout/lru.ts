/**
 * LRU работ со смонтированными слоями поверхностей (кусок 2.5, спека 5.5):
 * контейнеры держатся у трёх последних активных работ, более старый
 * размонтируется — xterm освобождаются, `pty.detach`. Порядок — свежий первым.
 */

export interface Lru<K> {
  /** Касание ставит ключ первым; возвращает вытесненные сверх предела. */
  touch(key: K): K[];
  has(key: K): boolean;
  keys(): K[];
  /** Работа исчезла (`drop`) — её контейнер размонтируется. */
  remove(key: K): void;
}

export function createLru<K>(limit: number): Lru<K> {
  let order: K[] = [];
  return {
    touch(key) {
      order = [key, ...order.filter((item) => item !== key)];
      const evicted = order.slice(limit);
      order = order.slice(0, limit);
      return evicted;
    },
    has: (key) => order.includes(key),
    keys: () => order.slice(),
    remove(key) {
      order = order.filter((item) => item !== key);
    },
  };
}
