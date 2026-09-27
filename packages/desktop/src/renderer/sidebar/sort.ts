/**
 * Порядок сайдбара (спека 6.1, 6.2): «Закреплённые», затем группы проектов;
 * внутри — где нужен человек, выше. Функции чистые: пересортировку под
 * указателем держит `use-deferred-order.ts`, а не этот модуль.
 */

import type { WorkEntry } from '@harnas/core';
import { S } from '../../shared/strings.js';
import { ATTENTION_RANK, attentionOf as attentionIn, type WorkAttention } from '../attention/derive.js';
import { isoMs } from '../lib/iso-time.js';
import { workKey } from '../lib/tree-order.js';

export interface SidebarSection {
  kind: 'pinned' | 'project';
  key: string;                          // 'pinned' | projectPath
  title: string;                        // S.sidebar.pinned ('Pinned') | имя папки
  projectPath: string | null;
  works: WorkEntry[];                   // показанные в секции, уже отсортированы
  collapsed: boolean;
}

const PINNED_KEY = 'pinned';

/** Время в мс; не-ISO — самое старое, чтобы битая дата не поднимала карточку. */
const msOf = (value: string): number => isoMs(value) ?? Number.NEGATIVE_INFINITY;

export function compareWorks(a: { attention: WorkAttention; createdAt: string }, b: typeof a): number {
  const byRank = ATTENTION_RANK[b.attention.level] - ATTENTION_RANK[a.attention.level];
  if (byRank !== 0) return byRank;
  const aAt = msOf(a.attention.lastEventAt);
  const bAt = msOf(b.attention.lastEventAt);
  if (aAt !== bAt) return aAt < bAt ? 1 : -1;
  const aCreated = msOf(a.createdAt);
  const bCreated = msOf(b.createdAt);
  if (aCreated !== bCreated) return aCreated < bCreated ? -1 : 1;
  return 0;
}

/** Имя папки — последний сегмент пути, хвостовой `/` не в счёт. */
function folderName(projectPath: string): string {
  const parts = projectPath.split('/').filter((part) => part !== '');
  return parts.at(-1) ?? projectPath;
}

export function buildSections(input: {
  entries: WorkEntry[];
  attention: Record<string, WorkAttention>;   // ключ — workKey
  pinned: string[]; collapsed: string[]; showDone: boolean;
}): SidebarSection[] {
  const { entries, attention, showDone } = input;
  const pinned = new Set(input.pinned);
  const collapsed = new Set(input.collapsed);

  // Работе без посчитанного внимания — `off` со временем карты (`attentionOf` в derive.ts).
  const attentionOf = (entry: WorkEntry): WorkAttention => attentionIn(attention, entry);

  // `done` внизу своей секции — одно правило для всех секций, «Закреплённых» тоже.
  const sortWorks = (works: WorkEntry[]): WorkEntry[] =>
    [...works].sort((a, b) => {
      const aDone = a.map.work.status === 'done' ? 1 : 0;
      const bDone = b.map.work.status === 'done' ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      const byAttention = compareWorks(
        { attention: attentionOf(a), createdAt: a.map.work.createdAt },
        { attention: attentionOf(b), createdAt: b.map.work.createdAt },
      );
      if (byAttention !== 0) return byAttention;
      // Последний ключ — workKey: иначе при полном равенстве порядок зависел бы от порядка entries.
      const aKey = workKey(a.projectPath, a.map.work.id);
      const bKey = workKey(b.projectPath, b.map.work.id);
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });

  const shown = entries.filter(
    (entry) => entry.map.work.status !== 'archived' && (showDone || entry.map.work.status !== 'done'),
  );

  const pinnedWorks: WorkEntry[] = [];
  const byProject = new Map<string, WorkEntry[]>();
  for (const entry of shown) {
    if (pinned.has(workKey(entry.projectPath, entry.map.work.id))) {
      pinnedWorks.push(entry);
      continue;
    }
    const list = byProject.get(entry.projectPath);
    if (list === undefined) byProject.set(entry.projectPath, [entry]);
    else list.push(entry);
  }

  // Ранг группы — по показанным в ней работам: закреплённая поднимает «Закреплённые»,
  // а не свой проект. Время на порядок групп не влияет, иначе группы прыгали бы (6.1).
  // Считается один раз на группу, а не в каждом вызове компаратора.
  const groupRank = (works: WorkEntry[]): number =>
    Math.max(...works.map((entry) => ATTENTION_RANK[attentionOf(entry).level]));

  const projects: SidebarSection[] = [...byProject.entries()]
    .map(([projectPath, works]) => ({
      rank: groupRank(works),
      section: {
        kind: 'project' as const,
        key: projectPath,
        title: folderName(projectPath),
        projectPath,
        works: sortWorks(works),
        collapsed: collapsed.has(projectPath),
      },
    }))
    .sort((a, b) => {
      const byRank = b.rank - a.rank;
      if (byRank !== 0) return byRank;
      const byName = a.section.title.localeCompare(b.section.title, 'en-US');
      if (byName !== 0) return byName;
      // Две папки с одним именем в разных местах — порядок всё равно устойчивый.
      return a.section.key < b.section.key ? -1 : a.section.key > b.section.key ? 1 : 0;
    })
    .map(({ section }) => section);

  if (pinnedWorks.length === 0) return projects;
  return [
    {
      kind: 'pinned',
      key: PINNED_KEY,
      title: S.sidebar.pinned,
      projectPath: null,
      works: sortWorks(pinnedWorks),
      collapsed: false,
    },
    ...projects,
  ];
}

/** Видимый порядок работ — для ⌘1–9, ⌘⇧↑↓, соседней работы и выбора на старте (3.4). */
export function visibleWorkOrder(sections: SidebarSection[]): string[] {
  return sections
    .filter((section) => !section.collapsed)
    .flatMap((section) => section.works.map((entry) => workKey(entry.projectPath, entry.map.work.id)));
}

/**
 * Соседняя работа в порядке по кругу (⌘⇧↑↓, кусок 3.4; переехала сюда в 6.1b). Активной в
 * порядке нет (её проект свёрнут, `done` скрыта) — вперёд первая, назад последняя; порядок пуст — `null`.
 */
export function neighborInOrder(order: readonly string[], current: string | null, step: 1 | -1): string | null {
  if (order.length === 0) return null;
  const index = current === null ? -1 : order.indexOf(current);
  if (index === -1) return (step === 1 ? order[0] : order[order.length - 1]) ?? null;
  return order[(((index + step) % order.length) + order.length) % order.length] ?? null;
}
