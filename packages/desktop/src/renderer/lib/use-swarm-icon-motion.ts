/** «Reduce motion» окна для иконки роя (спека роя v1, 7.5): настройка Parley `ui.island.motion`, общая с островом. */

import { useUiStore } from '../store/ui.js';

export function useSwarmIconMotion(): boolean {
  return useUiStore((state) => state.ui.island.motion === 'reduce');
}
