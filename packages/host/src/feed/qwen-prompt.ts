import { confirmStartupChoice, recogniseQwenFolderTrust, type FolderTrustMenu } from './folder-trust.js';
import { createHash } from 'node:crypto';
import type { FeedDecision, FeedPermissionCard, FeedQuestionCard } from '@parley/core';
import { FEED_DECISION_ANSWER_LIMIT } from '@parley/protocol';
import stringWidth from 'string-width';

export type QwenPromptKind = 'question' | 'permission';
type Card = FeedQuestionCard | FeedPermissionCard;

interface Row {
  number: string;
  label: string;
  description: string | null;
  selected: boolean;
  checked: boolean | null;
}

export interface QwenPrompt {
  fingerprint: string;
  card: Card;
  rows: Row[];
  review: boolean;
  previous: string | null;
  feedback?: boolean;
  folderTrust?: FolderTrustMenu;
}

interface IO {
  screen(): readonly string[] | undefined;
  write(keys: string): void;
  current(): boolean;
}

const waiting = /^(?:\S+\s+)?(?:Waiting for user confirmation|Ожидание подтверждения от пользователя)\.{3}$/u;
const option = /^\s*([❯›]?)\s*(?:\[([ ✓x])\]\s+)?([1-9])\.\s+(.+?)\s*$/u;
const customLabel = /^(?:Type something|Введите что-то)\.{3}$/u;
const submitLabel = /^(?:Submit answers|Отправить ответы)$/u;
const cancelLabel = /^(?:Cancel|Отмена|Отменить)$/u;
const feedbackFooters = [
  ['How is Qwen doing this session? (optional)', '1: Good 2: Bad 3: Fine 0: Dismiss'],
  ['Как дела у Qwen в этой сессии? (необязательно)', '1: Хорошо 2: Плохо 3: Нормально 0: Отклонить'], // cyrillic-ok: Exact incoming Qwen terminal feedback footer.
];

function permissionKind(name: string): 'allow_once' | 'allow_always' | 'reject_once' | null {
  if (/^(Yes, allow once|Да, разрешить один раз)$/u.test(name)) return 'allow_once';
  if (/^(Yes, allow always|Да, всегда разрешать)$/u.test(name)) return 'allow_always';
  // Scoped rows carry the rule text between the prefix and the scope suffix (0.27.2 exec and MCP dialogs).
  if (/^(Always allow(?: .*)? in this project|Всегда разрешать(?: .*)? в этом проекте)$/u.test(name)) return 'allow_always';
  if (/^(Always allow(?: .*)? for this user|Всегда разрешать(?: .*)? для этого пользователя)$/u.test(name)) return 'allow_always';
  if (/^(No|Нет)(?:, [^\n]+)? \(esc\)$/iu.test(name)) return 'reject_once';
  return null;
}

/** Read only the active bottom dialog. A clipped header, menu or footer falls back to the live terminal panel. */
export function recogniseQwenPrompt(lines: readonly string[], kind: QwenPromptKind, cardId: string, at: string): QwenPrompt | null {
  const trust = kind === 'permission' ? recogniseQwenFolderTrust(lines) : undefined;
  if (trust) {
    const card: FeedQuestionCard = { kind: 'question', id: cardId, cardId, at, state: 'pending', via: 'terminal',
      toolName: 'qwen_folder_trust', toolUseId: null, toolInput: {}, questions: [{
        header: trust.title, question: trust.detail, options: trust.options.map(label => ({ label, description: null })),
        multiSelect: false, field: { id: 'answer', type: 'choice', required: true },
      }] };
    return { fingerprint: trust.fingerprint, card, folderTrust: trust, rows: [], previous: null, review: false };
  }
  let end = lines.findLastIndex(line => line.trim() !== '');
  const feedback = kind === 'question' && end >= 2 && lines[end - 1]!.trim() === '' &&
    feedbackFooters.some(([title, choices]) => lines[end]!.trim() === choices &&
      ['●\ufe0e ' + title, '● ' + title].includes(lines[end - 2]!.trim()));
  if (feedback) end = lines.slice(0, end - 2).findLastIndex(line => line.trim() !== '');
  if (end < 0 || !waiting.test(lines[end]!.trim())) return null;
  const start = lines.slice(0, end).findLastIndex(line => /^\s*\?\s+\S.*\s←\s*$/u.test(line) ||
    (kind === 'question' && /^\s*\?\s+AskUserQuestion\b.*\s← +[│█]\s*$/u.test(line)));
  if (start < 0) return null;
  let dialog = lines.slice(start, end);
  if (/[│█]\s*$/u.test(dialog[0]!)) {
    dialog = dialog.slice(0, dialog.findLastIndex(line => line.trim() !== '') + 1);
    const column = stringWidth(dialog[0]!.trimEnd());
    if (!dialog.some(line => /^ +[│█]\s*$/u.test(line)) ||
        dialog.some(line => !/ +[│█]\s*$/u.test(line) || stringWidth(line.trimEnd()) !== column)) return null;
    dialog = dialog.map(line => line.trimEnd().slice(0, -1).trimEnd());
  }
  const header = dialog[0]!.trim().slice(2, -1).trim();
  const body = dialog.slice(1).map(line => line.trimEnd());
  const question = /^AskUserQuestion\b/.test(header);
  if (question !== (kind === 'question')) return null;
  if (question) {
    const help = body.findLastIndex(line => line.trim() !== '');
    if (help < 0 || !/^↑\/↓:.*Enter:/u.test(body[help]!.trim())) return null;
    body.splice(help);
  }
  const last = body.findLastIndex(line => line.trim() !== '');
  const first = body.slice(0, last + 1).findLastIndex(line => option.exec(line)?.[3] === '1');
  if (first < 0) return null;
  const rows: Row[] = [];
  for (const line of body.slice(first, last + 1)) {
    const match = option.exec(line);
    if (match) {
      const [, marker, check, number, name] = match;
      if (Number(number) !== rows.length + 1) return null;
      rows.push({ number: number!, label: name!, description: null, selected: !!marker, checked: check === undefined ? null : check !== ' ' });
    } else if (question && rows.length && /^\s{4,}\S/.test(line)) {
      const row = rows[rows.length - 1]!;
      row.description = [row.description, line.trim()].filter(Boolean).join(' ');
    } else if (line.trim()) return null;
  }
  if (rows.length < 2 || rows.filter(row => row.selected).length !== 1) return null;
  const prefix = body.slice(0, first).filter(line => line.trim() !== '').map(line => line.trim());
  if (!prefix.length) return null;
  const base = { id: cardId, cardId, at, state: 'pending' as const, via: 'terminal' as const, toolUseId: null, toolInput: {}, toolName: header.split(/\s+/)[0]! };
  let card: Card;
  let review = false;
  let previous: string | null = null;
  let identity: unknown;
  if (!question) {
    const permissionOptions: NonNullable<FeedPermissionCard['permissionOptions']> = [];
    for (const row of rows) {
      const choice = permissionKind(row.label);
      if (!choice) return null;
      permissionOptions.push({ optionId: row.number, name: row.label, kind: choice });
    }
    card = { ...base, kind: 'permission', suggestions: [], notified: true, permissionOptions,
      permissionPreview: [{ type: 'text', text: [header, ...body.slice(0, first)].join('\n').trim() }] };
    identity = [header, body.slice(0, first), permissionOptions];
  } else {
    const lastRow = rows.at(-1)!;
    review = rows.length === 2 && submitLabel.test(rows[0]!.label) && cancelLabel.test(lastRow.label);
    if (!review && !(customLabel.test(lastRow.label) || (lastRow.selected && lastRow.label.startsWith('> ')))) return null;
    const choices = review ? rows : rows.slice(0, -1);
    const multi = choices[0]!.checked !== null;
    if (new Set(choices.map(row => row.label)).size !== choices.length) return null;
    if (choices.some(row => (row.checked !== null) !== multi)) return null;
    // Headers and review answers precede a blank line, then the question (which may wrap).
    let qStart = first - 1;
    while (qStart >= 0 && !body[qStart]!.trim()) qStart--;
    const qEnd = qStart;
    while (qStart > 0 && body[qStart - 1]!.trim()) qStart--;
    const title = body.slice(qStart, qEnd + 1).map(line => line.trim()).join(' ');
    if (!title) return null;
    const options = choices.map(row => ({ label: row.label, description: row.description }));
    // Qwen also offers the left arrow on its review tab. It can skip a tab after a custom answer on 0.27.2.
    if (review && prefix.some(line => line.includes('▸'))) {
      previous = 'Previous question';
      options.push({ label: previous, description: null });
    }
    card = { ...base, kind: 'question', questions: [{ question: title, header: null, options, multiSelect: multi,
      ...(review ? { field: { id: 'answer', type: 'choice' as const, required: true } } : {}) }],
      ...(review ? { formPrompt: prefix.slice(0, -1).filter(line => !line.includes('▸')).join('\n') } : {}) };
    identity = [header, prefix.map(line => line.includes('▸') ? line.replace(/ ✓/g, '') : line), options, review, multi];
  }
  return { fingerprint: createHash('sha256').update(JSON.stringify(identity)).digest('hex'), card, rows, review, previous, feedback };
}

/**
 * The window joins picked multiSelect labels and the «Other» text with ', ' (`answerOf`, the shared
 * chat/island wire format) and sends no `values`. Restore the labels by longest match so a label
 * containing ', ' is not split; whatever no label matches is the free «Other» text.
 */
function splitJoinedAnswer(answer: string, labels: readonly string[]): { values: string[]; other: string } {
  const longestFirst = [...labels].sort((a, b) => b.length - a.length);
  const values: string[] = [];
  let rest = answer;
  for (;;) {
    const label = longestFirst.find(entry => rest === entry || rest.startsWith(entry + ', '));
    if (label === undefined) break;
    values.push(label);
    rest = rest === label ? '' : rest.slice(label.length + 2);
  }
  return { values, other: rest };
}

export async function answerQwenPrompt(prompt: QwenPrompt, decision: FeedDecision, io: IO): Promise<boolean> {
  const { card } = prompt;
  if (prompt.folderTrust) {
    if (decision.kind !== 'question') return false;
    const trust = prompt.folderTrust;
    const answer = decision.values?.answer ?? decision.answers[trust.detail];
    const target = trust.options.findIndex(option => option === answer);
    const selected = () => {
      const seen = io.current() ? recogniseQwenFolderTrust(io.screen() ?? []) : undefined;
      return seen?.fingerprint === trust.fingerprint ? seen.selected : undefined;
    };
    return await confirmStartupChoice(target, trust.options.length, selected, io.write) === 'done';
  }
  function read(allowFeedback = false): QwenPrompt | null {
    const lines = io.current() ? io.screen() : undefined;
    const seen = lines && recogniseQwenPrompt(lines, card.kind, card.id, card.at);
    return seen?.fingerprint === prompt.fingerprint && (allowFeedback || !seen.feedback) ? seen : null;
  }
  async function waitFor(check: (seen: QwenPrompt) => boolean): Promise<boolean> {
    for (let i = 0; i < 24; i++) {
      const seen = read();
      if (!seen) return false;
      if (check(seen)) return true;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    return false;
  }
  function send(keys: string, check?: (seen: QwenPrompt) => boolean): boolean {
    const seen = read();
    if (!seen || (check && !check(seen))) return false;
    io.write(keys);
    return true;
  }
  if (card.kind === 'permission' && decision.kind === 'permission') {
    const choice = card.permissionOptions?.find(item => item.optionId === decision.optionId);
    if (!choice || decision.behavior !== (choice.kind.startsWith('allow') ? 'allow' : 'deny')) return false;
    return send(choice.optionId);
  }
  if (card.kind !== 'question' || decision.kind !== 'question') return false;
  const question = card.questions[0]!;
  const submitted = decision.values?.answer;
  const answer = prompt.review && typeof submitted === 'string' ? submitted : decision.answers[question.question];
  const custom = prompt.rows.at(-1)!;
  const validText = (text: unknown): text is string => typeof text === 'string' && !!text &&
    text.length <= FEED_DECISION_ANSWER_LIMIT && !/[\p{Cc}\p{Cf}]/u.test(text) && text.trim() === text;
  async function prepare(): Promise<boolean> {
    const seen = read(true);
    if (!seen || (!seen.review && seen.rows.at(-1)!.selected)) return false;
    if (!seen.feedback) return true;
    const rows = JSON.stringify(seen.rows);
    // Native 0 dismisses the optional rating without voting. No answer key may reach that overlay.
    io.write('0');
    for (let i = 0; i < 24; i++) {
      const next = read(true);
      if (!next || JSON.stringify(next.rows) !== rows) return false;
      if (!next.feedback) return true;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    return false;
  }
  async function typeOther(text: string, valid: (seen: QwenPrompt) => boolean = () => true): Promise<boolean> {
    if (!validText(text)) return false;
    const empty = (s: QwenPrompt) => valid(s) && s.rows.at(-1)!.selected && customLabel.test(s.rows.at(-1)!.label.slice(2));
    const seen = read();
    if (!seen || seen.rows.at(-1)!.selected) return false;
    if (!send(custom.number, s => valid(s) && !s.rows.at(-1)!.selected)) return false;
    if (!await waitFor(empty) || !send(text, empty)) return false;
    const echoed = (s: QwenPrompt) => valid(s) && s.rows.at(-1)!.selected && s.rows.at(-1)!.label === '> ' + text;
    return await waitFor(echoed) && send('\r', echoed);
  }
  if (question.multiSelect) {
    const choices = prompt.rows.slice(0, -1);
    const joined = decision.values?.choices === undefined && typeof answer === 'string'
      ? splitJoinedAnswer(answer, choices.map(row => row.label))
      : null;
    const values = decision.values?.choices ?? joined?.values ?? [];
    if (!Array.isArray(values)) return false;
    const other = decision.values?.other ?? joined?.other ?? '';
    if (typeof other !== 'string' || (!values.length && !other) ||
        (other !== '' && !validText(other)) || values.some(value => !choices.some(row => row.label === value))) return false;
    if (!await prepare()) return false;
    for (const row of choices) {
      const seen = read();
      if (!seen || seen.rows.at(-1)?.selected || seen.rows.at(-1)?.checked) return false;
      const want = values.includes(row.label);
      const matches = (s: QwenPrompt) => s.rows[Number(row.number) - 1]!;
      if (matches(seen).checked === want) continue;
      if (!send(row.number) || !await waitFor(s => matches(s).selected)) return false;
      if (!send(' ', s => matches(s).selected && matches(s).checked !== want) || !await waitFor(s => matches(s).checked === want)) return false;
    }
    const selected = (s: QwenPrompt) => !s.rows.at(-1)!.checked &&
      s.rows.slice(0, -1).every(row => row.checked === values.includes(row.label));
    if (!await waitFor(selected)) return false;
    if (other) return typeOther(other, s => s.rows.slice(0, -1).every(row => row.checked === values.includes(row.label)));
    return send('\r', s => !s.rows.at(-1)!.selected && selected(s));
  }
  if (!answer) return false;
  const choice = (prompt.review ? prompt.rows : prompt.rows.slice(0, -1)).find(row => row.label === answer);
  if (prompt.review ? !choice && answer !== prompt.previous : !choice && !validText(answer)) return false;
  if (!await prepare()) return false;
  if (prompt.review) {
    if (answer === prompt.previous) return send('\x1b[D');
    if (!choice || !send(choice.number) || !await waitFor(s => s.rows.find(row => row.number === choice.number)?.selected === true)) return false;
    return send('\r', s => s.rows.find(row => row.number === choice.number)?.selected === true);
  }
  if (choice) return send(choice.number, s => !s.rows.at(-1)!.selected);
  return typeOther(answer);
}
