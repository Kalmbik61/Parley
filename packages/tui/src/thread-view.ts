/**
 * Вид треда выбранной сессии: заголовок, блок решений и лента писем
 * (спецификация 2026-09-08, 6.2–6.3).
 *
 * Здесь только текст: ни Ink, ни файловой системы, ни состояния — рисует эти
 * строки `components/thread.tsx`, прокрутку держит `use-thread.ts`. Функция
 * одна на оба места показа: док справа от панели и оверлей-запасник на узком
 * терминале видят ровно одни и те же строки (6.1).
 */

import {
  decisionsOf,
  participantLabel,
  threadOf,
  type Message,
  type WorkEntry,
} from '@harnas/core';
import type { OverlayLine } from './components/overlay.js';
import { formatClock, wrapText } from './format.js';
import type { Glyphs } from './glyphs.js';

/** Отступ продолжения переноса; метка первой строки — той же ширины. */
const INDENT = '  ';

/** Сколько последних решений видно; старше — одной строкой «+N раньше» (6.3). */
const DECISIONS_SHOWN = 5;

export interface ThreadViewOptions {
  entry: WorkEntry;
  sessionId: string;
  /** Ширина тела треда, без разделителя. */
  width: number;
  /** Строк на экране. */
  height: number;
  /** Смещение от начала ленты; `null` — держаться хвоста. */
  scroll: number | null;
  g: Glyphs;
}

export interface ThreadView {
  /** «тред · план» у поддерева, «тред · работа» у одинокого корня (6.2). */
  title: string;
  /** Непрочитанные во всём треде: заголовок показывает их числом `▤N`. */
  unread: number;
  /** Строки, уже нарезанные под `height`. */
  lines: OverlayLine[];
  /** Сколько строк ниже окна, когда пользователь ушёл вверх: знак `↓N`. */
  below: number;
  /** Полная высота ленты — по ней считает шаг прокрутка. */
  total: number;
}

/** Знак вида письма в заголовке строки: у заметки его нет (6.3). */
function kindMark(message: Message, g: Glyphs): string {
  if (message.kind === 'question') return ' ?';
  return message.kind === 'decision' ? ` ${g.done}` : '';
}

/**
 * Абзац с переносом: первая строка с меткой, продолжения — с отступом на её
 * ширину. Ничего не обрезается: письмо видно целиком, длинное уходит вниз и
 * достаётся прокруткой (6.3).
 */
function paragraph(mark: string, text: string, width: number, g: Glyphs): string[] {
  return wrapText(text, width - INDENT.length, Number.POSITIVE_INFINITY, g.ellipsis).map(
    (row, at) => `${at === 0 ? mark : INDENT}${row}`,
  );
}

export function threadView({
  entry,
  sessionId,
  width,
  height,
  scroll,
  g,
}: ThreadViewOptions): ThreadView {
  const map = entry.map;
  const thread = threadOf(map, sessionId);
  const label = (id: string): string => participantLabel(map, id);
  const lines: OverlayLine[] = [];

  const decisions = decisionsOf(thread);
  if (decisions.length > 0) {
    lines.push({ text: 'РЕШЕНИЯ' });
    // Свёрнутые решения старше показанных, поэтому их счёт стоит над ними:
    // лента везде идёт по времени, сверху старое.
    const older = decisions.length - DECISIONS_SHOWN;
    if (older > 0) lines.push({ text: `+${older} раньше`, dim: true });
    for (const decision of decisions.slice(-DECISIONS_SHOWN)) {
      const text = `${formatClock(decision.at)} ${label(decision.from)}: «${decision.text}»`;
      for (const row of paragraph(`${g.done} `, text, width, g)) lines.push({ text: row });
    }
    lines.push({ text: '', rule: true });
  }

  if (thread.messages.length === 0) lines.push({ text: 'писем пока нет', dim: true });
  for (const message of thread.messages) {
    const fresh = message.readAt === null;
    const head = `${formatClock(message.at)} ${label(message.from)} ${g.arrow} ${label(
      message.to,
    )}${kindMark(message, g)}`;
    const rows = [
      // Конверт стоит перед временем непрочитанного, как бейдж сайдбара (6.3).
      ...paragraph(fresh ? `${g.mail} ` : '', head, width, g),
      ...paragraph(INDENT, message.text, width, g),
    ];
    // Непрочитанное ярче прочитанного — тем же правилом, что в деталях (6.3).
    for (const row of rows) lines.push({ text: row, dim: !fresh });
  }

  const total = lines.length;
  const room = Math.max(0, height);
  const tail = Math.max(0, total - room);
  // Дальше хвоста прокрутка не пускается: иначе окно вставало бы в пустоту, а
  // `↓N` обещал бы строки, которых нет.
  const start = scroll === null ? tail : Math.min(Math.max(0, scroll), tail);
  const window = lines.slice(start, start + room);

  return {
    title: thread.owner === null ? 'тред · работа' : `тред · ${label(thread.owner)}`,
    unread: thread.messages.filter((message) => message.readAt === null).length,
    lines: window,
    below: total - (start + window.length),
    total,
  };
}
