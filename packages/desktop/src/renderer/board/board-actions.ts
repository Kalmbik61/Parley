/**
 * Действия над карточкой доски: перенос по колонкам, возврат с замечанием, правка, удаление, перенос в другой проект.
 * Всё идёт через `backlog.*` и `rooms.send`; снимки из ответов кладутся в стор, ошибки показываются тостом.
 */
import { toast } from 'sonner';
import { boardReturnMessage } from '@parley/core/board-card';
import type { BacklogMethodParams, BacklogSnapshot, BacklogState } from '@parley/protocol';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { S } from '../../shared/strings.js';
import type { BoardCard, TakenTarget } from './board-model.js';
import { useBoardStore } from './board-store.js';
import type { BoardBridge } from './board-store.js';

/** Версия свежего снимка проекта карточки: стор обновляется ответами и `backlog.changed`. */
function freshVersion(card: BoardCard): string {
  return useBoardStore.getState().slots.get(card.project.projectPath)?.snapshot?.version ?? card.project.snapshot.version;
}

/** Номер карточки; руками вписанной в файл без номера — сначала получает его через `prepareTake`. */
export async function ensureId(bridge: BoardBridge, card: BoardCard): Promise<{ id: string; version: string }> {
  const version = freshVersion(card);
  if (card.item.id !== undefined && card.item.id !== null) return { id: card.item.id, version };
  const result = await bridge.call('backlog.prepareTake', { projectPath: card.project.projectPath, index: card.index, version });
  useBoardStore.getState().apply(result.snapshot);
  return { id: result.id, version: result.snapshot.version };
}

/** Подписи тоста: на конфликт версии и на любую другую ошибку. */
interface GuardTexts { conflict: string; failed: string }

/** Выполняет действие; конфликт версии — тост `conflict` и перечитывание проекта, остальное — тост `failed`. */
async function guard(
  bridge: BoardBridge,
  card: BoardCard,
  run: () => Promise<void>,
  texts: GuardTexts = { conflict: S.board.changed, failed: S.board.failed },
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (decodeIpcError(error).code === 'conflict') {
      toast(texts.conflict);
      void useBoardStore.getState().refresh(bridge, card.project.projectPath);
    } else {
      toast(texts.failed);
    }
  }
}

async function applyCall<M extends 'backlog.move' | 'backlog.update' | 'backlog.remove'>(bridge: BoardBridge, method: M, params: BacklogMethodParams<M>): Promise<void> {
  const snapshot = await bridge.call(method, params);
  useBoardStore.getState().apply(snapshot as BacklogSnapshot);
}

export async function moveCard(bridge: BoardBridge, card: BoardCard, to: BacklogState): Promise<void> {
  await guard(bridge, card, async () => {
    const { id, version } = await ensureId(bridge, card);
    await applyCall(bridge, 'backlog.move', { projectPath: card.project.projectPath, id, version, to });
  });
}

/** Возврат из Review: письмо цели, и только после него карточка уходит в In progress. */
export async function returnCard(bridge: BoardBridge, card: BoardCard, target: TakenTarget, note: string): Promise<void> {
  await guard(bridge, card, async () => {
    const { id } = await ensureId(bridge, card);
    const text = boardReturnMessage({ id, title: card.item.title }, note);
    const base = { projectPath: target.entry.projectPath, workId: target.entry.map.work.id, text, kind: 'note' as const };
    if (target.kind === 'session') await bridge.call('rooms.send', { ...base, roomId: null, to: [target.session.id] });
    else await bridge.call('rooms.send', { ...base, roomId: target.room.id, to: [] });
    await applyCall(bridge, 'backlog.move', { projectPath: card.project.projectPath, id, version: freshVersion(card), to: 'in-progress' });
  });
}

export async function editCard(bridge: BoardBridge, card: BoardCard, patch: { title?: string; details?: string }): Promise<void> {
  await guard(bridge, card, async () => {
    const { id, version } = await ensureId(bridge, card);
    await applyCall(bridge, 'backlog.update', { projectPath: card.project.projectPath, id, version, patch });
  });
}

export async function deleteCard(bridge: BoardBridge, card: BoardCard): Promise<void> {
  await guard(bridge, card, async () => {
    const locator = card.item.id !== undefined && card.item.id !== null ? { id: card.item.id } : { index: card.index };
    await applyCall(bridge, 'backlog.remove', { projectPath: card.project.projectPath, ...locator, version: freshVersion(card) });
  });
}

/** Перенос в другой проект или во «Входящие». Отказ хоста (карточка из плана — `conflict`, версия, прочее) — `cantMove`. */
export async function moveCardToProject(bridge: BoardBridge, card: BoardCard, toProjectPath: string): Promise<void> {
  await guard(bridge, card, async () => {
    const { id, version } = await ensureId(bridge, card);
    const result = await bridge.call('backlog.transfer', { projectPath: card.project.projectPath, id, version, toProjectPath });
    useBoardStore.getState().apply(result.snapshot);
  }, { conflict: S.board.cantMove, failed: S.board.cantMove });
}
