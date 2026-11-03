/**
 * Карточка Backlog в поле ввода: бросок на поле комнаты или Chat кладёт её письмо черновиком, а при отправке окно
 * берёт в работу каждую карточку, чей номер остался в отправленном тексте. Связи «поле → карточки» живут в памяти модуля.
 */
import { toast } from 'sonner';
import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import { refKey } from '@parley/protocol';
import type { BacklogMethodParams } from '@parley/protocol';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { S } from '../../shared/strings.js';
import { useChatUiStore } from '../chat/ui-store.js';
import { roomKey } from '../lib/room-view.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { useUiStore } from '../store/ui.js';
import { ensureId, transferCard } from './board-actions.js';
import { cardText } from './board-send.js';
import type { SendTarget } from './board-send.js';
import type { BoardCard } from './board-model.js';
import { useBoardStore } from './board-store.js';
import type { BoardBridge } from './board-store.js';

interface DraftInserts {
  /** Запросы вставки в смонтированные поля комнат: `draftKey` → текст, ещё не вставленный. */
  inserts: Record<string, string>;
  /** Поля комнат, смонтированные сейчас: `draftKey` → сколько полей. */
  mounted: Record<string, number>;
  /** Поле комнаты смонтировано; возвращает функцию снятия. */
  register(key: string): () => void;
  request(key: string, text: string): void;
  /** Забирает запрос вставки поля; `null` — запроса нет. */
  take(key: string): string | null;
}

export const useDraftInserts: UseBoundStore<StoreApi<DraftInserts>> = create<DraftInserts>((set, get) => ({
  inserts: {},
  mounted: {},
  register: (key) => {
    set((state) => ({ mounted: { ...state.mounted, [key]: (state.mounted[key] ?? 0) + 1 } }));
    return () => {
      set((state) => {
        const count = (state.mounted[key] ?? 0) - 1;
        const mounted = { ...state.mounted };
        if (count > 0) mounted[key] = count; else delete mounted[key];
        return { mounted };
      });
    };
  },
  request: (key, text) => set((state) => ({ inserts: { ...state.inserts, [key]: state.inserts[key] === undefined ? text : `${state.inserts[key]}\n\n${text}` } })),
  take: (key) => {
    const text = get().inserts[key];
    if (text === undefined) return null;
    const inserts = { ...get().inserts };
    delete inserts[key];
    set({ inserts });
    return text;
  },
}));

/** Поле → карточки, лежащие в нём черновиками, в порядке броска: проект, где каждая сейчас, и её номер. */
const links = new Map<string, { projectPath: string; id: string }[]>();

const joinDraft = (before: string | undefined, text: string): string => (before === undefined || before === '' ? text : `${before}\n\n${text}`);

/**
 * Кладёт письмо карточки в поле цели. Карточка из «Входящих» сначала переезжает в проект цели, остальные получают номер.
 * Отказ — тост `failed`, черновик не меняется.
 */
export async function putCardDraft(bridge: BoardBridge, card: BoardCard, target: SendTarget): Promise<void> {
  const projectPath = target.entry.projectPath;
  const workId = target.entry.map.work.id;
  let id: string;
  try {
    ({ id } = card.project.inbox ? await transferCard(bridge, card, projectPath) : await ensureId(bridge, card));
  } catch (error) {
    toast(decodeIpcError(error).code === 'conflict' ? S.board.changed : S.board.failed);
    return;
  }
  const sent = card.project.inbox ? { ...card, project: { ...card.project, key: projectPath } } : card;
  const text = cardText(sent, id);
  let draftKey: string;
  if (target.kind === 'session') {
    draftKey = refKey({ projectPath, workId, sessionId: target.id });
    const chat = useChatUiStore.getState();
    chat.setDraft(draftKey, joinDraft(chat.drafts[draftKey], text));
  } else {
    draftKey = roomKey(workKeyOf(projectPath, workId), target.id);
    if (useDraftInserts.getState().mounted[draftKey] !== undefined) {
      useDraftInserts.getState().request(draftKey, text);
    } else {
      useUiStore.getState().setComposerDraft(draftKey, joinDraft(useUiStore.getState().composerDrafts[draftKey], text));
    }
  }
  const link = { projectPath: card.project.inbox ? projectPath : card.project.projectPath, id };
  // Та же карточка, брошенная в поле ещё раз, связь не множит: в работу она уйдёт один раз.
  const others = (links.get(draftKey) ?? []).filter((row) => row.projectPath !== link.projectPath || row.id !== link.id);
  links.set(draftKey, [...others, link]);
  toast(S.board.draftAdded(target.label));
}

/**
 * Поле `draftKey` отправило `sentText`: каждая карточка, лежавшая в нём черновиком, чей номер остался в тексте, уходит в
 * работу на `target`. Связи снимаются в любом случае. Отказ — тост `failed` (один на отправку): сообщение уже ушло.
 */
export async function claimCardDraft(
  bridge: BoardBridge,
  draftKey: string,
  sentText: string,
  target: BacklogMethodParams<'backlog.take'>['target'],
): Promise<void> {
  const linked = links.get(draftKey);
  if (linked === undefined) return;
  links.delete(draftKey);
  let failed = false;
  // По очереди: каждый `take` меняет версию снимка проекта, и следующий читает её из стора после `apply`.
  for (const link of linked) {
    // Номер как отдельное слово: b-001 не найдётся в b-0012.
    if (!new RegExp(`(?<![\\w-])${link.id}(?![\\w-])`).test(sentText)) continue;
    try {
      const version = useBoardStore.getState().slots.get(link.projectPath)?.snapshot?.version;
      if (version === undefined) throw new Error('board snapshot is missing');
      const taken = await bridge.call('backlog.take', { projectPath: link.projectPath, id: link.id, version, target });
      useBoardStore.getState().apply(taken);
    } catch {
      failed = true;
    }
  }
  if (failed) toast(S.board.failed);
}
