/**
 * Модель доски: чистые функции над снимками бэклогов. Колонки, сортировка, склейка worktree с основной
 * копией и разбор `taken` — здесь; стор и подписки — в `board-store.ts`.
 */
import type { Room, WindowWorkEntry, WorkSession } from '@parley/core';
import { backlogState, parseTaken } from '@parley/core/board-card';
import type { BacklogSnapshot, BacklogState } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { folderName } from '../sidebar/sort.js';
import type { BoardSlot } from './board-store.js';

export type BacklogRow = BacklogSnapshot['items'][number];
export type BoardFilter = { kind: 'all' } | { kind: 'inbox' } | { kind: 'project'; path: string };
export interface BoardProject {
  key: string; projectPath: string; paths: readonly string[]; title: string; inbox: boolean; snapshot: BacklogSnapshot; live: boolean;
}
export interface BoardCard { project: BoardProject; item: BacklogRow; state: BacklogState; index: number }
export interface BoardColumns { backlog: BoardCard[]; inProgress: BoardCard[]; review: BoardCard[]; done: BoardCard[]; olderDone: BoardCard[] }
export type TakenTarget =
  | { kind: 'session'; entry: WindowWorkEntry; session: WorkSession }
  | { kind: 'room'; entry: WindowWorkEntry; room: Room };

const DONE_DAYS = 14;

/** Различные пути проектов работ, кроме архивных. */
export function boardProjectPaths(entries: readonly WindowWorkEntry[]): string[] {
  const paths = new Set<string>();
  for (const entry of entries) if (entry.map.work.status !== 'archived') paths.add(entry.projectPath);
  return [...paths];
}

const byTitle = (a: BoardProject, b: BoardProject): number => {
  const left = a.title.toLowerCase();
  const right = b.title.toLowerCase();
  if (left !== right) return left < right ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
};

/** Worktree и основная копия делят бэклог, поэтому слоты со снимком склеиваются по `sharedProjectPath`. */
export function boardProjects(slots: ReadonlyMap<string, BoardSlot>, inboxPath: string | null): BoardProject[] {
  const groups = new Map<string, { path: string; slot: BoardSlot & { snapshot: BacklogSnapshot } }[]>();
  let inbox: BoardProject | null = null;
  for (const [path, slot] of slots) {
    if (slot.snapshot === null) continue;
    const ready = { path, slot: { ...slot, snapshot: slot.snapshot } };
    if (path === inboxPath) {
      inbox = { key: path, projectPath: path, paths: [path], title: S.board.noProject, inbox: true, snapshot: slot.snapshot, live: slot.live };
      continue;
    }
    const key = slot.snapshot.sharedProjectPath;
    const group = groups.get(key);
    if (group) group.push(ready); else groups.set(key, [ready]);
  }
  const result: BoardProject[] = [];
  for (const [key, group] of groups) {
    const sorted = [...group].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const main = sorted.find(row => row.path === key) ?? sorted[0]!;
    result.push({ key, projectPath: main.path, paths: sorted.map(row => row.path), title: folderName(key), inbox: false,
      snapshot: main.slot.snapshot, live: main.slot.live });
  }
  result.sort(byTitle);
  if (inbox) result.push(inbox);
  return result;
}

export function filterProjects(projects: readonly BoardProject[], filter: BoardFilter): BoardProject[] {
  if (filter.kind === 'all') return [...projects];
  if (filter.kind === 'inbox') return projects.filter(project => project.inbox);
  return projects.filter(project => !project.inbox && (project.key === filter.path || project.paths.includes(filter.path)));
}

/** Граница Done: сегодня минус 13 дней, `YYYY-MM-DD`. */
function doneCutoff(today: string): string {
  const [year, month, day] = today.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  date.setUTCDate(date.getUTCDate() - (DONE_DAYS - 1));
  return date.toISOString().slice(0, 10);
}

const compareCreated = (a: BoardCard, b: BoardCard): number => {
  const left = a.item.created;
  const right = b.item.created;
  if (left !== undefined && right !== undefined && left !== right) return left < right ? 1 : -1;
  if (left !== undefined && right === undefined) return -1;
  if (left === undefined && right !== undefined) return 1;
  const titles = byTitle(a.project, b.project);
  return titles !== 0 ? titles : a.index - b.index;
};

export function boardColumns(projects: readonly BoardProject[], filter: BoardFilter, today: string): BoardColumns {
  const columns: BoardColumns = { backlog: [], inProgress: [], review: [], done: [], olderDone: [] };
  const cutoff = doneCutoff(today);
  for (const project of filterProjects(projects, filter)) {
    project.snapshot.items.forEach((item, index) => {
      const state = item.state ?? backlogState(item, { review: item.review });
      const card: BoardCard = { project, item, state, index };
      if (state === 'backlog') columns.backlog.push(card);
      else if (state === 'in-progress') columns.inProgress.push(card);
      else if (state === 'review') columns.review.push(card);
      else if (item.done !== undefined && item.done.slice(0, 10) >= cutoff) columns.done.push(card);
      else columns.olderDone.push(card);
    });
  }
  columns.backlog.sort(compareCreated);
  columns.inProgress.sort(compareCreated);
  columns.review.sort(compareCreated);
  const byDone = (a: BoardCard, b: BoardCard): number => {
    const left = a.item.done ?? '';
    const right = b.item.done ?? '';
    return left !== right ? (left < right ? 1 : -1) : compareCreated(a, b);
  };
  columns.done.sort(byDone);
  columns.olderDone.sort(byDone);
  return columns;
}

/** Review всех проектов, без фильтра. */
export function reviewCount(projects: readonly BoardProject[]): number {
  let count = 0;
  for (const project of projects) {
    for (const item of project.snapshot.items) {
      if ((item.state ?? backlogState(item, { review: item.review })) === 'review') count += 1;
    }
  }
  return count;
}

/** Цель `taken` среди работ проекта; не одна работа с таким номером, «Входящие» или мусор — `null`. */
export function resolveTaken(taken: string | undefined, project: BoardProject, entries: readonly WindowWorkEntry[]): TakenTarget | null {
  if (taken === undefined || project.inbox) return null;
  const ref = parseTaken(taken);
  if (!ref) return null;
  const works = entries.filter(entry => project.paths.includes(entry.projectPath) && entry.map.work.id === ref.workId);
  if (works.length !== 1) return null;
  const entry = works[0]!;
  if (ref.kind === 'session') {
    const session = entry.map.sessions.find(row => row.id === ref.targetId);
    return session ? { kind: 'session', entry, session } : null;
  }
  const room = entry.map.rooms.find(row => row.id === ref.targetId);
  return room ? { kind: 'room', entry, room } : null;
}

export function cardKey(card: Pick<BoardCard, 'project' | 'item' | 'index'>): string {
  return `${card.project.projectPath}#${card.item.id ?? `@${card.index}`}`;
}
