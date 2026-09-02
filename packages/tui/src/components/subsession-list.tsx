import { modelBadge, type Subsession } from '@harnas/core';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { formatDuration, truncate, visibleWindow } from '../format.js';

export interface SubsessionListProps {
  subsessions: Subsession[];
  selected: number;
  height: number;
  width: number;
  loading?: boolean;
}

/** Бейджи всех моделей агента: их может быть несколько за одну подсессию. */
function badges(subsession: Subsession): string {
  if (subsession.models.length === 0) return '—';
  return [...new Set(subsession.models.map(modelBadge))].join('/');
}

export function SubsessionList({
  subsessions,
  selected,
  height,
  width,
  loading = false,
}: SubsessionListProps): ReactNode {
  if (loading) return <Text dimColor>читаю…</Text>;
  if (subsessions.length === 0) return <Text dimColor>Подсессий нет.</Text>;

  const { start, end } = visibleWindow(subsessions.length, selected, height);

  return (
    <Box flexDirection="column">
      {subsessions.slice(start, end).map((subsession, offset) => {
        const at = start + offset;
        const active = at === selected;
        const tail = `${formatDuration(subsession.durationMs)} · ${badges(subsession)}`;
        const task = truncate(
          subsession.task ?? subsession.agentType ?? subsession.agentId,
          Math.max(4, width - tail.length - 4),
        );

        return (
          <Box key={subsession.file} justifyContent="space-between">
            <Text {...(active ? { color: 'cyan', bold: true } : {})} wrap="truncate">
              {active ? '▸ ' : '  '}
              {task}
            </Text>
            <Text dimColor wrap="truncate">
              {tail}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
