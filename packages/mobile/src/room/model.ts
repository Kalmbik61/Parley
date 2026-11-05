// Room chat logic (D1 §9.7), React-free: mentions, recipients, delivery lines, grouping, the composer's mode, the send.
// Words follow the window (`S.rooms.*`). No `clientMsgId` here: `rooms.send` has none, so a lost answer is never repeated;
// the client re-reads the room and the history decides (A12b).
import type { Message } from '@parley/core';
import type { RemoteRoom, RemoteSession } from '@parley/protocol/remote';
import type { RemoteClient, SendRoomMessageOutcome } from '@parley/remote-client';
import { TEXT_MAX_BYTES, utf8Length } from '../launch/launch-model';
import { withQuote } from '../feed/reply';

export const FIVE_MIN = 5 * 60 * 1000;

// ---- mentions ----

/** An agent that can be mentioned: id and the label the window shows. */
export interface Mentionable {
  id: string;
  label: string;
  /** `model · state` line of the menu (`mentionMeta`). */
  meta: string;
}

/** The `@word` being typed at the end of the text; `null` — none. */
export function mentionQuery(text: string): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(text);
  return m === null ? null : { start: text.length - m[2]!.length - 1, query: m[2]! };
}

/** Agents whose label contains the query (case-insensitive); empty query — everyone. */
export function filterMentionable(list: readonly Mentionable[], query: string): Mentionable[] {
  const q = query.trim().toLowerCase();
  return q === '' ? [...list] : list.filter((a) => a.label.toLowerCase().includes(q));
}

/** The typed `@query` becomes the chip `@Label ` (a trailing space so typing goes on). */
export function insertMention(text: string, label: string): string {
  const q = mentionQuery(text);
  const head = q === null ? text : text.slice(0, q.start);
  return `${head}@${label} `;
}

/** The chip is a text `@Label`: a chip whose text was edited away is no longer a recipient (the window's rule). */
export function recipientsOf(text: string, chips: readonly Mentionable[]): Mentionable[] {
  const seen = new Set<string>();
  return chips.filter((c) => {
    if (seen.has(c.id) || !new RegExp(`(^|\\s)@${escapeRe(c.label)}(?=$|[\\s.,;:!?])`).test(text)) return false;
    seen.add(c.id);
    return true;
  });
}
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "To everyone" / "To Greta, Critic-A1". */
export const toLine = (names: readonly string[]): string => (names.length === 0 ? 'To everyone' : `To ${names.join(', ')}`);

export const COMPOSER_PLACEHOLDER = 'Write to everyone · type @ to mention an agent';

// ---- the room's header ----

export interface RoomHeader {
  /** `decision` — a decision waits; `needs-you` — a member waits for the person; `working` — N working; `idle`. */
  state: 'decision' | 'needs-you' | 'working' | 'idle';
  word: string;
  subtitle: string;
}

export function roomHeader(room: RemoteRoom, members: readonly RemoteSession[], waiting: number, working: number, leadLabel: string | null): RoomHeader {
  const state = room.proposal !== null ? 'decision' : waiting > 0 ? 'needs-you' : working > 0 ? 'working' : 'idle';
  const word = state === 'decision' ? 'Decision' : state === 'needs-you' ? 'Needs you' : state === 'working' ? `${working} working` : 'Idle';
  const parts = [`${members.length} agent${members.length === 1 ? '' : 's'}`, ...(leadLabel === null ? [] : [`lead ${leadLabel}`]), room.mode ?? 'free'];
  return { state, word, subtitle: `${word} · ${parts.join(' · ')}` };
}

// ---- the history ----

export interface Line {
  message: Message;
  /** The header (avatar, name, time) is shown: not a continuation of the previous sender within 5 minutes. */
  header: boolean;
}

/** Messages in order with the "same sender within 5 minutes" grouping. Deleted letters and system lines never group. */
export function lines(messages: readonly Message[]): Line[] {
  return messages.map((message, i) => {
    const prev = messages[i - 1];
    const same = prev !== undefined && prev.from === message.from && message.from !== 'system' && Date.parse(message.at) - Date.parse(prev.at) <= FIVE_MIN && JSON.stringify(prev.to) === JSON.stringify(message.to);
    return { message, header: !same };
  });
}

/** Recipients of a human letter: the named ones, or every member. */
export function recipientIds(message: Message, memberIds: readonly string[]): string[] {
  return message.to.length > 0 ? message.to : [...memberIds];
}

/** "✓ Picked up by Greta, Critic-A1" / "▤ Not picked up yet by Greta" under the last own letter; `null` — nothing to say. */
export function deliveryLine(message: Message, memberIds: readonly string[], labelOf: (id: string) => string): string | null {
  if (message.from !== 'human') return null;
  const ids = recipientIds(message, memberIds).filter((id) => id !== 'human');
  if (ids.length === 0) return null;
  const done = ids.filter((id) => message.readBy[id] !== undefined).map(labelOf);
  const left = ids.filter((id) => message.readBy[id] === undefined).map(labelOf);
  if (left.length === 0) return `✓ Picked up by ${done.join(', ')}`;
  return `▤ Not picked up yet by ${left.join(', ')}`;
}

/** The first words of the quoted letter for the reply line. */
export function quote(text: string, max = 80): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// ---- the composer ----

export type RoomComposer =
  | { kind: 'input'; sendEnabled: boolean; note: string | null }
  | { kind: 'hidden'; text: string };

export function roomComposer(room: Pick<RemoteRoom, 'mode' | 'archived'>, hasSend: boolean, online: boolean): RoomComposer {
  if (!hasSend) return { kind: 'hidden', text: 'Messaging agents from the phone is turned off on your Mac' };
  if (room.mode === 'autonomous') return { kind: 'hidden', text: 'This room runs on its own — write to it on your Mac' };
  if (room.archived) return { kind: 'hidden', text: 'This room is archived' };
  return { kind: 'input', sendEnabled: online, note: online ? null : 'Reconnecting — actions are paused' };
}

export function letterProblem(text: string): string | null {
  if (text.trim() === '') return 'Write a message';
  if (utf8Length(text) > TEXT_MAX_BYTES) return 'Too long for one message — 16 KB max';
  return null;
}

// ---- the send ----

export type RoomSendUi =
  | { kind: 'sent'; messageId: string }
  /** The host refused or the call never went: the text comes back to the field. */
  | { kind: 'refused'; message: string; hideComposer: boolean }
  /** The answer was lost and the re-read did not find the letter. */
  | { kind: 'not-sent'; message: string };

export function uiOfRoomSend(o: SendRoomMessageOutcome): RoomSendUi {
  if (o.outcome === 'sent') return { kind: 'sent', messageId: o.messageId };
  if (o.outcome === 'rejected') {
    if (o.code === 'unknown_method') return { kind: 'refused', message: 'Not sent — messaging from the phone is turned off on your Mac', hideComposer: true };
    return { kind: 'refused', message: `Not sent — ${o.message.trim() === '' ? o.code : o.message}`, hideComposer: false };
  }
  return { kind: 'not-sent', message: 'Not sent · Retry' };
}

export interface RoomTarget {
  projectPath: string;
  workId: string;
  roomId: string;
}

/** `rooms.send` as the window does: always a `note`; recipients from `replyRecipients`; the reply links by id. */
export async function sendLetter(
  client: Pick<RemoteClient, 'sendRoomMessage'>,
  room: RoomTarget,
  text: string,
  to: readonly string[],
  replyTo: string | null,
): Promise<RoomSendUi> {
  return uiOfRoomSend(await client.sendRoomMessage({ ...room, text, kind: 'note', to: [...to], ...(replyTo !== null ? { replyTo } : {}) }));
}

/** The room's reply plate: the letter answered, and the fragment picked in the Select Text sheet ('' — none). */
export interface RoomReply {
  message: Message;
  selected: string;
}

/**
 * What `rooms.send` gets: `replyTo` always, and the selected fragment as a `withQuote` block before the text, as the
 * window's RoomPanel does (D1 §9.7). A plain Reply sends the text as typed.
 */
export function roomOutgoing(draft: string, reply: RoomReply | null): { text: string; replyTo: string | null } {
  if (reply === null) return { text: draft, replyTo: null };
  return { text: reply.selected.trim() === '' ? draft : withQuote(reply.selected.trim(), draft), replyTo: reply.message.id };
}

/**
 * Who the letter goes to (sg-28): the chips, and on a Reply also the author of the quoted letter while they are still a
 * member and not named already, as the window's RoomPanel `handleSend` does. The human's own letter adds nobody: the
 * human is not in `members`.
 */
export function replyRecipients(to: readonly string[], reply: RoomReply | null, memberIds: readonly string[]): string[] {
  const author = reply?.message.from;
  return author !== undefined && memberIds.includes(author) && !to.includes(author) ? [...to, author] : [...to];
}
