import { modelBadge } from '@harnas/core';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { formatDuration, truncate } from '../format.js';
import { glyphs, statusColor, statusGlyph } from '../glyphs.js';
import { providerLabel, workTail, type WorkRow } from '../work-rows.js';

export interface DetailsPaneProps {
  /** Выбранный ряд списка работ; `undefined` — список пуст. */
  row: WorkRow | undefined;
  width: number;
}

/**
 * Панель ДЕТАЛИ вместо SUBSESSIONS в режиме работ (дизайн координации TUI, 3).
 *
 * Пока здесь только шапка ряда: провайдер и модель, статус и задача. Секции
 * СВОДКА, ВХОДЯЩИЕ, АРТЕФАКТЫ, СУБАГЕНТЫ и ИСТОРИЯ — отдельная задача.
 */
export function DetailsPane({ row, width }: DetailsPaneProps): ReactNode {
  const g = glyphs();

  if (row === undefined) return <Text dimColor>Работа не выбрана.</Text>;

  if (row.kind === 'work') {
    return (
      <Box flexDirection="column">
        <Text wrap="truncate">
          {truncate(row.work.goal || 'цель не записана', width, g.ellipsis)}
        </Text>
        <Text wrap="truncate">{workTail(row.counters, g, width)}</Text>
      </Box>
    );
  }

  const { session, live } = row;
  const model = modelBadge(live.model);
  const provider = providerLabel(session.provider);

  return (
    <Box flexDirection="column">
      <Text color="blackBright" bold wrap="truncate">
        {live.model === null || model === provider ? provider : `${provider} ${model}`}
      </Text>
      <Text wrap="truncate">
        <Text {...statusColor(session.status)}>{statusGlyph(session.status, g)}</Text>
        {` ${session.status} · ${formatDuration(live.durationMs)}`}
      </Text>
      <Text wrap="truncate">{truncate(session.task, width, g.ellipsis)}</Text>
    </Box>
  );
}
