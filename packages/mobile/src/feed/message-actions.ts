import { newClientMsgId } from '@parley/remote-client';
import { messageProblem, type ComposerMode } from './send';

// The long-press sheet of a chat message (D1 §9.2, plan A42): which actions an agent reply and an own prompt offer. No React.

export type MessageKind = 'agent' | 'prompt';
export type ActionId = 'copy' | 'reply' | 'again' | 'select';

export interface ActionFacts {
  kind: MessageKind;
  /** `pty.send` is in `hello.methods` (the Mac switch is on). */
  hasPtySend: boolean;
  /** The session is closed. */
  closed: boolean;
  /**
   * The field would send now (D1 §9.5 rules: connected, not blocked, not switched off, not busy or waking, a sleeping
   * session with Resume) and the text fits 16 KB. Send again is shown but off otherwise.
   */
  canSend: boolean;
}

export interface Action {
  id: ActionId;
  title: string;
  disabled?: boolean;
}

/** D1 order: Copy, Reply, Send again (own prompt only, with `pty.send`, session not closed), Select Text. */
export function messageActions(f: ActionFacts): Action[] {
  const items: Action[] = [
    { id: 'copy', title: 'Copy' },
    { id: 'reply', title: 'Reply' },
  ];
  if (f.kind === 'prompt' && f.hasPtySend && !f.closed) items.push({ id: 'again', title: 'Send again', ...(f.canSend ? {} : { disabled: true }) });
  items.push({ id: 'select', title: 'Select Text' });
  return items;
}

/** Copy: an agent reply — its Markdown source; a prompt — its text without edge whitespace (as the window). */
export const copyText = (kind: MessageKind, text: string): string => (kind === 'prompt' ? text.trim() : text);

/** Send again: the same text, a NEW `clientMsgId` (the old one belongs to the first send and its bridge cache). */
export function againMessage(text: string, now: number): { text: string; clientMsgId: string } {
  return { text, clientMsgId: newClientMsgId(now) };
}

/**
 * Why Send again cannot go now (null — it can): the field's own rules (D1 §9.5), so the VoiceOver action, which stays in
 * the list whenever `pty.send` exists, refuses with a reason instead of bypassing them (critic A42 m17).
 */
export function sendAgainReason(f: { mode: ComposerMode; busy: boolean; text: string }): string | null {
  if (f.mode.kind === 'hidden') return f.mode.text === '' ? 'Answer the card first' : f.mode.text;
  if (f.busy) return 'Wait — another message is on its way';
  if (!f.mode.sendEnabled) return f.mode.note ?? 'Not available right now';
  return messageProblem(f.text);
}
