/** Тема окна для иконки роя (спека роя v1, 7.5): `.dark` на `<html>` ставит `theme/appearance.ts`, флаг лежит в сторе. */

import type { CombTheme } from '../components/swarm-comb.js';
import { useUiStore } from '../store/ui.js';

export function useSwarmIconTheme(): CombTheme {
  return useUiStore((state) => (state.dark ? 'dark' : 'light'));
}
