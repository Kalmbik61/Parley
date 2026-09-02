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

/** С этой ширины в строку помещаются токены (дизайн координации TUI, 6.3). */
const TOKENS_MIN_WIDTH = 36;

/**
 * Хвост строки: относительное время, токены, длительность и бейдж модели.
 *
 * В узкой колонке всё это не помещается, а заголовок важнее меты — поэтому части
 * отбрасываются по приоритету, пока хвост не влезет в отведённую долю ширины.
 */
function meta(session: SessionIndex, width: number): string {
  const when = formatRelative(session.endedAt);
  // Уже ниже TOKENS_MIN_WIDTH токенов нет совсем — там их место в деталях сессии.
  const tokens = width >= TOKENS_MIN_WIDTH ? formatTokenPair(session.tokens) : '';
  const parts = [
    when,
    tokens,
    formatDuration(session.durationMs),
    modelBadge(session.primaryModel),
  ];
  const limit = Math.max(when.length, Math.floor(width * 0.45));
  const join = (list: readonly string[]) => list.filter((part) => part !== '').join(' · ');
  // Бюджет считается по хвосту без токенов: с TOKENS_MIN_WIDTH они обязательная
  // часть строки (дизайн 6.3), поэтому не отбрасываются и не съедают сами себя.
  const budgeted = () => join(parts.filter((_, at) => at !== 1));

  // Порядок отбрасывания (дизайн координации TUI, 2.3): токены уже отброшены
  // шириной ниже порога, дальше идут длительность и бейдж модели; время
  // остаётся всегда.
  for (const drop of [2, 3]) {
    if (budgeted().length <= limit) break;
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
