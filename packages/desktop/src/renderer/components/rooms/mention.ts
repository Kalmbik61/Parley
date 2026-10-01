/**
 * Упоминания в комнате (дизайн комнат, 1.4, 2.2, 2.3) — чистая часть, без DOM: токен `@s02` в тексте
 * письма, условия открытия меню в поле ввода и его фильтр. Поле ввода (`Composer.tsx`,
 * `mention-editor.ts`) и лента (`RoomMarkdown.tsx`) зовут одни и те же функции, чтобы то, что человек
 * видит в поле, и то, что рисует лента, не разошлись.
 */

import { sessionTag } from '../../lib/participant.js';

/** Неразрывный пробел: ставится за чипом, чтобы курсор мог встать между чипом и следующим словом. */
export const NBSP = ' ';

/** Столько знаков после `@` меню ещё терпит; на следующем закрывается (2.3). */
export const MENTION_QUERY_MAX = 24;

/**
 * Вид чипа упоминания (1.4) — один и в поле ввода (нередактируемый узел), и в ленте. Строка классов
 * лежит здесь, а не в двух компонентах: Tailwind читает её как есть, а разойтись им негде. Чип не
 * переносится по словам (`nowrap`), а слишком длинный ярлык обрезается многоточием по ширине колонки:
 * `align-bottom` держит его на строке, когда `overflow: hidden` сдвигает базовую линию.
 */
export const MENTION_CHIP_CLASS =
  'mx-px inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-full bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)] px-[7px] align-bottom font-semibold text-accent-800';

/** `s-02` → `@s02`: так упоминание уходит в тексте письма (2.2). */
export function mentionToken(sessionId: string): string {
  return `@${sessionId.replace('-', '')}`;
}

/** Цифры токена → id сессии: `2` → `s-02`, как у `nextSessionId` core (номер от двух знаков). */
function tokenSessionId(digits: string): string {
  return `s-${digits.padStart(2, '0')}`;
}

export type TextSegment =
  { kind: 'text'; text: string } | { kind: 'mention'; sessionId: string; raw: string };

/**
 * Токен: `@s02` или `@s-02`. Слева — не буква, не цифра и не `@` (иначе `user@s02.example.com` стал бы
 * чипом), справа — не буква и не цифра (`@s02бэкенд` — слово, а не упоминание).
 */
const TOKEN = /(?<![\p{L}\p{N}_@])@s-?(\d+)(?![\p{L}\p{N}_])/giu;

/**
 * Текст → текст и упоминания: то, что нужно полю ввода, когда оно поднимает черновик, и ленте комнаты
 * (`RoomMarkdown.tsx` режет по нему текстовые узлы Markdown).
 */
export function splitMentions(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > last) out.push({ kind: 'text', text: text.slice(last, match.index) });
    out.push({ kind: 'mention', sessionId: tokenSessionId(match[1] as string), raw: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/**
 * Упоминание человека — `@human` (Parley 0.3.0): так агенты обращаются к человеку в комнате. Лента рисует его
 * чипом «@you», окно считает такое сообщение адресованным человеку (`attention/derive.ts`). Границы — те же,
 * что у токена сессии: `user@human.dev` и `@humans` упоминанием не считаются; регистр не важен.
 */
const HUMAN_TOKEN = /(?<![\p{L}\p{N}_@])@human(?![\p{L}\p{N}_])/iu;

/** Токен сессии или человека — одним проходом по всему тексту, чтобы границы `@human` и `mentionsHuman` совпали. */
const FEED_TOKEN = /(?<![\p{L}\p{N}_@])@(?:s-?(\d+)|(human))(?![\p{L}\p{N}_])/giu;

/** В тексте есть упоминание человека `@human`. */
export function mentionsHuman(text: string): boolean {
  return HUMAN_TOKEN.test(text);
}

export type FeedSegment = TextSegment | { kind: 'human'; raw: string };

/**
 * Текст ленты → текст, упоминания сессий и упоминания человека. Поле ввода человека зовёт `splitMentions`:
 * там `@human` остаётся текстом — себя человек не упоминает.
 */
export function splitFeedMentions(text: string): FeedSegment[] {
  const out: FeedSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(FEED_TOKEN)) {
    if (match.index > last) out.push({ kind: 'text', text: text.slice(last, match.index) });
    const digits = match[1];
    out.push(
      digits === undefined
        ? { kind: 'human', raw: match[0] }
        : { kind: 'mention', sessionId: tokenSessionId(digits), raw: match[0] },
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/**
 * Меню упоминаний открыто, когда перед курсором стоит `@` — в начале строки или после пробела или
 * переноса — и за ним до 24 знаков без пробела (2.3). `beforeCaret` — текст узла до курсора.
 * `@` в середине слова и в email (`user@example`) меню не открывает.
 */
export function findMentionQuery(beforeCaret: string): { start: number; query: string } | null {
  const start = beforeCaret.lastIndexOf('@');
  if (start < 0) return null;
  const query = beforeCaret.slice(start + 1);
  if (query.length > MENTION_QUERY_MAX || /\s/.test(query)) return null;
  const previous = start === 0 ? '' : (beforeCaret[start - 1] as string);
  // `\s` в JS берёт и неразрывный пробел, и перенос.
  if (previous !== '' && !/\s/.test(previous)) return null;
  return { start, query };
}

/** То, по чему меню фильтруется, — из участника комнаты. */
export interface MentionCandidate {
  id: string;
  /** Ярлык сессии без номера (`бэкенд`). */
  rawLabel: string;
  /** Имя провайдера (`Claude Code`). */
  providerName: string;
  /** Модель сессии (`Opus 5.5`); `null` — неизвестна, в поиск не попадает. */
  model: string | null;
}

/** Фильтр меню — подстрока без учёта регистра в `S02 s02 {ярлык} {провайдер} {модель}` (2.3). */
export function filterMentions<T extends MentionCandidate>(candidates: readonly T[], query: string): T[] {
  const needle = query.toLowerCase();
  if (needle === '') return [...candidates];
  return candidates.filter((candidate) =>
    [sessionTag(candidate.id), candidate.id.replace('-', ''), candidate.rawLabel, candidate.providerName, candidate.model ?? '']
      .join(' ')
      .toLowerCase()
      .includes(needle),
  );
}
