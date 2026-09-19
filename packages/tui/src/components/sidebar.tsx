/**
 * Сайдбар: работы проекта сверху, строка `new`, дерево сессий выбранной работы
 * снизу (дизайн TUI v2, 2.1; макеты 1.1–1.5, 5 и 7).
 *
 * Компонент только рисует: порядок сессий берётся из `work-rows.ts`, состояние
 * точек — из `use-activity.ts`, выбор — из `use-selection.ts`.
 */

import type { SessionIndex, WorkEntry, WorkSession, WorkStatus } from '@harnas/core';
import { Box, Text } from 'ink';
import { memo, type ReactNode } from 'react';
import {
  formatDuration,
  formatTokens,
  truncate,
  truncateLeft,
  visibleWindow,
  withHome,
} from '../format.js';
import { glyphs, selectionProps, type Glyphs } from '../glyphs.js';
import { treeOrder, workKey, type LiveMetrics } from '../work-rows.js';
import { ActivityDot, dotColor, stateLetter, type DotState } from './activity-dot.js';

/** Ширина сайдбара по умолчанию и узкая (раздел 2.1). */
export const WIDE = 26;
const NARROW = 18;
/** Уже этого сайдбар прячется сам и доступен оверлеем по `prefix b` (2.1). */
const MIN_COLUMNS = 60;
/** На этой ширине терминала сайдбар ещё узкий; полный — шире её (макет 1.2). */
const WIDE_COLUMNS = 80;
/** Короче этого ярлык и заголовок не режутся (раздел 7). */
const MIN_LABEL = 4;

/**
 * Ширина сайдбара по ширине терминала: `null` — сайдбар не показывается.
 * Настроенная ширина уже узкой не расширяется.
 */
export function sidebarWidth(columns: number, configured: number = WIDE): number | null {
  if (columns < MIN_COLUMNS) return null;
  return columns <= WIDE_COLUMNS ? Math.min(configured, NARROW) : configured;
}

export interface SidebarWork {
  /** Ключ работы: `workKey(projectPath, id)`. */
  key: string;
  /** Номер 1..9 для `prefix 1..9`; дальше работы идут без номера (решение №1). */
  number: number | null;
  title: string;
  /** Хвост пути проекта для второй строки. */
  project: string;
  /** Ветка git проекта; `null` — неизвестна, второй строкой только путь. */
  branch: string | null;
  /** Точка работы: максимум по её сессиям; `null` — сессий нет (решение №6). */
  state: DotState | null;
  /** `done` — одна строка, без проекта и ветки (решение №4). */
  done: boolean;
}

export interface SidebarSession {
  session: WorkSession;
  state: DotState;
  live: LiveMetrics;
  unread: number;
  /** Живые субагенты: `⋮N` в компактной строке (макет §5). */
  subagents: number;
}

/** Сколько работ получают номера `prefix 1..9`; дальше — без номера (решение №1). */
const NUMBERED = 9;

const workRank = (status: WorkStatus): number => (status === 'active' ? 0 : 1);

/** Запись индекса логов провайдера: из неё берутся ветка и метрики. */
type Indexer = (session: WorkSession) => SessionIndex | undefined;

export interface WorksViewOptions {
  /** Проект харнесса: сверху сайдбара — только его работы (решение №3). */
  projectPath: string;
  /** Точка работы — максимум по её сессиям; `null` — сессий нет (решение №6). */
  workState: (key: string) => DotState | null;
  index: Indexer;
  /** Ветка проекта из `.git/HEAD`: запасной источник, когда лога ещё нет. */
  branch?: GitBranch;
  /**
   * Работы чужих проектов, выбранные через пикер `prefix w`: они закрепляются
   * в сайдбаре до выхода из харнесса (2.1, решение №3).
   */
  pinned?: ReadonlySet<string>;
}

/** Ветка проекта из `.git/HEAD` (`use-git-branch.ts`). */
type GitBranch = (projectPath: string) => string | null;

const NO_BRANCH: GitBranch = () => null;

/**
 * Ветка работы: из лога любой её сессии, а у работы без логов — из `.git/HEAD`
 * её проекта. В карте ветки нет ни в каком виде.
 */
export function branchOf(
  entry: WorkEntry,
  index: Indexer,
  branch: GitBranch = NO_BRANCH,
): string | null {
  for (const session of entry.map.sessions) {
    const found = index(session)?.gitBranch;
    if (found != null) return found;
  }
  return branch(entry.projectPath);
}

/**
 * Работы текущего проекта в порядке сайдбара (2.1): `active` по свежести,
 * `done` ниже, `archived` не показываются.
 */
export function sidebarWorks(
  entries: readonly WorkEntry[],
  {
    projectPath,
    workState,
    index,
    branch = NO_BRANCH,
    pinned = new Set<string>(),
  }: WorksViewOptions,
): SidebarWork[] {
  return (
    entries
      .filter(
        (entry) =>
          (entry.projectPath === projectPath ||
            pinned.has(workKey(entry.projectPath, entry.map.work.id))) &&
          entry.map.work.status !== 'archived',
      )
      // Порядок создания, а не последнего события: номера `prefix 1..9` не должны
      // скакать, как только в какой-то работе что-то произошло.
      .sort(
        (a, b) =>
          workRank(a.map.work.status) - workRank(b.map.work.status) ||
          a.map.work.createdAt.localeCompare(b.map.work.createdAt),
      )
      .map((entry, at) => {
        const key = workKey(entry.projectPath, entry.map.work.id);
        return {
          key,
          number: at < NUMBERED ? at + 1 : null,
          title: entry.map.work.title,
          project: withHome(entry.projectPath),
          branch: branchOf(entry, index, branch),
          state: workState(key),
          done: entry.map.work.status === 'done',
        };
      })
  );
}

export interface SessionsViewOptions {
  state: (session: WorkSession) => DotState;
  index: Indexer;
  /** Живые субагенты сессии: `⋮N` в компактной строке. */
  subagents: (session: WorkSession) => number;
}

/** Метрики завершённой сессии зафиксированы в карте, у живой — в логах. */
function metricsOf(session: WorkSession, found: SessionIndex | undefined): LiveMetrics {
  return {
    durationMs: session.metrics?.durationMs ?? found?.durationMs ?? null,
    tokens: session.metrics?.tokens ?? found?.tokens ?? null,
    model: found?.primaryModel ?? null,
    lastRecordAt: found?.endedAt ?? null,
  };
}

/** Сессии выбранной работы: дерево строит сам сайдбар, порядок — из карты. */
export function sidebarSessions(
  entry: WorkEntry | undefined,
  { state, index, subagents }: SessionsViewOptions,
): SidebarSession[] {
  if (entry === undefined) return [];
  return entry.map.sessions.map((session) => ({
    session,
    state: state(session),
    live: metricsOf(session, index(session)),
    unread: entry.map.messages.filter(
      (message) => message.to === session.id && message.readAt === null,
    ).length,
    subagents: subagents(session),
  }));
}

export interface SidebarProps {
  works: readonly SidebarWork[];
  /** Сессии выбранной работы; дерево строится здесь. */
  sessions: readonly SidebarSession[];
  selectedWork: string | null;
  selectedSession: string | null;
  /** 26 или 18: `sidebarWidth` уже решил, показывать ли сайдбар вообще. */
  width: number;
  /** Строк под сайдбар — вся высота, кроме строки статуса. */
  height: number;
  /** Режим навигации `prefix s`: разделитель cyan и жирный (макет 1.5). */
  navigating?: boolean;
  /** Курсор режима навигации: его строка подсвечена наравне с выбранными (3.2). */
  cursor?: SidebarTarget | null;
  /**
   * Рамки блоков и боковые грани сайдбара; в оверлее рамку даёт сам оверлей —
   * `framed={false}` убирает и грани блоков, и боковые вертикали, а заголовки
   * блоков остаются обычными строками (план рамок, задача 5, решение №5).
   */
  framed?: boolean;
}

const pad = (used: number, width: number): string => ' '.repeat(Math.max(0, width - used));

/**
 * Строка-грань блока сайдбара, ровно `width` символов (план рамок, задача 2).
 * Верхняя несёт заголовок «╭─ заголовок ─…─╮», нижняя — пустая «╰──…──╯».
 * Заголовок режется существующим `truncate` по `width - 5`: два угла, дефис
 * и два пробела вокруг подписи. Места нет — грань глухая.
 *
 * Второе, правое поле верхней грани — короткая пометка у угла, зеркально
 * заголовку: «╭─ заголовок ────… пометка ─╮» (план рамок, находка сверки:
 * рамка треда). Приоритет при нехватке места — у пометки: заголовок режется
 * первым, без пометки тред врал бы про непрочитанное. Нижняя грань правое
 * поле не несёт — как и заголовок, оно относится только к верхней.
 */
export function frameLine({
  title,
  right = null,
  width,
  g,
  top,
}: {
  title: string | null;
  right?: string | null;
  width: number;
  g: Glyphs;
  top: boolean;
}): string {
  const left = top ? g.frame.topLeft : g.frame.bottomLeft;
  const cornerRight = top ? g.frame.topRight : g.frame.bottomRight;
  const plain = `${left}${g.frame.horizontal.repeat(Math.max(0, width - 2))}${cornerRight}`;
  if (!top) return plain;
  // Хвост грани: без пометки — просто угол, с ней — те же пробел-дефис, что
  // и слева у заголовка, зеркально.
  const tail = right === null ? cornerRight : ` ${right} ${g.frame.horizontal}${cornerRight}`;
  if (title === null) {
    if (right === null) return plain;
    return `${left}${g.frame.horizontal.repeat(Math.max(0, width - 1 - tail.length))}${tail}`;
  }
  // Фиксированных символов пять у заголовка одного, плюс три у пометки (два
  // пробела и дефис вокруг неё — сам угол уже в `tail`). Не влезают — грань
  // остаётся глухой под заголовок, пометка при этом никуда не девается.
  const room = width - 5 - (right === null ? 0 : right.length + 3);
  if (room <= 0) {
    return `${left}${g.frame.horizontal.repeat(Math.max(0, width - 1 - tail.length))}${tail}`;
  }
  const head = `${left}${g.frame.horizontal} ${truncate(title, room, g.ellipsis)} `;
  return `${head}${g.frame.horizontal.repeat(Math.max(0, width - head.length - tail.length))}${tail}`;
}

/**
 * Цвет граней блока по активности: `navigating` — bold cyan, иначе dim. Ровно
 * приём, которым раньше красился разделитель `Divider` (план рамок, задача 5).
 */
function frameColor(navigating: boolean): { bold?: boolean; color?: string; dimColor?: boolean } {
  return navigating ? { bold: true, color: 'cyan' } : { dimColor: true };
}

/** Боковая грань блока: вертикаль слева и справа у каждой обычной строки (§3, §5). */
function FrameEdge({ g, navigating }: { g: Glyphs; navigating: boolean }): ReactNode {
  return <Text {...frameColor(navigating)}>{g.frame.vertical}</Text>;
}

/**
 * Текст кнопки `new` неизменен (план рамок, задача 4, решение №4): длинная
 * подсказка «первая сессия» внутрь не идёт — она не влезла бы в плашку на
 * узком сайдбаре 18, поэтому рисуется отдельной строкой снаружи.
 */
const NEW_BUTTON_TEXT = ' + new ';

/**
 * Фон плашки `new` под курсором — акцентный cyan вместо общего blackBright
 * подсветки строк: кнопка отличима от обычного выбранного ряда (план рамок,
 * задача 4). В ASCII-наборе, как и у общей подсветки, — reverse video.
 */
function buttonProps(
  selected: boolean,
  g: Glyphs,
): { backgroundColor?: string; inverse?: boolean } {
  if (!selected) return {};
  return g.ascii ? { inverse: true } : { backgroundColor: 'cyan' };
}

/**
 * Кнопка `new` — первая строка блока работ (план рамок, задача 4, решение №4):
 * компактная плашка, фон только под текстом. В `Row` фон красит и добивку до
 * ширины — здесь добивка фон не несёт нарочно: иначе на строке под курсором
 * лёг бы фон на фон.
 */
function NewButton({
  selected,
  width,
  g,
  navigating,
  framed,
}: {
  selected: boolean;
  width: number;
  g: Glyphs;
  navigating: boolean;
  framed: boolean;
}): ReactNode {
  return (
    <Text wrap="truncate">
      {framed && <FrameEdge g={g} navigating={navigating} />}
      <Text {...buttonProps(selected, g)}>{NEW_BUTTON_TEXT}</Text>
      {pad(NEW_BUTTON_TEXT.length, width)}
      {framed && <FrameEdge g={g} navigating={navigating} />}
    </Text>
  );
}

/** Простая строка сайдбара: боковые грани, текст слева, добивка до ширины. */
function Row({
  text,
  width,
  g,
  navigating,
  framed,
  selected = false,
  dim = true,
}: {
  text: string;
  width: number;
  g: Glyphs;
  navigating: boolean;
  framed: boolean;
  selected?: boolean;
  dim?: boolean;
}): ReactNode {
  return (
    <Text wrap="truncate">
      {framed && <FrameEdge g={g} navigating={navigating} />}
      <Text {...selectionProps(selected, g)}>
        <Text dimColor={dim}>{truncate(text, width, g.ellipsis)}</Text>
        {pad(text.length, width)}
      </Text>
      {framed && <FrameEdge g={g} navigating={navigating} />}
    </Text>
  );
}

/** Строка работы: `[N ]заголовок … точка`; номер и точка не отбрасываются (§7). */
function WorkRow({
  work,
  selected,
  width,
  g,
  navigating,
  framed,
}: {
  work: SidebarWork;
  selected: boolean;
  width: number;
  g: Glyphs;
  navigating: boolean;
  framed: boolean;
}): ReactNode {
  const head = ` ${work.number === null ? '' : `${work.number} `}`;
  // Точка стоит на предпоследней колонке, последняя всегда пустая (макет 1.1).
  const title = truncate(work.title, Math.max(MIN_LABEL, width - head.length - 2), g.ellipsis);

  return (
    <Text wrap="truncate">
      {framed && <FrameEdge g={g} navigating={navigating} />}
      <Text {...selectionProps(selected, g)}>
        {head}
        {title}
        {pad(head.length + title.length + 2, width)}
        {work.state === null ? ' ' : <ActivityDot state={work.state} g={g} />}{' '}
      </Text>
      {framed && <FrameEdge g={g} navigating={navigating} />}
    </Text>
  );
}

/**
 * Вторая строка работы: `проект · ветка`. Первой режется ветка, следом путь —
 * слева, у него важен хвост (§7).
 */
function projectLine(work: SidebarWork, width: number, g: Glyphs): string {
  const room = width - 3;
  if (work.branch === null) return truncateLeft(work.project, room, g.ellipsis);
  const branch = truncate(work.branch, Math.max(MIN_LABEL, room - MIN_LABEL - 3), g.ellipsis);
  const project = truncateLeft(work.project, Math.max(0, room - branch.length - 3), g.ellipsis);
  return `${project} · ${branch}`;
}

/** Строка сессии: `[отступ] глиф ярлык … слово`; отступ и глиф не отбрасываются (§7). */
function SessionRow({
  item,
  depth,
  selected,
  width,
  g,
  navigating,
  framed,
}: {
  item: SidebarSession;
  depth: number;
  selected: boolean;
  width: number;
  g: Glyphs;
  navigating: boolean;
  framed: boolean;
}): ReactNode {
  const indent = ' '.repeat(1 + depth * 2);
  const child = depth > 0 ? `${g.child} ` : '';
  // На 18 слово состояния заменяется буквой, и только у живых состояний (1.2).
  const tail = width <= NARROW ? stateLetter(item.state) : item.state;
  const head = indent.length + child.length + 2;
  const label = truncate(
    item.session.label,
    Math.max(MIN_LABEL, width - head - tail.length - 2),
    g.ellipsis,
  );

  return (
    <Text wrap="truncate">
      {framed && <FrameEdge g={g} navigating={navigating} />}
      <Text {...selectionProps(selected, g)}>
        {indent}
        <Text dimColor>{child}</Text>
        <ActivityDot state={item.state} g={g} />
        {` ${label}`}
        {pad(head + label.length + tail.length + 1, width)}
        <Text {...dotColor(item.state)}>{tail}</Text>{' '}
      </Text>
      {framed && <FrameEdge g={g} navigating={navigating} />}
    </Text>
  );
}

/**
 * Компактная строка под выбранной сессией: `↑вход ↓выход · длительность · ▤N · ⋮N`.
 * Отбрасываются токены, следом длительность; `▤N` и `⋮N` — никогда (§7).
 */
function compactLine(item: SidebarSession, width: number, g: Glyphs): string {
  const counters = [
    item.unread > 0 ? `${g.mail}${item.unread}` : '',
    item.subagents > 0 ? `${g.subagent}${item.subagents}` : '',
  ].filter((part) => part !== '');

  const tokens =
    item.live.tokens === null
      ? '—'
      : `${g.up}${formatTokens(item.live.tokens.input)} ${g.down}${formatTokens(
          item.live.tokens.output,
        )}`;
  const duration = formatDuration(item.live.durationMs);

  const room = width - 3;
  const join = (parts: readonly string[]): string =>
    parts.filter((part) => part !== '').join(' · ');
  // На 18 токены отброшены всегда (§7).
  const full = width <= NARROW ? [duration, ...counters] : [tokens, duration, ...counters];
  if (join(full).length <= room) return join(full);
  const withoutTokens = [duration, ...counters];
  return join(join(withoutTokens).length <= room ? withoutTokens : counters);
}

/** Дерево сессий выбранной работы в порядке `createdAt` (2.1). */
function orderOf(
  sessions: readonly SidebarSession[],
): Array<{ item: SidebarSession; depth: number }> {
  const byId = new Map(sessions.map((item) => [item.session.id, item]));
  return treeOrder(sessions.map((item) => item.session)).flatMap(({ session, depth }) => {
    const item = byId.get(session.id);
    return item === undefined ? [] : [{ item, depth }];
  });
}

/** Что стоит за строкой сайдбара: по ней же работает клик мышью (3.3). */
export interface SidebarTarget {
  kind: 'work' | 'session' | 'new';
  /** Ключ работы, id сессии; у строки `new` ключа нет. */
  key: string;
}

const NEW_TARGET: SidebarTarget = { kind: 'new', key: '' };

/** Одна строка сайдбара: чем её рисовать и что делает клик по ней. */
type SidebarRow = { key: string; target: SidebarTarget | null } & (
  | { kind: 'work'; work: SidebarWork; selected: boolean }
  | { kind: 'session'; item: SidebarSession; depth: number; selected: boolean }
  | { kind: 'text'; text: string; dim: boolean; selected: boolean }
  // Грань блока (план рамок, задача 3): цели у неё нет — под клик не попадает.
  // `title` нужен рендеру: без рамок (`framed={false}`) заголовок идёт обычной
  // строкой вместо верхней грани, а не глухим текстом (план рамок, задача 5).
  | { kind: 'frame'; text: string; title: string | null }
  // Кнопка `new` (план рамок, задача 4): цель та же `NEW_TARGET`, что и раньше.
  | { kind: 'button'; selected: boolean }
);

/** Верхняя и нижняя грани у каждого из двух блоков сайдбара (план рамок, задача 3). */
const FRAME_ROWS = 4;

/**
 * Раскладка сайдбара сверху вниз: ровно `height` строк. Чистая — из неё же
 * берутся цели клика, поэтому картинка и мышь не расходятся (3.3).
 */
function layout({
  works,
  sessions,
  selectedWork,
  selectedSession,
  width,
  height,
  cursor = null,
  framed = true,
}: SidebarProps): SidebarRow[] {
  const g = glyphs();
  // Боковые грани отъедают по колонке слева и справа; без них (`framed={false}`,
  // оверлей рисует рамку сам) содержимому остаётся вся ширина (план рамок,
  // задача 5, бюджет места).
  const content = framed ? width - 2 : width;
  const atCursor = (target: SidebarTarget | null): boolean => sameTarget(cursor, target);
  const line = (
    key: string,
    text: string,
    dim = true,
    selected = false,
    target: SidebarTarget | null = null,
  ): SidebarRow => ({ kind: 'text', key, text, dim, selected, target });
  // Грань не кликабельна — цели у неё нет ни в клике мышью, ни в курсоре (§3, инвариант 2).
  const frame = (key: string, title: string | null, top: boolean): SidebarRow => ({
    kind: 'frame',
    key,
    target: null,
    title,
    text: frameLine({ title, width, g, top }),
  });

  // Кнопка `new` — первая строка блока работ, до самих работ (план рамок,
  // задача 4): цель та же `NEW_TARGET`, курсор и клик ходят как раньше.
  const top: SidebarRow[] = [
    { kind: 'button', key: 'new', target: NEW_TARGET, selected: atCursor(NEW_TARGET) },
  ];
  if (works.length === 0) {
    top.push(line('нет-работ', ' работ нет'));
    // Подсказка — отдельная dim-строка под кнопкой, а не текст внутри неё:
    // не поместилась бы в плашку на узком сайдбаре 18 (план рамок, задача 4).
    top.push(line('подсказка-new', ' первая сессия'));
  } else {
    for (const work of works) {
      const target: SidebarTarget = { kind: 'work', key: work.key };
      const selected = work.key === selectedWork || atCursor(target);
      top.push({ kind: 'work', key: work.key, work, selected, target });
      // Вторая строка отбрасывается у `done`-работ и на узком сайдбаре (§7).
      if (work.done || content <= NARROW) continue;
      top.push(
        line(`${work.key} проект`, `   ${projectLine(work, content, g)}`, true, selected, target),
      );
    }
  }

  const selectedTitle = works.find((work) => work.key === selectedWork)?.title ?? null;
  const ordered = selectedTitle === null ? [] : orderOf(sessions);
  const selectedAt = ordered.findIndex((item) => item.item.session.id === selectedSession);
  const chosen = selectedAt < 0 ? null : (ordered[selectedAt]?.item ?? null);
  // Компактная строка — часть выбранного ряда и тоже занимает место в окне;
  // у `pending` её нет (решение №7).
  const compact = chosen !== null && chosen.state !== 'pending';

  // Бюджет окна сессий отдаёт 4 строки под грани обоих блоков (§3, инвариант 3).
  const capacity = Math.max(0, height - top.length - FRAME_ROWS);
  let room = capacity - (compact ? 1 : 0);
  // Строки «… N выше / ниже» тоже занимают место (макет §5).
  if (ordered.length > room) room -= 2;
  const { start, end } = visibleWindow(
    ordered.length,
    selectedAt < 0 ? 0 : selectedAt,
    Math.max(0, room),
  );

  const bottom: SidebarRow[] = [];
  if (selectedTitle !== null && ordered.length === 0) {
    bottom.push(line('нет-сессий', ' сессий нет'));
    bottom.push(line('подсказка', ' ctrl+q c — новая'));
  } else {
    if (start > 0) bottom.push(line('выше', ` ${g.ellipsis} ${start} выше`));
    for (const { item, depth } of ordered.slice(start, end)) {
      const chosenRow = item.session.id === selectedSession;
      const target: SidebarTarget = { kind: 'session', key: item.session.id };
      const selected = chosenRow || atCursor(target);
      bottom.push({ kind: 'session', key: item.session.id, item, depth, selected, target });
      // Компактная строка принадлежит выбранной сессии, а не курсору (решение №7).
      if (!chosenRow || !compact) continue;
      bottom.push(
        line(
          `${item.session.id} метрики`,
          `   ${compactLine(item, content, g)}`,
          true,
          true,
          target,
        ),
      );
    }
    if (end < ordered.length) {
      bottom.push(line('ниже', ` ${g.ellipsis} ${ordered.length - end} ниже`));
    }
  }

  const visible = bottom.slice(0, capacity);
  const filler = Math.max(0, capacity - visible.length);
  const sessionsTitle = selectedTitle === null ? 'сессии' : `сессии · ${selectedTitle}`;

  const rows: SidebarRow[] = [
    // Блок работ: грань-верх с заголовком → работы → грань-низ (§3).
    frame('грань-работы-верх', 'работы', true),
    ...top.slice(0, Math.max(0, height - FRAME_ROWS)),
    frame('грань-работы-низ', null, false),
    // Блок сессий: грань-верх с заголовком «сессии · <работа>» → сессии → грань-низ (§3).
    frame('грань-сессии-верх', sessionsTitle, true),
    ...visible,
    ...Array.from({ length: filler }, (_, at) => line(`пусто-${at}`, '')),
    frame('грань-сессии-низ', null, false),
  ];
  // Четыре грани встают в результат безусловно, и на высоте меньше четырёх их
  // одних больше, чем места. Режем по высоте: картинка на таком экране всё
  // равно вырожденная, а вот контракт «ровно `height` строк» нарушать нельзя —
  // на нём стоит попадание клика (`use-actions.ts:229`).
  return rows.slice(0, Math.max(0, height));
}

/**
 * Цель каждой строки сайдбара по её номеру сверху (координата мыши `y` минус
 * единица); `null` — по этой строке кликать не по чему.
 */
export const sidebarTargets = (props: SidebarProps): Array<SidebarTarget | null> =>
  layout(props).map((row) => row.target);

/** Одна и та же строка сайдбара: клавиша и мышь метят в одну цель. */
export const sameTarget = (a: SidebarTarget | null, b: SidebarTarget | null): boolean =>
  a !== null && b !== null && a.kind === b.kind && a.key === b.key;

/**
 * Строки, по которым ходит курсор режима навигации: работы сверху вниз, строка
 * `new`, затем сессии выбранной работы (дизайн 3.2, макеты 1.5 и §8). Окно
 * видимых сессий здесь не при чём: курсор доходит и до тех, что уехали за край.
 */
export const sidebarCursorRows = (
  works: readonly SidebarWork[],
  sessions: readonly string[],
): SidebarTarget[] => [
  ...works.map((work): SidebarTarget => ({ kind: 'work', key: work.key })),
  NEW_TARGET,
  ...sessions.map((id): SidebarTarget => ({ kind: 'session', key: id })),
];

/**
 * Соседняя строка по кругу; курсора нет или его строка пропала — первая строка
 * сайдбара, а не потерянный курсор.
 */
export function stepCursor(
  rows: readonly SidebarTarget[],
  cursor: SidebarTarget | null,
  delta: number,
): SidebarTarget | null {
  if (rows.length === 0) return null;
  const at = rows.findIndex((row) => sameTarget(row, cursor));
  if (at < 0) return rows[0] ?? null;
  return rows[(at + delta + rows.length) % rows.length] ?? null;
}

export const Sidebar = memo(function Sidebar(props: SidebarProps): ReactNode {
  const { width, navigating = false, framed = true } = props;
  const g = glyphs();
  // Боковые грани отъедают по колонке слева и справа; без них (оверлей рисует
  // рамку сам) обычные строки занимают всю ширину, как раньше (план рамок,
  // задача 5, бюджет места). Общая ширина строки остаётся `width` в обоих
  // случаях — разделителя, добавлявшего лишнюю колонку, больше нет (решение №6).
  const content = framed ? width - 2 : width;

  return (
    <Box flexDirection="column" width={width}>
      {layout(props).map((row) =>
        row.kind === 'work' ? (
          <WorkRow
            key={row.key}
            work={row.work}
            selected={row.selected}
            width={content}
            g={g}
            navigating={navigating}
            framed={framed}
          />
        ) : row.kind === 'session' ? (
          <SessionRow
            key={row.key}
            item={row.item}
            depth={row.depth}
            selected={row.selected}
            width={content}
            g={g}
            navigating={navigating}
            framed={framed}
          />
        ) : row.kind === 'button' ? (
          <NewButton
            key={row.key}
            selected={row.selected}
            width={content}
            g={g}
            navigating={navigating}
            framed={framed}
          />
        ) : row.kind === 'frame' ? (
          framed ? (
            <Text key={row.key} {...frameColor(navigating)}>
              {row.text}
            </Text>
          ) : (
            // Без рамки блока верхняя грань становится обычной dim-строкой с
            // заголовком, а нижняя — пустой (план рамок, задача 5, решение №5).
            // Обе идут через `Row`, а не своим `Text`: он добивает строку до
            // ширины и режет заголовок. Голый `<Text>` с пустой строкой Ink
            // схлопывает в нулевую высоту, а длинный заголовок переносит на
            // вторую строку и разрывает рамку оверлея.
            <Row
              key={row.key}
              text={row.title === null ? '' : ` ${row.title}`}
              width={content}
              g={g}
              navigating={navigating}
              framed={false}
            />
          )
        ) : (
          <Row
            key={row.key}
            text={row.text}
            width={content}
            g={g}
            navigating={navigating}
            framed={framed}
            dim={row.dim}
            selected={row.selected}
          />
        ),
      )}
    </Box>
  );
});

/**
 * Сайдбар оверлеем у левого края: терминал уже 60 колонок, и по `prefix b`
 * он открывается рамкой поверх панели (макет 1.3, решение №9).
 */
export function SidebarOverlay(props: SidebarProps): ReactNode {
  const g = glyphs();
  return (
    <Box
      borderStyle={g.ascii ? 'classic' : 'single'}
      borderColor="cyan"
      // Место разделителя занимает правый бок рамки: без этого строки не
      // помещались бы в неё и кончались знаком усечения (макет 1.3).
      width={props.width + 2}
      marginTop={1}
    >
      <Sidebar {...props} framed={false} />
    </Box>
  );
}
