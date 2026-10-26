import { useId, useState, type FocusEvent, type PointerEvent } from 'react';
import type { FeedDecision, FeedQuestionCard } from '@parley/core';
import { FEED_DECISION_ANSWER_LIMIT, FEED_INPUT_LIMIT } from '@parley/protocol';
import { answerOf, type QuestionAnswerDraft } from '../lib/question-answer.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';

export interface QuestionFormLabels {
  back: string;
  next: string;
  submit: string;
  other: string;
  otherAnswer: string;
  questionOf(index: number, total: number): string;
  invalidQuestion: string;
  answerTooLong(limit: number): string;
  openInParley: string;
}

export interface QuestionFormProps {
  identity: string;
  card: FeedQuestionCard;
  disabled: boolean;
  labels: QuestionFormLabels;
  onTakeKeyboard(): void;
  onSubmit(decision: Extract<FeedDecision, { kind: 'question' }>): void;
  onOpenInParley(): void;
}

/** Входные строки уже проверены feed-схемой; неоднозначные wire-ключи требуют основного окна. */
function canAnswer(card: FeedQuestionCard): boolean {
  const text = (value: string): boolean => value.trim() !== '' && value.length <= FEED_INPUT_LIMIT;
  const optionalText = (value: string | null): boolean => value === null || value.length <= FEED_INPUT_LIMIT;
  return card.state === 'pending' && card.truncated !== true && card.questions.length >= 1 && card.questions.length <= 4
    && new Set(card.questions.map((question) => question.question)).size === card.questions.length
    && card.questions.every((question) => text(question.question) && optionalText(question.header)
      && new Set(question.options.map((option) => option.label)).size === question.options.length
      && question.options.every((option) => text(option.label) && optionalText(option.description)));
}

/** Локальный draft только активной identity; refresh без изменения вопросов его не сбрасывает. */
export function QuestionForm(props: QuestionFormProps): JSX.Element {
  const identity = JSON.stringify([props.identity, props.card.cardId, props.card.questions, props.card.truncated, props.card.state]);
  return <QuestionFormDraft key={identity} {...props} />;
}

function QuestionFormDraft({ card, disabled, labels, onTakeKeyboard, onSubmit, onOpenInParley }: QuestionFormProps): JSX.Element {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<QuestionAnswerDraft>({ picked: {}, otherOn: {}, otherText: {} });
  const group = useId();
  const question = card.questions[step];
  if (!canAnswer(card) || question === undefined) {
    return (
      <div data-no-drag className="flex min-w-0 flex-col gap-2">
        <p className="m-0 text-sm">{labels.invalidQuestion}</p>
        <Button type="button" variant="outline" onClick={onOpenInParley}>{labels.openInParley}</Button>
      </div>
    );
  }

  const answers = card.questions.map((entry, at) => answerOf(entry, at, draft));
  const tooLong = card.questions.map((_, at) => answers[at]!.length > FEED_DECISION_ANSWER_LIMIT
    || (draft.otherText[at] ?? '').length > FEED_DECISION_ANSWER_LIMIT && draft.otherOn[at] === true);
  const valid = (at: number): boolean => answers[at] !== '' && !tooLong[at];
  const picked = draft.picked[step] ?? [];
  const otherOn = draft.otherOn[step] === true;
  const last = step === card.questions.length - 1;
  const pick = (label: string): void => {
    setDraft({
      ...draft,
      picked: { ...draft.picked, [step]: question.multiSelect ? (picked.includes(label) ? picked.filter((entry) => entry !== label) : [...picked, label]) : [label] },
      otherOn: question.multiSelect ? draft.otherOn : { ...draft.otherOn, [step]: false },
    });
  };
  const pickOther = (): void => {
    setDraft({
      ...draft,
      picked: question.multiSelect ? draft.picked : { ...draft.picked, [step]: [] },
      otherOn: { ...draft.otherOn, [step]: question.multiSelect ? !otherOn : true },
    });
  };
  const submit = (): void => {
    if (disabled || !answers.every((_, at) => valid(at))) return;
    onSubmit({ kind: 'question', answers: Object.fromEntries(card.questions.map((entry, at) => [entry.question, answers[at]!])) });
  };
  // Мышь на кнопке не передаёт клавиатуру острову; редактирование и выделение — явное взаимодействие.
  const takeKeyboard = (event: PointerEvent<HTMLDivElement> | FocusEvent<HTMLDivElement>): void => {
    if (event.target instanceof Element && event.target.closest('button, [role="button"]') !== null) return;
    onTakeKeyboard();
  };
  const kind = question.multiSelect ? 'checkbox' : 'radio';

  return (
    <div data-no-drag className="flex min-h-0 min-w-0 flex-1 flex-col gap-2" onPointerDownCapture={takeKeyboard} onFocusCapture={takeKeyboard}>
      <div data-testid="island-question-body" data-no-drag className="flex min-h-0 max-h-[40vh] flex-1 flex-col gap-2 overflow-y-auto [overflow-wrap:anywhere]">
        <span className="text-xs text-muted-foreground">{labels.questionOf(step + 1, card.questions.length)}</span>
        {question.header === null ? null : <span className="text-xs font-semibold uppercase text-muted-foreground">{question.header}</span>}
        <p className="m-0" id={`${group}-question`}>{question.question}</p>
        <div role="group" aria-labelledby={`${group}-question`} className="flex min-w-0 flex-col gap-1">
          {question.options.map((option) => (
            <label key={option.label} className="flex min-w-0 cursor-pointer items-start gap-2">
              <input type={kind} name={`${group}-${step}`} checked={picked.includes(option.label)} onChange={() => pick(option.label)} className="mt-0.5 shrink-0" />
              <span className="min-w-0">
                <span className="font-medium">{option.label}</span>{' '}
                {option.description === null ? null : <span className="block text-xs text-muted-foreground">{option.description}</span>}
              </span>
            </label>
          ))}
          <label className="flex cursor-pointer items-center gap-2">
            <input type={kind} name={`${group}-${step}`} checked={otherOn} onChange={pickOther} />
            <span className="font-medium">{labels.other}</span>
          </label>
          {otherOn ? (
            <Input
              aria-label={labels.otherAnswer}
              placeholder={labels.otherAnswer}
              value={draft.otherText[step] ?? ''}
              onChange={(event) => setDraft({ ...draft, otherText: { ...draft.otherText, [step]: event.target.value } })}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.nativeEvent.isComposing) event.stopPropagation(); }}
              onKeyUp={(event) => { if (event.key === 'Enter' || event.nativeEvent.isComposing) event.stopPropagation(); }}
            />
          ) : null}
        </div>
        {tooLong.some(Boolean) ? <p role="alert" className="m-0 text-xs text-destructive">{labels.answerTooLong(FEED_DECISION_ANSWER_LIMIT)}</p> : null}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {step > 0 ? <Button type="button" variant="outline" onClick={() => setStep(step - 1)}>{labels.back}</Button> : null}
        {last ? (
          <Button type="button" disabled={disabled || !answers.every((_, at) => valid(at))} onClick={submit}>{labels.submit}</Button>
        ) : (
          <Button type="button" disabled={!valid(step)} onClick={() => setStep(step + 1)}>{labels.next}</Button>
        )}
      </div>
    </div>
  );
}
