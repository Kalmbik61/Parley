/**
 * Порядок сайдбара (спека 6.1, 6.2): «Закреплённые», затем группы проектов;
 * внутри — где нужен человек, выше. Функции чистые: пересортировку под
 * указателем держит `use-deferred-order.ts`, а не этот модуль. Там же — состав строк одной
 * карточки (`cardRows`, спека окна 2026-09-29, 1.2): сессии и комнаты на месте своих участников.
 */

import type { Room, WorkEntry, WorkMap, WorkSession } from '@parley/core';
import { S } from '../../shared/strings.js';
import { ATTENTION_RANK, attentionOf as attentionIn, type WorkAttention } from '../attention/derive.js';
import { isoMs } from '../lib/iso-time.js';
import { roomLiveLead } from '../lib/room-lead.js';
import { roomLastAt, roomSessions } from '../lib/room-view.js';
import { treeOrder, workKey } from '../lib/tree-order.js';

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
  /** false — archived скрыты, как в 3.2; true — в конце своей секции, после done (кусок 6.3, спека 6.7). */
  showArchived: boolean;
}): SidebarSection[] {
  const { entries, attention, showDone, showArchived } = input;
  const pinned = new Set(input.pinned);
  const collapsed = new Set(input.collapsed);

  // Работе без посчитанного внимания — `off` со временем карты (`attentionOf` в derive.ts).
  const attentionOf = (entry: WorkEntry): WorkAttention => attentionIn(attention, entry);

  // `done` внизу своей секции, показанные архивные — под ними: одно правило для всех секций,
  // «Закреплённых» тоже.
  const tail = (entry: WorkEntry): number => (entry.map.work.status === 'archived' ? 2 : entry.map.work.status === 'done' ? 1 : 0);
  const sortWorks = (works: WorkEntry[]): WorkEntry[] =>
    [...works].sort((a, b) => {
      const aTail = tail(a);
      const bTail = tail(b);
      if (aTail !== bTail) return aTail - bTail;
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
    (entry) =>
      (showArchived || entry.map.work.status !== 'archived') && (showDone || entry.map.work.status !== 'done'),
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
  // Считается один раз на группу, а не в каждом вызове компаратора. Показанная архивная ранг
  // не поднимает — во внимание она не входит (спека 6.7); группа из одних архивных — ниже всех,
  // но с числом, а не `-Infinity`: разность двух бесконечностей сломала бы сортировку.
  const groupRank = (works: WorkEntry[]): number =>
    Math.max(
      -1,
      ...works.filter((entry) => entry.map.work.status !== 'archived').map((entry) => ATTENTION_RANK[attentionOf(entry).level]),
    );

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

/** Строка карточки — сессия сама по себе. */
export interface CardSessionRow {
  kind: 'session';
  session: WorkSession;
  depth: number;
}

/** Строка карточки — комната; участники, что стоят в ней, отдельными строками карточки не выводятся. */
export interface CardRoomRow {
  kind: 'room';
  room: Room;
  /** Глубина её первого живого участника в дереве сессий (отступ `8 + 12·depth`); комната в конце — 0. */
  depth: number;
  /** Ведущий (`roomLiveLead`), `★` — у него; `null` — живых участников нет, комната закрыта. */
  lead: string | null;
  /** Участники, что стоят в этой комнате и показаны строками развёрнутой комнаты: закрытые — при `showClosed`. */
  members: WorkSession[];
  /**
   * Все участники-сессии, что стоят в этой комнате, закрытые тоже: значки-счётчики свёрнутой комнаты, тултип и правило
   * развёртывания считают всех. Сессия старой карты, числящаяся в нескольких комнатах (решение 4), стоит в самой
   * ранней и в `sessions` остальных не входит: иначе один агент считался бы в бейджах двух комнат.
   */
  sessions: WorkSession[];
  /** Время последнего события комнаты — справа в её строке. */
  lastAt: string;
}

export type CardRow = CardSessionRow | CardRoomRow;

/** Время создания комнаты для порядка «самая ранняя»; битая дата — самая поздняя: настоящая её всегда обходит. */
const createdMs = (room: Room): number => isoMs(room.createdAt) ?? Number.POSITIVE_INFINITY;

/**
 * Комната, в которой сессия стоит в сайдбаре (решение 4 спеки окна): хост с 2026-09-29 держит сессию не
 * больше чем в одной комнате, но старая карта может числить её в нескольких — тогда она стоит в комнате с
 * самым ранним `createdAt` (равные и битые даты — в порядке карты), а в остальных её строки нет.
 */
function homeRooms(map: WorkMap): Map<string, Room> {
  const home = new Map<string, Room>();
  const byCreation = [...map.rooms].sort((a, b) => {
    const left = createdMs(a);
    const right = createdMs(b);
    return left === right ? 0 : left < right ? -1 : 1;
  });
  for (const room of byCreation) {
    for (const session of roomSessions(map, room)) {
      if (!home.has(session.id)) home.set(session.id, room);
    }
  }
  return home;
}

/**
 * Комната, в которой сессия стоит в сайдбаре (`homeRooms`); `null` — сессия вне комнат. Правило «своя комната» броска
 * (кусок 7, 2.5): в свою комнату сессию не бросают, а в другую, где она числится лишь в старой карте, — можно.
 */
export function homeRoomOf(map: WorkMap, sessionId: string): Room | null {
  return homeRooms(map).get(sessionId) ?? null;
}

/**
 * Строки карточки (спека окна 2026-09-29, 1.2, «Состав строк карточки»): сессии в порядке `treeOrder`;
 * участник комнаты отдельной строкой не выводится — на месте первого встреченного участника стоит строка
 * его комнаты; комнаты без живых участников — в конце, в порядке карты. Место комнаты задаёт её первый ЖИВОЙ
 * участник, а не первый показанный: закрытые скрыты за «N more closed», и от этого переключателя комната
 * не прыгала бы по карточке. Закрытая сессия вне комнаты — строкой, только при `showClosed`.
 */
export function cardRows(map: WorkMap, showClosed: boolean): CardRow[] {
  const home = homeRooms(map);
  const rows: CardRow[] = [];
  const emitted = new Set<string>();
  const roomRow = (room: Room, depth: number): CardRoomRow => {
    // Только те, кого сайдбар поставил в эту комнату: запись `room.members` старой карты может числить сессию и в другой.
    const sessions = roomSessions(map, room).filter((session) => home.get(session.id) === room);
    return {
      kind: 'room',
      room,
      depth,
      lead: roomLiveLead(map, room),
      members: sessions.filter((session) => showClosed || session.lifecycle !== 'closed'),
      sessions,
      lastAt: roomLastAt(map, room),
    };
  };

  for (const { session, depth } of treeOrder(map.sessions)) {
    const live = session.lifecycle !== 'closed';
    const room = home.get(session.id);
    if (room === undefined) {
      if (live || showClosed) rows.push({ kind: 'session', session, depth });
    } else if (live && !emitted.has(room.id)) {
      emitted.add(room.id);
      rows.push(roomRow(room, depth));
    }
  }
  for (const room of map.rooms) {
    if (!emitted.has(room.id)) rows.push(roomRow(room, 0));
  }
  return rows;
}
