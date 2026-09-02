import { modelBadge, providerMark, type SessionIndex } from '@harnas/core';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import {
  formatDuration,
  formatRelative,
  formatTokenPair,
  truncate,
  visibleWindow,
} from '../format.js';
import { glyphs, selectionProps } from '../glyphs.js';

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
 * Заголовку гарантируется не меньше этой доли ширины строки: хвост подстраивается
 * под заголовок, а не наоборот (дизайн координации TUI, 2.3 и 6.4).
 */
const TITLE_SHARE = 0.5;

/**
 * Хвост строки: относительное время, токены, длительность и бейдж модели.
 *
 * В узкой колонке всё это не помещается, а заголовок важнее меты — поэтому части
 * отбрасываются по приоритету, пока хвост не влезет в бюджет, оставшийся после
 * гарантированной доли заголовка.
 */
function meta(session: SessionIndex, width: number): string {
  const when = formatRelative(session.endedAt);
  const parts = [
    when,
    formatTokenPair(session.tokens),
    formatDuration(session.durationMs),
    modelBadge(session.primaryModel),
  ];
  const join = (list: readonly string[]) => list.filter((part) => part !== '').join(' · ');
  // Бюджет хвоста: ширина минус доля заголовка и зазор. Время остаётся всегда.
  const limit = Math.max(when.length, width - Math.ceil(width * TITLE_SHARE) - 1);

  // Порядок отбрасывания (дизайн координации TUI, 2.3): токены → длительность →
  // бейдж модели. Токены уходят первыми: их полная форма всегда есть в деталях.
  for (const drop of [1, 2, 3]) {
    if (join(parts).length <= limit) break;
    parts[drop] = '';
  }

  return join(parts);
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
  const g = glyphs();

  return (
    <Box flexDirection="column">
      {sessions.slice(start, end).map((session, offset) => {
        const at = start + offset;
        const active = at === selected;
        // Ведущий пробел в хвосте — гарантированный зазор: полагаться на
        // space-between нельзя, он появляется только когда есть что распределять.
        const tail = ` ${meta(session, width)}`;
        const mark = showProvider ? `${providerMark(session.provider)} ` : '';
        // Ширина строки: маркер провайдера + заголовок + хвост.
        const room = width - mark.length - tail.length;
        const title = truncate(session.title ?? session.id, Math.max(4, room));
        // Фон тянется до края колонки, поэтому строка добивается пробелами.
        const pad = ' '.repeat(Math.max(0, width - mark.length - title.length - tail.length));

        return (
          // Выбранный ряд подсвечен фоном, а не стрелкой, — правило общее для
          // обоих режимов левой колонки (дизайн координации TUI, 6.2).
          <Text key={session.file} wrap="truncate" {...selectionProps(active, g)}>
            {mark !== '' && <Text color="magenta">{mark}</Text>}
            {title}
            {pad}
            <Text dimColor>{tail}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
