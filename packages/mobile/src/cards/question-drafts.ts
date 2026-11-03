// Question-card drafts kept per pending card for the life of the app, so leaving the session screen and coming back
// keeps the picks and the step (the window keeps `CardDraft` per card in `ui-store`). No React.
import { EMPTY_QUESTION_DRAFT, type QuestionDraft } from './model';

const drafts = new Map<string, QuestionDraft>();
const keyOf = (sessionId: string, cardId: string): string => `${sessionId}\u0000${cardId}`;

export const readQuestionDraft = (sessionId: string, cardId: string): QuestionDraft => drafts.get(keyOf(sessionId, cardId)) ?? EMPTY_QUESTION_DRAFT;
export const writeQuestionDraft = (sessionId: string, cardId: string, draft: QuestionDraft): void => void drafts.set(keyOf(sessionId, cardId), draft);
/** The card was answered (or is gone): its draft is not needed any more. */
export const dropQuestionDraft = (sessionId: string, cardId: string): void => void drafts.delete(keyOf(sessionId, cardId));
