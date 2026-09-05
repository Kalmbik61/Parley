/**
 * Сайдбар: работы проекта сверху, строка `new`, дерево сессий выбранной работы
 * снизу (дизайн TUI v2, 2.1; макеты 1.1–1.5, 5 и 7).
 *
 * Компонент только рисует: порядок сессий берётся из `work-rows.ts`, состояние
 * точек — из `use-activity.ts`, выбор — из `use-selection.ts`.
 */

import type { WorkSession } from '@harnas/core';
import { Box, Text } from 'ink';
import { memo, type ReactNode } from 'react';
import { formatDuration, formatTokens, truncate, truncateLeft, visibleWindow } from '../format.js';
import { glyphs, selectionProps, type Glyphs } from '../glyphs.js';
import { treeOrder, type LiveMetrics } from '../work-rows.js';
import { ActivityDot, dotColor, stateLetter, type DotState } from './activity-dot.js';

/** Ширина сайдбара по умолчанию и узкая (раздел 2.1). */
export const WIDE = 26;
export const NARROW = 18;
/** Уже этого сайдбар прячется сам и доступен оверлеем по `prefix b` (2.1). */
export const MIN_COLUMNS = 60;
/** С этой ширины терминала помещается полный сайдбар. */
export const WIDE_COLUMNS = 80;
/** Короче этого ярлык и заголовок не режутся (раздел 7). */
const MIN_LABEL = 4;

/**
 * Ширина сайдбара по ширине терминала: `null` — сайдбар не показывается.
 * Настроенная ширина уже узкой не расширяется.
 */
export function sidebarWidth(columns: number, configured: number = WIDE): number | null {
  if (columns < MIN_COLUMNS) return null;
  return columns < WIDE_COLUMNS ? Math.min(configured, NARROW) : configured;
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
}

const pad = (used: number, width: number): string => ' '.repeat(Math.max(0, width - used));

/** Разделитель сайдбара и панели; в режиме навигации — cyan и жирный (макет 1.5). */
function Divider({ g, navigating }: { g: Glyphs; navigating: boolean }): ReactNode {
  return navigating ? (
    <Text bold color="cyan">
      {g.divider}
    </Text>
  ) : (
    <Text dimColor>{g.divider}</Text>
  );
}

/** Простая строка сайдбара: текст слева, добивка до ширины, разделитель. */
function Row({
  text,
  width,
  g,
  navigating,
  selected = false,
  dim = true,
}: {
  text: string;
  width: number;
  g: Glyphs;
  navigating: boolean;
  selected?: boolean;
  dim?: boolean;
}): ReactNode {
  return (
    <Text wrap="truncate">
      <Text {...selectionProps(selected, g)}>
        <Text dimColor={dim}>{truncate(text, width, g.ellipsis)}</Text>
        {pad(text.length, width)}
      </Text>
      <Divider g={g} navigating={navigating} />
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
}: {
  work: SidebarWork;
  selected: boolean;
  width: number;
  g: Glyphs;
  navigating: boolean;
}): ReactNode {
  const head = ` ${work.number === null ? '' : `${work.number} `}`;
  // Точка стоит на предпоследней колонке, последняя всегда пустая (макет 1.1).
  const title = truncate(work.title, Math.max(MIN_LABEL, width - head.length - 2), g.ellipsis);

  return (
    <Text wrap="truncate">
      <Text {...selectionProps(selected, g)}>
        {head}
        {title}
        {pad(head.length + title.length + 2, width)}
        {work.state === null ? ' ' : <ActivityDot state={work.state} g={g} />}{' '}
      </Text>
      <Divider g={g} navigating={navigating} />
    </Text>
  );
}

/**
 * Вторая строка работы: `проект · ветка`. Первой режется ветка, следом путь —
 * слева, у него важен хвост (§7).
 */
export function projectLine(work: SidebarWork, width: number, g: Glyphs): string {
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
}: {
  item: SidebarSession;
  depth: number;
  selected: boolean;
  width: number;
  g: Glyphs;
  navigating: boolean;
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
      <Text {...selectionProps(selected, g)}>
        {indent}
        <Text dimColor>{child}</Text>
        <ActivityDot state={item.state} g={g} />
        {` ${label}`}
        {pad(head + label.length + tail.length + 1, width)}
        <Text {...dotColor(item.state)}>{tail}</Text>{' '}
      </Text>
      <Divider g={g} navigating={navigating} />
    </Text>
  );
}

/**
 * Компактная строка под выбранной сессией: `↑вход ↓выход · длительность · ▤N · ⋮N`.
 * Отбрасываются токены, следом длительность; `▤N` и `⋮N` — никогда (§7).
 */
export function compactLine(item: SidebarSession, width: number, g: Glyphs): string {
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

export const Sidebar = memo(function Sidebar({
  works,
  sessions,
  selectedWork,
  selectedSession,
  width,
  height,
  navigating = false,
}: SidebarProps): ReactNode {
  const g = glyphs();
  const line = (key: string, text: string, dim = true, selected = false): ReactNode => (
    <Row
      key={key}
      text={text}
      width={width}
      g={g}
      navigating={navigating}
      dim={dim}
      selected={selected}
    />
  );

  const top: ReactNode[] = [];
  if (works.length === 0) {
    top.push(line('нет-работ', ' работ нет'));
    top.push(line('new', ' new — первая сессия', false));
  } else {
    for (const work of works) {
      const selected = work.key === selectedWork;
      top.push(
        <WorkRow
          key={work.key}
          work={work}
          selected={selected}
          width={width}
          g={g}
          navigating={navigating}
        />,
      );
      // Вторая строка отбрасывается у `done`-работ и на узком сайдбаре (§7).
      if (work.done || width <= NARROW) continue;
      top.push(line(`${work.key} проект`, `   ${projectLine(work, width, g)}`, true, selected));
    }
    top.push(line('new', ' new', false));
  }

  const selectedTitle = works.find((work) => work.key === selectedWork)?.title ?? null;
  const ordered = selectedTitle === null ? [] : orderOf(sessions);
  const selectedAt = ordered.findIndex((item) => item.item.session.id === selectedSession);
  const chosen = selectedAt < 0 ? null : (ordered[selectedAt]?.item ?? null);
  // Компактная строка — часть выбранного ряда и тоже занимает место в окне;
  // у `pending` её нет (решение №7).
  const compact = chosen !== null && chosen.state !== 'pending';

  const capacity = Math.max(0, height - top.length - 2);
  let room = capacity - (compact ? 1 : 0);
  // Строки «… N выше / ниже» тоже занимают место (макет §5).
  if (ordered.length > room) room -= 2;
  const { start, end } = visibleWindow(
    ordered.length,
    selectedAt < 0 ? 0 : selectedAt,
    Math.max(0, room),
  );

  const bottom: ReactNode[] = [];
  if (selectedTitle !== null && ordered.length === 0) {
    bottom.push(line('нет-сессий', ' сессий нет'));
    bottom.push(line('подсказка', ' ctrl+q c — новая'));
  } else {
    if (start > 0) bottom.push(line('выше', ` ${g.ellipsis} ${start} выше`));
    for (const { item, depth } of ordered.slice(start, end)) {
      const selected = item.session.id === selectedSession;
      bottom.push(
        <SessionRow
          key={item.session.id}
          item={item}
          depth={depth}
          selected={selected}
          width={width}
          g={g}
          navigating={navigating}
        />,
      );
      if (!selected || !compact) continue;
      bottom.push(
        line(`${item.session.id} метрики`, `   ${compactLine(item, width, g)}`, true, true),
      );
    }
    if (end < ordered.length) {
      bottom.push(line('ниже', ` ${g.ellipsis} ${ordered.length - end} ниже`));
    }
  }

  const visible = bottom.slice(0, capacity);
  const filler = Math.max(0, capacity - visible.length);

  return (
    <Box flexDirection="column" width={width + 1}>
      {top.slice(0, Math.max(0, height - 2))}
      {line('линейка', g.rule.repeat(width))}
      {line(
        'заголовок',
        selectedTitle === null
          ? ' сессии'
          : ` сессии · ${truncate(selectedTitle, Math.max(MIN_LABEL, width - 10), g.ellipsis)}`,
      )}
      {visible}
      {Array.from({ length: filler }, (_, at) => line(`пусто-${at}`, ''))}
    </Box>
  );
});
