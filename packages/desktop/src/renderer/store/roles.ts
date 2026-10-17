/**
 * Каталог ролей для плашек (`roles.list`): одна запись на рабочий каталог, а не на сессию. Плашка есть у каждой
 * сессии сайдбара, и все они монтируются разом — 12 сессий одного каталога давали 12 одинаковых вызовов, и хост
 * 12 раз сканировал файлы ролей. Ключ — каталог, который посчитает хост: `cwd` окно передаёт вместе с `ref`
 * только когда знает worktree сессии, иначе зовёт без `ref` и кладёт ответ под `projectPath`.
 * Дольше нескольких секунд ответ не держим: новая роль должна появляться сразу.
 */

import { create } from 'zustand';
import type { RoleSummary, SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { useHostStore } from './host.js';

export const ROLES_STORE_TTL_MS = 3_000;

export interface RolesEntry {
  status: 'loading' | 'reloading' | 'ready' | 'error';
  /** Последний удачный ответ: при перезагрузке или ошибке роли не пропадают из стора. */
  roles: RoleSummary[];
  at: number;
}

export interface RolesState {
  byCwd: Record<string, RolesEntry>;
  /** `ref` только когда вызывающий знает worktree сессии и `cwd` равен тому, что посчитает хост; иначе без `ref`, cwd = projectPath. */
  load(bridge: ParleyBridge, input: { projectPath: string; ref?: SessionRef; cwd: string; force?: boolean }): void;
}

/** Запросы в полёте: ключ — мост и каталог, чтобы разные соединения не делили ответы. */
const inflight = new WeakMap<object, Map<string, symbol>>();

/** Хост на связи и `roles.list` среди его методов нет (старый хост) — не спрашиваем; связи ещё нет — спрашиваем. */
function hostLacksRoles(): boolean {
  const status = useHostStore.getState().status;
  return status.state === 'connected' && !status.methods?.includes('roles.list');
}

export const useRolesStore = create<RolesState>((set, get) => ({
  byCwd: {},
  load: (bridge, { projectPath, ref, cwd, force }) => {
    if (hostLacksRoles()) return;
    const was = get().byCwd[cwd];
    let pending = inflight.get(bridge);
    if (pending === undefined) inflight.set(bridge, pending = new Map());
    // Принудительная перезагрузка уже в полёте (пачка плашек сменила ревизию разом) — второй вызов не нужен.
    if (pending.has(cwd) && (force !== true || was?.status === 'reloading')) return;
    if (!force && was !== undefined && was.status !== 'loading' && Date.now() - was.at < ROLES_STORE_TTL_MS) return;
    const token = Symbol(cwd);
    pending.set(cwd, token);
    const keep = was?.roles ?? [];
    // Force поверх любой записи (ready, loading по TTL, error) — reloading: чип скрывает замок старой ревизии до ответа.
    const status = force && was !== undefined ? 'reloading' : 'loading';
    set((state) => ({ byCwd: { ...state.byCwd, [cwd]: { status, roles: keep, at: Date.now() } } }));
    const finish = (entry: RolesEntry): void => {
      // Ответ устаревшего запроса (после force) не затирает свежий.
      if (pending.get(cwd) !== token) return;
      pending.delete(cwd);
      set((state) => ({ byCwd: { ...state.byCwd, [cwd]: entry } }));
    };
    bridge
      .call('roles.list', { projectPath, ...(ref ? { ref } : {}) })
      .then((result) => finish({ status: 'ready', roles: result.roles, at: Date.now() }))
      .catch((error: unknown) => {
        console.warn('[parley] roles.list', decodeIpcError(error).message);
        finish({ status: 'error', roles: keep, at: Date.now() });
      });
  },
}));

export function resetRolesStoreForTests(): void {
  useRolesStore.setState({ byCwd: {} });
}
