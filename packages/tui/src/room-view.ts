/**
 * Вид комнаты: вся переписка работы одной лентой (дизайн комнаты 2026-09-23,
 * раздел 5). В отличие от `threadView` комната не смотрит на выбранную
 * сессию — она берёт все письма работы и участников из всех сессий сразу.
 *
 * Здесь только текст: ни Ink, ни файловой системы, ни состояния — рисует эти
 * строки `components/room.tsx`, прокрутку держит `use-room.ts`.
 */

import {
  isUnreadFor,
  modelName,
  recipientsOf,
  sessionTag,
  type Message,
  type MessageKind,
  type WorkEntry,
  type WorkMap,
} from '@harnas/core';
import { formatClock, wrapText } from './format.js';
import type { Glyphs } from './glyphs.js';
import { registryEntry, treeOrder } from './work-rows.js';

/** Отступ продолжения переноса в блоке решений. */
const INDENT = '  ';

/** Сколько последних решений видно; старше — одной строкой «+N раньше». */
const DECISIONS_SHOWN = 5;

/**
 * Строк на решение в блоке сверху. Решения агентов — абзацы на десяток строк
 * (живой прогон w-0010): целиком два таких занимали весь экран и ещё раз
 * повторялись в ленте. Сверху — начало с многоточием, полный текст — в ленте.
 */
const DECISION_ROWS = 2;

/**
 * Подпись участника комнаты (дизайн комнаты, 4): известная сессия —
 * `S03 (Codex)`, где имя модели берётся из `modelOf`, а если модель неизвестна
 * (сессия ещё не писала, провайдер логов не отдаёт) — подпись провайдера из
 * реестра, а если провайдер и в реестре не найден — его сырой id. Удалённая
 * сессия — `S02 (удалена)`, чужой id — как есть.
 */
export function participantTag(
  map: WorkMap,
  id: string,
  modelOf: (id: string) => string | null,
): string {
  const session = map.sessions.find((candidate) => candidate.id === id);
  if (session === undefined) {
    return (map.work.deletedSessions ?? []).includes(id) ? `${sessionTag(id)} (удалена)` : id;
  }
  const name = modelName(modelOf(id)) ?? registryEntry(session.provider)?.label ?? session.provider;
  return `${sessionTag(id)} (${name})`;
}

/** Число писем словом: 1 письмо, 2 письма, 5 писем, 11 писем, 21 письмо, 22 письма. */
function mailWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'письмо';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'письма';
  return 'писем';
}

/** Вид письма словом в заголовке строки: у заметки его нет (5.3). */
function kindSuffix(kind: MessageKind): string {
  if (kind === 'question') return ' · вопрос';
  if (kind === 'decision') return ' · решение';
  return '';
}

/**
 * Абзац решения с переносом: первая строка с меткой, продолжения — с отступом
 * на её ширину.
 */
function paragraph(mark: string, text: string, width: number, g: Glyphs): string[] {
  return wrapText(text, width - INDENT.length, Number.POSITIVE_INFINITY, g.ellipsis).map(
    (row, at) => `${at === 0 ? mark : INDENT}${row}`,
  );
}

/** Строка ленты комнаты: тон заменяет `dim` — прочитанность строки не гасит (5.3). */
export interface RoomLine {
  text: string;
  tone: 'head' | 'body' | 'muted';
  /** Непрочитанное адресатом письмо — знак рисует компонент, не текст. */
  mark?: 'unseen';
  /** Горизонтальная линейка под блоком решений. */
  rule?: boolean;
}

export interface RoomViewOptions {
  entry: WorkEntry;
  /** Ширина ленты. */
  width: number;
  /** Строк на экране. */
  height: number;
  /** Смещение от начала ленты; `null` — держаться хвоста. */
  scroll: number | null;
  g: Glyphs;
  /** Модель сессии по индексу логов; core о нём не знает. */
  modelOf: (id: string) => string | null;
}

export interface RoomView {
  /** «комната · N писем» с верным числительным (5.1). */
  title: string;
  /** Письма работы, которые адресат ещё не забрал. */
  unread: number;
  /** Строки, уже нарезанные под `height`. */
  lines: RoomLine[];
  /** Сколько строк ниже окна, когда пользователь ушёл вверх. */
  below: number;
  /** Полная высота ленты — по ней считает шаг прокрутка. */
  total: number;
}

export function roomView({ entry, width, height, scroll, g, modelOf }: RoomViewOptions): RoomView {
  const map = entry.map;
  const tag = (id: string): string => participantTag(map, id, modelOf);
  // Письмо непрочитано, пока его не прочёл хоть один адресат.
  const unseen = (message: Message): boolean =>
    recipientsOf(message, map).some((id) => isUnreadFor(message, id, map));
  const messages = [...map.messages].sort((a, b) => a.at.localeCompare(b.at));
  const lines: RoomLine[] = [];

  // Первая строка тела — участники: сессии, встреченные хотя бы в одном письме
  // отправителем или адресатом, в порядке сайдбара; удалённые не считаются —
  // их уже нет в `map.sessions`, а `treeOrder` смотрит только туда.
  const seen = new Set<string>();
  for (const message of map.messages) {
    seen.add(message.from);
    for (const id of recipientsOf(message, map)) seen.add(id);
  }
  const participants = treeOrder(map.sessions)
    .map((item) => item.session.id)
    .filter((id) => seen.has(id))
    .map(tag)
    .join(' · ');
  lines.push({ text: participants, tone: 'muted' });

  const decisions = messages.filter((message) => message.kind === 'decision');
  if (decisions.length > 0) {
    lines.push({ text: 'РЕШЕНИЯ', tone: 'head' });
    // Свёрнутые решения старше показанных, поэтому их счёт стоит над ними:
    // лента везде идёт по времени, сверху старое.
    const older = decisions.length - DECISIONS_SHOWN;
    if (older > 0) lines.push({ text: `+${older} раньше`, tone: 'muted' });
    for (const decision of decisions.slice(-DECISIONS_SHOWN)) {
      const text = `${formatClock(decision.at)} ${tag(decision.from)}: «${decision.text}»`;
      const rows = paragraph(`${g.done} `, text, width, g);
      const shown = rows.slice(0, DECISION_ROWS);
      if (rows.length > DECISION_ROWS) {
        const last = shown[DECISION_ROWS - 1] ?? '';
        // Многоточие встаёт в ту же ширину: строка не длиннее ленты.
        shown[DECISION_ROWS - 1] =
          `${last.length >= width ? last.slice(0, width - 1) : last}${g.ellipsis}`;
      }
      for (const row of shown) lines.push({ text: row, tone: 'head' });
    }
    lines.push({ text: '', tone: 'muted', rule: true });
  }

  messages.forEach((message, index) => {
    const fresh = unseen(message);
    const to = recipientsOf(message, map).map(tag).join(', ');
    const head = `${formatClock(message.at)}  ${tag(message.from)} ${g.arrow} ${to}${kindSuffix(
      message.kind,
    )}`;
    // Непрочитанность НЕ гасит письмо (5.3): тон один и тот же для всех писем,
    // непрочитанное отличается только знаком `mark`, который рисует компонент.
    lines.push(fresh ? { text: head, tone: 'head', mark: 'unseen' } : { text: head, tone: 'head' });
    for (const row of wrapText(message.text, width, Number.POSITIVE_INFINITY, g.ellipsis)) {
      lines.push({ text: row, tone: 'body' });
    }
    // Пустая строка между письмами — не после последнего.
    if (index < messages.length - 1) lines.push({ text: '', tone: 'muted' });
  });

  const total = lines.length;
  const room = Math.max(0, height);
  const tail = Math.max(0, total - room);
  // Дальше хвоста прокрутка не пускается: иначе окно вставало бы в пустоту, а
  // `↓N` обещал бы строки, которых нет.
  const start = scroll === null ? tail : Math.min(Math.max(0, scroll), tail);
  const window = lines.slice(start, start + room);

  return {
    title: `комната · ${messages.length} ${mailWord(messages.length)}`,
    unread: messages.filter(unseen).length,
    lines: window,
    below: total - (start + window.length),
    total,
  };
}
