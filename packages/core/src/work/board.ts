import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parleyHome } from '../home.js';
import { addBacklogItem, completeBacklogItem, readBacklog, removeBacklogItem, takeBacklogItem, updateBacklogItem } from './backlog.js';
import type { BacklogDocument, BacklogItem, BacklogWriteResult } from './backlog.js';
import { boardCardMessage } from './board-card.js';
import { boardItems, readBoardMeta, updateBoardMeta } from './board-meta.js';
import type { BacklogState, BoardItem, BoardMeta } from './board-meta.js';
import { SharedStateError, sharedProjectPaths, withSharedProjectLock } from './store.js';
import type { SharedProjectPaths, SharedWriteOptions } from './store.js';
import type { WorkMap } from './types.js';

/** «Входящие» — скрытый псевдопроект со своим обычным бэклогом. */
export const boardInboxPath = (env: NodeJS.ProcessEnv = process.env): string => path.join(parleyHome(env), 'board', 'inbox');

export async function ensureBoardInbox(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const dir = boardInboxPath(env);
  await mkdir(dir, { recursive: true });
  return realpath(dir);
}

export async function readBoardItems(projectPath: string): Promise<{ version: string; boardVersion: string; items: BoardItem[] }> {
  const paths = await sharedProjectPaths(projectPath);
  const document = await readBacklog(projectPath);
  const { meta, snapshot } = await readBoardMeta(paths);
  return { version: document.version, boardVersion: snapshot.version, items: boardItems(document, meta) };
}

const conflict = (): SharedStateError => new SharedStateError('backlog-conflict');
const findItem = (document: BacklogDocument, locator: string | number): BacklogItem | undefined =>
  typeof locator === 'number' ? document.items[locator] : document.items.find(row => row.id === locator);
const today = (): string => new Date().toISOString().slice(0, 10);
/** Снимает с карточки метки Review и отправки: повторная отправка начинается с чистого листа. */
const clearSent = (meta: BoardMeta, id: string): void => {
  const row = meta.items[id];
  if (!row) return;
  delete row.sent;
  delete row.review;
};

export async function boardTake(projectPath: string, locator: string | number, taken: string, options: SharedWriteOptions = {}): Promise<BacklogWriteResult> {
  const document = await readBacklog(projectPath, options);
  const item = findItem(document, locator);
  if (!item) throw new SharedStateError('backlog-invalid');
  if (item.checked) throw conflict();
  if (item.taken !== undefined && item.taken !== taken) throw conflict();
  // Проверка и запись атомарны: версия, по которой проверяли, уходит в запись.
  const result = await takeBacklogItem(projectPath, locator, taken, { ...options, expectedVersion: options.expectedVersion ?? document.version });
  const paths = await sharedProjectPaths(projectPath, options);
  const now = new Date().toISOString();
  await withSharedProjectLock(paths, () => updateBoardMeta(paths, meta => {
    const row = meta.items[result.id] ?? {};
    delete row.review;
    meta.items[result.id] = { ...row, sent: now };
  }), options);
  return result;
}

async function look(projectPath: string, paths: SharedProjectPaths, id: string, options: SharedWriteOptions):
  Promise<{ document: BacklogDocument; state: BacklogState }> {
  const document = await readBacklog(projectPath, options);
  const { meta } = await readBoardMeta(paths);
  const row = boardItems(document, meta).find(candidate => candidate.id === id);
  if (!row) throw new SharedStateError('backlog-invalid');
  return { document, state: row.state };
}

export async function boardMove(projectPath: string, id: string, to: BacklogState, options: SharedWriteOptions = {}): Promise<BacklogWriteResult> {
  const paths = await sharedProjectPaths(projectPath, options);
  const peek = await look(projectPath, paths, id, options);
  const from = peek.state;
  const stale = (document: BacklogDocument): boolean => options.expectedVersion !== undefined && options.expectedVersion !== document.version;
  const current = (document: BacklogDocument): BacklogWriteResult => ({ id, document, diagnostics: [] });

  if (from === to) {
    if (stale(peek.document)) throw conflict();
    return current(peek.document);
  }
  if ((from === 'in-progress' && to === 'review') || (from === 'review' && to === 'in-progress')) {
    // Меняется только board.json: документ, метаданные и проверка состояния — под одним замком.
    return withSharedProjectLock(paths, async () => {
      const now = await look(projectPath, paths, id, options);
      if (stale(now.document) || now.state !== from) throw conflict();
      const at = new Date().toISOString();
      await updateBoardMeta(paths, meta => {
        const row = meta.items[id] ?? {};
        if (to === 'review') meta.items[id] = { ...row, review: at };
        else { delete row.review; meta.items[id] = row; }
      });
      return current(now.document);
    }, options);
  }

  const write = { ...options, expectedVersion: options.expectedVersion ?? peek.document.version };
  let result: BacklogWriteResult;
  if (to === 'backlog') {
    result = from === 'done'
      ? await updateBacklogItem(projectPath, id, { checked: false, done: null, taken: null }, write)
      : await updateBacklogItem(projectPath, id, { taken: null }, write);
  } else if (to === 'done') {
    result = await completeBacklogItem(projectPath, id, today(), write);
  } else {
    throw conflict();
  }
  if (to === 'backlog') await withSharedProjectLock(paths, () => updateBoardMeta(paths, meta => clearSent(meta, id)), options);
  return result;
}

export type BoardSkipReason = 'missing' | 'done' | 'not-yours' | 'already' | 'plan';

export async function markBoardReview(projectPath: string, ids: readonly string[], takenBy: readonly string[], excluded?: ReadonlySet<string>):
  Promise<{ review: string[]; skipped: { id: string; reason: BoardSkipReason }[] }> {
  const paths = await sharedProjectPaths(projectPath);
  return withSharedProjectLock(paths, async () => {
    const document = await readBacklog(projectPath);
    const { meta } = await readBoardMeta(paths);
    const review: string[] = [];
    const skipped: { id: string; reason: BoardSkipReason }[] = [];
    for (const id of ids) {
      const item = document.items.find(row => row.id === id);
      let reason: BoardSkipReason | null = null;
      if (!item) reason = 'missing';
      else if (item.checked) reason = 'done';
      else if (excluded?.has(id)) reason = 'plan';
      else if (item.taken === undefined || !takenBy.includes(item.taken)) reason = 'not-yours';
      else if (meta.items[id]?.review !== undefined || review.includes(id)) reason = 'already';
      if (reason) skipped.push({ id, reason });
      else review.push(id);
    }
    if (review.length > 0) {
      const now = new Date().toISOString();
      await updateBoardMeta(paths, next => { for (const id of review) next.items[id] = { ...next.items[id], review: now }; });
    }
    return { review, skipped };
  });
}

export async function boardTransfer(fromProjectPath: string, id: string, toProjectPath: string,
  options: { version?: string; planIds?: ReadonlySet<string> } = {}): Promise<{ id: string }> {
  const fromPaths = await sharedProjectPaths(fromProjectPath);
  const document = await readBacklog(fromProjectPath);
  const item = document.items.find(row => row.id === id);
  if (!item || item.checked || item.taken !== undefined || options.planIds?.has(id)) throw conflict();
  // Устаревшая карточка не копируется в цель.
  if (options.version !== undefined && options.version !== document.version) throw conflict();
  const { meta } = await readBoardMeta(fromPaths);
  const created = meta.items[id]?.created;

  const added = await addBacklogItem(toProjectPath, { title: item.title, details: item.details, ...(item.by === undefined ? {} : { by: item.by }) });
  if (created !== undefined) {
    // Копия в цели уже добавлена, а created не критично: сбой записи не должен прерывать перенос, иначе повтор создаст вторую копию.
    try {
      const toPaths = await sharedProjectPaths(toProjectPath);
      await withSharedProjectLock(toPaths, () => updateBoardMeta(toPaths, next => { next.items[added.id] = { ...next.items[added.id], created }; }));
    } catch { /* created не записан */ }
  }
  // Если удалить не вышло, ошибка уходит наверх, а копия в цели остаётся: ничего не теряется.
  await removeBacklogItem(fromProjectPath, id, { expectedVersion: options.version ?? document.version });
  return { id: added.id };
}

/** Номера карточек из принятых планов (в том числе завершённых) и из планов, которые предложены в комнате и ждут ответа. */
export function planBacklogIds(map: WorkMap): Set<string> {
  const ids = new Set<string>();
  for (const plan of map.plans ?? []) for (const id of plan.backlog) ids.add(id);
  for (const room of map.rooms) for (const id of room.proposal?.plan?.backlog ?? []) ids.add(id);
  return ids;
}

export { boardCardMessage };
