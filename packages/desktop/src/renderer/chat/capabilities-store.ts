/**
 * Что CLI провайдера умеет в проекте (живая проверка 2026-10-02): команды, скиллы и субагенты для
 * подсказок поля ввода. Берётся у хоста (`capabilities.list`) по `projectPath` и не чаще раза в 60 с —
 * папки скиллов читаются с диска. Хост без метода не спрашивается: подсказок команд и скиллов нет,
 * работают только модели и файлы. Своего каталога окно не ведёт.
 */

import { create } from 'zustand';
import type { Capabilities } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { hostMethods } from '../lib/capabilities.js';
import { useHostStore } from '../store/host.js';

/** Не чаще раза в это время на проект (для того же провайдера). */
export const CAPABILITIES_TTL_MS = 60_000;

export interface CapabilitiesEntry {
  status: 'loading' | 'ready' | 'error';
  provider: string;
  /** Последний удачный ответ: при повторной загрузке или ошибке подсказки не пропадают. */
  capabilities: Capabilities | null;
  at: number;
}

export interface CapabilitiesState {
  byProject: Record<string, CapabilitiesEntry>;
  load(bridge: ParleyBridge, projectPath: string, provider: string): void;
}

export const useCapabilitiesStore = create<CapabilitiesState>((set, get) => ({
  byProject: {},
  load: (bridge, projectPath, provider) => {
    if (!hostMethods(useHostStore.getState().status).has('capabilities.list')) return;
    const was = get().byProject[projectPath];
    if (was !== undefined && was.provider === provider && Date.now() - was.at < CAPABILITIES_TTL_MS) return;
    const started = Date.now();
    const keep = was?.provider === provider ? was.capabilities : null;
    set((state) => ({
      byProject: { ...state.byProject, [projectPath]: { status: 'loading', provider, capabilities: keep, at: started } },
    }));
    bridge
      .call('capabilities.list', { projectPath, provider })
      .then((capabilities) => {
        set((state) => ({
          byProject: { ...state.byProject, [projectPath]: { status: 'ready', provider, capabilities, at: Date.now() } },
        }));
      })
      .catch((error: unknown) => {
        console.warn('[parley] capabilities.list', decodeIpcError(error).message);
        set((state) => ({
          byProject: { ...state.byProject, [projectPath]: { status: 'error', provider, capabilities: keep, at: Date.now() } },
        }));
      });
  },
}));

export function resetCapabilitiesStoreForTests(): void {
  useCapabilitiesStore.setState({ byProject: {} });
}
