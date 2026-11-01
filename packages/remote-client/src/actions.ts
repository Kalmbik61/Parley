// Действия человека (спека §10.1, §11.4): итог — `applied | conflict | stale | lost`. Изменяющий вызов после потери
// соединения не повторяется: клиент перечитывает состояние и называет итог по его данным.
import type { FeedDecision, Message, RoleList } from '@parley/core';
import { BRIDGE_CALL_DEADLINE_MS } from './rpc.js';
import { remoteWorksSnapshotSchema, type RemoteRoom } from '@parley/protocol/remote';
import type { RemoteStore } from './store.js';
import { roomKey, sessionKey, type ProviderCatalog, type RoomRef, type SessionRef } from './state.js';

/** RPC A11 (`call` отклоняется ошибкой с `code`: `connection_lost`, `conflict`, ...). Здесь — интерфейс, в тестах мок. */
export interface Rpc {
  call(method: string, params?: unknown): Promise<unknown>;
}

const codeOf = (error: unknown): string | null =>
  typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;

/** Ответа нет: соединение ушло или вышел срок. Итог вызова неизвестен, его узнают перечитыванием. */
const isLostCode = (code: string | null): boolean => code === 'connection_lost' || code === 'timeout';

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
  const startedAt = now();
  try {
    const res = (await rpc.call('feed.snapshot', { ref, scope: 'attention' })) as { items?: unknown } | null;
    const items = Array.isArray(res?.items) ? (res.items as never[]) : [];
    store.dispatch({ t: 'cards.loaded', ref, epoch, items, at: now(), startedAt });
    return { ok: store.getState().epoch === epoch };
  } catch (error) {
    if (!isLostCode(codeOf(error))) store.dispatch({ t: 'cards.failed', ref, epoch, at: now() });
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
      store.dispatch({ t: 'cards.resolved', ref, cardId, at: now() });
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
    if (!isLostCode(code)) throw error;
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
    if (isLostCode(code)) return lostResolve(store, rpc, stillPending);
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

// ---- Запуск с телефона и письмо в комнату (решение 5, A12b) ----
// Изменяющие вызовы не повторяются. Итог после обрыва узнаётся перечитыванием снимка работ.

/** Отказ хоста или моста: `unknown_method` (переключатель выключен), `bad_request`, `rate_limited`, ошибки лимитов хоста... */
export interface Rejected {
  outcome: 'rejected';
  code: string;
  message: string;
}

const messageOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : 'request failed';

/** Ошибка вызова → итог: `null` для потери ответа (итог неизвестен), иначе отказ; не-ошибки RPC пробрасываются. */
function rejection(error: unknown): Rejected | null {
  const code = codeOf(error);
  if (code === null) throw error;
  return isLostCode(code) ? null : { outcome: 'rejected', code, message: messageOf(error) };
}

/** Часы и пауза для действий с ожиданием итога; в тестах — фейковые. */
export interface ActionEnv {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Расхождение часов телефона и Мака, которое поиск созданного прощает (старт сессии и письмо ставят часы хоста). */
export const CLOCK_SKEW_MS = 60_000;
/** Отступы между перечитываниями снимка после потери ответа на запуск. */
const REREAD_BACKOFF_MS = [1000, 2000, 4000, 5000];

const isoMs = (iso: string | null): number | null => {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

export interface CreateSessionParams {
  projectPath: string;
  workId: string;
  provider: string;
  label: string;
  task: string;
  model?: string | null;
  role?: { source: 'builtin' | 'claude' | 'codex'; name: string } | null;
  worktree?: boolean;
}

export type CreateSessionOutcome =
  | { outcome: 'created'; ref: SessionRef }
  | Rejected
  /** Ответа нет, и снимок перечитать не удалось. */
  | { outcome: 'lost' }
  /** Снимок перечитан до срока вызова моста, новой сессии с этими параметрами в нём нет: возможно, она ещё запускается. */
  | { outcome: 'unknown' };

const workOf = (store: RemoteStore, projectPath: string, workId: string) =>
  store.getState().snapshot?.works.find((w) => w.projectPath === projectPath && w.id === workId);

/**
 * После потери ответа ищем созданное в свежем снимке. Мост ещё ждёт хост до `BRIDGE_CALL_DEADLINE_MS` от начала вызова,
 * поэтому, пока срок не вышел, перечитываем с отступом; после срока — последняя попытка и итог.
 * `null` — снимок не удалось перечитать ни разу; `undefined` — читали, но не нашли.
 */
async function awaitCreated<T>(store: RemoteStore, rpc: Rpc, env: ActionEnv, startedAt: number, find: () => T | undefined): Promise<T | null | undefined> {
  const deadline = startedAt + BRIDGE_CALL_DEADLINE_MS + 2000;
  let read = false;
  for (let attempt = 0; ; attempt++) {
    if (await rereadWorks(store, rpc)) {
      read = true;
      const found = find();
      if (found !== undefined) return found;
    }
    const wait = REREAD_BACKOFF_MS[Math.min(attempt, REREAD_BACKOFF_MS.length - 1)] ?? 5000;
    if (env.now() + wait > deadline) return read ? undefined : null;
    await env.sleep(wait);
  }
}

/** Запустить сессию. `projectPath` и `workId` — из проекции: новую работу с телефона не создать. */
export async function createSession(store: RemoteStore, rpc: Rpc, env: ActionEnv, params: CreateSessionParams): Promise<CreateSessionOutcome> {
  const epoch = store.getState().epoch;
  const startedAt = env.now();
  const before = new Set(workOf(store, params.projectPath, params.workId)?.sessions.map((x) => x.id));
  try {
    const res = (await rpc.call('sessions.create', { ...params, parent: null })) as { ref?: SessionRef } | null;
    if (store.getState().epoch === epoch && res?.ref !== undefined) return { outcome: 'created', ref: res.ref };
  } catch (error) {
    const rejected = rejection(error);
    if (rejected !== null) return rejected;
  }
  // Итог неизвестен: новая сессия — не из прежнего снимка, с тем же именем, провайдером и моделью, начатая не раньше вызова.
  const found = await awaitCreated(store, rpc, env, startedAt, () =>
    workOf(store, params.projectPath, params.workId)
      ?.sessions.filter((x) => {
        if (before.has(x.id) || x.label !== params.label || x.provider !== params.provider) return false;
        if (params.model && x.model !== null && x.model !== params.model) return false;
        const started = isoMs(x.startedAt);
        return started === null || started >= startedAt - CLOCK_SKEW_MS;
      })
      .at(-1),
  );
  if (found === null) return { outcome: 'lost' };
  return found === undefined
    ? { outcome: 'unknown' }
    : { outcome: 'created', ref: { projectPath: params.projectPath, workId: params.workId, sessionId: found.id } };
}

export interface CreateRoomParams {
  projectPath: string;
  workId: string;
  title: string;
  members: string[];
  lead?: string;
  quiet?: boolean;
  /** Без `autonomous`: он с телефона закрыт. */
  mode?: 'free' | 'checklist' | 'verified';
}

export type CreateRoomOutcome =
  | { outcome: 'created'; ref: RoomRef }
  | Rejected
  | { outcome: 'lost' }
  | { outcome: 'unknown' };

export async function createRoom(store: RemoteStore, rpc: Rpc, env: ActionEnv, params: CreateRoomParams): Promise<CreateRoomOutcome> {
  const epoch = store.getState().epoch;
  const startedAt = env.now();
  const before = new Set(workOf(store, params.projectPath, params.workId)?.rooms.map((x) => x.id));
  try {
    const res = (await rpc.call('rooms.create', params)) as { roomId?: string } | null;
    if (store.getState().epoch === epoch && typeof res?.roomId === 'string') {
      return { outcome: 'created', ref: { projectPath: params.projectPath, workId: params.workId, roomId: res.roomId } };
    }
  } catch (error) {
    const rejected = rejection(error);
    if (rejected !== null) return rejected;
  }
  // У комнаты в проекции нет времени создания: сверяем название, состав и режим.
  const found = await awaitCreated(store, rpc, env, startedAt, () =>
    workOf(store, params.projectPath, params.workId)
      ?.rooms.filter(
        (r) =>
          !before.has(r.id) &&
          r.title === params.title &&
          params.members.every((m) => r.members.includes(m)) &&
          (r.mode ?? 'free') === (params.mode ?? 'free'),
      )
      .at(-1),
  );
  if (found === null) return { outcome: 'lost' };
  return found === undefined
    ? { outcome: 'unknown' }
    : { outcome: 'created', ref: { projectPath: params.projectPath, workId: params.workId, roomId: found.id } };
}

export interface SendRoomMessageParams extends RoomRef {
  text: string;
  kind: 'note' | 'question';
  /** Адресаты; без поля — всем участникам комнаты. */
  to?: string[];
  replyTo?: string;
}

export type SendRoomMessageOutcome = { outcome: 'sent'; messageId: string } | Rejected | { outcome: 'lost' };

/** Письмо человека с этим текстом в ленте комнаты, написанное не раньше начала отправки (с поправкой на часы). */
async function findSentLetter(rpc: Rpc, params: SendRoomMessageParams, startedAt: number): Promise<Message | null> {
  try {
    const page = (await rpc.call('context.messages', { projectPath: params.projectPath, workId: params.workId, roomId: params.roomId })) as { messages?: Message[] } | null;
    const found = (page?.messages ?? []).filter((m) => {
      if (m.from !== 'human' || m.roomId !== params.roomId) return false;
      // Длинное письмо хост в странице сокращает (`textBytes`): тогда сверяем начало.
      const same = m.text === params.text || (m.textBytes !== undefined && params.text.startsWith(m.text));
      const at = isoMs(m.at);
      return same && at !== null && at >= startedAt - CLOCK_SKEW_MS;
    });
    return found.at(-1) ?? null;
  } catch {
    return null;
  }
}

/**
 * Письмо в комнату. Текст лежит в черновике (`state.drafts`) с начала отправки и уходит из него только после `sent`:
 * отказ и потеря ответа оставляют письмо человеку. После потери ответа лента комнаты проверяется: письмо уже там — итог
 * `sent`; пока связи нет, чтение повторяется с отступом до срока вызова моста. Само письмо не повторяется.
 */
export async function sendRoomMessage(store: RemoteStore, rpc: Rpc, env: ActionEnv, params: SendRoomMessageParams): Promise<SendRoomMessageOutcome> {
  const epoch = store.getState().epoch;
  const key = roomKey(params);
  const startedAt = env.now();
  store.dispatch({ t: 'draft', key, text: params.text });
  const sent = (messageId: string): SendRoomMessageOutcome => {
    store.dispatch({ t: 'draft', key, text: '' });
    return { outcome: 'sent', messageId };
  };
  try {
    const res = (await rpc.call('rooms.send', {
      projectPath: params.projectPath,
      workId: params.workId,
      roomId: params.roomId,
      to: params.to ?? [],
      text: params.text,
      kind: params.kind,
      ...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
    })) as { messageId?: string } | null;
    if (store.getState().epoch === epoch && typeof res?.messageId === 'string') return sent(res.messageId);
  } catch (error) {
    const rejected = rejection(error);
    if (rejected !== null) return rejected;
  }
  // Связь после обрыва ещё может быть закрыта: читаем ленту с отступом до срока вызова моста, пока письмо не найдётся.
  const deadline = startedAt + BRIDGE_CALL_DEADLINE_MS + 2000;
  for (let attempt = 0; ; attempt++) {
    const letter = await findSentLetter(rpc, params, startedAt);
    if (letter !== null) return sent(letter.id);
    const wait = REREAD_BACKOFF_MS[Math.min(attempt, REREAD_BACKOFF_MS.length - 1)] ?? 5000;
    if (env.now() + wait > deadline) return { outcome: 'lost' };
    await env.sleep(wait);
  }
}

/** Каталог провайдеров для диалога запуска; `false` — не загрузился (метода нет, обрыв). */
export async function loadProviders(store: RemoteStore, rpc: Rpc): Promise<boolean> {
  const epoch = store.getState().epoch;
  try {
    const providers = (await rpc.call('providers.list', {})) as ProviderCatalog;
    store.dispatch({ t: 'catalog.providers', epoch, providers });
    return store.getState().epoch === epoch;
  } catch {
    return false;
  }
}

/** Роли проекта для диалога запуска. */
export async function loadRoles(store: RemoteStore, rpc: Rpc, projectPath: string): Promise<boolean> {
  const epoch = store.getState().epoch;
  try {
    const roles = (await rpc.call('roles.list', { projectPath })) as RoleList;
    store.dispatch({ t: 'catalog.roles', epoch, projectPath, roles });
    return store.getState().epoch === epoch;
  } catch {
    return false;
  }
}
