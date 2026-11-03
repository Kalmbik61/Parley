// Question-card drafts kept per pending card for the life of the app, so leaving the session screen and coming back
// keeps the picks and the step (the window keeps `CardDraft` per card in `ui-store`). Subscribable, so two copies of one
// card stay in sync. No React.
import { EMPTY_QUESTION_DRAFT, type QuestionDraft } from './model';

const drafts = new Map<string, QuestionDraft>();
const listeners = new Set<() => void>();
const notify = (): void => listeners.forEach((l) => l());

/** `sessionKey(ref)` of the app plus the card id. */
export const draftKey = (sessionKeyOf: string, cardId: string): string => `${sessionKeyOf}\u0000${cardId}`;

export const subscribeQuestionDrafts = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
export const readQuestionDraft = (key: string): QuestionDraft => drafts.get(key) ?? EMPTY_QUESTION_DRAFT;
/** A real functional update against the stored draft. */
export function updateQuestionDraft(key: string, f: (x: QuestionDraft) => QuestionDraft): void {
  drafts.set(key, f(readQuestionDraft(key)));
  notify();
}
/** Developer preview: sets a draft only when there is none, without notifying (called while rendering). */
export function seedQuestionDraft(key: string, draft: QuestionDraft): void {
  if (!drafts.has(key)) drafts.set(key, draft);
}
export function dropQuestionDraft(key: string): void {
  if (drafts.delete(key)) notify();
}
/** The card settled elsewhere (answered at the Mac, stale, gone): keep only the drafts of `pending` cards of this session. */
export function pruneQuestionDrafts(sessionKeyOf: string, pendingCardIds: readonly string[]): void {
  const prefix = `${sessionKeyOf}\u0000`;
  const keep = new Set(pendingCardIds.map((id) => draftKey(sessionKeyOf, id)));
  let changed = false;
  for (const key of [...drafts.keys()]) {
    if (key.startsWith(prefix) && !keep.has(key)) {
      drafts.delete(key);
      changed = true;
    }
  }
  if (changed) notify();
}
/** The host was removed: nothing typed for it may outlive its keys. */
export function clearQuestionDrafts(): void {
  if (drafts.size === 0) return;
  drafts.clear();
  notify();
}
