/**
 * Цель карточки «в работе»: подпись, слово состояния и куда вести клик. Слова — те же, что в строках сайдбара:
 * у сессии `sessionWord` (общий с `SessionRow`), у комнаты — выражение `RoomRow`; состояние считает единый модуль
 * `session-state`.
 */
import { roomAwaitsDecision, sessionNeed } from '@parley/core/attention';
import { S } from '../../shared/strings.js';
import type { FocusTarget } from '../../shared/bridge.js';
import { isRoomArchived } from '../lib/room-archive.js';
import { roomLiveLead } from '../lib/room-lead.js';
import { sessionRowLabel } from '../lib/participant.js';
import { sessionWord } from '../lib/session-word.js';
import { activityFor } from '../store/activity.js';
import type { ActivityEntry } from '../store/activity.js';
import type { TakenTarget } from './board-model.js';

export type ActivityByRef = Record<string, ActivityEntry>;
export interface TargetInfo { label: string; word: string; gone: boolean; focus: FocusTarget }

export function targetInfo(target: TakenTarget | null, activity: ActivityByRef, now: Date): TargetInfo | null {
  if (target === null) return null;
  const { entry } = target;
  const workId = entry.map.work.id;
  const workActive = entry.map.work.status === 'active';
  if (target.kind === 'session') {
    const { session } = target;
    const ref = { projectPath: entry.projectPath, workId, sessionId: session.id };
    const word = sessionWord(session, activityFor(activity, ref)?.activity ?? null, now);
    return { label: sessionRowLabel(session.id, session.label), word, gone: session.lifecycle === 'closed' || !workActive, focus: { kind: 'session', ref } };
  }
  const { room } = target;
  const stuck = room.members.some(id => {
    const session = entry.map.sessions.find(row => row.id === id);
    if (!session) return false;
    const live = activityFor(activity, { projectPath: entry.projectPath, workId, sessionId: id });
    return sessionNeed(session, live?.activity ?? null) !== null;
  });
  const word = roomAwaitsDecision(room) ? S.sidebar.roomDecision : stuck ? S.states.blocked : '';
  return {
    label: room.title === '' ? S.rooms.fallbackTitle : room.title,
    word,
    gone: isRoomArchived(room) || roomLiveLead(entry.map, room) === null || !workActive,
    focus: { kind: 'room', projectPath: entry.projectPath, workId, roomId: room.id },
  };
}
