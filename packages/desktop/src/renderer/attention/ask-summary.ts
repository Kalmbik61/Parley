/**
 * Сводка вопроса, на котором стоит сессия «нужен ты»: что именно просят разрешить, спросить или одобрить —
 * строка для тела уведомления macOS (`notify.ts`). Чистые функции без сторов: на вход — снимок ленты
 * (`feed.snapshot`), на выход — id карточки (цель клика) и короткий текст. Длину не режет: это делает `send()`.
 */

// Подпуть, а не корень: корневой индекс грузит модули только для Node, и тесты в jsdom падают.
import { cardGist, pendingCards } from '@parley/core/card-gist';
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

export function askSummary(card: FeedCard, projectPath: string): string {
  const gist = cardGist(card, projectPath);
  switch (gist.kind) {
    case 'plan': return S.notifications.askPlan;
    case 'question': return S.notifications.askQuestion(gist.text);
    case 'run': return S.notifications.askRun(gist.command);
    case 'fetch': return S.notifications.askFetch(gist.url);
    case 'tool': return gist.path === null ? card.toolName : S.notifications.askTool(gist.tool, gist.path);
  }
}

export { pendingCards };

/** Самая поздняя карточка, ждущая ответа; нет такой — `null`. */
export function pendingAskOf(
  snapshot: { items: readonly FeedItem[]; decisions?: FeedDecisions | null },
  projectPath: string,
): PendingAsk | null {
  const card = pendingCards(snapshot.items).at(-1);
  if (card === undefined) return null;
  return { cardId: card.id, summary: askSummary(card, projectPath), inWindow: snapshot.decisions !== 'terminal' };
}
