import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { TerminalSegment, TerminalSnapshot } from '../pty/terminal-buffer.js';

export interface TerminalViewProps {
  snapshot: TerminalSnapshot;
  /** Сколько строк помещается в панель. */
  height: number;
}

/** Стиль сегмента → пропсы Ink. Пустые не передаём: exactOptionalPropertyTypes. */
function styleProps(segment: TerminalSegment): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (segment.color !== undefined) props['color'] = segment.color;
  if (segment.backgroundColor !== undefined) props['backgroundColor'] = segment.backgroundColor;
  if (segment.bold === true) props['bold'] = true;
  if (segment.dim === true) props['dimColor'] = true;
  if (segment.italic === true) props['italic'] = true;
  if (segment.underline === true) props['underline'] = true;
  if (segment.inverse === true) props['inverse'] = true;
  return props;
}

/** Рисует снимок экрана PTY. Всю работу с управляющими кодами уже сделал xterm. */
export function TerminalView({ snapshot, height }: TerminalViewProps): ReactNode {
  const lines = snapshot.lines.slice(0, Math.max(0, height));

  return (
    <Box flexDirection="column">
      {/* Ключ — номер строки экрана: у строк терминала другой идентичности нет. */}
      {lines.map((segments, y) => (
        <Text key={y} wrap="truncate">
          {segments.map((segment, at) => (
            <Text key={at} {...styleProps(segment)}>
              {segment.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}
