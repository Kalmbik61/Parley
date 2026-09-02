import { modelBadge, providerMark, type SessionIndex } from '@harnas/core';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { formatDuration, formatRelative, truncate, visibleWindow } from '../format.js';

export interface SessionListProps {
  sessions: SessionIndex[];
  selected: number;
  /** Сколько строк помещается в панели — за её пределы не рисуем. */
  height: number;
  width: number;
  /**
   * Показывать маркер провайдера. Имеет смысл, только когда в списке их
   * несколько: с одним провайдером это был бы шум в и без того узкой колонке.
   */
  showProvider?: boolean;
}

/** Хвост строки: относительное время, длительность и бейдж модели. */
function meta(session: SessionIndex): string {
  return `${formatRelative(session.endedAt)} · ${formatDuration(session.durationMs)} · ${modelBadge(session.primaryModel)}`;
}

export function SessionList({
  sessions,
  selected,
  height,
  width,
  showProvider = false,
}: SessionListProps): ReactNode {
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
        const mark = showProvider ? `${providerMark(session.provider)} ` : '';
        const title = truncate(
          session.title ?? session.id,
          Math.max(4, width - tail.length - mark.length - 4),
        );

        return (
          <Box key={session.file} justifyContent="space-between">
            <Text wrap="truncate">
              <Text {...(active ? { color: 'cyan', bold: true } : {})}>{active ? '❯ ' : '  '}</Text>
              {mark !== '' && <Text color="magenta">{mark}</Text>}
              <Text {...(active ? { color: 'cyan', bold: true } : {})}>{title}</Text>
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
