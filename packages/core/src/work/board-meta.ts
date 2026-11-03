import path from 'node:path';
import { readSharedFile, writeSharedFile } from './store.js';
import type { SharedFileSnapshot, SharedProjectPaths } from './store.js';
import type { BacklogDocument, BacklogItem } from './backlog.js';

export type BacklogState = 'backlog' | 'in-progress' | 'review' | 'done';
/** Время карточки в ISO 8601 UTC; хранится рядом с бэклогом, а не в его Markdown-строках. */
export interface BoardItemMeta { created?: string; sent?: string; review?: string }
export interface BoardMeta { version: 1; items: Record<string, BoardItemMeta> }
export type BoardItem = BacklogItem & BoardItemMeta & { state: BacklogState };

const FIELDS = ['created', 'sent', 'review'] as const;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function backlogState(item: BacklogItem, meta?: BoardItemMeta): BacklogState {
  if (item.checked) return 'done';
  if (item.taken === undefined) return 'backlog';
  return meta?.review === undefined ? 'in-progress' : 'review';
}

export const boardMetaPath = (paths: SharedProjectPaths): string => path.join(paths.dir, 'board.json');

const emptyMeta = (): BoardMeta => ({ version: 1, items: {} });
function parseMeta(text: string): BoardMeta {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return emptyMeta(); }
  if (!object(data) || data.version !== 1 || !object(data.items)) return emptyMeta();
  const meta = emptyMeta();
  for (const [id, row] of Object.entries(data.items)) {
    if (!object(row)) continue;
    const entry: BoardItemMeta = {};
    for (const field of FIELDS) if (typeof row[field] === 'string') entry[field] = row[field] as string;
    meta.items[id] = entry;
  }
  return meta;
}

export async function readBoardMeta(paths: SharedProjectPaths): Promise<{ meta: BoardMeta; snapshot: SharedFileSnapshot }> {
  const snapshot = await readSharedFile(boardMetaPath(paths));
  return { meta: parseMeta(snapshot.text), snapshot };
}

/** Читает, меняет и пишет board.json (0o600). Замок проекта держит вызывающий. */
export async function updateBoardMeta(paths: SharedProjectPaths, change: (meta: BoardMeta) => void): Promise<BoardMeta> {
  const { meta, snapshot } = await readBoardMeta(paths);
  change(meta);
  await writeSharedFile(boardMetaPath(paths), `${JSON.stringify(meta, null, 2)}\n`, snapshot, 0o600);
  return meta;
}

export function boardItems(document: BacklogDocument, meta: BoardMeta): BoardItem[] {
  return document.items.map(item => {
    const row = item.id === null ? undefined : meta.items[item.id];
    return { ...item, ...row, state: backlogState(item, row) };
  });
}
