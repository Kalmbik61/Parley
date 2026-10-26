import type { FeedQuestion } from '@parley/core';

export interface QuestionAnswerDraft {
  picked: Readonly<Record<number, readonly string[]>>;
  otherOn: Readonly<Record<number, boolean>>;
  otherText: Readonly<Record<number, string>>;
}

/** Ответ на вопрос `at`; пустая строка — ответа ещё нет. Общий wire-формат чата и острова. */
export function answerOf(question: FeedQuestion, at: number, draft: QuestionAnswerDraft): string {
  const labels = draft.picked[at] ?? [];
  const otherOn = draft.otherOn[at] === true;
  const other = (draft.otherText[at] ?? '').trim();
  if (!question.multiSelect) return otherOn ? other : (labels[0] ?? '');
  return [...labels, ...(otherOn && other !== '' ? [other] : [])].join(', ');
}
