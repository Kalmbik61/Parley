/**
 * Колонка треда справа от панели агента: разделитель слева, заголовок с
 * непрочитанными и лента писем (спецификация 2026-09-08, 6.1–6.3; макет 138×N).
 *
 * Компонент только рисует: строки считает `thread-view.ts`, положение ленты
 * держит `use-thread.ts`. Разделитель здесь слева — зеркально сайдбару, где он
 * справа (`sidebar.tsx`).
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { truncate } from '../format.js';
import { glyphs, type Glyphs } from '../glyphs.js';
import type { ThreadView } from '../thread-view.js';
import type { OverlayLine } from './overlay.js';

export interface ThreadProps {
  /** Вид треда; `null` — сессия не выбрана, и показывать нечего. */
  view: ThreadView | null;
  /** Ширина тела треда, без разделителя. */
  width: number;
  /** Строк колонки вместе с заголовком. */
  height: number;
}

/**
 * Заголовок: ярлык треда слева, непрочитанные и хвост ленты справа (6.2–6.3).
 * `↓N` появляется, только когда пользователь ушёл вверх и ниже окна есть новое.
 */
export function threadHead(view: ThreadView | null, width: number, g: Glyphs): string {
  if (view === null) return 'тред';
  const marks = [
    view.unread > 0 ? `${g.mail}${view.unread}` : '',
    view.below > 0 ? `${g.down}${view.below}` : '',
  ]
    .filter((mark) => mark !== '')
    .join(' ');
  if (marks === '') return truncate(view.title, width, g.ellipsis);
  // Ярлык уступает пометкам: они короткие, а без них тред врёт про непрочитанные.
  const title = truncate(view.title, Math.max(1, width - marks.length - 1), g.ellipsis);
  return `${title}${' '.repeat(Math.max(1, width - title.length - marks.length))}${marks}`;
}

function Row({ line, width, g }: { line: OverlayLine; width: number; g: Glyphs }): ReactNode {
  const rule = line.rule === true;
  const text = rule ? g.rule.repeat(width) : truncate(line.text, width, g.ellipsis);
  return (
    <Text wrap="truncate">
      <Text dimColor>{g.divider}</Text>
      <Text dimColor={rule || line.dim === true}>{text}</Text>
    </Text>
  );
}

export function Thread({ view, width, height }: ThreadProps): ReactNode {
  const g = glyphs();
  const lines: readonly OverlayLine[] =
    view === null ? [{ text: 'сессия не выбрана', dim: true }] : view.lines;
  // Пустые строки под лентой: без них Ink стянул бы колонку вверх и разделитель
  // обрывался бы на последнем письме.
  const filler = Math.max(0, height - 1 - lines.length);

  return (
    <Box flexDirection="column" width={width + 1}>
      <Row line={{ text: threadHead(view, width, g) }} width={width} g={g} />
      {lines.map((line, at) => (
        <Row key={at} line={line} width={width} g={g} />
      ))}
      {Array.from({ length: filler }, (_, at) => (
        <Row key={`пусто-${at}`} line={{ text: '' }} width={width} g={g} />
      ))}
    </Box>
  );
}
