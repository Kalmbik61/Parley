import { modelBadge, type SessionStatus } from '@harnas/core';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { formatDuration, formatTokenPair, truncate, truncateLeft } from '../format.js';
import { glyphs, statusColor, statusGlyph, type Glyphs } from '../glyphs.js';
import {
  layoutRows,
  providerLabel,
  workTail,
  type LiveMetrics,
  type WorkRow,
  type WorkRowSession,
  type WorkRowWork,
} from '../work-rows.js';

export interface WorkListProps {
  rows: WorkRow[];
  selected: number;
  /** Сколько строк помещается в панели: ряд двухэтажный и не рвётся (2.3). */
  height: number;
  width: number;
}

/** С этой ширины в ряд помещаются токены и глиф дочерней сессии (дизайн 6.3, 2.4). */
const WIDE_WIDTH = 36;
/** Короче этого label не режется — дальше отбрасывается мета (2.3). */
const MIN_LABEL = 4;

const STATUSES: readonly SessionStatus[] = [
  'pending',
  'active',
  'idle',
  'exited',
  'done',
  'failed',
];

const padTo = (used: number, width: number): string => ' '.repeat(Math.max(0, width - used));

/** Фон выбранного ряда — вместо стрелки (дизайн 6.2). Текст при этом не меняется. */
const selectionProps = (selected: boolean): { backgroundColor?: string } =>
  selected ? { backgroundColor: 'blackBright' } : {};

/** Цвет части агрегата работы определяется её глифом — цвет тут не единственный смысл. */
function partProps(part: string, g: Glyphs): Record<string, unknown> {
  if (part.startsWith(g.mail)) return { color: 'magenta', bold: true };
  const status = STATUSES.find((item) => part.startsWith(g[item]));
  return status === undefined ? { dimColor: true } : statusColor(status);
}

/**
 * Метрики ряда: пара токенов только на широкой колонке, `—` когда сессия ещё не
 * привязана к логам (дизайн 6.3 и раздел 7).
 */
function sessionMeta(live: LiveMetrics, width: number): string {
  if (live.durationMs === null && live.tokens === null) return '—';
  // Порядок частей — по макетам 2.1, 2.2 и 6.6: сначала длительность, потом токены.
  const parts = [formatDuration(live.durationMs)];
  if (width >= WIDE_WIDTH) parts.push(formatTokenPair(live.tokens));
  return parts.join(' ');
}

/** Заголовок проекта: хвост пути и линейка до края (2.1, усечение слева — 6.4). */
function ProjectHeader({
  projectPath,
  width,
  g,
}: {
  projectPath: string;
  width: number;
  g: Glyphs;
}): ReactNode {
  const tail = truncateLeft(projectPath, Math.max(0, width - 4), g.ellipsis);
  return (
    <Text dimColor wrap="truncate">
      {`${tail} ${g.rule.repeat(Math.max(0, width - tail.length - 1))}`}
    </Text>
  );
}

function WorkLine({
  row,
  selected,
  width,
  g,
  sticky = false,
}: {
  row: WorkRowWork;
  selected: boolean;
  width: number;
  g: Glyphs;
  /** Ряд нарисован липким заголовком над окном (6.6). */
  sticky?: boolean;
}): ReactNode {
  const head = `${row.expanded ? g.expanded : g.collapsed} `;
  // Число сессий важно там, где их самих не видно: у свёрнутой работы и у липкого
  // заголовка развёрнутой — макет 6.6 показывает `(24)` именно на нём.
  const count = (row.expanded && !sticky) || row.total === 0 ? '' : ` (${row.total})`;
  const tail = workTail(row.counters, g, Math.max(2, width - head.length - MIN_LABEL - 1));
  const title = truncate(
    row.work.title,
    Math.max(MIN_LABEL, width - head.length - count.length - tail.length - 1),
    g.ellipsis,
  );
  const pad = padTo(head.length + title.length + count.length + tail.length, width);

  return (
    <Text wrap="truncate" {...selectionProps(selected)}>
      {head}
      {title}
      <Text dimColor>{count}</Text>
      {pad}
      {tail.split(' ').map((part, at) => (
        <Text key={at} {...partProps(part, g)}>
          {at === 0 ? part : ` ${part}`}
        </Text>
      ))}
    </Text>
  );
}

function SessionLines({
  row,
  selected,
  width,
  g,
}: {
  row: WorkRowSession;
  selected: boolean;
  width: number;
  g: Glyphs;
}): ReactNode {
  // Вариант А (2.4): вложенность — отступом, ветка `└` только на широкой колонке.
  const indent = ' '.repeat(2 + row.depth * 3);
  const branch = row.depth > 0 && width >= WIDE_WIDTH ? `${g.child} ` : '';
  // Вторая строка выравнивается под label: она — тот же ряд, а не отдельная строка.
  const head = indent.length + branch.length + 2;

  const mail = row.unread > 0 ? `${g.mail}${row.unread}` : '';
  const join = (parts: readonly string[]): string => parts.filter((part) => part !== '').join(' ');
  let meta = sessionMeta(row.live, width);
  let tail = join([meta, mail]);
  // Порядок отбрасывания (2.3): токены уже ушли по ширине, следом длительность;
  // `✉N` и значок статуса не отбрасываются никогда.
  if (width - head - tail.length - 1 < MIN_LABEL) {
    meta = '';
    tail = mail;
  }

  const label = truncate(
    row.session.label,
    Math.max(MIN_LABEL, width - head - tail.length - 1),
    g.ellipsis,
  );
  const model = modelBadge(row.live.model);
  const provider = providerLabel(row.session.provider);
  // У pending модели ещё нет; у Codex бейдж модели совпадает с провайдером — не двоим.
  const second = row.live.model === null || model === provider ? provider : `${provider} ${model}`;

  return (
    <>
      <Text wrap="truncate" {...selectionProps(selected)}>
        {indent}
        <Text dimColor>{branch}</Text>
        <Text {...statusColor(row.session.status)}>{statusGlyph(row.session.status, g)}</Text>
        {` ${label}`}
        {padTo(head + label.length + tail.length, width)}
        <Text dimColor>{meta}</Text>
        {meta !== '' && mail !== '' ? ' ' : ''}
        <Text color="magenta" bold>
          {mail}
        </Text>
      </Text>
      <Text wrap="truncate" {...selectionProps(selected)}>
        {' '.repeat(head)}
        <Text color="blackBright" bold>
          {truncate(second, Math.max(0, width - head), g.ellipsis)}
        </Text>
        {padTo(head + second.length, width)}
      </Text>
    </>
  );
}

/** Список работ: проекты → работы → сессии (дизайн координации TUI, разделы 2 и 6). */
export function WorkList({ rows, selected, height, width }: WorkListProps): ReactNode {
  const g = glyphs();

  if (rows.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Работ нет.</Text>
        <Text dimColor>N — новая работа</Text>
        <Text dimColor>w — ко всем сессиям</Text>
      </Box>
    );
  }

  const layout = layoutRows(rows, selected, height);
  const sticky = layout.stickyWork === null ? undefined : rows[layout.stickyWork];

  return (
    <Box flexDirection="column">
      {layout.stickyProject !== null && (
        <ProjectHeader projectPath={layout.stickyProject} width={width} g={g} />
      )}
      {sticky?.kind === 'work' && (
        <WorkLine row={sticky} selected={false} width={width} g={g} sticky />
      )}
      {layout.above > 0 && <Text dimColor>{`  ${g.ellipsis} ${layout.above} выше`}</Text>}

      {rows.slice(layout.start, layout.end).map((row, offset) => {
        const active = layout.start + offset === selected;
        return (
          <Box key={row.key} flexDirection="column">
            {row.startsProject && (
              <ProjectHeader projectPath={row.projectPath} width={width} g={g} />
            )}
            {row.kind === 'work' ? (
              <>
                <WorkLine row={row} selected={active} width={width} g={g} />
                {row.note !== null && (
                  <Text dimColor wrap="truncate" {...selectionProps(active)}>
                    {`    ${row.note}${padTo(4 + row.note.length, width)}`}
                  </Text>
                )}
              </>
            ) : (
              <SessionLines row={row} selected={active} width={width} g={g} />
            )}
          </Box>
        );
      })}

      {layout.below > 0 && <Text dimColor>{`  ${g.ellipsis} ${layout.below} ниже`}</Text>}
    </Box>
  );
}
