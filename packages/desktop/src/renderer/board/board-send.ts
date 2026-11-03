/**
 * Отправка карточки Backlog сессии или комнате: цели, задержка с Undo, перенос из «Входящих», `backlog.take`
 * и письмо. Окно собирает отправку само, новых методов хоста нет.
 */
import { toast } from 'sonner';
import { boardCardMessage, backlogState } from '@parley/core/board-card';
import type { WindowWorkEntry } from '@parley/core';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { S } from '../../shared/strings.js';
import { isRoomArchived } from '../lib/room-archive.js';
import { roomLiveLead } from '../lib/room-lead.js';
import { sessionRowLabel } from '../lib/participant.js';
import { folderName } from '../sidebar/sort.js';
import { useUiStore } from '../store/ui.js';
import { ensureId, transferCard } from './board-actions.js';
import { cardKey } from './board-model.js';
import type { BoardCard, BoardProject } from './board-model.js';
import { useBoardStore } from './board-store.js';
import type { BoardBridge } from './board-store.js';

export interface SendTarget { entry: WindowWorkEntry; kind: 'session' | 'room'; id: string; label: string }

export const SEND_DELAY_MS = 5000;

/** Живые цели проекта: комнаты не в архиве и с живым ведущим, сессии не закрытые; только в активных работах. */
export function liveTargets(project: BoardProject, entries: readonly WindowWorkEntry[]): SendTarget[] {
  const targets: SendTarget[] = [];
  for (const entry of entries) {
    if (entry.map.work.status !== 'active') continue;
    // «Входящие» шлют в любой проект доски, остальные — только в свои пути.
    if (project.inbox ? entry.projectPath === project.projectPath : !project.paths.includes(entry.projectPath)) continue;
    for (const room of entry.map.rooms) {
      if (isRoomArchived(room) || roomLiveLead(entry.map, room) === null) continue;
      targets.push({ entry, kind: 'room', id: room.id, label: room.title === '' ? S.rooms.fallbackTitle : room.title });
    }
    for (const session of entry.map.sessions) {
      if (session.lifecycle === 'closed') continue;
      targets.push({ entry, kind: 'session', id: session.id, label: sessionRowLabel(session.id, session.label) });
    }
  }
  return targets;
}

/** Письмо карточки; проект в нём — папка группы проекта. */
export function cardText(card: BoardCard, id: string): string {
  return boardCardMessage({ id, title: card.item.title, details: card.item.details, project: folderName(card.project.key) });
}

const itemTextOf = (card: BoardCard): string => [card.item.title, card.item.details].filter(Boolean).join('\n\n');

/** Свежая карточка из стора: ищется по номеру, без номера — по месту и заголовку. `null` — пропала или не в Backlog. */
function freshBacklogCard(card: BoardCard): BoardCard | null {
  const snapshot = useBoardStore.getState().slots.get(card.project.projectPath)?.snapshot;
  if (!snapshot) return null;
  const id = card.item.id ?? null;
  const index = id !== null
    ? snapshot.items.findIndex(row => row.id === id)
    : snapshot.items[card.index]?.title === card.item.title ? card.index : -1;
  const item = index < 0 ? undefined : snapshot.items[index];
  if (!item) return null;
  const state = item.state ?? backlogState(item, { review: item.review });
  if (state !== 'backlog') return null;
  return { project: { ...card.project, snapshot }, item, state, index };
}

/** Карточка из «Входящих» едет в проект цели; в тексте письма проектом считается он. */
function withTargetProject(card: BoardCard, projectPath: string): BoardCard {
  return card.project.inbox ? { ...card, project: { ...card.project, key: projectPath } } : card;
}

/**
 * Отказ подготовки карточки или `take`. Конфликт версии — тост `changed` и перечитывание проекта карточки и проекта,
 * где шёл `take` (`projectOfItem`): карточка из «Входящих» к этому моменту уже переехала в проект цели.
 */
async function failed(bridge: BoardBridge, card: BoardCard, error: unknown, projectOfItem = card.project.projectPath): Promise<void> {
  if (decodeIpcError(error).code === 'conflict') {
    toast(S.board.changed);
    const paths = new Set([card.project.projectPath, projectOfItem]);
    await Promise.all([...paths].map(path => useBoardStore.getState().refresh(bridge, path)));
  } else {
    toast(S.board.sendFailed);
  }
}

export async function sendCardNow(bridge: BoardBridge, card: BoardCard, target: SendTarget): Promise<void> {
  const key = cardKey(card);
  const store = useBoardStore.getState();
  store.setSending(key, target.label);
  try {
    const fresh = freshBacklogCard(card);
    if (fresh === null) {
      toast(S.board.changed);
      return;
    }
    const projectPath = target.entry.projectPath;
    let id: string;
    let version: string;
    let projectOfItem = fresh.project.projectPath;
    try {
      ({ id, version } = fresh.project.inbox ? await transferCard(bridge, fresh, projectPath) : await ensureId(bridge, fresh));
      if (fresh.project.inbox) projectOfItem = projectPath;
      const taken = await bridge.call('backlog.take', {
        projectPath: projectOfItem, id, version,
        target: target.kind === 'room'
          ? { projectPath, workId: target.entry.map.work.id, roomId: target.id }
          : { projectPath, workId: target.entry.map.work.id, sessionId: target.id },
      });
      useBoardStore.getState().apply(taken);
      version = taken.version;
    } catch (error) {
      await failed(bridge, fresh, error, projectOfItem);
      return;
    }
    const sent = withTargetProject(fresh, projectPath);
    const base = { projectPath, workId: target.entry.map.work.id, text: cardText(sent, id), kind: 'note' as const };
    try {
      if (target.kind === 'session') await bridge.call('rooms.send', { ...base, roomId: null, to: [target.id] });
      else await bridge.call('rooms.send', { ...base, roomId: target.id, to: [] });
    } catch {
      // Письмо не ушло — карточка возвращается в Backlog; успех отката не проверяется.
      try {
        const snapshot = await bridge.call('backlog.move', { projectPath: projectOfItem, id, version, to: 'backlog' });
        useBoardStore.getState().apply(snapshot);
      } catch {
        // Откат не удался: Refresh покажет, где карточка.
      }
      toast(S.board.sendFailed);
      return;
    }
    toast(S.board.sent(target.label));
  } finally {
    useBoardStore.getState().setSending(key, null);
  }
}

/** Ставит отправку на 5 с: до конца задержки ничего не пишется, Undo в тосте её снимает. */
export function scheduleSend(bridge: BoardBridge, card: BoardCard, target: SendTarget): void {
  const key = cardKey(card);
  if (useBoardStore.getState().sending.has(key)) return;
  let settled = false;
  const timer = setTimeout(() => {
    settled = true;
    void sendCardNow(bridge, card, target);
  }, SEND_DELAY_MS);
  useBoardStore.getState().setSending(key, target.label);
  toast(S.board.sending(target.label), {
    id: `board-send:${key}`,
    duration: SEND_DELAY_MS,
    cancel: {
      label: S.board.undo,
      // Sonner сам гасит тост после клика.
      onClick: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        useBoardStore.getState().setSending(key, null);
      },
    },
  });
}

/**
 * New session… / New room…: карточка получает номер (из «Входящих» сначала переезжает в проект работы) и уходит
 * в диалог письмом. `entry` — работа диалога; диалог показывает только работы с этим путём.
 */
export async function openCardInDialog(bridge: BoardBridge, card: BoardCard, entry: WindowWorkEntry, kind: 'session' | 'room'): Promise<void> {
  const fresh = freshBacklogCard(card);
  if (fresh === null) {
    toast(S.board.changed);
    return;
  }
  const projectPath = entry.projectPath;
  try {
    const { id, version } = fresh.project.inbox ? await transferCard(bridge, fresh, projectPath) : await ensureId(bridge, fresh);
    const sent = withTargetProject(fresh, projectPath);
    useUiStore.getState().openNewSessionDialog({ projectPath, workId: entry.map.work.id }, {
      room: kind === 'room',
      backlog: { projectPath, id, version, task: cardText(sent, id), itemText: itemTextOf(fresh) },
    });
  } catch (error) {
    await failed(bridge, fresh, error);
  }
}
