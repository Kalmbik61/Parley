import { newClientMsgId } from '@parley/remote-client';

// The long-press sheet of a chat message (D1 §9.2, plan A42): which actions an agent reply and an own prompt offer. No React.

export type MessageKind = 'agent' | 'prompt';
export type ActionId = 'copy' | 'reply' | 'again' | 'select';

export interface ActionFacts {
  kind: MessageKind;
  /** `pty.send` is in `hello.methods` (the Mac switch is on). */
  hasPtySend: boolean;
  /** The session is closed. */
  closed: boolean;
}

export interface Action {
  id: ActionId;
  title: string;
}

/** D1 order: Copy, Reply, Send again (own prompt only, with `pty.send`, session not closed), Select Text. */
export function messageActions(f: ActionFacts): Action[] {
  const items: Action[] = [
    { id: 'copy', title: 'Copy' },
    { id: 'reply', title: 'Reply' },
  ];
  if (f.kind === 'prompt' && f.hasPtySend && !f.closed) items.push({ id: 'again', title: 'Send again' });
  items.push({ id: 'select', title: 'Select Text' });
  return items;
}

/** Copy: an agent reply — its Markdown source; a prompt — its text without edge whitespace (as the window). */
export const copyText = (kind: MessageKind, text: string): string => (kind === 'prompt' ? text.trim() : text);

/** Send again: the same text, a NEW `clientMsgId` (the old one belongs to the first send and its bridge cache). */
export function againMessage(text: string, now: number): { text: string; clientMsgId: string } {
  return { text, clientMsgId: newClientMsgId(now) };
}
