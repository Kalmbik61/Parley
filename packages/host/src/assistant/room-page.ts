/**
 * Комната целиком для помощника (спека 2026-10-28, 5.2): шапка как у `detailText` и письма полным текстом, страницами
 * от новых к старым. Чистая функция: сами письма отдаёт `LetterPage`, сервис кладёт в неё `readLetters`. Курсор —
 * число из id самого старого показанного письма (`m-12` → `before=12`).
 */

import { participantLabel, type Message, type WorkEntry } from '@parley/core';
import { roomHeader, type AssistantTarget, type OverviewSource } from './overview.js';

/** Страница писем комнаты от новых к старым; `beforeSeq` — письма строго старше этого номера. */
export type LetterPage = (entry: WorkEntry, roomId: string, query: { beforeSeq?: number; limit: number }) => readonly Message[];

export const ROOM_PAGE = 30;
export const ROOM_PAGE_MAX = 50;
/** Письмо длиннее этого обрезается до `LETTER_MAX - 1` знака и «…». */
export const LETTER_MAX = 4000;
/** Мягкий бюджет страницы в знаках текста писем: письма идут от новых, пока текст влезает. */
export const PAGE_BUDGET = 40_000;

const BEGINNING = 'This is the beginning of the room.';
const seqOf = (message: Message): number => Number(/(\d+)$/.exec(message.id)?.[1]);
const clipLetter = (text: string): string => (text.length > LETTER_MAX ? `${text.slice(0, LETTER_MAX - 1)}…` : text);

export function roomPageText(
  source: OverviewSource,
  target: Extract<AssistantTarget, { kind: 'room' }>,
  page: { before?: number; limit?: number },
  read: LetterPage,
): string {
  const entry = source.entries.find((item) => item.projectPath === target.projectPath && item.map.work.id === target.workId);
  const room = entry?.map.rooms.find((item) => item.id === target.roomId);
  if (entry === undefined || room === undefined) return `${target.name} is no longer in Parley.`;
  const requested = page.limit !== undefined && Number.isFinite(page.limit) ? Math.trunc(page.limit) : ROOM_PAGE;
  const limit = Math.min(Math.max(requested, 1), ROOM_PAGE_MAX);
  // На одно письмо больше, чем нужно: лишнее значит, что за страницей есть старые.
  const fetched = read(entry, room.id, page.before === undefined ? { limit: limit + 1 } : { beforeSeq: page.before, limit: limit + 1 });
  const wanted = fetched.slice(0, limit);
  const shown: Array<{ message: Message; text: string }> = [];
  let used = 0;
  for (const message of wanted) {
    const text = clipLetter(message.text);
    if (shown.length > 0 && used + text.length > PAGE_BUDGET) break;
    used += text.length;
    shown.push({ message, text });
  }
  const hasOlder = fetched.length > limit || shown.length < wanted.length;
  const lines = roomHeader(source, entry, room.id, target.where);
  if (shown.length === 0) {
    // Страница пуста: у комнаты вовсе нет писем или курсор уже стоит на самом старом.
    if (page.before === undefined) lines.push('No messages yet.');
    lines.push(BEGINNING);
    return lines.join('\n');
  }
  lines.push('Messages, oldest first:');
  for (const { message, text } of [...shown].reverse()) {
    lines.push(`[${message.id} · ${message.at} · ${participantLabel(entry.map, message.from)} · ${message.kind}]`, text);
  }
  const oldest = shown[shown.length - 1]!.message;
  lines.push(hasOlder ? `Older messages: call parley_room with before=${seqOf(oldest)}` : BEGINNING);
  return lines.join('\n');
}
