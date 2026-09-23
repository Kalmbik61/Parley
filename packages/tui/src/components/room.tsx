/**
 * Комната на месте панели агента: рамка тех же размеров, лента переписки
 * внутри (дизайн комнаты 2026-09-23, разделы 3 и 5). PTY гостя эта колонка не
 * трогает вовсе — она либо подключена, либо нет, независимо от того, что
 * здесь нарисовано.
 *
 * Компонент только рисует: строки считает `room-view.ts`, положение ленты
 * держит `use-room.ts`. Рамка несёт заголовок и пометки тем же приёмом, что и
 * `components/thread.tsx` (`frameLine` из `sidebar.tsx`), но роль всегда
 * `border.active` — комната выбрана, значит это активная зона (раздел 3).
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { glyphs, type Glyphs } from '../glyphs.js';
import type { RoomLine, RoomView } from '../room-view.js';
import { fillLine, zoneBg } from '../theme/fill.js';
import { theme } from '../theme/index.js';
import { PANEL_FRAME } from './panel.js';
import { frameLine } from './sidebar.js';

export interface RoomProps {
  /** Вид комнаты; `null` — работа не выбрана, показывать нечего. */
  view: RoomView | null;
  /** Ширина тела — те же колонки, что достались бы гостю (раздел 3). */
  width: number;
  /** Строк тела — те же строки, что достались бы гостю. */
  height: number;
}

/** Пометки заголовка: непрочитанные адресатом и хвост ленты (5.1). */
export function roomMarks(view: RoomView | null, g: Glyphs): string {
  if (view === null) return '';
  return [
    view.unread > 0 ? `${g.mail}${view.unread}` : '',
    view.below > 0 ? `${g.down}${view.below}` : '',
  ]
    .filter((mark) => mark !== '')
    .join(' ');
}

/** Боковая грань строки ленты: вертикаль слева и справа — как у дока треда. */
function Edge({ g }: { g: Glyphs }): ReactNode {
  return <Text {...theme().border.active}>{g.frame.vertical}</Text>;
}

/**
 * Строка ленты: линейка — из `g.rule` ролью `border.idle`; обычная строка —
 * непрочитанное помечено глифом `g.mail` ролью `status.unseen` и пробелом
 * перед строкой, тон красит остальное (5.2–5.3). Тело всегда ровно `width`:
 * длинный заголовок письма режется без многоточия — тело уже перенесено
 * `roomView`, обрезка здесь только страхует нарезку.
 */
function Row({ line, width, g }: { line: RoomLine; width: number; g: Glyphs }): ReactNode {
  if (line.rule === true) {
    return (
      <Text wrap="truncate">
        <Edge g={g} />
        <Text {...zoneBg(theme().bg.panel)}>
          <Text {...theme().border.idle}>{fillLine(g.rule.repeat(width), width)}</Text>
        </Text>
        <Edge g={g} />
      </Text>
    );
  }
  const prefix = line.mark === 'unseen' ? `${g.mail} ` : '';
  const filled = fillLine(`${prefix}${line.text}`, width);
  const tone = line.tone === 'muted' ? theme().fg.muted : theme().fg.default;
  return (
    <Text wrap="truncate">
      <Edge g={g} />
      <Text {...zoneBg(theme().bg.panel)}>
        <Text {...theme().status.unseen}>{filled.slice(0, prefix.length)}</Text>
        <Text {...tone} bold={line.tone === 'head'}>
          {filled.slice(prefix.length)}
        </Text>
      </Text>
      <Edge g={g} />
    </Text>
  );
}

export function Room({ view, width, height }: RoomProps): ReactNode {
  const g = glyphs();
  const lines: readonly RoomLine[] =
    view === null ? [{ text: 'работа не выбрана', tone: 'muted' }] : view.lines;
  // Рамка занимает по строке сверху и снизу — тем же приёмом, что у дока
  // треда (план рамок, находка сверки: рамка треда).
  const filler = Math.max(0, height - lines.length);
  const frameWidth = width + 2 * PANEL_FRAME;
  const marks = roomMarks(view, g);

  const rows: ReactNode[] = [
    <Text key="грань-верх" {...theme().border.active}>
      {frameLine({
        title: view === null ? 'комната' : view.title,
        right: marks === '' ? null : marks,
        width: frameWidth,
        g,
        top: true,
      })}
    </Text>,
    ...lines.map((line, at) => <Row key={`лента-${at}`} line={line} width={width} g={g} />),
    ...Array.from({ length: filler }, (_, at) => (
      <Row key={`пусто-${at}`} line={{ text: '', tone: 'muted' }} width={width} g={g} />
    )),
    <Text key="грань-низ" {...theme().border.active}>
      {frameLine({ title: null, width: frameWidth, g, top: false })}
    </Text>,
  ];

  // Режем по высоте, как это делает тред: строки ленты приходят снаружи, и
  // доверять их числу нельзя.
  return (
    <Box flexDirection="column" width={frameWidth}>
      {rows.slice(0, Math.max(0, height + 2 * PANEL_FRAME))}
    </Box>
  );
}
