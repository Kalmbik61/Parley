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
  notReadyYet: 'The agent is not ready for the answer yet - try again',
  couldNot: (reason: string): string => `Could not do that: ${reason}`,
  newConversation: 'Started a new conversation with the assistant.',
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
  permissionTitle: (tool: string): string => `Permission: ${tool}`,
  questionTitle: 'Question',
  questionOf: (index: number, total: number): string => `Question ${index} of ${total}`,
  planTitle: 'Plan',
  decisionTitle: 'Decision',
  completionTitle: 'Completion',
  assistantTo: (target: string, where: string): string => `To ${target} · ${where}`,
  assistantNewRoom: (where: string): string => `New room in ${where}`,
  assistantRoomLine: (title: string, members: string, lead: string): string => `${title} · ${members} · lead ${lead}`,
  assistantNote: (text: string): string => `Note: ${text}`,
  assistantAnswerLine: (question: string, answer: string): string => `${question} → ${answer}`,
  assistantAcceptDecision: (room: string): string => `Accept decision in ${room}?`,
  assistantReturnDecision: (lead: string): string => `Return to ${lead} for rework?`,
  assistantAskTitle: (verb: string, name: string): string => `${verb} ${name}?`,
  assistantPlanTitle: (verb: string, name: string): string => `${verb} of ${name}?`,
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
  answer: 'Answer',
  return: 'Return',
  wakeAndSend: 'Wake and send',
} as const;
