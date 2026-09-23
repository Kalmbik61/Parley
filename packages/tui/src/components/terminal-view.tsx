import { Box, Text } from 'ink';
import { memo, type ReactNode } from 'react';
import stringWidth from 'string-width';
import type { TerminalSegment, TerminalSnapshot } from '../pty/terminal-buffer.js';
import { pad } from '../theme/fill.js';
import { theme } from '../theme/index.js';

export interface TerminalViewProps {
  snapshot: TerminalSnapshot;
  /** Сколько строк помещается в панель. */
  height: number;
}

/**
 * Стиль сегмента → пропсы Ink. Пустые не передаём: exactOptionalPropertyTypes.
 *
 * Дефолты зоны агента (дизайн темы TUI, 5.3): цвет не задан гостем → `fg.default`,
 * фон не задан → `bg.agent`. Всё, что гость окрасил сам — ANSI-имя, hex, что
 * угодно, — остаётся ровно его: подстановка трогает только пустую сторону
 * ячейки. Как и везде в теме, подстановка живёт только при `theme().fills`
 * (5.1) — на уровнях ≤1 роли и так пустые, а кадр обязан остаться прежним.
 */
function styleProps(segment: TerminalSegment): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const fillsOn = theme().fills;

  if (segment.color !== undefined) props['color'] = segment.color;
  else if (fillsOn) Object.assign(props, theme().fg.default);

  if (segment.backgroundColor !== undefined) props['backgroundColor'] = segment.backgroundColor;
  else if (fillsOn) Object.assign(props, theme().bg.agent);

  if (segment.bold === true) props['bold'] = true;
  if (segment.dim === true) props['dimColor'] = true;
  if (segment.italic === true) props['italic'] = true;
  if (segment.underline === true) props['underline'] = true;
  if (segment.inverse === true) props['inverse'] = true;
  return props;
}

/** Сумма ширин сегментов строки в колонках — по ним же считает и терминал. */
const lineWidth = (segments: readonly TerminalSegment[]): number =>
  segments.reduce((sum, segment) => sum + stringWidth(segment.text), 0);

/**
 * Хвост строки до ширины снимка, залитый фоном зоны (дизайн темы TUI, 5.3):
 * добавочный сегмент без своего стиля — `styleProps` подставит ему тот же
 * `fg.default`/`bg.agent`, что и обычной ячейке. Только при `theme().fills`;
 * без темы строка обязана остаться такой же короткой, как сегодня.
 */
function withTail(segments: readonly TerminalSegment[], width: number): TerminalSegment[] {
  if (!theme().fills) return segments as TerminalSegment[];
  const tail = pad(lineWidth(segments), width);
  return tail === '' ? (segments as TerminalSegment[]) : [...segments, { text: tail }];
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
  const { cursor } = snapshot;
  const available = Math.max(0, height);
  // Заливка тянет панель вниз до `height`, даже когда гость короче
  // (дизайн темы TUI, 5.3, «пустые строки ниже snapshot.rows»); без неё
  // лишние строки, как и сегодня, просто не рисуются.
  const rowCount = theme().fills ? available : Math.min(available, snapshot.lines.length);

  return (
    <Box flexDirection="column">
      {/* Ключ — номер строки экрана: у строк терминала другой идентичности нет. */}
      {Array.from({ length: rowCount }, (_, y) => {
        const raw = snapshot.lines[y] ?? [];
        // Каретка не выходит за последнюю колонку: xterm держит `cursorX`
        // равным `cols`, пока строка напечатана во всю ширину и перенос ещё
        // не случился, а лишняя ячейка сделала бы залитую строку шире зоны.
        const at = Math.min(cursor.x, Math.max(0, snapshot.cols - 1));
        const withCur = cursor.visible && cursor.y === y ? withCursor(raw, at) : raw;
        const segments = withTail(withCur, snapshot.cols);
        return (
          <Text key={y} wrap="truncate">
            {segments.map((segment, at) => (
              <Text key={at} {...styleProps(segment)}>
                {segment.text}
              </Text>
            ))}
          </Text>
        );
      })}
    </Box>
  );
});
