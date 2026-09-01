import type { SessionIndex } from '@harnas/core';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { formatDuration, formatRelative, modelBadge, truncate, visibleWindow } from '../format.js';

export interface SessionListProps {
  sessions: SessionIndex[];
  selected: number;
  /** Сколько строк помещается в панели — за её пределы не рисуем. */
  height: number;
  width: number;
}

/** Хвост строки: относительное время, длительность и бейдж модели. */
function meta(session: SessionIndex): string {
  return `${formatRelative(session.endedAt)} · ${formatDuration(session.durationMs)} · ${modelBadge(session.primaryModel)}`;
}

export function SessionList({ sessions, selected, height, width }: SessionListProps): ReactNode {
  if (sessions.length === 0) {
    return <Text dimColor>Сессий не найдено. Загляни в ~/.claude/projects.</Text>;
  }

  const { start, end } = visibleWindow(sessions.length, selected, height);

  return (
    <Box flexDirection="column">
      {sessions.slice(start, end).map((session, offset) => {
        const at = start + offset;
        const active = at === selected;
        const tail = meta(session);
        const title = truncate(session.title ?? session.id, Math.max(4, width - tail.length - 4));

        return (
          <Box key={session.file} justifyContent="space-between">
            <Text {...(active ? { color: 'cyan', bold: true } : {})} wrap="truncate">
              {active ? '❯ ' : '  '}
              {title}
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
