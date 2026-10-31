// Стор, совместимый с zustand по форме (`getState / setState / subscribe`): `useStore(store, selector)` из zustand
// работает с ним как есть, а зависимости от самого zustand у пакета нет.
import { actionFromEvent, reduce, type RemoteAction } from './reducer.js';
import { initialRemoteState, type RemoteState } from './state.js';

export type Listener<S> = (state: S, prev: S) => void;

export interface StoreApi<S> {
  getState(): S;
  getInitialState(): S;
  setState(partial: Partial<S> | ((state: S) => Partial<S>), replace?: false): void;
  setState(state: S | ((state: S) => S), replace: true): void;
  subscribe(listener: Listener<S>): () => void;
}

export interface RemoteStore extends StoreApi<RemoteState> {
  /** Применить действие редьюсера. */
  dispatch(action: RemoteAction): void;
  /** Кадр события моста или хоста; чужое игнорируется. */
  handleEvent(event: string, data: unknown): void;
}

export function createRemoteStore(): RemoteStore {
  let state = initialRemoteState();
  const initial = state;
  const listeners = new Set<Listener<RemoteState>>();

  const set = (next: RemoteState): void => {
    if (Object.is(next, state)) return;
    const prev = state;
    state = next;
    for (const l of [...listeners]) l(state, prev);
  };

  const store: RemoteStore = {
    getState: () => state,
    getInitialState: () => initial,
    setState: ((partial: unknown, replace?: boolean) => {
      const p = typeof partial === 'function' ? (partial as (s: RemoteState) => unknown)(state) : partial;
      set(replace === true ? (p as RemoteState) : { ...state, ...(p as Partial<RemoteState>) });
    }) as RemoteStore['setState'],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    dispatch: (action) => set(reduce(state, action)),
    handleEvent: (event, data) => {
      const action = actionFromEvent(event, data);
      if (action !== null) store.dispatch(action);
    },
  };
  return store;
}
