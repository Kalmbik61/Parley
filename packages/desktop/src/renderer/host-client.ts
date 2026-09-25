import type { HarnasBridge } from '../shared/bridge.js';

/**
 * Тонкая обёртка над `window.harnas`: рендерер обращается к хосту только
 * через неё, чтобы компоненты и стор (кусок 1.10) не трогали `window`
 * напрямую. Вызывается лениво — в момент импорта прелоад ещё мог не
 * отработать (актуально в тестах, где `window.harnas` подставляется вручную).
 */
export function getHostClient(): HarnasBridge {
  return window.harnas;
}
