/**
 * Карточка вопроса агента (план 2026-10-01, решение 4, кусок 4a, решение Р): заголовок, текст,
 * варианты с описаниями (одиночный выбор — радио, `multiSelect` — флажки) и пункт «Other» со свободным
 * текстом. Несколько вопросов идут по одному: «Next», на последнем «Submit» шлёт все ответы разом.
 * Ответ — `{ [текст вопроса]: подпись }`; при `multiSelect` подписи через `, `, «Other» — свой текст.
 * Выбранное и набранное — в `ui-store` по карточке (строки ленты размонтируются при прокрутке).
 */

import type { FeedQuestion, FeedQuestionCard, FeedQuestionValue } from '@parley/core';
import { FEED_DECISION_ANSWER_LIMIT, FEED_DECISION_ANSWERS } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { Input } from '../../ui/input.js';
import { answerOf } from '../../lib/question-answer.js';
import { EMPTY_CARD_DRAFT, useChatUiStore, type CardDraft } from '../ui-store.js';
import { CardFrame } from './CardFrame.js';
import { CardNote } from './CardNote.js';
import { useCardDecision } from './use-card-decision.js';

export { answerOf } from '../../lib/question-answer.js';

function settledStatus(item: FeedQuestionCard): string {
  return item.state === 'pending' ? S.chat.waiting : S.chat.cardState[item.state];
}

function readField(question: FeedQuestion, at: number, draft: CardDraft): { valid: boolean; value?: FeedQuestionValue } {
  const field = question.field;
  if (field === undefined) return { valid: false };
  const picked = draft.picked[at] ?? [];
  const text = draft.otherText[at] ?? '';
  const within = (size: number): boolean =>
    (field.min === undefined || size >= field.min) && (field.max === undefined || size <= field.max);
  if (field.type === 'choice' || field.type === 'boolean') {
    if (picked.length === 0) return { valid: !field.required };
    if (field.type === 'boolean') return { valid: true, value: picked[0] === 'true' };
    if (!question.multiSelect) return { valid: true, value: picked[0]! };
    const value = question.options.flatMap((option) => option.value !== undefined && picked.includes(option.value) ? [option.value] : []);
    return { valid: value.length <= FEED_DECISION_ANSWERS && within(value.length), value };
  }
  if (text === '') return { valid: !field.required };
  if (field.type === 'text') return { valid: within([...text].length), value: text };
  const value = Number(text);
  return { valid: Number.isFinite(value) && (field.type !== 'integer' || Number.isInteger(value)) && within(value), value };
}

export function QuestionCard({ item }: { item: FeedQuestionCard }): JSX.Element {
  const { key, deciding, note, decide } = useCardDecision(item.cardId);
  const draft = useChatUiStore((state) => state.cardDrafts[key] ?? EMPTY_CARD_DRAFT);
  if (item.state !== 'pending') {
    const answers = item.answers === undefined ? [] : Object.entries(item.answers);
    return (
      <CardFrame item={item} status={settledStatus(item)}>
        {answers.length === 0 ? undefined : (
          <ul data-testid="card-answers" className="m-0 list-none p-0 text-xs [overflow-wrap:anywhere]">
            {answers.map(([question, answer]) => (
              <li key={question}>{S.chat.card.answer(question, answer)}</li>
            ))}
          </ul>
        )}
      </CardFrame>
    );
  }

  const total = item.questions.length;
  const step = Math.min(draft.step, Math.max(total - 1, 0));
  const question = item.questions[step];
  if (question === undefined) return <CardFrame item={item} status={null} />;
  const last = step === total - 1;
  const set = (patch: Partial<CardDraft>): void => useChatUiStore.getState().setCardDraft(key, patch);
  const field = question.field;
  const answered = field === undefined ? answerOf(question, step, draft) !== '' : readField(question, step, draft).valid;
  const group = `${key}:${step}`;
  const picked = draft.picked[step] ?? [];
  const otherOn = draft.otherOn[step] === true;
  const numeric = field?.type === 'number' || field?.type === 'integer';
  const textField = field?.type === 'text' || numeric;

  const pick = (label: string): void => {
    if (question.multiSelect) {
      set({ picked: { ...draft.picked, [step]: picked.includes(label) ? picked.filter((entry) => entry !== label) : [...picked, label] } });
    } else {
      set({ picked: { ...draft.picked, [step]: [label] }, otherOn: { ...draft.otherOn, [step]: false } });
    }
  };
  const pickOther = (): void => {
    if (question.multiSelect) set({ otherOn: { ...draft.otherOn, [step]: !otherOn } });
    else set({ picked: { ...draft.picked, [step]: [] }, otherOn: { ...draft.otherOn, [step]: true } });
  };
  const submit = (): void => {
    if (field !== undefined) {
      const values = Object.fromEntries(item.questions.flatMap((entry, at) => {
        const { value } = readField(entry, at, draft);
        return entry.field !== undefined && value !== undefined ? [[entry.field.id, value] as const] : [];
      }));
      decide({ kind: 'question', answers: {}, values });
      return;
    }
    decide({ kind: 'question', answers: Object.fromEntries(item.questions.map((entry, at) => [entry.question, answerOf(entry, at, draft)])) });
  };
  const kind = question.multiSelect ? 'checkbox' : 'radio';

  return (
    <CardFrame item={item} status={null}>
      {item.formPrompt !== undefined && item.formPrompt !== question.question ? (
        <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{item.formPrompt}</p>
      ) : null}
      {total > 1 ? <span className="text-xs text-muted-foreground">{S.chat.card.questionOf(step + 1, total)}</span> : null}
      {question.header === null ? null : <span className="text-xs font-semibold uppercase text-muted-foreground">{question.header}</span>}
      <p className="m-0 [overflow-wrap:anywhere]">{question.question}</p>
      {field?.description === undefined ? null : <p className="m-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">{field.description}</p>}
      <div className="flex min-w-0 flex-col gap-1">
        {question.options.map((option) => {
          const value = option.value ?? option.label;
          return (
            <label key={value} className="flex min-w-0 cursor-pointer items-start gap-2">
              <input
                type={kind}
                name={group}
                data-testid="card-option"
                data-option-label={option.label}
                checked={picked.includes(value) && !(otherOn && !question.multiSelect)}
                disabled={deciding}
                onChange={() => pick(value)}
                className="mt-0.5 shrink-0"
              />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span className="font-medium">{option.label}</span>
                {option.description === null ? null : <span className="block text-xs text-muted-foreground">{option.description}</span>}
              </span>
            </label>
          );
        })}
        {field === undefined ? (
          <label className="flex min-w-0 cursor-pointer items-center gap-2">
            <input type={kind} name={group} data-testid="card-other" checked={otherOn} disabled={deciding} onChange={pickOther} className="shrink-0" />
            <span className="font-medium">{S.chat.card.other}</span>
          </label>
        ) : null}
        {otherOn || textField ? (
          <Input
            data-testid="card-other-text"
            aria-label={textField ? question.question : S.chat.card.otherAnswer}
            placeholder={textField ? undefined : S.chat.card.otherAnswer}
            type={numeric ? 'number' : 'text'}
            step={field?.type === 'integer' ? 1 : numeric ? 'any' : undefined}
            maxLength={field?.type === 'text' ? FEED_DECISION_ANSWER_LIMIT : undefined}
            value={draft.otherText[step] ?? ''}
            disabled={deciding}
            onChange={(event) => set({ otherText: { ...draft.otherText, [step]: event.target.value } })}
            className="h-6 px-2 text-xs"
          />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {last ? (
          <Button type="button" size="xs" data-testid="card-submit" disabled={deciding || !answered} onClick={submit}>
            {S.chat.card.submit}
          </Button>
        ) : (
          <Button type="button" size="xs" data-testid="card-next" disabled={!answered} onClick={() => set({ step: step + 1 })}>
            {S.chat.card.next}
          </Button>
        )}
      </div>
      <CardNote note={note} />
    </CardFrame>
  );
}
