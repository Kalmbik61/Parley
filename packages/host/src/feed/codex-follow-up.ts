import { readCodexFollowUpScreen, type CodexFollowUpEditor } from '@parley/core/codex-follow-up-screen';
import type { FeedQuestion } from '@parley/core';
import { ANSWER_POLL_MS, ANSWER_STEP_MAX_MS } from './terminal-answer.js';

interface FollowUpIO {
  /** An absent screen means that the process, transcript, or pending card changed. */
  read(): string[] | undefined;
  write(key: string): void;
  sleep(ms: number): Promise<void>;
}

const NEXT = '\x1b[1;2D';
const squash = (text: string): string => text.replace(/\s+/gu, ' ').trim();

function matches(editor: CodexFollowUpEditor, question: FeedQuestion): boolean {
  if (editor.title !== squash(question.question)) return false;
  if (!question.options.length) return editor.options.length === 0;
  return editor.options.length === question.options.length + 1 &&
    question.options.every((option, i) => squash(option.label) === editor.options[i]);
}

/** Codex 0.166 asynchronous follow-ups use a separate editor from Plan-mode questions. */
export async function submitCodexFollowUp(io: FollowUpIO, question: FeedQuestion, answer: string, pending: readonly FeedQuestion[]): Promise<boolean> {
  if (!answer.trim() || /\p{Cc}/u.test(answer)) return false;
  const read = () => {
    const lines = io.read();
    return lines && readCodexFollowUpScreen(lines);
  };
  // Check on the same tick as each write, including when a human is also using Terminal.
  const waitFor = async (accept: (editor: CodexFollowUpEditor) => boolean): Promise<CodexFollowUpEditor | null> => {
    for (let elapsed = 0; elapsed <= ANSWER_STEP_MAX_MS; elapsed += ANSWER_POLL_MS) {
      const current = read();
      if (current === undefined) return null;
      if (current && current !== 'collapsed' && accept(current)) return current;
      if (elapsed < ANSWER_STEP_MAX_MS) await io.sleep(ANSWER_POLL_MS);
    }
    return null;
  };
  const identifiesTarget = (current: CodexFollowUpEditor): boolean => {
    if (!matches(current, question)) return false;
    const candidates = pending.filter(entry => matches(current, entry));
    if (candidates.length === 1) return true;
    const index = pending.indexOf(question);
    return index >= 0 && current.position === `${index + 1} of ${pending.length}`;
  };
  let editor = read();
  if (editor === 'collapsed') {
    io.write(NEXT);
    editor = await waitFor(() => true);
  }
  const visited = new Set<string>();
  while (editor && !identifiesTarget(editor)) {
    const visible = editor;
    const position = visible.position;
    if (!visible.next || visited.has(position) || !pending.some(entry => matches(visible, entry))) return false;
    visited.add(position);
    io.write(NEXT);
    editor = await waitFor(current => current.position !== position);
  }
  if (!editor) return false;
  const currentTarget = (): CodexFollowUpEditor | null => {
    const value = read();
    return value && value !== 'collapsed' && identifiesTarget(value) ? value : null;
  };
  editor = currentTarget();
  if (!editor) return false;
  const choice = question.options.findIndex(option => option.label === answer);
  if (choice >= 0) {
    if (choice >= 9) return false;
    io.write(String(choice + 1));
    return true;
  }
  const other = question.options.length;
  const draft = (current: CodexFollowUpEditor): string => other ? current.options[other]! : current.input;
  const placeholder = other ? 'Other' : 'Type your answer';
  if (other && editor.selected !== other) {
    if (other >= 9 || draft(editor) !== placeholder) return false;
    io.write(String(other + 1));
    await waitFor(current => identifiesTarget(current) && current.selected === other);
  }
  const writable = (): CodexFollowUpEditor | null => {
    const current = currentTarget();
    return current && (!other || current.selected === other) ? current : null;
  };
  editor = writable();
  if (!editor) return false;
  const expected = squash(answer);
  if (draft(editor) === placeholder) {
    io.write('\x1b[200~' + answer + '\x1b[201~');
    await waitFor(current => identifiesTarget(current) && draft(current) === expected);
  }
  // A retry may find the same complete draft. Never append to an unrelated draft.
  editor = writable();
  if (!editor || draft(editor) !== expected) return false;
  io.write('\r');
  return true;
}
