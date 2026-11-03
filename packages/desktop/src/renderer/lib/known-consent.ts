/**
 * Карточки согласия, которые окно и остров умеют показать. Карточка `project-mcp` — только известной версии формы (1,
 * спека 2026-11-02, 7.2): новую форму старый клиент не рисует и в очередь диалогов не ставит, иначе она держала бы
 * «занятый» диалог. О неизвестной версии — одна запись в консоль на карточку.
 */

import type { ConsentCard } from '@parley/protocol';

const warned = new Set<string>();

export function isKnownConsent(card: ConsentCard): boolean {
  if (card.kind !== 'project-mcp' || (card as { version?: unknown }).version === 1) return true;
  const key = `${card.id}:${String((card as { version?: unknown }).version)}`;
  if (!warned.has(key)) {
    warned.add(key);
    console.warn('[parley] consent card with an unknown form is not shown', { id: card.id, kind: card.kind, version: (card as { version?: unknown }).version });
  }
  return false;
}
