/**
 * Стор доски: снимки бэклогов по путям проектов и фильтр. Подписками на хосте управляет `BoardSync`;
 * здесь — слоты, чтение снимка с защитой от запоздавших ответов и производный список проектов.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import type { UseBoundStore, StoreApi } from 'zustand';
import { backlogSnapshot } from '@parley/protocol';
import type { BacklogSnapshot } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { boardProjects } from './board-model.js';
import type { BoardFilter, BoardProject } from './board-model.js';

export type BoardBridge = Pick<ParleyBridge, 'call' | 'on'>;
export interface BoardSlot { snapshot: BacklogSnapshot | null; live: boolean }
export interface BoardState {
  supported: boolean; slots: Map<string, BoardSlot>; inboxPath: string | null; filter: BoardFilter;
  setFilter(filter: BoardFilter): void;
  apply(snapshot: BacklogSnapshot): void;
  refresh(bridge: BoardBridge, projectPath: string): Promise<void>;
}

/** Номер последнего запроса по пути: ответ с другим номером запоздал и отбрасывается. */
const requests = new Map<string, number>();

export const useBoardStore: UseBoundStore<StoreApi<BoardState>> = create<BoardState>((set, get) => ({
  supported: false,
  slots: new Map(),
  inboxPath: null,
  filter: { kind: 'all' },
  setFilter: (filter) => set({ filter }),
  apply: (snapshot) => putSnapshot(snapshot, null),
  refresh: async (bridge, projectPath) => {
    const slot = get().slots.get(projectPath);
    if (slot === undefined) return;
    await loadSlot(bridge, projectPath, !slot.live);
  },
}));

/** Кладёт снимок в слот, если он есть; `live` — null: не менять. */
function putSnapshot(snapshot: BacklogSnapshot, live: boolean | null): void {
  const { slots } = useBoardStore.getState();
  const slot = slots.get(snapshot.projectPath);
  if (!slot) return;
  const next = new Map(slots);
  next.set(snapshot.projectPath, { snapshot, live: live ?? slot.live });
  useBoardStore.setState({ slots: next });
}

export function setSlotLive(projectPath: string, live: boolean): void {
  const { slots } = useBoardStore.getState();
  const slot = slots.get(projectPath);
  if (!slot || slot.live === live) return;
  const next = new Map(slots);
  next.set(projectPath, { ...slot, live });
  useBoardStore.setState({ slots: next });
}

/** Слот под подписку: существующий снимок остаётся, пока не придёт свежий. */
export function ensureSlot(projectPath: string): void {
  const { slots } = useBoardStore.getState();
  if (slots.has(projectPath)) return;
  const next = new Map(slots);
  next.set(projectPath, { snapshot: null, live: false });
  useBoardStore.setState({ slots: next });
}

export function dropSlot(projectPath: string): void {
  requests.delete(projectPath);
  const { slots } = useBoardStore.getState();
  if (!slots.has(projectPath)) return;
  const next = new Map(slots);
  next.delete(projectPath);
  useBoardStore.setState({ slots: next });
}

const parse = (value: unknown, projectPath: string): BacklogSnapshot | null => {
  const parsed = backlogSnapshot.safeParse(value);
  return parsed.success && parsed.data.projectPath === projectPath ? parsed.data : null;
};

/**
 * Читает снимок проекта. `subscribe` — подписка (`live` по успеху); отказ подписки — обычное `backlog.get` без `live`.
 * Снимок кладётся только из текущего запроса: ответ, пережитый более новым запросом на тот же путь, отбрасывается.
 * `live` от этого не зависит: ответ подписки ставит его всегда, ведь хост уже подписан, даже если за это время
 * пришёл `backlog.changed` или Refresh.
 */
export async function loadSlot(bridge: BoardBridge, projectPath: string, subscribe: boolean): Promise<void> {
  const id = (requests.get(projectPath) ?? 0) + 1;
  requests.set(projectPath, id);
  const current = (): boolean => requests.get(projectPath) === id && useBoardStore.getState().slots.has(projectPath);
  if (subscribe) {
    let snapshot: BacklogSnapshot | null = null;
    try {
      snapshot = parse(await bridge.call('backlog.subscribe', { projectPath }), projectPath);
    } catch {
      // Отказ подписки — то же, что неверный ответ: слот без live, снимок читает обычный `backlog.get`.
    }
    if (snapshot) {
      if (current()) putSnapshot(snapshot, true); else setSlotLive(projectPath, true);
      return;
    }
    setSlotLive(projectPath, false);
    if (!current()) return;
  }
  try {
    const snapshot = parse(await bridge.call('backlog.get', { projectPath }), projectPath);
    if (current() && snapshot) putSnapshot(snapshot, null);
  } catch {
    // Снимок остаётся прежним: Refresh прочитает заново.
  }
}

/** Проекты доски из слотов; слоты и «Входящие» берутся отдельными селекторами, список считается в `useMemo`. */
export function useBoardProjects(): BoardProject[] {
  const slots = useBoardStore(s => s.slots);
  const inboxPath = useBoardStore(s => s.inboxPath);
  return useMemo(() => boardProjects(slots, inboxPath), [slots, inboxPath]);
}
