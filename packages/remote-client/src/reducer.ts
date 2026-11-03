// Редьюсер состояния телефона (спека §10.1, §8.3). Чистый: часы и RPC сюда не входят, время приходит в действии.
import type { FeedItem, Message, RoleList, SessionActivity } from '@parley/core';
import { pendingCards } from '@parley/core/card-gist';
import type { ConsentCard, EventData, FeedDecisions, RoomsMailEvent } from '@parley/protocol';
import { bridgeEventSchemas, remoteWorksSnapshotSchema, type RemoteWorksSnapshot } from '@parley/protocol/remote';
import {
  goneKey,
  initialRemoteState,
  sessionKey,
  workKeyOf,
  type ActivityEntry,
  type CardsEntry,
  type FeedEntry,
  type HostStatus,
  type ProviderCatalog,
  type RemoteState,
  type RoomChat,
  type RoomRef,
  roomKey,
  type SessionRef,
} from './state.js';

export type RemoteAction =
  | { t: 'bridge.status'; host: HostStatus; epoch: string | null }
  /** `epoch` — эпоха вызова, если снимок пришёл ответом; у события `works.changed` её нет (порядок держит мост). */
  | { t: 'snapshot'; snapshot: RemoteWorksSnapshot; epoch?: string | null }
  | { t: 'activity.snapshot'; epoch: string | null; items: unknown[] }
  | { t: 'activity.changed'; ref: SessionRef; activity: SessionActivity; metrics: unknown }
  | { t: 'mail'; event: RoomsMailEvent }
  | { t: 'messages'; projectPath: string; workId: string; roomId: string | null; messages: Message[]; epoch?: string | null }
  /** `at` — когда чтение закончилось, `startedAt` — когда началось (без него равно `at`). */
  | { t: 'cards.loaded'; ref: SessionRef; epoch: string | null; items: FeedItem[]; at: number; startedAt?: number }
  | { t: 'cards.failed'; ref: SessionRef; epoch: string | null; at: number }
  /** Карточку решили мы сами: она уходит без «Answered at your Mac». */
  | { t: 'cards.resolved'; ref: SessionRef; cardId: string; at: number }
  | { t: 'gone.dismiss'; key: string }
  /** Методы из hello моста; `null` — соединение потеряно, hello устарел. */
  | { t: 'hello'; methods: string[] | null }
  | { t: 'catalog.providers'; epoch: string | null; providers: ProviderCatalog }
  | { t: 'catalog.roles'; epoch: string | null; projectPath: string; roles: RoleList }
  /** Снимок ленты (`feed.snapshot`, полный). Ответ другой эпохи не применяется. */
  | { t: 'feed.loaded'; ref: SessionRef; epoch: string | null; items: FeedItem[]; revision: number; mode: string | null; decisions: FeedDecisions | null }
  | { t: 'feed.failed'; ref: SessionRef; epoch: string | null }
  /** Открытие ленты: запись в состоянии `loading` (прежние элементы остаются на экране). */
  | { t: 'feed.open'; ref: SessionRef }
  | { t: 'feed.close'; ref: SessionRef }
  /** Подписка потеряна (фон, переподключение): до нового снимка запись снова `loading`, дельты ждут в очереди. */
  | { t: 'feed.reload'; ref: SessionRef }
  | { t: 'feed.changed'; delta: EventData<'feed.changed'> }
  | { t: 'room.open'; ref: RoomRef }
  | { t: 'room.close'; ref: RoomRef }
  | { t: 'room.reload'; ref: RoomRef }
  | { t: 'room.loaded'; ref: RoomRef; epoch: string | null; messages: Message[]; next: string | null }
  | { t: 'room.older'; ref: RoomRef; epoch: string | null; messages: Message[]; next: string | null }
  | { t: 'room.more'; ref: RoomRef }
  | { t: 'room.failed'; ref: RoomRef; epoch: string | null; more: boolean }
  | { t: 'consents.loaded'; epoch: string | null; items: ConsentCard[] }
  | { t: 'consents.changed'; upsert: ConsentCard[]; removed: string[] }
  /** Карточку согласия решили мы сами. */
  | { t: 'consents.resolved'; id: string }
  /** `text: ''` убирает черновик. */
  | { t: 'draft'; key: string; text: string };

const isRef = (value: unknown): value is SessionRef => {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.projectPath === 'string' && typeof r.workId === 'string' && typeof r.sessionId === 'string';
};

/** Элемент `activity.snapshot.items`: `{ref, activity, metrics}`; чужая форма пропускается. */
function activityEntry(item: unknown): ActivityEntry | null {
  if (typeof item !== 'object' || item === null) return null;
  const { ref, activity, metrics } = item as Record<string, unknown>;
  if (!isRef(ref) || typeof activity !== 'object' || activity === null) return null;
  return { ref, activity: activity as SessionActivity, metrics: metrics ?? null };
}

function applySnapshot(state: RemoteState, snapshot: RemoteWorksSnapshot): RemoteState {
  // Внутри эпохи меньший (и равный) `revision` не откатывает больший.
  if (state.snapshot !== null && snapshot.revision <= state.snapshot.revision) return state;
  const letterUnread = { ...state.letterUnread };
  for (const work of snapshot.works) letterUnread[workKeyOf(work.projectPath, work.id)] = work.messages.direct?.unread ?? 0;
  return { ...state, snapshot, letterUnread };
}

function mergeLetters(state: RemoteState, key: string, incoming: Message[]): RemoteState {
  const own = incoming.filter((m) => m.roomId === null);
  if (own.length === 0) return state;
  const merged = { ...state.letters[key] };
  for (const m of own) merged[m.id] = m;
  return { ...state, letters: { ...state.letters, [key]: merged } };
}

function applyMail(state: RemoteState, event: RoomsMailEvent): RemoteState {
  const key = workKeyOf(event.projectPath, event.workId);
  let next: RemoteState = { ...state, letterUnread: { ...state.letterUnread, [key]: event.unread.letters } };
  const direct = event.rooms.find((r) => r.roomId === null);
  if (direct !== undefined) {
    next = mergeLetters(next, key, direct.letters);
    const current = next.letters[key];
    if (current !== undefined && (direct.reads.length > 0 || direct.deleted.length > 0)) {
      const copy = { ...current };
      for (const id of direct.deleted) delete copy[id];
      for (const read of direct.reads) {
        const m = copy[read.id];
        if (m !== undefined) copy[read.id] = { ...m, readBy: { ...m.readBy, [read.reader]: read.at } };
      }
      next = { ...next, letters: { ...next.letters, [key]: copy } };
    }
  }
  return next;
}

function applyCards(state: RemoteState, ref: SessionRef, items: FeedItem[], at: number, startedAt: number): RemoteState {
  const key = sessionKey(ref);
  // Карточка, решённая на телефоне после начала этого чтения, в устаревшем ответе не воскресает.
  const resolved = { ...state.resolved };
  let touched = false;
  const cards = pendingCards(items).filter((c) => {
    const at0 = resolved[goneKey(key, c.cardId)];
    return at0 === undefined || startedAt > at0;
  });
  const prefix = `${key}\u0000`;
  for (const [k, resolvedAt] of Object.entries(resolved)) {
    if (k.startsWith(prefix) && startedAt > resolvedAt) {
      delete resolved[k];
      touched = true;
    }
  }
  const texts = items.filter((i): i is Extract<FeedItem, { kind: 'text' }> => i.kind === 'text');
  const last = texts[texts.length - 1];
  const entry: CardsEntry = {
    cards,
    lastReply: last ? { id: last.id, text: last.text, at: last.at, streaming: last.streaming } : null,
    readAt: at,
    error: false,
  };
  const ids = new Set(cards.map((c) => c.cardId));
  let gone = state.gone;
  for (const old of state.cards[key]?.cards ?? []) {
    if (ids.has(old.cardId)) continue;
    if (gone === state.gone) gone = { ...gone };
    gone[goneKey(key, old.cardId)] = { sessionKey: key, cardId: old.cardId, card: old, at };
  }
  return { ...state, gone, cards: { ...state.cards, [key]: entry }, ...(touched ? { resolved } : {}) };
}

/** Дельта r+1 поверх элементов: upsert по id (новые — в конец, известные — на месте), затем `removed`. */
export function applyFeedDelta(items: readonly FeedItem[], upsert: readonly FeedItem[], removed: readonly string[]): FeedItem[] {
  const next = [...items];
  const index = new Map(next.map((item, at) => [item.id, at]));
  for (const item of upsert) {
    const at = index.get(item.id);
    if (at === undefined) {
      index.set(item.id, next.length);
      next.push(item);
    } else {
      next[at] = item;
    }
  }
  if (removed.length === 0) return next;
  const gone = new Set(removed);
  return next.filter((item) => !gone.has(item.id));
}

/** Применяет дельты по порядку `revision`; устаревшие отбрасывает, на пропуске останавливается (`gap`). */
function drain(entry: FeedEntry): FeedEntry {
  const queued = [...entry.queued].sort((a, b) => a.revision - b.revision);
  let { items, revision, mode, decisions } = entry;
  let gap = false;
  const rest: EventData<'feed.changed'>[] = [];
  for (const delta of queued) {
    if (delta.revision <= revision) continue;
    if (!gap && delta.revision === revision + 1) {
      items = applyFeedDelta(items, delta.upsert, delta.removed);
      revision = delta.revision;
      mode = delta.mode;
      if (delta.decisions !== undefined) decisions = delta.decisions;
    } else {
      gap = true;
      rest.push(delta);
    }
  }
  return { ...entry, items, revision, mode, decisions, queued: rest, status: gap ? 'stale' : entry.status };
}

/** Снимок свежее любой дельты с пропуском: остаток очереди отбрасывается, лента готова. */
function settle(entry: FeedEntry): FeedEntry {
  const drained = drain(entry);
  return { ...drained, queued: [], status: 'ready' };
}

const upsertConsents = (items: ConsentCard[], upsert: ConsentCard[], removed: string[]): ConsentCard[] => {
  const gone = new Set(removed);
  const next = items.filter((c) => !gone.has(c.id));
  for (const card of upsert) {
    if (gone.has(card.id)) continue;
    const at = next.findIndex((c) => c.id === card.id);
    if (at === -1) next.push(card);
    else next[at] = card;
  }
  return next;
};

const idNum = (id: string): number => Number(/(\d+)$/.exec(id)?.[1] ?? 0);
/** Ascending by time, then by id. */
export const byOrder = (a: Message, b: Message): number => Date.parse(a.at) - Date.parse(b.at) || idNum(a.id) - idNum(b.id);

function mergeMessages(list: readonly Message[], incoming: readonly Message[]): Message[] {
  const map = new Map(list.map((m) => [m.id, m]));
  for (const m of incoming) map.set(m.id, m);
  return [...map.values()].sort(byOrder);
}

/** `rooms.mail` for the rooms open on the phone: new letters, read marks, deletions; `reread` marks the room stale. */
function applyRoomMail(state: RemoteState, event: RoomsMailEvent): RemoteState {
  let chats = state.roomChats;
  const set = (key: string, chat: RoomChat): void => {
    if (chats === state.roomChats) chats = { ...chats };
    chats[key] = chat;
  };
  for (const room of event.rooms) {
    if (room.roomId === null) continue;
    const key = roomKey({ projectPath: event.projectPath, workId: event.workId, roomId: room.roomId });
    const chat = state.roomChats[key];
    if (chat === undefined) continue;
    let messages = mergeMessages(chat.messages, room.letters.filter((m) => m.roomId === room.roomId));
    if (room.deleted.length > 0) messages = messages.map((m) => (room.deleted.includes(m.id) ? { ...m, deleted: true } : m));
    for (const read of room.reads) messages = messages.map((m) => (m.id === read.id ? { ...m, readBy: { ...m.readBy, [read.reader]: read.at } } : m));
    set(key, { ...chat, messages, status: room.reread === true && chat.status === 'ready' ? 'stale' : chat.status });
  }
  for (const dropped of event.droppedRooms) {
    const key = roomKey({ projectPath: event.projectPath, workId: event.workId, roomId: dropped });
    if (key in chats) {
      if (chats === state.roomChats) chats = { ...chats };
      delete chats[key];
    }
  }
  return chats === state.roomChats ? state : { ...state, roomChats: chats };
}

export function reduce(state: RemoteState, action: RemoteAction): RemoteState {
  switch (action.t) {
    case 'bridge.status':
      // Другая эпоха сбрасывает снимок, активность, карточки и письма: защита по `revision` начинается заново.
      // `methods` (hello моста) и черновики пишет не эпоха хоста: они живут до своего события.
      if (action.epoch !== state.epoch) {
        // Открытые ленты остаются записями `loading` (элементы прежние на экране до нового снимка); `revision` начинается заново.
        const feeds: Record<string, FeedEntry> = {};
        for (const [k, f] of Object.entries(state.feeds)) feeds[k] = { ...f, revision: 0, status: 'loading', queued: [] };
        // Open rooms keep what they show and read the newest page again.
        const roomChats: Record<string, RoomChat> = {};
        for (const [k, r] of Object.entries(state.roomChats)) roomChats[k] = { ...r, status: 'loading', more: 'idle' };
        return { ...initialRemoteState(), hostStatus: action.host, epoch: action.epoch, methods: state.methods, drafts: state.drafts, feeds, roomChats };
      }
      return state.hostStatus === action.host ? state : { ...state, hostStatus: action.host };
    case 'snapshot':
      if (action.epoch !== undefined && action.epoch !== state.epoch) return state;
      return applySnapshot(state, action.snapshot);
    case 'activity.snapshot': {
      if (action.epoch !== state.epoch) return state;
      const activity: Record<string, ActivityEntry> = {};
      for (const item of action.items) {
        const entry = activityEntry(item);
        if (entry !== null) activity[sessionKey(entry.ref)] = entry;
      }
      return { ...state, activity };
    }
    case 'activity.changed':
      return {
        ...state,
        activity: {
          ...state.activity,
          [sessionKey(action.ref)]: { ref: action.ref, activity: action.activity, metrics: action.metrics },
        },
      };
    case 'mail':
      return applyRoomMail(applyMail(state, action.event), action.event);
    case 'room.open': {
      const key = roomKey(action.ref);
      if (key in state.roomChats) return state;
      return { ...state, roomChats: { ...state.roomChats, [key]: { messages: [], older: null, status: 'loading', more: 'idle' } } };
    }
    case 'room.close': {
      const key = roomKey(action.ref);
      if (!(key in state.roomChats)) return state;
      const roomChats = { ...state.roomChats };
      delete roomChats[key];
      return { ...state, roomChats };
    }
    case 'room.reload': {
      const key = roomKey(action.ref);
      const chat = state.roomChats[key];
      return chat === undefined || chat.status === 'loading' ? state : { ...state, roomChats: { ...state.roomChats, [key]: { ...chat, status: 'loading' } } };
    }
    case 'room.loaded': {
      if (action.epoch !== state.epoch) return state;
      const key = roomKey(action.ref);
      const chat = state.roomChats[key];
      if (chat === undefined) return state;
      // The newest page replaces what is held (a reread); letters that arrived by `rooms.mail` meanwhile are kept.
      const messages = mergeMessages(action.messages, chat.messages.filter((m) => action.messages.length === 0 || Date.parse(m.at) >= Date.parse(action.messages[0]!.at)));
      return { ...state, roomChats: { ...state.roomChats, [key]: { messages, older: action.next, status: 'ready', more: 'idle' } } };
    }
    case 'room.more': {
      const key = roomKey(action.ref);
      const chat = state.roomChats[key];
      return chat === undefined ? state : { ...state, roomChats: { ...state.roomChats, [key]: { ...chat, more: 'loading' } } };
    }
    case 'room.older': {
      if (action.epoch !== state.epoch) return state;
      const key = roomKey(action.ref);
      const chat = state.roomChats[key];
      if (chat === undefined) return state;
      return { ...state, roomChats: { ...state.roomChats, [key]: { ...chat, messages: mergeMessages(chat.messages, action.messages), older: action.next, more: 'idle' } } };
    }
    case 'room.failed': {
      if (action.epoch !== state.epoch) return state;
      const key = roomKey(action.ref);
      const chat = state.roomChats[key];
      if (chat === undefined) return state;
      return { ...state, roomChats: { ...state.roomChats, [key]: action.more ? { ...chat, more: 'error' } : { ...chat, status: 'error' } } };
    }
    case 'messages':
      if (action.epoch !== undefined && action.epoch !== state.epoch) return state;
      return action.roomId === null
        ? mergeLetters(state, workKeyOf(action.projectPath, action.workId), action.messages)
        : state;
    case 'cards.loaded':
      return action.epoch === state.epoch ? applyCards(state, action.ref, action.items, action.at, action.startedAt ?? action.at) : state;
    case 'cards.failed': {
      if (action.epoch !== state.epoch) return state;
      const key = sessionKey(action.ref);
      const prev = state.cards[key] ?? { cards: [], lastReply: null, readAt: 0, error: false };
      return { ...state, cards: { ...state.cards, [key]: { ...prev, readAt: action.at, error: true } } };
    }
    case 'cards.resolved': {
      const key = sessionKey(action.ref);
      const entry = state.cards[key];
      if (entry === undefined) return { ...state, resolved: { ...state.resolved, [goneKey(key, action.cardId)]: action.at } };
      return {
        ...state,
        resolved: { ...state.resolved, [goneKey(key, action.cardId)]: action.at },
        cards: { ...state.cards, [key]: { ...entry, cards: entry.cards.filter((c) => c.cardId !== action.cardId) } },
      };
    }
    case 'hello':
      return { ...state, methods: action.methods };
    case 'feed.open': {
      const key = sessionKey(action.ref);
      if (key in state.feeds) return state;
      return { ...state, feeds: { ...state.feeds, [key]: { items: [], revision: 0, mode: null, decisions: null, status: 'loading', queued: [] } } };
    }
    case 'feed.close': {
      const key = sessionKey(action.ref);
      if (!(key in state.feeds)) return state;
      const feeds = { ...state.feeds };
      delete feeds[key];
      return { ...state, feeds };
    }
    case 'feed.reload': {
      const key = sessionKey(action.ref);
      const prev = state.feeds[key];
      if (prev === undefined || prev.status === 'loading') return state;
      return { ...state, feeds: { ...state.feeds, [key]: { ...prev, revision: 0, status: 'loading', queued: [] } } };
    }
    case 'feed.loaded': {
      if (action.epoch !== state.epoch) return state;
      const key = sessionKey(action.ref);
      const prev = state.feeds[key];
      // Открытие закрыли, пока шёл снимок: запись не воскрешается.
      if (prev === undefined) return state;
      const entry = settle({
        items: action.items,
        revision: action.revision,
        mode: action.mode,
        decisions: action.decisions,
        status: 'ready',
        queued: prev.queued,
      });
      return { ...state, feeds: { ...state.feeds, [key]: entry } };
    }
    case 'feed.failed': {
      if (action.epoch !== state.epoch) return state;
      const key = sessionKey(action.ref);
      const prev = state.feeds[key];
      return prev === undefined ? state : { ...state, feeds: { ...state.feeds, [key]: { ...prev, status: 'error' } } };
    }
    case 'feed.changed': {
      const key = sessionKey(action.delta.ref);
      const prev = state.feeds[key];
      if (prev === undefined) return state;
      // Снимка ещё нет (или нужен новый): дельта ждёт в очереди.
      if (prev.status !== 'ready') {
        if (prev.queued.some((d) => d.revision === action.delta.revision)) return state;
        return { ...state, feeds: { ...state.feeds, [key]: { ...prev, queued: [...prev.queued, action.delta] } } };
      }
      if (action.delta.revision <= prev.revision) return state;
      return { ...state, feeds: { ...state.feeds, [key]: drain({ ...prev, queued: [...prev.queued, action.delta] }) } };
    }
    case 'consents.loaded':
      return action.epoch === state.epoch ? { ...state, consents: { loaded: true, items: action.items } } : state;
    case 'consents.changed':
      return { ...state, consents: { ...state.consents, items: upsertConsents(state.consents.items, action.upsert, action.removed) } };
    case 'consents.resolved':
      return state.consents.items.some((c) => c.id === action.id)
        ? { ...state, consents: { ...state.consents, items: state.consents.items.filter((c) => c.id !== action.id) } }
        : state;
    case 'catalog.providers':
      return action.epoch === state.epoch ? { ...state, providers: action.providers } : state;
    case 'catalog.roles':
      return action.epoch === state.epoch ? { ...state, roles: { ...state.roles, [action.projectPath]: action.roles } } : state;
    case 'draft': {
      if (action.text === '') {
        if (!(action.key in state.drafts)) return state;
        const drafts = { ...state.drafts };
        delete drafts[action.key];
        return { ...state, drafts };
      }
      return state.drafts[action.key] === action.text ? state : { ...state, drafts: { ...state.drafts, [action.key]: action.text } };
    }
    case 'gone.dismiss': {
      if (!(action.key in state.gone)) return state;
      const gone = { ...state.gone };
      delete gone[action.key];
      return { ...state, gone };
    }
  }
}

/**
 * Кадр моста или хоста → действие. Чужое, невалидное и не касающееся состояния (`host.notice`, `session.closing`)
 * даёт `null`.
 */
export function actionFromEvent(event: string, data: unknown): RemoteAction | null {
  switch (event) {
    case 'bridge.status': {
      const p = bridgeEventSchemas['bridge.status'].safeParse(data);
      return p.success ? { t: 'bridge.status', host: p.data.host, epoch: p.data.epoch } : null;
    }
    case 'activity.snapshot': {
      const p = bridgeEventSchemas['activity.snapshot'].safeParse(data);
      return p.success ? { t: 'activity.snapshot', epoch: p.data.epoch, items: p.data.items } : null;
    }
    case 'works.changed': {
      const p = remoteWorksSnapshotSchema.safeParse(data);
      return p.success ? { t: 'snapshot', snapshot: p.data } : null;
    }
    case 'activity.changed':
      if (typeof data !== 'object' || data === null) return null;
      return activityChanged(data as Record<string, unknown>);
    case 'rooms.mail': {
      if (typeof data !== 'object' || data === null) return null;
      const e = data as Partial<RoomsMailEvent>;
      return typeof e.projectPath === 'string' && typeof e.workId === 'string' && Array.isArray(e.rooms) && e.unread
        ? { t: 'mail', event: e as RoomsMailEvent }
        : null;
    }
    case 'feed.changed': {
      if (typeof data !== 'object' || data === null) return null;
      const d = data as Partial<EventData<'feed.changed'>>;
      return isRef(d.ref) && typeof d.revision === 'number' && Array.isArray(d.upsert) && Array.isArray(d.removed)
        ? { t: 'feed.changed', delta: d as EventData<'feed.changed'> }
        : null;
    }
    case 'consents.changed': {
      if (typeof data !== 'object' || data === null) return null;
      const d = data as Partial<EventData<'consents.changed'>>;
      return Array.isArray(d.upsert) && Array.isArray(d.removed) ? { t: 'consents.changed', upsert: d.upsert, removed: d.removed } : null;
    }
    default:
      return null;
  }
}

function activityChanged(d: Record<string, unknown>): RemoteAction | null {
  if (!isRef(d.ref) || typeof d.activity !== 'object' || d.activity === null) return null;
  return { t: 'activity.changed', ref: d.ref, activity: d.activity as SessionActivity, metrics: d.metrics ?? null };
}
