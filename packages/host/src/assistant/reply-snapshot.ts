/**
 * Снимок ответа сессии для служебного сообщения (спека автономии §6.3, «Снимок»): в момент события хост закрепляет
 * содержимое, а не ссылку. Чистые функции: лента и журнал писем приходят снаружи.
 */

import type { FeedItem } from '@parley/core';
import type { WatchEvent } from './reply-watch.js';

/** Ответ длиннее этого режется: первые `REPLY_HEAD` и последние `REPLY_TAIL` знаков (вывод обычно в конце). */
export const REPLY_LIMIT = 6000;
export const REPLY_HEAD = 1500;
export const REPLY_TAIL = 4500;
/** Знаков содержимого ждущей карточки и последнего письма. */
export const CARD_LIMIT = 1500;
/**
 * Запись текста может лечь в ленту чуть позже `Stop`: текст относится к ходу, если появился не позже конца хода
 * плюс этот запас. Следующий ход начинается записью `prompt`, она обрезает окно раньше.
 */
export const TURN_SLACK_MS = 2000;

export const UNREADABLE_NOTE = 'the reply could not be read';
export const NO_TEXT_NOTE = 'the turn left no text reply';

/** Закреплённое содержимое события слежения: на нём стоят пересказчик (W3) и служебное сообщение (W2). */
export interface ReplySnapshot {
  event: WatchEvent['event'];
  /** Ключ события (`WatchEvent.key`). */
  key: string;
  /** Имя сессии для человека. */
  session: string;
  /** `turn-end`: текст ответа хода (при длине больше `REPLY_LIMIT` — с отметкой пропуска). */
  reply: string | null;
  /** `turn-end`: почему текста нет (`UNREADABLE_NOTE`, `NO_TEXT_NOTE`); иначе `null`. */
  replyNote: string | null;
  /** `needs-human`: вид ожидания и ждущая карточка. */
  waiting: { kind: string; detail: string | null; card: { type: 'permission' | 'question' | 'plan'; text: string } | null } | null;
  /** Последнее письмо помощника этой сессии; `null` — писем нет. */
  lastLetter: string | null;
}

/** Правило длины: до `REPLY_LIMIT` как есть; иначе голова, отметка пропуска, хвост. */
export function clipReply(text: string): string {
  if (text.length <= REPLY_LIMIT) return text;
  const omitted = text.length - REPLY_HEAD - REPLY_TAIL;
  return `${text.slice(0, REPLY_HEAD)}\n[… ${omitted} characters omitted …]\n${text.slice(text.length - REPLY_TAIL)}`;
}

const at = (item: FeedItem): number => Date.parse(item.at);

/** Текст ответа хода: последний завершённый `text` после границы и до конца хода (не дальше следующего `prompt`). */
export function turnReply(items: readonly FeedItem[], boundary: number, turnEndedAt: number): string | null {
  let found: string | null = null;
  for (const item of items) {
    const time = at(item);
    if (Number.isNaN(time) || time <= boundary) continue;
    if (item.kind === 'prompt') break;
    if (time > turnEndedAt + TURN_SLACK_MS) break;
    if (item.kind === 'text' && !item.streaming && item.text.trim() !== '') found = item.text;
  }
  return found;
}

const cut = (text: string): string => (text.length <= CARD_LIMIT ? text : `${text.slice(0, CARD_LIMIT)}…`);

/** Ждущая карточка сессии: последняя `pending` из ленты; вид и содержимое одной строкой-двумя. */
export function waitingCard(items: readonly FeedItem[]): { type: 'permission' | 'question' | 'plan'; text: string } | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined || (item.kind !== 'permission' && item.kind !== 'question' && item.kind !== 'plan') || item.state !== 'pending') continue;
    if (item.kind === 'permission') return { type: 'permission', text: cut(`${item.toolName} ${JSON.stringify(item.toolInput)}`) };
    if (item.kind === 'question') {
      const text = item.questions.map((q) => `${q.question}${q.options.length === 0 ? '' : ` [${q.options.map((option) => option.label).join(' | ')}]`}`).join('\n');
      return { type: 'question', text: cut(text) };
    }
    return { type: 'plan', text: cut(item.plan) };
  }
  return null;
}

/**
 * Сборка снимка. `items` — лента сессии на момент события; `null` — лента недоступна. `sent` — журнал писем помощника
 * этой сессии (`readSent`), порядок старые первыми.
 */
export function buildReplySnapshot(input: { event: WatchEvent; items: readonly FeedItem[] | null; sent: ReadonlyArray<{ text: string }> }): ReplySnapshot {
  const { event, items, sent } = input;
  const last = sent.at(-1)?.text;
  const base = { event: event.event, key: event.key, session: event.name, lastLetter: last === undefined ? null : cut(last) };
  if (event.event === 'needs-human') {
    const need = event.need;
    return { ...base, reply: null, replyNote: null, waiting: need === undefined ? null : { kind: need.kind, detail: need.detail, card: items === null ? null : waitingCard(items) } };
  }
  if (items === null) return { ...base, reply: null, replyNote: UNREADABLE_NOTE, waiting: null };
  const reply = turnReply(items, event.boundary, event.turnEndedAt ?? event.boundary);
  return { ...base, reply: reply === null ? null : clipReply(reply), replyNote: reply === null ? NO_TEXT_NOTE : null, waiting: null };
}
