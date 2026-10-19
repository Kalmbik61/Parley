/** Все тексты бота — только английский, по одной константе или функции на фразу. */

export type ReceiptKind =
  | 'allowed'
  | 'denied'
  | 'answered'
  | 'elsewhere'
  | 'stale'
  | 'accepted'
  | 'returned'
  | 'revised'
  | 'sent'
  | 'done'
  | 'cancelled'
  | 'unlinked'
  | 'restarted';

const RECEIPTS: Record<ReceiptKind, string> = {
  allowed: 'Allowed',
  denied: 'Denied',
  answered: 'Answered',
  elsewhere: 'Handled elsewhere',
  stale: 'No longer current',
  accepted: 'Accepted',
  returned: 'Returned with a note',
  revised: 'Revised',
  sent: 'Sent',
  done: 'Done',
  cancelled: 'Cancelled',
  unlinked: 'Unlinked',
  restarted: 'Restarted',
};

export const T = {
  linked: (macName: string): string => `Linked to ${macName}. You will get requests and updates from your Parley agents here.`,
  help: 'Parley bot commands:\n/status - what the agents are doing\n/unlink - disconnect this chat\n/help - this text\n\nSend text or a voice message to talk to the assistant.',
  assistantOff: 'The assistant is turned off in Parley settings.',
  voiceOff: 'Voice messages are turned off in Parley settings.',
  voiceTooLong: 'This voice message is too long. Please send a shorter one.',
  voiceFailed: 'Could not recognize the voice message. Please try again or send text.',
  tooLong: 'That message is too long. Please send a shorter one.',
  noLongerCurrent: 'This request is no longer current.',
  answeredAtMac: 'Already answered on the Mac.',
  expired: 'This card has expired.',
  returnNotePrompt: (from: string): string => `Reply to this message with a note for ${from}.`,
  otherPrompt: 'Reply to this message with your answer.',
  unlinked: 'Unlinked. This chat will no longer get messages from Parley.',
  restarted: 'Parley restarted. Cards that were open are closed.',
  reminderOff: (id: string, what: string): string => `Reminder ${id} turned off: ${what}`,
  sentTo: (name: string): string => `Sent to ${name}.`,
  heard: (text: string): string => `Heard: ${text}`,
  needsYou: (name: string, where: string): string => `${name} needs you in ${where}`,
  finished: (name: string, where: string): string => `${name} finished in ${where}`,
  letter: (from: string, where: string): string => `Letter from ${from} in ${where}`,
  waitingAtMac: (name: string): string => `${name} is waiting for you at the Mac.`,
  revised: 'Revised version',
  cardTitle: (name: string, where: string): string => `${name} - ${where}`,
  expiresWithTurn: 'Valid until the agent turn ends.',
  receipt: (kind: ReceiptKind, time: string): string => `${RECEIPTS[kind]} at ${time}`,
} as const;

/** Подписи inline-кнопок. */
export const B = {
  allow: 'Allow',
  allowAlways: 'Always allow',
  deny: 'Deny',
  other: 'Other…',
  accept: 'Accept plan',
  approveEach: 'Approve each edit',
  returnNote: 'Return…',
  send: 'Send',
  create: 'Create',
  cancel: 'Cancel',
  acceptDecision: 'Accept',
} as const;
