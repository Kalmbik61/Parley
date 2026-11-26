import type { KimiFollowUpMode } from '@parley/core';
import type { KimiRequest } from '@parley/protocol';

export const KIMI_STEER_KEY = '\x13';
export const KIMI_STEER_DRAFT_KEY = '\x1b[13;5u';
export const KIMI_QUEUE_KEY = '\x11';

export function isKimiSubmitKey(key: string): boolean {
  return key === '\r' || key === KIMI_STEER_KEY || key === KIMI_STEER_DRAFT_KEY || key === KIMI_QUEUE_KEY;
}

export function kimiSelectiveSteerKey(mode: KimiFollowUpMode): typeof KIMI_STEER_DRAFT_KEY | '\r' {
  return mode === 'queue' ? KIMI_STEER_DRAFT_KEY : '\r';
}

const activelyWorking = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+Working for \d/i;
const working = /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]?\s*(?:Working for \d|Starting a new session|Compacting (?:context|conversation))/i;
const liveQueueHint = /^↑ to edit · ctrl-s to steer immediately$/i;
const divider = /^─{5,}$/;
const queueBarrier = /^❯\s+(?:\/compact(?:\s|$)|Compact, then switch to )/i;
const queueHint = /^.*↑.*(?:ctrl-s to steer immediately|will send after (?:compaction|current task))$/i;
const dialog = /Trust this folder\?|Ready to submit your answers\?|^(?:Select permission mode|Follow-up behavior)$|▶\s*\d+\. (?:Approve|Reject)|^\s*\?\s+\S|(?:Sign in|Log in) to (?:Kimi|continue)/i;
const top = /^╭─+(?: ↑ [1-9]\d* more ─+)?╮$/;
const bottom = /^╰─+(?: ↓ [1-9]\d* more ─+)?╯$/;

/** A stock Kimi composer must be the active bottom-most framed editor, not an old prompt line. */
export function kimiComposer(view: readonly string[], mode: 'idle' | 'steer' | 'selective-steer' = 'idle'): { empty: boolean } | undefined {
  const lines = view.map(line => line.trim()).filter(Boolean);
  const end = lines.findLastIndex(line => bottom.test(line));
  if (end < 2 || lines.length - end > 3) return undefined;
  let start = end - 1;
  while (/^│.*│$/.test(lines[start] ?? '')) start--;
  if (!top.test(lines[start] ?? '') || !/^│ >.*│$/.test(lines[start + 1] ?? '')) return undefined;
  const before = lines.slice(0, start);
  let status = start - 1;
  if (mode === 'selective-steer') {
    const boundary = before.findLastIndex(line => divider.test(line));
    // A divider, visible older prompt and current queue affordance separate the
    // working line from the editor. An opaque or compacting pane is not proof.
    if (boundary < 1 || start - boundary < 3 || !liveQueueHint.test(before.at(-1) ?? '') ||
        before.slice(boundary + 1, -1).some(line => !/^❯\s+\S/.test(line) || queueBarrier.test(line))) return undefined;
    status = boundary - 1;
  }
  const outside = [...before.slice(Math.max(0, status - 3)), ...lines.slice(end + 1)];
  if (outside.some(line => dialog.test(line))) return undefined;
  if (mode !== 'idle') {
    // Bulk Ctrl+S is safe only when a current working status directly adjoins
    // the editor. A separate positive shape is required for selective steer.
    if (!activelyWorking.test(lines[status] ?? '') ||
        outside.some(line => working.test(line) && !activelyWorking.test(line))) return undefined;
  } else if (outside.some(line => working.test(line) || queueHint.test(line))) return undefined;
  // Stock Kimi shows `>` on the first visible row, not necessarily the first input line.
  return { empty: end === start + 2 && !lines[start]!.includes('↑') && !lines[end]!.includes('↓') && /^│ >\s*│$/.test(lines[start + 1]!) };
}

export function kimiModeMenu(view: readonly string[]): { selected: number; current: number } | undefined {
  const lines = view.map(line => line.trim());
  const open = lines.findLastIndex(line => line === 'Select permission mode');
  if (open < 0) return;
  const options = lines.slice(open + 1).map(line => line.match(/^(❯\s+)?(Always Ask|Ask When Needed|Never Ask)(\s+← current)?$/)).filter(row => row !== null);
  if (options.map(row => row[2]).join('|') !== 'Always Ask|Ask When Needed|Never Ask') return;
  const selected = options.findIndex(row => row[1] !== undefined);
  const current = options.findIndex(row => row[3] !== undefined);
  return selected < 0 || current < 0 ? undefined : { selected, current };
}

export function kimiStartupDialog(view: readonly string[]): 'trust' | 'login' | undefined {
  const lines = view.map(line => line.trim());
  if (lines.includes('Trust this folder?') && lines.includes('↑↓ navigate · Enter select · Esc exit')) return 'trust';
  if (lines.some(line => /^(?:│\s*)?Sign in to Kimi Code(?:\s*│)?$/.test(line))) return 'login';
}

export function kimiLazyStartup(view: readonly string[]): boolean {
  return view.some(line => line.trim() === 'No session yet — one will be created on your first message.');
}

/** Optional startup diagnostic. The label is not an input capability. */
export function kimiScreenVersion(view: readonly string[]): string | undefined {
  return view.map(line => line.match(/^\s*│\s*Version:\s+([\w.+-]{1,64})\s*│\s*$/)?.[1]).find(value => value !== undefined);
}

export function kimiStartedId(view: readonly string[]): string | undefined {
  return view.map(line => line.match(/^\s*Started a new session \((session_[a-f0-9-]+)\)\.\s*$/)?.[1]).findLast(value => value !== undefined);
}

export function kimiParleyCount(view: readonly string[]): number | undefined {
  const row = view.map(line => line.match(/^\s*│\s+parley\s+connected\s+stdio\s+(\d+) tools?\s*│\s*$/)?.[1]).findLast(value => value !== undefined);
  return row === undefined ? undefined : Number(row);
}

type Option = Extract<KimiRequest, { kind: 'permission' }>['options'][number];
const labels: readonly [string, Option['kind']][] = [
  ['Approve once', 'allow_once'],
  ['Approve for this session', 'allow_always'],
  ['Reject', 'reject_once'],
  ['Reject with feedback', 'reject_always'],
];

export function kimiPermissionMenu(view: readonly string[], action: string): { options: Option[]; fingerprint: string } | undefined {
  if (!action || action.length > 400 || /[\r\n]/.test(action)) return;
  const lines = view.map(line => line.trim()).filter(Boolean).slice(-18);
  if (lines.includes('Type feedback · ↵ submit.')) return;
  const title = lines.findLastIndex(line => line === `▶ ${action}?` || line === `${action}?`);
  if (title < 0) return;
  const options: Option[] = [];
  let selected = 0;
  const first = lines.findIndex((line, index) => index > title && /^▶?\s*\d+\. Approve once$/.test(line));
  if (first < 0 || first - title > 4) return;
  for (const [index, [name, kind]] of labels.entries()) {
    const row = lines[first + index]?.match(/^(▶\s*)?(\d)\. (.*)$/);
    if (!row || row[3] !== name || options.some(option => option.optionId === row[2])) return;
    if (row[1]) selected++;
    options.push({ optionId: row[2]!, name, kind });
  }
  if (selected !== 1 || lines.slice(first + labels.length).some(line => /^│ >/.test(line))) return;
  return { options, fingerprint: lines.slice(title, first + labels.length).join('\n') };
}

export function kimiQuestionMenu(view: readonly string[], question: string, answers: readonly string[]) {
  const lines = view.map(line => line.trim()).filter(Boolean).slice(-19);
  const start = lines.findLastIndex(line => line === `? ${question}`);
  if (start < 0 || answers.length < 2 || answers.length > 4) return;
  const options = lines.slice(start + 1, start + 1 + answers.length).map(line => line.match(/^(?:→\s*)?\[(\d)\] (.*)$/));
  if (options.length !== answers.length || options.some((row, i) => row?.[2] !== answers[i])) return;
  const extra = lines[start + 1 + answers.length]?.match(/^(?:→\s*)?\[(\d)\] (.*)$/);
  if (extra && (extra[2] !== 'Other' || answers.includes('Other'))) return;
  const labels = extra ? [...answers, 'Other'] : [...answers];
  const keys = [...options.map(row => row![1]!), ...(extra ? [extra[1]!] : [])];
  if (new Set(keys).size !== keys.length) return;
  return { keys, labels, fingerprint: lines.slice(start, start + 1 + labels.length).join('\n') };
}

export function kimiQuestionReview(view: readonly string[], question: string, answer: string): boolean {
  const lines = view.map(line => line.trim()).filter(Boolean).slice(-14);
  const questionAt = lines.findIndex(line => line === `Q  ${question}` || line === `Q ${question}`);
  return questionAt >= 0 && /^→\s+/.test(lines[questionAt + 1] ?? '') &&
    lines[questionAt + 1]!.replace(/^→\s+/, '') === answer &&
    lines.includes('Ready to submit your answers?') && lines.some(line => /^→\s+\[\d\] Submit$/.test(line));
}
