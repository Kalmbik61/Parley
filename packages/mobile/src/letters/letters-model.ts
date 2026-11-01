// Letters (D1 §10.2): direct letters to the human, read-only. Newest first; the dot = unread on the Mac.
import type { Message } from '@parley/core';
import { workKeyOf, type RemoteState } from '@parley/remote-client';

export interface LetterRow {
  key: string;
  workKey: string;
  projectPath: string;
  workId: string;
  workTitle: string;
  message: Message;
  /** Not read on the Mac and not opened on this phone. */
  unread: boolean;
}

/** `opened`: ids of letters opened on this phone (they sink below the rest, the Mac's counter is not touched). */
export function selectLetters(state: RemoteState, opened: ReadonlySet<string> = new Set()): LetterRow[] {
  const rows: LetterRow[] = [];
  for (const work of state.snapshot?.works ?? []) {
    const workKey = workKeyOf(work.projectPath, work.id);
    for (const message of Object.values(state.letters[workKey] ?? {})) {
      rows.push({
        key: `${workKey}\u0000${message.id}`,
        workKey,
        projectPath: work.projectPath,
        workId: work.id,
        workTitle: work.title,
        message,
        unread: message.readBy.human === undefined && !opened.has(message.id),
      });
    }
  }
  return rows.sort((a, b) => Number(b.unread) - Number(a.unread) || b.message.at.localeCompare(a.message.at));
}

export const letterUnreadTotal = (state: Pick<RemoteState, 'letterUnread'>): number =>
  Object.values(state.letterUnread).reduce((a, b) => a + b, 0);

export function timeLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now.getTime() - 86_400_000);
  return d.toDateString() === yesterday.toDateString() ? 'Yesterday' : d.toLocaleDateString();
}

/** One flat line for the list preview: no heading marks, emphasis, code ticks or link syntax. */
export function plainPreview(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s+)/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}
