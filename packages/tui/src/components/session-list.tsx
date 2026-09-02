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

/**
 * Хвост строки: относительное время, длительность и бейдж модели.
 *
 * В узкой колонке всё это не помещается, а заголовок важнее меты — поэтому части
 * отбрасываются по приоритету, пока хвост не влезет в отведённую долю ширины.
 */
function meta(session: SessionIndex, width: number): string {
  const when = formatRelative(session.endedAt);
  const parts = [when, formatDuration(session.durationMs), modelBadge(session.primaryModel)];
  const limit = Math.max(when.length, Math.floor(width * 0.45));

  // Сначала уходит длительность, затем бейдж модели; время остаётся всегда.
  const order = [1, 2];
  for (const drop of order) {
    if (parts.join(' · ').length <= limit) break;
    parts[drop] = '';
  }

  return parts.filter((part) => part !== '').join(' · ');
}

export function SessionList({
  sessions,
  selected,
  height,
  width,
  showProvider = false,
}: SessionListProps): ReactNode {
  if (sessions.length === 0) {
    return <Text dimColor>Сессий не найдено. Смотрим ~/.claude/projects и ~/.codex/sessions.</Text>;
  }

  const { start, end } = visibleWindow(sessions.length, selected, height);

  return (
    <Box flexDirection="column">
      {sessions.slice(start, end).map((session, offset) => {
        const at = start + offset;
        const active = at === selected;
        const tail = meta(session, width);
        const mark = showProvider ? `${providerMark(session.provider)} ` : '';
        // Ширина строки: маркер выбора (2) + маркер провайдера + заголовок + зазор + хвост.
        const room = width - 2 - mark.length - tail.length - 1;
        const title = truncate(session.title ?? session.id, Math.max(4, room));

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
