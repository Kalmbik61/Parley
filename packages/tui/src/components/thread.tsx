/**
 * Колонка треда справа от панели агента: рамка с заголовком и лента писем
 * (спецификация 2026-09-08, 6.1–6.3; план рамок, находка сверки: рамка треда;
 * макет 138×N).
 *
 * Компонент только рисует: строки считает `thread-view.ts`, положение ленты
 * держит `use-thread.ts`. Рамка — тот же приём, что у блоков сайдбара
 * (`frameLine`, `sidebar.tsx`): верхняя грань несёт заголовок и пометки,
 * боковые — вертикаль у каждой строки ленты, нижняя замыкает колонку. Тред
 * ввода не держит, поэтому её цвет — всегда dim, тем же приёмом, что и раньше
 * у бокового разделителя.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { truncate } from '../format.js';
import { glyphs, type Glyphs } from '../glyphs.js';
import { theme } from '../theme/index.js';
import type { ThreadView } from '../thread-view.js';
import { frameLine } from './sidebar.js';
import type { OverlayLine } from './overlay.js';

export interface ThreadProps {
  /** Вид треда; `null` — сессия не выбрана, и показывать нечего. */
  view: ThreadView | null;
  /** Ширина тела треда, без боковых граней рамки. */
  width: number;
  /** Строк колонки вместе с рамкой. */
  height: number;
}

/**
 * Пометки заголовка: непрочитанные и хвост ленты (6.2–6.3). Общая логика для
 * старой строки-заголовка (`threadHead`) и правого поля верхней грани дока
 * (план рамок, находка сверки: рамка треда) — один и тот же счёт в обоих
 * местах. `↓N` появляется, только когда пользователь ушёл вверх и ниже окна
 * есть новое.
 */
export function threadMarks(view: ThreadView | null, g: Glyphs): string {
  if (view === null) return '';
  return [
    view.unread > 0 ? `${g.mail}${view.unread}` : '',
    view.below > 0 ? `${g.down}${view.below}` : '',
  ]
    .filter((mark) => mark !== '')
    .join(' ');
}

/** Заголовок: ярлык треда слева, непрочитанные и хвост ленты справа (6.2–6.3). */
export function threadHead(view: ThreadView | null, width: number, g: Glyphs): string {
  if (view === null) return 'тред';
  const marks = threadMarks(view, g);
  if (marks === '') return truncate(view.title, width, g.ellipsis);
  // Ярлык уступает пометкам: они короткие, а без них тред врёт про непрочитанные.
  const title = truncate(view.title, Math.max(1, width - marks.length - 1), g.ellipsis);
  return `${title}${' '.repeat(Math.max(1, width - title.length - marks.length))}${marks}`;
}

/** Боковая грань строки ленты: вертикаль слева и справа, добивка до ширины. */
function Row({ line, width, g }: { line: OverlayLine; width: number; g: Glyphs }): ReactNode {
  const rule = line.rule === true;
  const text = rule ? g.rule.repeat(width) : truncate(line.text, width, g.ellipsis);
  const filled = rule ? text : `${text}${' '.repeat(Math.max(0, width - text.length))}`;
  return (
    <Text wrap="truncate">
      <Text {...theme().border.idle}>{g.frame.vertical}</Text>
      <Text {...(rule || line.dim === true ? theme().fg.muted : {})}>{filled}</Text>
      <Text {...theme().border.idle}>{g.frame.vertical}</Text>
    </Text>
  );
}

export function Thread({ view, width, height }: ThreadProps): ReactNode {
  const g = glyphs();
  const lines: readonly OverlayLine[] =
    view === null ? [{ text: 'сессия не выбрана', dim: true }] : view.lines;
  // Рамка занимает по строке сверху и снизу (было — одну, под заголовок):
  // без этого Ink стянул бы колонку вверх и низ рамки обрывался бы раньше
  // последнего письма (план рамок, находка сверки: рамка треда).
  const filler = Math.max(0, height - 2 - lines.length);
  const frameWidth = width + 2;
  const marks = threadMarks(view, g);

  const rows: ReactNode[] = [
    <Text key="грань-верх" {...theme().border.idle}>
      {frameLine({
        title: view === null ? 'тред' : view.title,
        right: marks === '' ? null : marks,
        width: frameWidth,
        g,
        top: true,
      })}
    </Text>,
    ...lines.map((line, at) => <Row key={`лента-${at}`} line={line} width={width} g={g} />),
    ...Array.from({ length: filler }, (_, at) => (
      <Row key={`пусто-${at}`} line={{ text: '' }} width={width} g={g} />
    )),
    <Text key="грань-низ" {...theme().border.idle}>
      {frameLine({ title: null, width: frameWidth, g, top: false })}
    </Text>,
  ];

  // Режем по высоте, как это делает сайдбар: строки ленты приходят снаружи, и
  // доверять их числу нельзя. На высоте меньше трёх одни только грани уже не
  // влезают, а перерасти отведённое тред не имеет права — на высотах всех трёх
  // зон стоит раскладка целиком.
  return (
    <Box flexDirection="column" width={frameWidth}>
      {rows.slice(0, Math.max(0, height))}
    </Box>
  );
}
