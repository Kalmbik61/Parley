import type { IslandBridge } from '../../shared/island.js';

/** Мост окна острова: preload острова кладёт его в `window.parley` (тип глобала — мост главного окна). */
export function getIslandBridge(): IslandBridge {
  return (window as unknown as { parley: IslandBridge }).parley;
}
