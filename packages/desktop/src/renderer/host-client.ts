import type { ParleyBridge } from '../shared/bridge.js';

/**
 * Тонкая обёртка над `window.parley`: рендерер обращается к хосту только
 * через неё, чтобы компоненты и стор (кусок 1.10) не трогали `window`
 * напрямую. Вызывается лениво — в момент импорта прелоад ещё мог не
 * отработать (актуально в тестах, где `window.parley` подставляется вручную).
 */
export function getHostClient(): ParleyBridge {
  return window.parley;
}
