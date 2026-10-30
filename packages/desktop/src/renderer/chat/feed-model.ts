/**
 * Чистые выводы из ленты для вида «Chat» (план 2026-10-01, Task 3): идёт ли ход, какая модель, как
 * назвать вызов инструмента одной строкой. Ни React, ни моста — только элементы ленты.
 */

import type { FeedAgent, FeedItem, WorkSession } from '@parley/core';
import { S } from '../../shared/strings.js';

/**
 * Идёт ли ход — правило общее с хостом (сев закрывает ход, оборванный в журнале), поэтому живёт в core
 * (`feed/turn.ts`); отдельный вход пакета — чтобы окно не тянуло за ним файловые модули core. Карточки
 * субагентов в счёт не идут: пока сессию держат одни фоновые агенты (`heldByBackground`), родитель стоит у
 * приглашения — Stop не нужен, ввод открыт.
 */
export { turnActive } from '@parley/core/feed-turn';

/** Карточки субагентов, что ещё работают, — «N agents running» в тулбаре; порядок ленты. */
export function runningAgents(items: readonly FeedItem[]): FeedAgent[] {
  return items.filter((item): item is FeedAgent => item.kind === 'agent' && item.status === 'running');
}

/** В ленте есть карточка, ждущая решения человека (состояние `pending`). */
export function hasPendingCard(items: readonly FeedItem[]): boolean {
  return items.some((item) => 'cardId' in item && item.state === 'pending');
}

/** Модель сессии — из последнего `notice` старта сессии или смены модели; нет — `null`. */
export function currentModel(items: readonly FeedItem[]): string | null {
  for (let at = items.length - 1; at >= 0; at -= 1) {
    const item = items[at]!;
    if (item.kind !== 'notice') continue;
    const notice = item.notice;
    if (notice.type === 'session-start' && notice.model !== null) return notice.model;
    if (notice.type === 'model-switch' && notice.to !== null) return notice.to;
  }
  return null;
}

export interface ToolHeadline {
  /** Имя для строки: `Bash`, `Edit`; у MCP — `сервер · инструмент`. */
  name: string;
  /** Сводка: команда `Bash`, путь `Edit`/`Write`/`Read`; нет — `null`. */
  summary: string | null;
}

const MCP = /^mcp__(.+?)__(.+)$/;
const PATH_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'Read', 'NotebookEdit', 'Delete', 'ViewImage']);

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Строка вызова: `Bash` — команда, `Edit`/`Write`/`Read` — путь, MCP — сервер и инструмент, прочее — имя. */
export function toolHeadline(name: string, input: Record<string, unknown>): ToolHeadline {
  const mcp = MCP.exec(name);
  if (mcp !== null) return { name: `${mcp[1]} · ${mcp[2]}`, summary: null };
  if (name === 'Bash') return { name, summary: stringField(input, 'command') };
  if (PATH_TOOLS.has(name)) return { name, summary: stringField(input, 'file_path') ?? stringField(input, 'notebook_path') };
  return { name, summary: null };
}

/** Высота одной строки ряда миниатюр под вызовом (`ToolImages`): рамка 120 px и зазор между строками 8 px. */
const THUMB_LINE_PX = 128;
/** Сколько миниатюр помещается в строку ряда в узком окне (800 px): ряд из шести переносится на три строки. */
const THUMBS_PER_LINE = 2;

/**
 * На сколько вызов с картинками (`response.images`) выше обычной строки, px: виртуальная лента оценивает высоту строки до
 * замера, и оценка 56 px для строки с рядом миниатюр (170–430 px) заставляла полосу прокрутки прыгать, пока строки
 * измеряются. Оценка грубая — по две миниатюры в строке; точную высоту потом даёт замер.
 */
export function imagesExtraPx(item: FeedItem): number {
  if (item.kind !== 'tool') return 0;
  const count = item.response?.images?.length ?? 0;
  return Math.ceil(count / THUMBS_PER_LINE) * THUMB_LINE_PX;
}

/** Первая непустая строка текста — сводка плана в карточке. */
export function firstLine(text: string): string | null {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '');
  return line === undefined ? null : line.trim();
}

/** Разделитель ленты в момент замены агента сессии (спека 2026-10-30, 5.7). */
export interface SwitchDivider {
  id: string;
  /** Момент замены — `endedAt` записи `previousAgents`. */
  at: string;
  text: string;
}

function clock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/**
 * По разделителю на запись `previousAgents`. Новый провайдер записи i — провайдер записи i+1, у последней — текущий
 * провайдер сессии; `label` даёт подпись провайдера по id.
 */
export function switchDividers(
  session: Pick<WorkSession, 'provider' | 'model' | 'previousAgents'>,
  label: (providerId: string) => string,
): SwitchDivider[] {
  const previous = session.previousAgents ?? [];
  return previous.map((binding, index) => {
    const next = previous[index + 1];
    const to = next === undefined ? { provider: session.provider, model: session.model ?? null } : next;
    const reason =
      binding.reason === 'limit'
        ? S.chat.switchDivider.limit
        : binding.reason === 'sign-in'
          ? S.chat.switchDivider.signIn
          : binding.reason === 'provider-missing'
            ? S.chat.switchDivider.providerMissing
            : binding.reason === 'model'
              ? S.chat.switchDivider.model
              : S.chat.switchDivider.manual(binding.requestedBy === 'human' ? S.chat.switchDivider.you : `@${binding.requestedBy.replace('-', '')}`);
    return {
      id: `switch:${index}:${binding.endedAt}`,
      at: binding.endedAt,
      text: S.chat.switchDivider.text(label(to.provider), to.model, clock(binding.endedAt), label(binding.provider), reason),
    };
  });
}
