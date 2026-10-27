import type { ConsentCard } from '@parley/protocol';
import type { FocusTarget } from '../../shared/bridge.js';
import type { IslandRequest } from './requests.js';

export type PendingNavigationItem = {
  key: string;
  kind: 'consent' | 'feed' | 'room';
  target?: FocusTarget;
};
export interface PendingNavigationState {
  items: PendingNavigationItem[];
  selectedKey: string | null;
}

export const consentNavigationKey = (id: string): string => `consent:${id}`;
export const feedNavigationKey = (key: string): string => `feed:${key}`;
export const roomNavigationKey = (key: string): string => `room:${key}`;

export function pendingRoomNavigation(rows: readonly {
  kind: string; key: string; projectPath: string; workId: string; roomId: string; done: boolean;
  proposal?: { key: string };
}[]): PendingNavigationItem[] {
  return rows.flatMap((row) => row.kind === 'room' && !row.done && row.proposal !== undefined ? [{
    key: roomNavigationKey(row.proposal.key), kind: 'room' as const,
    target: { kind: 'room' as const, projectPath: row.projectPath, workId: row.workId, roomId: row.roomId },
  }] : []);
}

export function pendingNavigation(
  consents: readonly Pick<ConsentCard, 'id'>[],
  feed: readonly IslandRequest[],
  rooms: readonly PendingNavigationItem[],
): PendingNavigationState {
  const items: PendingNavigationItem[] = [
    ...consents.map(({ id }) => ({ key: consentNavigationKey(id), kind: 'consent' as const })),
    ...feed.map((item) => ({
      key: feedNavigationKey(item.key), kind: 'feed' as const,
      target: item.card === null ? { kind: 'session' as const, ref: item.ref, view: 'terminal' as const }
        : { kind: 'session' as const, ref: item.ref, cardId: item.card.cardId },
    })),
    ...rooms,
  ];
  return { items, selectedKey: items[0]?.key ?? null };
}

export function reconcilePendingNavigation(previous: PendingNavigationState, items: PendingNavigationItem[]): PendingNavigationState {
  if (items.some(({ key }) => key === previous.selectedKey)) return { items, selectedKey: previous.selectedKey };
  const oldIndex = Math.max(0, previous.items.findIndex(({ key }) => key === previous.selectedKey));
  return { items, selectedKey: items[Math.min(oldIndex, items.length - 1)]?.key ?? null };
}

export function movePendingSelection(state: PendingNavigationState, delta: -1 | 1): PendingNavigationState {
  if (state.items.length === 0) return state;
  const index = state.items.findIndex(({ key }) => key === state.selectedKey);
  const current = index < 0 ? 0 : index;
  return { ...state, selectedKey: state.items[(current + delta + state.items.length) % state.items.length]!.key };
}

export type PendingKeyCommand = 'next' | 'previous' | 'open' | 'escape' | null;
export function pendingKeyCommand(input: {
  key: string; ctrlKey: boolean; isComposing: boolean; repeat: boolean; editable: boolean;
}): PendingKeyCommand {
  if (input.isComposing) return null;
  if (input.key === 'Escape') return 'escape';
  if (input.repeat || input.editable) return null;
  if (input.key === 'ArrowDown') return 'next';
  if (input.key === 'ArrowUp') return 'previous';
  if (input.key === 'Enter' && input.ctrlKey) return 'open';
  return null;
}
