// Чистые помощники карточки доски. Здесь нет импортов значений: модуль берёт окно через подпуть пакета.

export type BacklogState = 'backlog' | 'in-progress' | 'review' | 'done';

export function backlogState(item: { checked: boolean; taken?: string | undefined }, meta?: { review?: string | undefined }): BacklogState {
  if (item.checked) return 'done';
  if (item.taken === undefined) return 'backlog';
  return meta?.review === undefined ? 'in-progress' : 'review';
}

export function boardCardMessage(card: { id: string; title: string; details: string; project: string }): string {
  const { id, title, details, project } = card;
  return `Board card ${id} (${project}): ${title}\n\n` +
    (details.trim() ? `${details.trim()}\n\n` : '') +
    `When it is done, call report with status done and backlog ["${id}"].`;
}

export function boardReturnMessage(card: { id: string; title: string }, note: string): string {
  const { id, title } = card;
  return `Board card ${id} is back from review: ${title}\n\n${note.trim()}\n\nWhen it is done, call report with status done and backlog ["${id}"].`;
}

export interface TakenRef { workId: string; kind: 'session' | 'room'; targetId: string }

export function parseTaken(taken: string): TakenRef | null {
  const match = /^(w-\d+)\/([sr])-(\d+)$/.exec(taken);
  if (!match) return null;
  const [, workId, letter, number] = match;
  return { workId: workId!, kind: letter === 's' ? 'session' : 'room', targetId: `${letter}-${number}` };
}
