/**
 * Карточки согласия на острове (спека 2026-10-21, 4.4): зеркало `consents.list` / `consents.changed` хоста, в `items`
 * только ждущие (`pending`) — решённые хост присылает с `removed` или с другим состоянием, и в стор они не попадают.
 * Показывается первая: карточка держит запуск Codex, пока человек не решит в окне, на острове или в Telegram.
 *
 * Решение — `consents.decide` через белый список острова. Исход: `applied: true` — карточка остаётся «Done ✓» на
 * `ANSWER_HOLD_MS`; `applied: false` — на неё уже ответили в другом месте, пометка `elsewhere` на `ELSEWHERE_MS`
 * и уход; ошибка — пометка `failed`, карточка остаётся и решается снова. Пока решение в пути и пока держится пометка,
 * события хоста о той же карточке стор не трогают: хост присылает «закрыта» раньше ответа на вызов, и иначе
 * «Done ✓» не успевал бы показаться.
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { ConsentCard, EventData } from '@parley/protocol';
import type { IslandBridge } from '../../../shared/island.js';
import { ELSEWHERE_MS } from '../requests.js';

/** Сколько «Done ✓» держится на карточке после решения. */
export const ANSWER_HOLD_MS = 8000;

export interface ConsentsDeps {
  call: IslandBridge['call'];
}

export interface ConsentsState {
  /** Ждущие карточки в порядке появления; показывается первая. */
  items: ConsentCard[];
  /** Id карточки, решение по которой в пути. */
  deciding: string | null;
  /** Пометка показанной (первой) карточки. */
  note: 'done' | 'elsewhere' | 'failed' | null;
  configure(deps: ConsentsDeps): void;
  apply(change: EventData<'consents.changed'>): void;
  replace(items: readonly ConsentCard[]): void;
  decide(id: string, decision: 'allow' | 'deny'): Promise<void>;
}

const pending = (cards: readonly ConsentCard[]): ConsentCard[] => cards.filter((card) => card.state === 'pending');

export function createConsentsStore(): UseBoundStore<StoreApi<ConsentsState>> {
  let deps: ConsentsDeps | null = null;
  /** Карточки, которых события хоста не трогают: решение в пути или держится «Done ✓» / «Already answered». */
  const held = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return create<ConsentsState>((set, get) => {
    /** Новый набор карточек; пометка принадлежит показанной карточке и с ней уходит. */
    const withItems = (items: ConsentCard[]): Partial<ConsentsState> =>
      items[0]?.id === get().items[0]?.id ? { items } : { items, note: null };
    const finish = (id: string): void => {
      held.delete(id);
      timers.delete(id);
      set((state) => withItems(state.items.filter((card) => card.id !== id)));
    };
    /** Исход решения: пометка на `ms`, потом карточка уходит. Карточку уже могли заменить (`replace`) — пометка чужой не нужна. */
    const settle = (id: string, note: 'done' | 'elsewhere', ms: number): void => {
      if (!get().items.some((card) => card.id === id)) {
        held.delete(id);
        set({ deciding: null });
        return;
      }
      set({ deciding: null, note });
      timers.set(id, setTimeout(() => finish(id), ms));
    };
    return {
      items: [],
      deciding: null,
      note: null,
      configure: (next) => {
        deps = next;
      },
      apply: ({ upsert, removed }) =>
        set((state) => {
          const byId = new Map(state.items.map((card) => [card.id, card]));
          for (const card of upsert) {
            if (held.has(card.id)) continue;
            if (card.state === 'pending') byId.set(card.id, card);
            else byId.delete(card.id);
          }
          for (const id of removed) if (!held.has(id)) byId.delete(id);
          return withItems([...byId.values()]);
        }),
      replace: (items) => {
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        held.clear();
        set({ items: pending(items), deciding: null, note: null });
      },
      decide: async (id, decision) => {
        const current = deps;
        if (current === null || get().deciding !== null || held.has(id) || !get().items.some((card) => card.id === id)) return;
        held.add(id);
        set({ deciding: id, note: null });
        try {
          const result = await current.call('consents.decide', { id, decision });
          settle(id, result.applied ? 'done' : 'elsewhere', result.applied ? ANSWER_HOLD_MS : ELSEWHERE_MS);
        } catch {
          held.delete(id);
          set({ deciding: null, ...(get().items.some((card) => card.id === id) ? { note: 'failed' as const } : {}) });
        }
      },
    };
  });
}

export const useConsentsStore = createConsentsStore();
