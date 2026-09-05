import { Box, Text } from 'ink';
import { memo, type ReactNode } from 'react';
import stringWidth from 'string-width';
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

/**
 * Строка с кареткой: ячейка в колонке `x` выделяется в свой сегмент и
 * инвертируется (на уже инверсной — наоборот). Колонки считаются по ширине
 * символов, как их считает и терминал: широкий символ занимает две.
 * За концом строки каретка рисуется пробелом с отступом до своей колонки.
 */
export function withCursor(segments: readonly TerminalSegment[], x: number): TerminalSegment[] {
  const result: TerminalSegment[] = [];
  let column = 0;
  let placed = false;

  for (const segment of segments) {
    const { text, ...style } = segment;
    if (placed || column + stringWidth(text) <= x) {
      result.push(segment);
      column += stringWidth(text);
      continue;
    }
    let before = '';
    let under = '';
    let after = '';
    for (const char of Array.from(text)) {
      if (under === '' && column >= x) under = char;
      else if (under === '') before += char;
      else after += char;
      column += stringWidth(char);
    }
    if (before !== '') result.push({ ...style, text: before });
    result.push({ ...style, inverse: style.inverse !== true, text: under });
    if (after !== '') result.push({ ...style, text: after });
    placed = true;
  }

  if (!placed) {
    if (column < x) result.push({ text: ' '.repeat(x - column) });
    result.push({ inverse: true, text: ' ' });
  }
  return result;
}

/**
 * Рисует снимок экрана PTY. Всю работу с управляющими кодами уже сделал xterm.
 *
 * Мемоизирован: мигание точек и перерисовка сайдбара не должны стоить панели
 * ничего (дизайн TUI v2, 8.2). Снимок приходит новым объектом только тогда,
 * когда экран гостя действительно изменился.
 */
export const TerminalView = memo(function TerminalView({
  snapshot,
  height,
}: TerminalViewProps): ReactNode {
  const lines = snapshot.lines.slice(0, Math.max(0, height));
  const { cursor } = snapshot;

  return (
    <Box flexDirection="column">
      {/* Ключ — номер строки экрана: у строк терминала другой идентичности нет. */}
      {lines.map((segments, y) => (
        <Text key={y} wrap="truncate">
          {(cursor.visible && cursor.y === y ? withCursor(segments, cursor.x) : segments).map(
            (segment, at) => (
              <Text key={at} {...styleProps(segment)}>
                {segment.text}
              </Text>
            ),
          )}
        </Text>
      ))}
    </Box>
  );
});
