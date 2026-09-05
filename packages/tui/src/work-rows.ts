/**
 * Строки списка работ: карты работ → плоский список рядов, готовых к рисованию.
 *
 * Здесь нет ни файловой системы, ни Ink — только порядок (дизайн координации TUI,
 * 6.5), свёртка, фильтр и геометрия окна (6.6).
 */

import {
  PROVIDERS,
  type Message,
  type Provider,
  type ProviderInfo,
  type SessionStatus,
  type TokenTotals,
  type Work,
  type WorkEntry,
  type WorkSession,
} from '@harnas/core';
import type { Glyphs } from './glyphs.js';

/**
 * Метрики, которые видны в списке. Пока сессия жива, карта их не хранит —
 * они считаются по логам провайдера; модель в карте не хранится никогда.
 */
export interface LiveMetrics {
  durationMs: number | null;
  tokens: TokenTotals | null;
  model: string | null;
  /**
   * Время последней записи в логе провайдера: от него ДЕТАЛИ считают «молчит Nм»
   * (дизайн 3). В карте его нет — только в индексе логов.
   */
  lastRecordAt: string | null;
}

const NO_METRICS: LiveMetrics = {
  durationMs: null,
  tokens: null,
  model: null,
  lastRecordAt: null,
};

/** Сколько сессий работы в каком статусе плюс её непрочитанные сообщения. */
export interface WorkCounters {
  statuses: Partial<Record<SessionStatus, number>>;
  unread: number;
}

export interface WorkRowWork {
  kind: 'work';
  key: string;
  projectPath: string;
  /** Перед этой строкой рисуется заголовок проекта. */
  startsProject: boolean;
  work: Work;
  expanded: boolean;
  /** Сколько всего сессий в работе — показывается у свёрнутой. */
  total: number;
  counters: WorkCounters;
  /** Строка-объяснение под работой: сессий нет или все скрыты фильтром. */
  note: string | null;
}

/** Входящее сообщение сессии: отправитель уже подписан ролью (дизайн 3). */
export interface InboxMessage {
  id: string;
  /** Роль отправителя; у неизвестной сессии — её id. */
  from: string;
  at: string;
  text: string;
  read: boolean;
}

export interface WorkRowSession {
  kind: 'session';
  key: string;
  projectPath: string;
  workId: string;
  startsProject: false;
  session: WorkSession;
  /** 0 — сессия открыта в работе, дальше — кого породил агент. */
  depth: number;
  unread: number;
  /** Только входящие: непрочитанные первыми, внутри — по времени убыв. (6.5). */
  inbox: InboxMessage[];
  live: LiveMetrics;
}

export type WorkRow = WorkRowWork | WorkRowSession;

export interface BuildRowsOptions {
  /** Явная свёртка работы; по умолчанию свёрнуты `done` (дизайн 6.5). */
  expanded?: Map<string, boolean>;
  /** Фильтр по провайдеру: прячет сессии, но не работы (решение №4). */
  filter?: Provider | null;
  /** Метрики живой сессии по логам провайдера. */
  live?: (session: WorkSession) => LiveMetrics;
}

/**
 * Набор провайдеров открыт: `providers.json` добавляет свои CLI, и подписи для
 * них в реестре нет — показываем сырой id, а не падаем.
 */
const registryEntry = (provider: string): ProviderInfo | undefined =>
  (PROVIDERS as Record<string, ProviderInfo | undefined>)[provider];

export function providerLabel(provider: string): string {
  return registryEntry(provider)?.label ?? provider;
}

export function providerMarkOf(provider: string): string {
  return registryEntry(provider)?.mark ?? provider;
}

/** Ключ работы: id уникален только внутри проекта. */
export function workKey(projectPath: string, workId: string): string {
  return `${projectPath} ${workId}`;
}

const rank = (status: Work['status']): number => (status === 'active' ? 0 : 1);

const desc = (a: string, b: string): number => b.localeCompare(a);

/** Сессии деревом: корни по порядку создания, дети сразу под родителем. */
export function treeOrder(
  sessions: readonly WorkSession[],
): Array<{ session: WorkSession; depth: number }> {
  const children = new Map<string, WorkSession[]>();
  const known = new Set(sessions.map((session) => session.id));
  const roots: WorkSession[] = [];

  for (const session of sessions) {
    // Порождённая сессия, чьего родителя в карте нет, — всё равно корень: иначе
    // она пропала бы из списка.
    if (session.parent !== null && known.has(session.parent)) {
      const list = children.get(session.parent);
      if (list === undefined) children.set(session.parent, [session]);
      else list.push(session);
    } else {
      roots.push(session);
    }
  }

  const out: Array<{ session: WorkSession; depth: number }> = [];
  const walk = (session: WorkSession, depth: number): void => {
    out.push({ session, depth });
    for (const child of children.get(session.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return out;
}

/** Входящие сессии: исходящие не показываются вовсе (решение №10). */
function inboxOf(
  messages: readonly Message[],
  sessionId: string,
  labels: ReadonlyMap<string, string>,
): InboxMessage[] {
  return messages
    .filter((message) => message.to === sessionId)
    .map((message) => ({
      id: message.id,
      from: labels.get(message.from) ?? message.from,
      at: message.at,
      text: message.text,
      read: message.readAt !== null,
    }))
    .sort((a, b) => Number(a.read) - Number(b.read) || desc(a.at, b.at));
}

function countersOf(entry: WorkEntry): WorkCounters {
  const statuses: Partial<Record<SessionStatus, number>> = {};
  for (const session of entry.map.sessions) {
    statuses[session.status] = (statuses[session.status] ?? 0) + 1;
  }
  const unread = entry.map.messages.filter((message) => message.readAt === null).length;
  return { statuses, unread };
}

/**
 * Метрики ряда: у завершённой сессии они зафиксированы в карте, у живой берутся
 * из логов. Модель в карте не хранится — она всегда из логов провайдера.
 */
function metricsOf(session: WorkSession, live: LiveMetrics): LiveMetrics {
  if (session.metrics === null) return live;
  return {
    durationMs: session.metrics.durationMs,
    tokens: session.metrics.tokens,
    model: live.model,
    lastRecordAt: live.lastRecordAt,
  };
}

/** Плоский список рядов: проекты → работы → сессии (дизайн 6.5). */
export function buildRows(
  entries: readonly WorkEntry[],
  { expanded = new Map(), filter = null, live = () => NO_METRICS }: BuildRowsOptions = {},
): WorkRow[] {
  const byProject = new Map<string, WorkEntry[]>();
  for (const entry of entries) {
    if (entry.map.work.status === 'archived') continue;
    const list = byProject.get(entry.projectPath);
    if (list === undefined) byProject.set(entry.projectPath, [entry]);
    else list.push(entry);
  }

  const freshest = (list: WorkEntry[]): string =>
    list.reduce((max, item) => (item.map.work.updatedAt > max ? item.map.work.updatedAt : max), '');

  const projects = [...byProject.entries()].sort(([, a], [, b]) => desc(freshest(a), freshest(b)));

  const rows: WorkRow[] = [];
  for (const [projectPath, list] of projects) {
    const works = [...list].sort(
      (a, b) =>
        rank(a.map.work.status) - rank(b.map.work.status) ||
        desc(a.map.work.updatedAt, b.map.work.updatedAt),
    );

    let first = true;
    for (const entry of works) {
      const { work, sessions, messages } = entry.map;
      const key = workKey(projectPath, work.id);
      // `done` при старте свёрнуты — на них уже не смотрят (дизайн 6.5).
      const open = expanded.get(key) ?? work.status !== 'done';
      const visible = treeOrder(sessions).filter(
        (item) => filter === null || item.session.provider === filter,
      );
      const note =
        !open || visible.length > 0
          ? null
          : sessions.length === 0
            ? 'сессий нет · n — новая'
            : `фильтр: ${providerMarkOf(filter as Provider)}`;

      rows.push({
        kind: 'work',
        key,
        projectPath,
        startsProject: first,
        work,
        expanded: open,
        total: sessions.length,
        counters: countersOf(entry),
        note,
      });
      first = false;

      if (!open) continue;
      const labels = new Map(sessions.map((item) => [item.id, item.label]));
      for (const { session, depth } of visible) {
        rows.push({
          kind: 'session',
          key: `${key} ${session.id}`,
          projectPath,
          workId: work.id,
          startsProject: false,
          session,
          depth,
          unread: messages.filter((message) => message.to === session.id && message.readAt === null)
            .length,
          inbox: inboxOf(messages, session.id, labels),
          live: metricsOf(session, live(session)),
        });
      }
    }
  }

  return rows;
}

/** Порядок показа частей агрегата и порядок, в котором они отбрасываются (6.4). */
const TAIL_ORDER: readonly SessionStatus[] = ['active', 'pending', 'exited', 'done', 'failed'];
const DROP_ORDER: readonly SessionStatus[] = ['done', 'failed', 'exited', 'pending'];

/**
 * Хвост строки работы: `●2 ◌1 ▤1`. Не отбрасывается целиком — на самой узкой
 * ширине сжимается до `▤N`, а без сообщений до `●N` (дизайн 6.4).
 */
export function workTail(counters: WorkCounters, g: Glyphs, limit: number): string {
  const dropped = new Set<SessionStatus>();

  const render = (): string => {
    const parts = TAIL_ORDER.filter(
      (status) => !dropped.has(status) && (counters.statuses[status] ?? 0) > 0,
    ).map((status) => `${g[status]}${counters.statuses[status] ?? 0}`);
    if (counters.unread > 0) parts.push(`${g.mail}${counters.unread}`);
    return parts.length === 0 ? '—' : parts.join(' ');
  };

  for (const status of DROP_ORDER) {
    if (render().length <= limit) return render();
    dropped.add(status);
  }
  // Последним уходит `●N` — и только если есть что показать вместо него.
  if (render().length > limit && counters.unread > 0) dropped.add('active');
  return render();
}

/** Сколько строк занимает ряд: сессия двухэтажная, ряд не рвётся (2.3). */
export function rowLines(row: WorkRow): number {
  if (row.kind === 'session') return 2;
  return 1 + (row.startsProject ? 1 : 0) + (row.note === null ? 0 : 1);
}

export interface RowLayout {
  start: number;
  end: number;
  /**
   * Сколько рядов не видно выше и ниже окна — строки «… N выше / ниже».
   * Липкий заголовок работы в `above` не входит: он нарисован над окном.
   */
  above: number;
  below: number;
  /** Ряд работы, чей заголовок нужно прилепить над окном. */
  stickyWork: number | null;
  stickyProject: string | null;
}

const EMPTY_LAYOUT: RowLayout = {
  start: 0,
  end: 0,
  above: 0,
  below: 0,
  stickyWork: null,
  stickyProject: null,
};

/** Окно рядов вокруг выбранного: растём по очереди вниз и вверх, пока влезает. */
function grow(
  rows: readonly WorkRow[],
  selected: number,
  budget: number,
): { start: number; end: number } {
  const at = Math.max(0, Math.min(selected, rows.length - 1));
  let start = at;
  let end = at + 1;
  let used = rowLines(rows[at] as WorkRow);
  let downwards = true;

  for (;;) {
    const next = end < rows.length ? rowLines(rows[end] as WorkRow) : null;
    const previous = start > 0 ? rowLines(rows[start - 1] as WorkRow) : null;
    const canDown = next !== null && used + next <= budget;
    const canUp = previous !== null && used + previous <= budget;
    if (!canDown && !canUp) break;

    if (downwards ? canDown : !canUp) {
      used += next as number;
      end += 1;
    } else {
      start -= 1;
      used += previous as number;
    }
    downwards = !downwards;
  }

  return { start, end };
}

function decorate(rows: readonly WorkRow[], window: { start: number; end: number }): RowLayout {
  const { start, end } = window;
  const first = rows[start];
  let stickyWork: number | null = null;
  let stickyProject: string | null = null;

  if (first !== undefined) {
    if (first.kind === 'session') {
      for (let at = start - 1; at >= 0; at--) {
        if (rows[at]?.kind === 'work') {
          stickyWork = at;
          break;
        }
      }
    }
    if (!first.startsProject) {
      for (let at = start - 1; at >= 0; at--) {
        const row = rows[at];
        if (row?.projectPath === first.projectPath && row.startsProject) {
          stickyProject = first.projectPath;
          break;
        }
      }
    }
  }

  // Ряд работы, вынесенный в липкий заголовок, из счётчика скрытых вычитается:
  // он нарисован над окном, и считать его «скрытым» — врать на единицу (6.6).
  const above = start - (stickyWork === null ? 0 : 1);
  return { start, end, above, below: rows.length - end, stickyWork, stickyProject };
}

const overheadOf = (layout: RowLayout): number =>
  (layout.above > 0 ? 1 : 0) +
  (layout.below > 0 ? 1 : 0) +
  (layout.stickyWork === null ? 0 : 1) +
  (layout.stickyProject === null ? 0 : 1);

/**
 * Окно видимых рядов: считается в строках, ряд не рвётся (2.3). Липкие заголовки
 * и строки «… N выше / ниже» тоже занимают место, поэтому окно пересчитывается,
 * пока их число не перестанет расти (6.6).
 */
export function layoutRows(rows: readonly WorkRow[], selected: number, height: number): RowLayout {
  if (rows.length === 0 || height <= 0) return EMPTY_LAYOUT;

  let overhead = 0;
  let layout = decorate(rows, grow(rows, selected, height));
  for (let pass = 0; pass < 3; pass++) {
    const needed = overheadOf(layout);
    if (needed <= overhead) break;
    overhead = needed;
    layout = decorate(rows, grow(rows, selected, Math.max(1, height - overhead)));
  }
  return layout;
}
