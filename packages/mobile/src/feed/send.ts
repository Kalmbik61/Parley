// Messaging an agent from the phone (D1 §9.5): the Face ID gate, `pty.send`, and what each outcome means for the bubble
// and the composer. No React. Nothing is retried by itself: a retry is a tap, and after `lost` it carries the same key.
import type { RemoteClient, SendMessageOutcome, SessionRef } from '@parley/remote-client';
import type { Approve, NotSent } from '../auth/approve';
import { TEXT_MAX_BYTES, utf8Length } from '../launch/launch-model';

export const COUNTER_FROM_BYTES = 15 * 1024;
export const TOO_LONG = 'Too long for one message — 16 KB max';

/** `null` — the text may be sent. */
export function messageProblem(text: string): string | null {
  if (text.trim() === '') return 'Write a message';
  if (utf8Length(text) > TEXT_MAX_BYTES) return TOO_LONG;
  return null;
}

/** "15.2 / 16 KB" from 15 KB up; `null` below. */
export function sizeCounter(text: string): string | null {
  const bytes = utf8Length(text);
  return bytes < COUNTER_FROM_BYTES ? null : `${(bytes / 1024).toFixed(1)} / 16 KB`;
}

/** What the sent message shows (the bubble's caption) and what happens to the text. */
export type SentUi =
  | { kind: 'sent' }
  /** Taken into the agent's queue behind the running turn. */
  | { kind: 'queued' }
  | { kind: 'typed-not-sent'; message: string }
  | { kind: 'unconfirmed' }
  | { kind: 'failed'; message: string; retry: boolean; edit: boolean; textBack: boolean; hideComposer: boolean };

export const OFF_ON_MAC_SEND = 'Not sent — messaging from the phone is turned off on your Mac';

const TYPED: Record<string, string> = {
  draft: 'Typed into the terminal, not sent — press Enter at your Mac',
  input: 'Typed into the terminal, not sent — press Enter at your Mac',
  restarted: 'Typed into the terminal, not sent — the session restarted',
  'blocked-before-enter': 'Typed into the terminal, not sent — the agent is waiting for your answer',
};

/** `turnRunning`: the agent was in a turn when the message went. */
export function uiOfSend(outcome: SendMessageOutcome, turnRunning: boolean): SentUi {
  if (outcome.outcome === 'lost') return { kind: 'unconfirmed' };
  if (outcome.outcome === 'rejected') {
    if (outcome.code === 'unknown_method') return { kind: 'failed', message: OFF_ON_MAC_SEND, retry: false, edit: false, textBack: true, hideComposer: true };
    if (outcome.code === 'not_found') return { kind: 'failed', message: "Not sent — the session isn't running", retry: false, edit: false, textBack: true, hideComposer: false };
    const host = outcome.message.trim() === '' ? outcome.code : outcome.message;
    return { kind: 'failed', message: `Not sent — ${host}`, retry: true, edit: false, textBack: false, hideComposer: false };
  }
  if (outcome.submitted) return turnRunning ? { kind: 'queued' } : { kind: 'sent' };
  if (outcome.inserted) return { kind: 'typed-not-sent', message: TYPED[outcome.reason ?? ''] ?? TYPED.draft! };
  switch (outcome.reason) {
    case 'busy':
      return { kind: 'failed', message: 'Not sent — the agent is busy with another message', retry: true, edit: false, textBack: false, hideComposer: false };
    case 'blocked':
      return { kind: 'failed', message: 'Not sent — the agent is waiting for your answer', retry: false, edit: false, textBack: true, hideComposer: false };
    case 'no-paste-mode':
      return { kind: 'failed', message: "Not sent — this agent doesn't accept multi-line messages", retry: false, edit: true, textBack: false, hideComposer: false };
    default:
      return { kind: 'failed', message: 'Not sent', retry: true, edit: false, textBack: false, hideComposer: false };
  }
}

export type GatedSend = { cancelled: true; reason: NotSent } | { cancelled: false; outcome: SendMessageOutcome };

/**
 * Face ID first — nothing is sent if it fails. `clientMsgId` is given only for a retry after `lost` (the bridge returns the
 * earlier answer, the agent gets the message once); a new message, or a retry of one that never reached the agent
 * (`busy`, host error), has no key and gets a fresh one.
 */
export async function sendToAgent(
  client: Pick<RemoteClient, 'sendMessage'>,
  approve: Approve,
  ref: SessionRef,
  text: string,
  clientMsgId?: string,
): Promise<GatedSend> {
  const asked = await approve('send');
  if (asked !== 'ok') return { cancelled: true, reason: asked };
  return { cancelled: false, outcome: await client.sendMessage({ ref, text, ...(clientMsgId !== undefined ? { clientMsgId } : {}) }) };
}

export type ComposerMode =
  | { kind: 'input'; sendEnabled: boolean; note: string | null }
  | { kind: 'hidden'; text: string };

export interface ComposerFacts {
  hasMethod: boolean;
  closed: boolean;
  sleeping: boolean;
  /** `needs-you` with a card the phone answers (the card panel replaces the composer). */
  hasCard: boolean;
  blockedNoCard: boolean;
  working: boolean;
  online: boolean;
  limitNote: string | null;
  feedReady: boolean;
}

/** D1 §9.5 table: what replaces or constrains the composer. The card panel is drawn by the screen, so `hasCard` hides it. */
export function composerMode(f: ComposerFacts): ComposerMode {
  if (!f.hasMethod) return { kind: 'hidden', text: 'Messaging agents from the phone is turned off on your Mac' };
  if (f.closed) return { kind: 'hidden', text: 'This session is closed' };
  if (f.sleeping) return { kind: 'hidden', text: 'Sleeping — resume it on your Mac to message it' };
  if (f.hasCard) return { kind: 'hidden', text: '' };
  if (f.blockedNoCard) return { kind: 'input', sendEnabled: false, note: 'Answer at your Mac first' };
  const note = !f.online ? 'Reconnecting — actions are paused' : f.working ? 'The agent is working — your message waits for this turn' : f.limitNote;
  return { kind: 'input', sendEnabled: f.online && f.feedReady, note };
}
