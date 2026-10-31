// Действия человека (спека §10.1, §11.4): итог — `applied | conflict | stale | lost`. Изменяющий вызов после потери
// соединения не повторяется: клиент перечитывает состояние и называет итог по его данным.
import type { FeedDecision } from '@parley/core';
import { remoteWorksSnapshotSchema, type RemoteRoom } from '@parley/protocol/remote';
import type { RemoteStore } from './store.js';
import { sessionKey, type SessionRef } from './state.js';

/** RPC A11 (`call` отклоняется ошибкой с `code`: `connection_lost`, `conflict`, ...). Здесь — интерфейс, в тестах мок. */
export interface Rpc {
  call(method: string, params?: unknown): Promise<unknown>;
}

const codeOf = (error: unknown): string | null =>
  typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;

export interface ReadCardsResult {
  /** Чтение завершилось и применено; `false` — ошибка, чужая эпоха или потеря соединения. */
  ok: boolean;
}

/**
 * Перечитать `feed.snapshot {ref, scope:'attention'}` и положить в стор. Ответ прошлой эпохи не применяется
 * (редьюсер сверяет эпоху вызова). `now` — часы клиента.
 */
export async function readCards(store: RemoteStore, rpc: Rpc, now: () => number, ref: SessionRef): Promise<ReadCardsResult> {
  const epoch = store.getState().epoch;
  try {
    const res = (await rpc.call('feed.snapshot', { ref, scope: 'attention' })) as { items?: unknown } | null;
    const items = Array.isArray(res?.items) ? (res.items as never[]) : [];
    store.dispatch({ t: 'cards.loaded', ref, epoch, items, at: now() });
    return { ok: store.getState().epoch === epoch };
  } catch (error) {
    if (codeOf(error) !== 'connection_lost') store.dispatch({ t: 'cards.failed', ref, epoch, at: now() });
    return { ok: false };
  }
}

export type DecideOutcome =
  | { outcome: 'applied' | 'conflict' | 'stale' }
  /** `stillPending`: после перечитывания карточка ещё ждёт (`true`), ушла (`false`), перечитать не удалось (`null`). */
  | { outcome: 'lost'; stillPending: boolean | null };

export async function decide(
  store: RemoteStore,
  rpc: Rpc,
  now: () => number,
  ref: SessionRef,
  cardId: string,
  decision: FeedDecision,
): Promise<DecideOutcome> {
  const epoch = store.getState().epoch;
  try {
    const res = (await rpc.call('feed.decide', { ref, cardId, decision })) as { applied?: boolean };
    if (store.getState().epoch === epoch && res.applied === true) {
      store.dispatch({ t: 'cards.resolved', ref, cardId });
      return { outcome: 'applied' };
    }
    if (store.getState().epoch === epoch) {
      // Ответили в терминале или нажали второй раз: карточка уже не ждёт — перечитываем, чтобы она ушла из списка.
      await readCards(store, rpc, now, ref);
      return { outcome: 'stale' };
    }
    // Ответ пришёл уже в другой эпохе: итог неизвестен.
  } catch (error) {
    const code = codeOf(error);
    if (code === 'conflict') return { outcome: 'conflict' };
    if (code !== 'connection_lost') throw error;
  }
  const read = await readCards(store, rpc, now, ref);
  if (!read.ok) return { outcome: 'lost', stillPending: null };
  const pending = store.getState().cards[sessionKey(ref)]?.cards.some((c) => c.cardId === cardId) ?? false;
  return { outcome: 'lost', stillPending: pending };
}

export interface ResolveProposalParams {
  projectPath: string;
  workId: string;
  roomId: string;
  proposalId: string;
  /** Версия показанной карточки: без неё хост телефона не принимает вызов (§4.2). */
  rev: number;
  action: 'accept' | 'return';
  note?: string;
}

export type ResolveOutcome =
  | { outcome: 'applied' | 'stale' }
  /** `proposal` — решение комнаты из снимка после конфликта; `null` — его там уже нет. */
  | { outcome: 'conflict'; proposal: RemoteRoom['proposal'] }
  | { outcome: 'lost'; stillPending: boolean | null };

const proposalOf = (store: RemoteStore, p: ResolveProposalParams): RemoteRoom['proposal'] | undefined => {
  const work = store.getState().snapshot?.works.find((w) => w.projectPath === p.projectPath && w.id === p.workId);
  return work?.rooms.find((r) => r.id === p.roomId)?.proposal ?? null;
};

/**
 * Свежий снимок через `works.list`: годится, только если мост отдал проекцию. Иначе (полный снимок хоста или ошибка)
 * снимок придёт событием `works.changed`, и решение берётся из того, что уже в сторе.
 */
async function rereadWorks(store: RemoteStore, rpc: Rpc): Promise<boolean> {
  const epoch = store.getState().epoch;
  try {
    const parsed = remoteWorksSnapshotSchema.safeParse(await rpc.call('works.list', {}));
    if (!parsed.success) return false;
    store.dispatch({ t: 'snapshot', snapshot: parsed.data, epoch });
    return true;
  } catch {
    return false;
  }
}

export async function resolveProposal(store: RemoteStore, rpc: Rpc, p: ResolveProposalParams): Promise<ResolveOutcome> {
  const epoch = store.getState().epoch;
  const stillPending = (): boolean | null => {
    const cur = proposalOf(store, p);
    return cur === undefined ? null : cur !== null && cur.id === p.proposalId && cur.rev === p.rev;
  };
  try {
    await rpc.call('rooms.resolveProposal', p);
    return store.getState().epoch !== epoch ? await lostResolve(store, rpc, stillPending) : { outcome: 'applied' };
  } catch (error) {
    const code = codeOf(error);
    if (code === 'connection_lost') return lostResolve(store, rpc, stillPending);
    if (code === 'conflict') {
      await rereadWorks(store, rpc);
      return { outcome: 'conflict', proposal: proposalOf(store, p) ?? null };
    }
    throw error;
  }
}

async function lostResolve(store: RemoteStore, rpc: Rpc, stillPending: () => boolean | null): Promise<ResolveOutcome> {
  if (!(await rereadWorks(store, rpc))) return { outcome: 'lost', stillPending: null };
  return { outcome: 'lost', stillPending: stillPending() };
}
