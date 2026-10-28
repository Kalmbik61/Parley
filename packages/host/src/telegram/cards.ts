/** Карточки бота: тексты HTML и inline-клавиатуры. Чистые функции — отправку и состояние ведёт сервис. */

import { cardDetail } from '@parley/core/card-gist';
import type { FeedCard, FeedDecision, FeedQuestionCard, Proposal } from '@parley/core';
import type { AssistantProposal, ConsentCard } from '@parley/protocol';
import { CALLBACK_CODES } from './callbacks.js';
import { clipText, escapeHtml } from './format.js';
import { B, T } from './texts.js';
import type { InlineKeyboard } from './types.js';

export interface CardMeta {
  sessionName: string;
  /** `Parley · my_harnas`. */
  where: string;
  projectPath: string;
  shortId: string;
  /** `false` у Codex без хуков: ответить можно только на Mac. */
  buttons: boolean;
}

const BUTTON_MAX = 64;
const DETAIL_MAX = 1500;

const pre = (text: string): string => `<pre>${escapeHtml(clipText(text, DETAIL_MAX))}</pre>`;
const button = (text: string, data: string): { text: string; callback_data: string } => ({ text, callback_data: data });
const pc1 = (shortId: string, code: string): string => `pc1:${shortId}:${code}`;
const label = (text: string): string => (text.length > BUTTON_MAX ? `${text.slice(0, BUTTON_MAX - 1)}…` : text);

/** Вопрос с индексом `question`: сам вопрос и варианты построчно. */
function questionBlock(card: FeedQuestionCard, question: number): string | null {
  const item = card.questions[question];
  if (item === undefined) return null;
  return [item.question, ...item.options.map((option) => `- ${option.label}`)].join('\n');
}

export function questionKeyboard(card: FeedQuestionCard, shortId: string, question: number): InlineKeyboard {
  const options = card.questions[question]?.options ?? [];
  return [
    ...options.map((option, index) => [button(label(option.label), pc1(shortId, CALLBACK_CODES.option(index)))]),
    [button(B.other, pc1(shortId, CALLBACK_CODES.other))],
  ];
}

function feedKeyboard(card: FeedCard, shortId: string, question: number): InlineKeyboard {
  if (card.kind === 'permission') {
    const row = [button(B.allow, pc1(shortId, CALLBACK_CODES.allow)), button(B.deny, pc1(shortId, CALLBACK_CODES.deny))];
    return card.suggestions.length > 0 ? [row, [button(B.allowAlways, pc1(shortId, CALLBACK_CODES.allowAlways))]] : [row];
  }
  if (card.kind === 'plan') {
    return [[button(B.accept, pc1(shortId, CALLBACK_CODES.planAuto))], [button(B.approveEach, pc1(shortId, CALLBACK_CODES.planManual))]];
  }
  return questionKeyboard(card, shortId, question);
}

export function feedCardMessage(card: FeedCard, meta: CardMeta, question = 0): { text: string; keyboard: InlineKeyboard | null } {
  let title: string;
  let detail: string | null;
  if (card.kind === 'permission') {
    title = T.permissionTitle(card.toolName);
    detail = cardDetail(card, DETAIL_MAX);
  } else if (card.kind === 'plan') {
    title = T.planTitle;
    detail = cardDetail(card, DETAIL_MAX);
  } else {
    title = card.questions.length > 1 ? T.questionOf(question + 1, card.questions.length) : T.questionTitle;
    detail = questionBlock(card, question);
  }
  const lines = [`<b>${escapeHtml(meta.sessionName)}</b> · ${escapeHtml(meta.where)}`, escapeHtml(title)];
  if (detail !== null) lines.push(pre(detail));
  if (!meta.buttons) {
    lines.push(escapeHtml(T.waitingAtMac(meta.sessionName)));
    return { text: lines.join('\n'), keyboard: null };
  }
  lines.push(escapeHtml(T.expiresWithTurn));
  return { text: lines.join('\n'), keyboard: feedKeyboard(card, meta.shortId, question) };
}

export function roomCardMessage(input: { roomTitle: string; where: string; proposal: Proposal; shortId: string }): { text: string; keyboard: InlineKeyboard } {
  const { proposal } = input;
  const title = proposal.kind === 'completion' ? T.completionTitle : T.decisionTitle;
  const lines = [`<b>${escapeHtml(input.roomTitle)}</b> · ${escapeHtml(input.where)}`, escapeHtml(`${title} · ${proposal.from}${proposal.rev > 0 ? ` · ${T.revised}` : ''}`), pre(proposal.text)];
  return {
    text: lines.join('\n'),
    keyboard: [[button(B.acceptDecision, pc1(input.shortId, CALLBACK_CODES.accept)), button(B.returnNote, pc1(input.shortId, CALLBACK_CODES.returnNote))]],
  };
}

/** Карточка согласия на папку (спека 2026-10-21, 4.4): Trust и Deny — те же коды `a` и `d`, что у разрешения в ленте. */
export function consentCardMessage(input: { card: ConsentCard; projectName: string; requestedByLabel: string; shortId: string }): { text: string; keyboard: InlineKeyboard } {
  const lines = [`<b>${escapeHtml(T.consentTitle)}</b>`, escapeHtml(input.card.folder), escapeHtml(T.consentRequestedBy(input.requestedByLabel, input.projectName))];
  return {
    text: lines.join('\n'),
    keyboard: [[button(B.trust, pc1(input.shortId, CALLBACK_CODES.allow)), button(B.deny, pc1(input.shortId, CALLBACK_CODES.deny))]],
  };
}

function decisionVerb(decision: FeedDecision): string {
  if (decision.kind === 'permission') return decision.behavior === 'deny' ? B.deny : B.allow;
  if (decision.kind === 'question') return B.answer;
  return decision.choice === 'manual' ? B.approveEach : B.accept;
}

/** Подпись кнопки подтверждения — те же слова, что у карточки помощника в окне. */
function confirmLabel(proposal: AssistantProposal): string {
  switch (proposal.action) {
    case 'room':
      return B.create;
    case 'decision': {
      const { decision } = proposal;
      if (decision.kind === 'permission') return decision.behavior === 'deny' ? B.deny : decision.always === true ? B.allowAlways : B.allow;
      return decision.kind === 'question' ? B.answer : decision.choice === 'manual' ? B.approveEach : B.accept;
    }
    case 'room-decision':
      return proposal.choice === 'accept' ? B.acceptDecision : B.return;
    default:
      return 'wake' in proposal && proposal.wake ? B.wakeAndSend : B.send;
  }
}

function assistantBody(proposal: AssistantProposal): string[] {
  switch (proposal.action) {
    case 'room':
      return [
        escapeHtml(T.assistantNewRoom(proposal.where)),
        escapeHtml(T.assistantRoomLine(proposal.title, proposal.members.join(', '), proposal.lead)),
        ...(proposal.task === null ? [] : [pre(proposal.task)]),
      ];
    case 'decision': {
      const verb = decisionVerb(proposal.decision);
      const head = proposal.decision.kind === 'plan' ? T.assistantPlanTitle(verb, proposal.target) : T.assistantAskTitle(verb, proposal.target);
      return [
        escapeHtml(head),
        escapeHtml(proposal.card.summary),
        ...(proposal.card.detail === null ? [] : [pre(proposal.card.detail)]),
        ...(proposal.decision.kind === 'question'
          ? Object.entries(proposal.decision.answers).map(([question, answer]) => escapeHtml(T.assistantAnswerLine(question.split('\n')[0] ?? '', answer)))
          : []),
      ];
    }
    case 'room-decision':
      return [
        escapeHtml(proposal.choice === 'accept' ? T.assistantAcceptDecision(proposal.target) : T.assistantReturnDecision(proposal.proposal.from)),
        pre(proposal.proposal.text),
        ...(proposal.note === null ? [] : [escapeHtml(T.assistantNote(proposal.note))]),
      ];
    default:
      return [escapeHtml(T.assistantTo(proposal.target, proposal.where)), pre(proposal.text)];
  }
}

export function assistantCardMessage(proposal: AssistantProposal): { text: string; keyboard: InlineKeyboard } {
  return {
    text: assistantBody(proposal).join('\n'),
    keyboard: [[button(confirmLabel(proposal), `pa1:${proposal.id}:send`), button(B.cancel, `pa1:${proposal.id}:cancel`)]],
  };
}

/** Текст карточки без кнопок, пустая строка и строка итога. */
export function receiptText(originalHtml: string, line: string): string {
  return `${originalHtml}\n\n${line}`;
}

/**
 * Код кнопки → решение ленты. `question` — вопрос, на который нажали (у карточки с несколькими вопросами);
 * `o` без `answer` → `'other'` (сервис ждёт текст ответом), с `answer` — готовый ответ своими словами.
 * Код не из этой карточки → `null`.
 */
export function feedDecisionFor(card: FeedCard, code: string, answer?: string, question = 0): FeedDecision | 'other' | null {
  if (card.kind === 'permission') {
    if (code === CALLBACK_CODES.allow) return { kind: 'permission', behavior: 'allow' };
    if (code === CALLBACK_CODES.allowAlways) return card.suggestions.length > 0 ? { kind: 'permission', behavior: 'allow', always: true } : null;
    if (code === CALLBACK_CODES.deny) return { kind: 'permission', behavior: 'deny' };
    return null;
  }
  if (card.kind === 'plan') {
    if (code === CALLBACK_CODES.planAuto) return { kind: 'plan', choice: 'auto-accept' };
    if (code === CALLBACK_CODES.planManual) return { kind: 'plan', choice: 'manual' };
    return null;
  }
  const item = card.questions[question];
  if (item === undefined) return null;
  if (code === CALLBACK_CODES.other) return answer === undefined ? 'other' : { kind: 'question', answers: { [item.question]: answer } };
  const match = /^q(\d+)$/.exec(code);
  const option = match === null ? undefined : item.options[Number(match[1])];
  return option === undefined ? null : { kind: 'question', answers: { [item.question]: option.label } };
}
