// Pure view-models for cards, status capsules and time text (D1 §7.1, §9.1, §9.2). No React.
import type { FeedCard, FeedDecision, FeedPermissionCard, FeedQuestion, FeedQuestionCard } from '@parley/core';
import type { CardGist } from '@parley/core/card-gist';

/** `permission_suggestions` → `Tool(content)` rules. `null`: no rules, so no "Allow and don't ask again" (mirror of the window's `alwaysRules`). */
export function alwaysRules(suggestions: readonly unknown[]): string[] | null {
  const rules: string[] = [];
  let found = false;
  for (const suggestion of suggestions) {
    if (typeof suggestion !== 'object' || suggestion === null) continue;
    const entry = suggestion as { type?: unknown; rules?: unknown };
    if (entry.type !== 'addRules') continue;
    found = true;
    if (!Array.isArray(entry.rules)) continue;
    for (const rule of entry.rules) {
      if (typeof rule !== 'object' || rule === null) continue;
      const { toolName, ruleContent } = rule as { toolName?: unknown; ruleContent?: unknown };
      if (typeof toolName !== 'string') continue;
      rules.push(typeof ruleContent === 'string' && ruleContent !== '' ? `${toolName}(${ruleContent})` : toolName);
    }
  }
  return found ? rules : null;
}

/** "Always" is offered only when the CLI suggested a rule. */
export const canAlways = (card: FeedPermissionCard): boolean => (alwaysRules(card.suggestions)?.length ?? 0) > 0;

export type SymbolName =
  | 'terminal'
  | 'doc.text'
  | 'wrench.and.screwdriver'
  | 'globe'
  | 'questionmark.bubble'
  | 'list.bullet.clipboard';

export interface GistView {
  icon: SymbolName;
  /** Session screen heading: `Run a command`, `Edit a file`, … */
  title: string;
  /** One-line summary for an Inbox row. */
  summary: string;
  mono: boolean;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function gistView(gist: CardGist): GistView {
  switch (gist.kind) {
    case 'run':
      return { icon: 'terminal', title: 'Run a command', summary: gist.command, mono: true };
    case 'fetch': {
      const host = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(gist.url)?.[1] ?? gist.url;
      return { icon: 'globe', title: 'Fetch a page', summary: host, mono: false };
    }
    case 'tool': {
      const edit = EDIT_TOOLS.has(gist.tool);
      return {
        icon: edit ? 'doc.text' : 'wrench.and.screwdriver',
        title: edit ? 'Edit a file' : `Use ${gist.tool}`,
        summary: gist.path === null ? gist.tool : `${gist.tool} · ${gist.path}`,
        mono: false,
      };
    }
    case 'question':
      return { icon: 'questionmark.bubble', title: 'Question', summary: gist.text, mono: false };
    case 'plan':
      return { icon: 'list.bullet.clipboard', title: 'Plan', summary: 'Plan ready for review', mono: false };
  }
}

// ---------- questions ----------

export interface QuestionDraft {
  picked: Readonly<Record<number, readonly string[]>>;
  otherOn: Readonly<Record<number, boolean>>;
  otherText: Readonly<Record<number, string>>;
  /** The question on screen (0-based), as the window's `CardDraft.step`; kept with the picks while the card waits. */
  step: number;
}
export const EMPTY_QUESTION_DRAFT: QuestionDraft = { picked: {}, otherOn: {}, otherText: {}, step: 0 };

/** Wire format shared with the window: one string per question, multi-select joined with ", ". Empty — no answer yet. */
export function answerOf(question: FeedQuestion, at: number, draft: QuestionDraft): string {
  const labels = draft.picked[at] ?? [];
  const otherOn = draft.otherOn[at] === true;
  const other = (draft.otherText[at] ?? '').trim();
  if (!question.multiSelect) return otherOn ? other : (labels[0] ?? '');
  return [...labels, ...(otherOn && other !== '' ? [other] : [])].join(', ');
}

export const ANSWER_LIMIT = 16 * 1024;

/** The decision to send, or `null` while a question has no answer, an answer is too long, or the card cannot be answered here. */
export function questionDecision(card: FeedQuestionCard, draft: QuestionDraft): Extract<FeedDecision, { kind: 'question' }> | null {
  if (card.state !== 'pending' || card.truncated === true || card.questions.length === 0) return null;
  if (new Set(card.questions.map((q) => q.question)).size !== card.questions.length) return null;
  const answers: Record<string, string> = {};
  for (let at = 0; at < card.questions.length; at++) {
    const q = card.questions[at]!;
    const a = answerOf(q, at, draft);
    if (a === '' || a.length > ANSWER_LIMIT) return null;
    answers[q.question] = a;
  }
  return { kind: 'question', answers };
}

// ---------- question steps (the window's QuestionCard: one question at a time) ----------

/** The step clamped into `0..count-1` (a card that changed under a stored draft never points past its end). */
export const stepOf = (draft: QuestionDraft, count: number): number => Math.min(Math.max(draft.step, 0), Math.max(count - 1, 0));

/** "Question 2 of 3"; `null` for a single question (no "1 of 1"). */
export const stepLabel = (draft: QuestionDraft, count: number): string | null =>
  count > 1 ? `Question ${stepOf(draft, count) + 1} of ${count}` : null;

export const hasBack = (draft: QuestionDraft, count: number): boolean => stepOf(draft, count) > 0;
export const isLastStep = (draft: QuestionDraft, count: number): boolean => stepOf(draft, count) >= count - 1;

/** Why the card cannot be answered here at all (truncated, or two questions with one text); `null` when it can. */
export const UNANSWERABLE_TEXT = "This question can't be answered here — answer at your Mac";
export const TOO_LONG_TEXT = 'Answer is too long — 16 KB max';
export function unanswerableReason(card: FeedQuestionCard): string | null {
  if (card.truncated === true || card.questions.length === 0) return UNANSWERABLE_TEXT;
  return new Set(card.questions.map((q) => q.question)).size !== card.questions.length ? UNANSWERABLE_TEXT : null;
}

/** The caption under the card for the current step: why Next / Send answer is off, when it is not just "no answer yet". */
export function stepNote(card: FeedQuestionCard, draft: QuestionDraft): string | null {
  const unanswerable = unanswerableReason(card);
  if (unanswerable !== null) return unanswerable;
  const at = stepOf(draft, card.questions.length);
  const q = card.questions[at];
  return q !== undefined && answerOf(q, at, draft).length > ANSWER_LIMIT ? TOO_LONG_TEXT : null;
}

/** Next is enabled when the current question has a valid answer (non-empty, within the limit — as the island's `valid(step)`) and there is a next one. */
export function canNext(card: FeedQuestionCard, draft: QuestionDraft): boolean {
  const at = stepOf(draft, card.questions.length);
  const q = card.questions[at];
  if (q === undefined || isLastStep(draft, card.questions.length) || unanswerableReason(card) !== null) return false;
  const a = answerOf(q, at, draft);
  return a !== '' && a.length <= ANSWER_LIMIT;
}

/** What VoiceOver hears when the question changes: "Question 2 of 3. <text>"; just the text for a single question. */
export function stepAnnouncement(card: FeedQuestionCard, draft: QuestionDraft): string {
  const count = card.questions.length;
  const text = card.questions[stepOf(draft, count)]?.question ?? '';
  const label = stepLabel(draft, count);
  return label === null ? text : `${label}. ${text}`;
}

/** Taps on Next / Send answer this soon after a step change are ignored (a double tap must not reach "Send answer"). */
export const STEP_TAP_GUARD_MS = 400;

export const nextStep = (card: FeedQuestionCard, draft: QuestionDraft): QuestionDraft =>
  canNext(card, draft) ? { ...draft, step: stepOf(draft, card.questions.length) + 1 } : draft;

export const backStep = (card: FeedQuestionCard, draft: QuestionDraft): QuestionDraft =>
  hasBack(draft, card.questions.length) ? { ...draft, step: stepOf(draft, card.questions.length) - 1 } : draft;

/** Send answer: only on the last question and only when `questionDecision` has an answer for every one. */
export const canSend = (card: FeedQuestionCard, draft: QuestionDraft): boolean =>
  isLastStep(draft, card.questions.length) && questionDecision(card, draft) !== null;

export function togglePick(draft: QuestionDraft, at: number, question: FeedQuestion, label: string): QuestionDraft {
  const picked = draft.picked[at] ?? [];
  return {
    ...draft,
    picked: {
      ...draft.picked,
      [at]: question.multiSelect ? (picked.includes(label) ? picked.filter((l) => l !== label) : [...picked, label]) : [label],
    },
    otherOn: question.multiSelect ? draft.otherOn : { ...draft.otherOn, [at]: false },
  };
}

export function toggleOther(draft: QuestionDraft, at: number, question: FeedQuestion): QuestionDraft {
  const on = draft.otherOn[at] === true;
  return {
    ...draft,
    picked: question.multiSelect ? draft.picked : { ...draft.picked, [at]: [] },
    otherOn: { ...draft.otherOn, [at]: question.multiSelect ? !on : true },
  };
}

// ---------- decision outcome → UI text ----------

export type DecisionUi =
  | { kind: 'done' }
  | { kind: 'already-answered' }
  | { kind: 'conflict' }
  /** `lost` and the card is gone after the re-read: the request is no longer pending. */
  | { kind: 'no-longer-pending' }
  /** `lost` and the card still waits (or the re-read failed): nothing was confirmed; the card stays. */
  | { kind: 'unconfirmed' }
  | { kind: 'error' };

export const DECISION_TEXT: Record<DecisionUi['kind'], string | null> = {
  done: null,
  'already-answered': 'Already answered at your Mac',
  conflict: 'This request changed — review it again',
  'no-longer-pending': 'This request is no longer pending',
  unconfirmed: "We couldn't confirm your answer",
  error: "Couldn't send the answer",
};

export type DecideResult =
  | { outcome: 'applied' | 'conflict' | 'stale' }
  | { outcome: 'lost'; stillPending: boolean | null };

export function uiOfDecide(result: DecideResult): DecisionUi {
  switch (result.outcome) {
    case 'applied':
      return { kind: 'done' };
    case 'stale':
      return { kind: 'already-answered' };
    case 'conflict':
      return { kind: 'conflict' };
    case 'lost':
      return result.stillPending === false ? { kind: 'no-longer-pending' } : { kind: 'unconfirmed' };
  }
}

/** One decision: the call is never retried — a `lost` result comes from the client's re-read. */
export async function runDecision(
  decision: FeedDecision,
  send: (decision: FeedDecision) => Promise<DecideResult>,
): Promise<DecisionUi> {
  try {
    return uiOfDecide(await send(decision));
  } catch {
    return { kind: 'error' };
  }
}

export const cardTitle = (card: FeedCard): string =>
  card.kind === 'permission' ? 'Permission' : card.kind === 'question' ? 'Question' : 'Plan';

// ---------- time ----------

export function timeAgo(iso: string | null, now: number): string | null {
  if (iso === null || iso === '') return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/** The whole command of a Bash-like permission card (for "Copy command"); `null` for any other card. */
export function fullCommand(card: FeedCard): string | null {
  if (card.kind !== 'permission') return null;
  const command = card.toolInput.command;
  if (typeof command === 'string') return command;
  if (Array.isArray(command) && command.every((p) => typeof p === 'string')) return command.join(' ');
  return null;
}
