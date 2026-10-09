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
import { agentsLeftWithoutRoom, isRoomArchived } from '../lib/room-archive.js';
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
  /**
   * Ссылка «N archived» внизу группы проекта (спека архива комнат и проектов, 6.1): `count` — все архивные работы
   * проекта, закреплённые тоже; `shown` — раскрыты ли они в этой группе. Нет поля — ссылки нет: архивных работ у проекта
   * нет, либо включён общий показ архивных (палитра «Show archived workspaces») и раскрывать нечего.
   */
  archived?: { count: number; shown: boolean };
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
export function folderName(projectPath: string): string {
  const parts = projectPath.split('/').filter((part) => part !== '');
  return parts.at(-1) ?? projectPath;
}

export function buildSections(input: {
  entries: WorkEntry[];
  attention: Record<string, WorkAttention>;   // ключ — workKey
  pinned: string[]; collapsed: string[]; showDone: boolean;
  /** false — archived скрыты, как в 3.2; true — в конце своей секции, после done (кусок 6.3, спека 6.7). */
  showArchived: boolean;
  /** Проекты, убранные из списка («Remove from list…», `ui.json.hiddenProjects`); при `showArchived` показаны все. */
  hidden: string[];
  /** Проекты, чья ссылка «N archived» раскрыта: их архивные работы показаны в конце группы, остальных проектов это не касается. */
  archivedShown: string[];
}): SidebarSection[] {
  const { entries, attention, showDone, showArchived } = input;
  const pinned = new Set(input.pinned);
  const collapsed = new Set(input.collapsed);
  const archivedShown = new Set(input.archivedShown);

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

  const isArchived = (entry: WorkEntry): boolean => entry.map.work.status === 'archived';

  // Архивные работы проекта — все, закреплённые тоже: их число стоит в ссылке «N archived» (6.1). Закреплённая
  // архивная из «Закреплённых» уходит, а в ссылке своего проекта остаётся.
  const archivedCount = new Map<string, number>();
  const liveProjects = new Set<string>();
  for (const entry of entries) {
    if (isArchived(entry)) archivedCount.set(entry.projectPath, (archivedCount.get(entry.projectPath) ?? 0) + 1);
    else liveProjects.add(entry.projectPath);
  }

  // Убранный проект скрыт, только пока в нём нет неархивных работ: окно снимает путь из `hiddenProjects`
  // эффектом (`use-sidebar-sections.ts`), но кадр до него работа с агентами скрытой остаться не должна.
  const hidden = new Set(input.hidden.filter((path) => !liveProjects.has(path)));
  const skipped = (projectPath: string): boolean => !showArchived && hidden.has(projectPath);

  const shown = entries.filter((entry) => {
    const { status } = entry.map.work;
    if (skipped(entry.projectPath)) return false;
    const archivedVisible = showArchived || archivedShown.has(entry.projectPath);
    return (archivedVisible || status !== 'archived') && (showDone || status !== 'done');
  });

  const pinnedWorks: WorkEntry[] = [];
  const byProject = new Map<string, WorkEntry[]>();
  for (const entry of shown) {
    // В «Закреплённые» архивная идёт только при общем показе архивных; при раскрытой ссылке проекта она в его группе.
    if (pinned.has(workKey(entry.projectPath, entry.map.work.id)) && (!isArchived(entry) || showArchived)) {
      pinnedWorks.push(entry);
      continue;
    }
    const list = byProject.get(entry.projectPath);
    if (list === undefined) byProject.set(entry.projectPath, [entry]);
    else list.push(entry);
  }
  // Группа из одних архивных остаётся (6.1): шапка, «+», пустой список и ссылка. Проекту не нужна показанная работа —
  // достаточно архивной, иначе он пропадал бы из сайдбара вместе с последней работой.
  for (const projectPath of archivedCount.keys()) {
    if (!skipped(projectPath) && !byProject.has(projectPath)) byProject.set(projectPath, []);
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

  // Ссылка «N archived»: при общем показе архивных раскрывать нечего, и ссылки нет.
  const archivedLink = (projectPath: string): Pick<SidebarSection, 'archived'> => {
    const count = archivedCount.get(projectPath) ?? 0;
    return count === 0 || showArchived ? {} : { archived: { count, shown: archivedShown.has(projectPath) } };
  };

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
        ...archivedLink(projectPath),
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
  /** Комната в архиве (спека архива комнат, 5.1): строка приглушена и стоит под ссылкой «N archived rooms». */
  archived: boolean;
  /**
   * Сессии, которых архивация этой комнаты оставит без открытой комнаты (`agentsLeftWithoutRoom`): число во флажке
   * «Also stop its N agents…» меню строки. Не то же, что `sessions`: там — кого сайдбар поставил в комнату, а здесь —
   * правило core по всей карте (сессия старой карты может числиться в нескольких комнатах). У архивной комнаты пусто.
   */
  archiveStops: WorkSession[];
}

export type CardRow = CardSessionRow | CardRoomRow;

/** Время создания комнаты для порядка «самая ранняя»; битая дата — самая поздняя: настоящая её всегда обходит. */
const createdMs = (room: Room): number => isoMs(room.createdAt) ?? Number.POSITIVE_INFINITY;

/**
 * Комната, в которой сессия стоит в сайдбаре (решение 4 спеки окна): хост с 2026-09-29 держит сессию не
 * больше чем в одной комнате, но старая карта может числить её в нескольких — тогда она стоит в комнате с
 * самым ранним `createdAt` (равные и битые даты — в порядке карты), а в остальных её строки нет. Открытая комната
 * раньше архивной (спека архива комнат, 5.1): сессия, числящаяся и там и там, стоит в открытой, а в архивную попадает,
 * только если открытой у неё нет.
 */
function homeRooms(map: WorkMap): Map<string, Room> {
  const home = new Map<string, Room>();
  const byCreation = [...map.rooms].sort((a, b) => {
    const left = createdMs(a);
    const right = createdMs(b);
    return left === right ? 0 : left < right ? -1 : 1;
  });
  const open = byCreation.filter((room) => !isRoomArchived(room));
  const archived = byCreation.filter(isRoomArchived);
  for (const room of [...open, ...archived]) {
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
 * Сессия архивной комнаты, что остаётся на карточке обычной строкой (спека архива комнат, 5.1): процесс жив (`active`)
 * или вот-вот поднимется (`pending`) — флажок «остановить» был снят, и прятать работающего агента, а с ним его
 * внимание, под ссылку нельзя. `sleeping` и `closed` уходят вместе с комнатой.
 */
const staysOnCard = (session: WorkSession): boolean => session.lifecycle === 'active' || session.lifecycle === 'pending';

/** Строка комнаты (`cardRows`, `archivedRows`): состав участников зависит от `home` и от того, в архиве ли комната. */
function buildRoomRow(map: WorkMap, home: Map<string, Room>, showClosed: boolean, room: Room, depth: number): CardRoomRow {
  const archived = isRoomArchived(room);
  // Только те, кого сайдбар поставил в эту комнату: запись `room.members` старой карты может числить сессию и в другой.
  // Работающие участники архивной комнаты стоят на карточке своими строками (`staysOnCard`), второй раз их не выводим.
  const sessions = roomSessions(map, room).filter(
    (session) => home.get(session.id) === room && !(archived && staysOnCard(session)),
  );
  return {
    kind: 'room',
    room,
    depth,
    lead: roomLiveLead(map, room),
    members: sessions.filter((session) => showClosed || session.lifecycle !== 'closed'),
    sessions,
    lastAt: roomLastAt(map, room),
    archived,
    archiveStops: archived ? [] : agentsLeftWithoutRoom(map, room),
  };
}

/**
 * Строки карточки (спека окна 2026-09-29, 1.2, «Состав строк карточки»): сессии в порядке `treeOrder`;
 * участник комнаты отдельной строкой не выводится — на месте первого встреченного участника стоит строка
 * его комнаты; комнаты без живых участников — в конце, в порядке карты. Место комнаты задаёт её первый ЖИВОЙ
 * участник, а не первый показанный: закрытые скрыты за «N more closed», и от этого переключателя комната
 * не прыгала бы по карточке. Закрытая сессия вне комнаты — строкой, только при `showClosed`.
 *
 * Архивные комнаты (спека архива комнат, 5.1) в основных строках не выводятся — их даёт `archivedRows`, под ссылкой
 * «N archived rooms». Сессия, чья домашняя комната архивная, стоит обычной строкой, если она работает (`staysOnCard`),
 * а спящая и закрытая уходят под ссылку вместе с комнатой.
 */
export function cardRows(map: WorkMap, showClosed: boolean): CardRow[] {
  const home = homeRooms(map);
  const rows: CardRow[] = [];
  const emitted = new Set<string>();

  for (const { session, depth } of treeOrder(map.sessions)) {
    const live = session.lifecycle !== 'closed';
    const room = home.get(session.id);
    const inArchive = room !== undefined && isRoomArchived(room);
    if (room === undefined || (inArchive && staysOnCard(session))) {
      if (live || showClosed) rows.push({ kind: 'session', session, depth });
    } else if (!inArchive && live && !emitted.has(room.id)) {
      // Спящая и закрытая сессия архивной комнаты (`inArchive`) строки не получает: она уходит с комнатой под ссылку.
      emitted.add(room.id);
      rows.push(buildRoomRow(map, home, showClosed, room, depth));
    }
  }
  for (const room of map.rooms) {
    if (!emitted.has(room.id) && !isRoomArchived(room)) rows.push(buildRoomRow(map, home, showClosed, room, 0));
  }
  return rows;
}

/**
 * Строки архивных комнат карточки (спека архива комнат, 5.1) — под ссылкой «N archived rooms», в порядке карты. Их
 * число — число в ссылке, даже у комнаты без единого участника под ссылкой.
 */
export function archivedRows(map: WorkMap, showClosed: boolean): CardRoomRow[] {
  const home = homeRooms(map);
  return map.rooms.filter(isRoomArchived).map((room) => buildRoomRow(map, home, showClosed, room, 0));
}
