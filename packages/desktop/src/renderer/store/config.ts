/**
 * Настройки хоста, как их последний раз отдал `settings.get` (или сохранил диалог настроек): `App` кладёт их сюда, а
 * читают не только терминал (шрифт), но и глубокие виды — подсказка про хуки Codex в Chat зависит от
 * `codexWriteApprovals`. До первого ответа хоста — `null`.
 */

import { create } from 'zustand';
import type { ParleyConfig } from '@parley/core';

export interface HostConfigState {
  config: ParleyConfig | null;
  set: (config: ParleyConfig) => void;
}

export const useHostConfigStore = create<HostConfigState>((set) => ({
  config: null,
  set: (config) => set({ config }),
}));
