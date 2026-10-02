/**
 * Карточка вопроса агента (план 2026-10-01, решение 4, кусок 4a, решение Р): заголовок, текст,
 * варианты с описаниями (одиночный выбор — радио, `multiSelect` — флажки) и пункт «Other» со свободным
 * текстом. Несколько вопросов идут по одному: «Next», на последнем «Submit» шлёт все ответы разом.
 * Ответ — `{ [текст вопроса]: подпись }`; при `multiSelect` подписи через `, `, «Other» — свой текст.
 * Выбранное и набранное — в `ui-store` по карточке (строки ленты размонтируются при прокрутке).
 */

import type { FeedQuestion, FeedQuestionCard } from '@parley/core';
import { S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { Input } from '../../ui/input.js';
import { EMPTY_CARD_DRAFT, useChatUiStore, type CardDraft } from '../ui-store.js';
import { CardFrame } from './CardFrame.js';
import { CardNote } from './CardNote.js';
import { useCardDecision } from './use-card-decision.js';

/** Ответ на вопрос `at` по черновику; пустая строка — ответа ещё нет. */
export function answerOf(question: FeedQuestion, at: number, draft: CardDraft): string {
  const labels = draft.picked[at] ?? [];
  const otherOn = draft.otherOn[at] === true;
  const other = (draft.otherText[at] ?? '').trim();
  if (!question.multiSelect) return otherOn ? other : (labels[0] ?? '');
  return [...labels, ...(otherOn && other !== '' ? [other] : [])].join(', ');
}

function settledStatus(item: FeedQuestionCard): string {
  return item.state === 'pending' ? S.chat.waiting : S.chat.cardState[item.state];
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
  const answered = answerOf(question, step, draft) !== '';
  const group = `${key}:${step}`;
  const picked = draft.picked[step] ?? [];
  const otherOn = draft.otherOn[step] === true;

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
    decide({ kind: 'question', answers: Object.fromEntries(item.questions.map((entry, at) => [entry.question, answerOf(entry, at, draft)])) });
  };
  const kind = question.multiSelect ? 'checkbox' : 'radio';

  return (
    <CardFrame item={item} status={null}>
      {total > 1 ? <span className="text-xs text-muted-foreground">{S.chat.card.questionOf(step + 1, total)}</span> : null}
      {question.header === null ? null : <span className="text-xs font-semibold uppercase text-muted-foreground">{question.header}</span>}
      <p className="m-0 [overflow-wrap:anywhere]">{question.question}</p>
      <div className="flex min-w-0 flex-col gap-1">
        {question.options.map((option) => (
          <label key={option.label} className="flex min-w-0 cursor-pointer items-start gap-2">
            <input
              type={kind}
              name={group}
              data-testid="card-option"
              data-option-label={option.label}
              checked={picked.includes(option.label) && !(otherOn && !question.multiSelect)}
              disabled={deciding}
              onChange={() => pick(option.label)}
              className="mt-0.5 shrink-0"
            />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <span className="font-medium">{option.label}</span>
              {option.description === null ? null : <span className="block text-xs text-muted-foreground">{option.description}</span>}
            </span>
          </label>
        ))}
        <label className="flex min-w-0 cursor-pointer items-center gap-2">
          <input type={kind} name={group} data-testid="card-other" checked={otherOn} disabled={deciding} onChange={pickOther} className="shrink-0" />
          <span className="font-medium">{S.chat.card.other}</span>
        </label>
        {otherOn ? (
          <Input
            data-testid="card-other-text"
            aria-label={S.chat.card.otherAnswer}
            placeholder={S.chat.card.otherAnswer}
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
