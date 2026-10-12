/**
 * Сводка вопроса, на котором стоит сессия «нужен ты»: что именно просят разрешить, спросить или одобрить —
 * строка для тела уведомления macOS (`notify.ts`). Чистые функции без сторов: на вход — снимок ленты
 * (`feed.snapshot`), на выход — id карточки (цель клика) и короткий текст. Длину не режет: это делает `send()`.
 */

import type { FeedCard, FeedItem } from '@parley/core';
import type { FeedDecisions } from '@parley/protocol';
import { S } from '../../shared/strings.js';

export interface PendingAsk {
  /** `id` карточки в ленте: клик по уведомлению ведёт к ней. */
  cardId: string;
  summary: string;
  /**
   * Ответить можно в окне. Codex с одобрениями в терминале (`decisions: 'terminal'`) окну не отвечает —
   * вести в Chat бесполезно, цель остаётся просто сессией.
   */
  inWindow: boolean;
}

/** Первая непустая строка: команда или вопрос бывают многострочными. */
function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? '';
}

/** Путь внутри проекта — относительно него (с учётом хвостового `/`), иначе как есть. */
function shownPath(path: string, projectPath: string): string {
  const root = projectPath.replace(/\/+$/, '');
  return root !== '' && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function isCard(item: FeedItem): item is FeedCard {
  return item.kind === 'permission' || item.kind === 'question' || item.kind === 'plan';
}

export function askSummary(card: FeedCard, projectPath: string): string {
  if (card.kind === 'plan') return S.notifications.askPlan;
  if (card.kind === 'question') return S.notifications.askQuestion(firstLine(card.questions[0]?.question ?? ''));
  const input = card.toolInput;
  // Команда Claude — строка, Codex присылает argv массивом.
  const command = Array.isArray(input.command) && input.command.every((part) => typeof part === 'string')
    ? input.command.join(' ')
    : input.command;
  if (typeof command === 'string') return S.notifications.askRun(firstLine(command));
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const path = input[key];
    if (typeof path === 'string') return S.notifications.askTool(card.toolName, shownPath(path, projectPath));
  }
  if (typeof input.url === 'string') return S.notifications.askFetch(input.url);
  return card.toolName;
}

/** Самая поздняя карточка, ждущая ответа; нет такой — `null`. */
export function pendingAskOf(
  snapshot: { items: readonly FeedItem[]; decisions?: FeedDecisions | null },
  projectPath: string,
): PendingAsk | null {
  const card = snapshot.items.findLast((item): item is FeedCard => isCard(item) && item.state === 'pending');
  if (card === undefined) return null;
  return { cardId: card.id, summary: askSummary(card, projectPath), inWindow: snapshot.decisions !== 'terminal' };
}
