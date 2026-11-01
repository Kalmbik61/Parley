// Редьюсер состояния телефона (спека §10.1, §8.3). Чистый: часы и RPC сюда не входят, время приходит в действии.
import type { FeedItem, Message, RoleList, SessionActivity } from '@parley/core';
import { pendingCards } from '@parley/core/card-gist';
import type { RoomsMailEvent } from '@parley/protocol';
import { bridgeEventSchemas, remoteWorksSnapshotSchema, type RemoteWorksSnapshot } from '@parley/protocol/remote';
import {
  goneKey,
  initialRemoteState,
  sessionKey,
  workKeyOf,
  type ActivityEntry,
  type CardsEntry,
  type HostStatus,
  type ProviderCatalog,
  type RemoteState,
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

export function reduce(state: RemoteState, action: RemoteAction): RemoteState {
  switch (action.t) {
    case 'bridge.status':
      // Другая эпоха сбрасывает снимок, активность, карточки и письма: защита по `revision` начинается заново.
      // `methods` (hello моста) и черновики пишет не эпоха хоста: они живут до своего события.
      if (action.epoch !== state.epoch) {
        return { ...initialRemoteState(), hostStatus: action.host, epoch: action.epoch, methods: state.methods, drafts: state.drafts };
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
      return applyMail(state, action.event);
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
    default:
      return null;
  }
}

function activityChanged(d: Record<string, unknown>): RemoteAction | null {
  if (!isRef(d.ref) || typeof d.activity !== 'object' || d.activity === null) return null;
  return { t: 'activity.changed', ref: d.ref, activity: d.activity as SessionActivity, metrics: d.metrics ?? null };
}
