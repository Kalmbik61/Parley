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
}
export const EMPTY_QUESTION_DRAFT: QuestionDraft = { picked: {}, otherOn: {}, otherText: {} };

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
  | { kind: 'cancelled' }
  | { kind: 'error' };

export const DECISION_TEXT: Record<DecisionUi['kind'], string | null> = {
  done: null,
  'already-answered': 'Already answered at your Mac',
  conflict: 'This request changed — review it again',
  'no-longer-pending': 'This request is no longer pending',
  unconfirmed: "We couldn't confirm your answer",
  cancelled: 'Face ID cancelled — nothing was sent',
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

/** Which approvals the Face ID gate covers (A16 wires `approve`; here it only receives the kind). */
export type ApproveKind = 'allow' | 'always' | 'plan';
export type Approve = (kind: ApproveKind) => Promise<boolean>;
/** Tests only: no gate. The app's default fails closed (approve-context.tsx). */
export const passThroughApprove: Approve = async () => true;

export function approveKindOf(decision: FeedDecision): ApproveKind | null {
  if (decision.kind === 'plan') return 'plan';
  if (decision.kind === 'permission' && decision.behavior === 'allow') return decision.always === true ? 'always' : 'allow';
  return null;
}

/**
 * One decision, per spec §11.4: the gate runs first for approvals (Deny/answers skip it); a cancelled gate sends nothing
 * and leaves the card; the call is never retried — a `lost` result comes from the client's re-read.
 */
export async function runDecision(
  decision: FeedDecision,
  approve: Approve,
  send: (decision: FeedDecision) => Promise<DecideResult>,
): Promise<DecisionUi> {
  const kind = approveKindOf(decision);
  if (kind !== null) {
    let ok = false;
    try {
      ok = await approve(kind);
    } catch {
      ok = false;
    }
    if (!ok) return { kind: 'cancelled' };
  }
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
