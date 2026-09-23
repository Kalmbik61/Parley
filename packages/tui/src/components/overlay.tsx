/**
 * Базовый оверлей: рамка с заголовком, геометрия и прокрутка (макеты TUI v2,
 * §4.0). На нём стоят детали, пикеры, справка и подтверждения — подтверждения
 * кладут внутрь рамки существующий `dialog.tsx`.
 *
 * Stock Ink не рисует поверх готового кадра, поэтому оверлей занимает место
 * панели, а широкий — и сайдбара. Живой агент за ним не виден, но и не тронут:
 * PTY продолжает работать, ввод просто идёт оверлею (2.4).
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import stringWidth from 'string-width';
import { truncate } from '../format.js';
import { glyphs, selectionProps, type Glyphs } from '../glyphs.js';
import { gutterMark, gutterWidth, pad, zoneBg } from '../theme/fill.js';
import { borderBoxProps, theme } from '../theme/index.js';
import type { DialogSpec } from '../work-dialogs.js';
import { Dialog } from './dialog.js';

/** Ширины оверлеев: подтверждения, пикеры со справкой, детали (§4.0). */
export const CONFIRM_WIDTH = 48;
export const PICKER_WIDTH = 56;
export const DETAILS_WIDTH = 64;

/** Уже этого рамка не имеет смысла: в ней не остаётся тела. */
const MIN_WIDTH = 12;

/** Одна строка тела оверлея. */
export interface OverlayLine {
  text: string;
  /** Горизонтальная линейка во всю ширину тела (макеты 4.2–4.4). */
  rule?: boolean;
  selected?: boolean;
  dim?: boolean;
}

/** Готовый вид оверлея-списка: строит его чистая функция, рисует `Overlay`. */
export interface OverlayView {
  title: string;
  /** Своя ширина: `CONFIRM_WIDTH`, `PICKER_WIDTH` или `DETAILS_WIDTH`. */
  desired: number;
  lines: OverlayLine[];
  footer: string;
}

export interface OverlayBox {
  /** Ширина рамки вместе с боками. */
  width: number;
  /** Высота рамки вместе с верхом и низом. */
  height: number;
  /** Колонка левого края рамки от края терминала. */
  left: number;
  /** Отступ слева внутри контейнера, в котором оверлей рисуется. */
  offset: number;
  /** Рамка не влезла в панель: оверлей ложится и на сайдбар (§4.0). */
  wide: boolean;
}

const clampWidth = (desired: number, columns: number): number =>
  Math.max(MIN_WIDTH, Math.min(desired, columns - 4));

/**
 * Раскладка оверлея (§4.0): ширина `min(своя, терминал − 4)`; центр по панели,
 * пока рамка с зазором в неё влезает, иначе по всему терминалу; высота
 * `min(контент + 2, строки − 3)` — строка статуса и строка панели сверху видны.
 */
export function overlayBox(
  desired: number,
  columns: number,
  rows: number,
  panelLeft: number,
  content: number,
): OverlayBox {
  const width = clampWidth(desired, columns);
  const wide = width + 2 > columns - panelLeft;
  const origin = wide ? 0 : panelLeft;
  const room = columns - origin;
  const left = origin + Math.max(0, Math.floor((room - width) / 2));
  const height = Math.max(3, Math.min(content + 2, rows - 3));
  return { width, height, left, offset: left - origin, wide };
}

/**
 * Уступает ли сайдбар место оверлею: широкая рамка не влезла в панель и ложится
 * на весь экран (§4.0). Сайдбар-оверлей рисуется на месте самого сайдбара.
 */
export const overlayCovers = (
  desired: number | null,
  wideAllowed: boolean,
  columns: number,
  rows: number,
  panelLeft: number,
): boolean =>
  desired !== null && wideAllowed && overlayBox(desired, columns, rows, panelLeft, 0).wide;

export interface OverlayProps {
  box: OverlayBox;
  title: string;
  /** Тело-список; без него тело рисуют `children` (подтверждения). */
  lines?: readonly OverlayLine[];
  /** Последняя строка внутри рамки: подсказка действий. */
  footer?: string;
  /** Индекс первой видимой строки списка. */
  scroll?: number;
  /** Строка, которую окно обязано показать: выбранная строка пикера. */
  focus?: number;
  children?: ReactNode;
}

/** Верхняя рамка с заголовком: `┌ детали · бэкенд ───┐` (§4.0). */
function topBorder(title: string, width: number, g: Glyphs): string {
  const corner = g.ascii ? ['+', '+'] : ['┌', '┐'];
  const rule = g.ascii ? '-' : '─';
  const head = `${corner[0]} ${truncate(title, Math.max(1, width - 4), g.ellipsis)} `;
  return `${head}${rule.repeat(Math.max(0, width - head.length - 1))}${corner[1]}`;
}

/**
 * Строка тела оверлея: список, линейка, подвал и «N ниже» рисуются одним и
 * тем же `Line` — все они текст (или линейка) шириной `width`, добитый
 * пробелами, и фон зоны (`bg.overlay`) только при `theme().fills` (5.1).
 * Экспортирован для прямой проверки заливки без рамки `Box` вокруг тела.
 */
export function Line({
  line,
  width,
  g,
  gutter = true,
}: {
  line: OverlayLine;
  width: number;
  g: Glyphs;
  /**
   * Эта строка — часть списка и получает колонку-жёлоб (уровень 0, дизайн
   * 4.3, кусок 6): выключается только у подвала (`footer` в `Overlay`) —
   * там выбора нет, и колонку отбирать не за что («где жёлоба нет»).
   * Линейка (`line.rule === true`) колонку не получает в любом случае — она
   * не часть выбираемого списка.
   */
  gutter?: boolean;
}): ReactNode {
  if (line.rule === true) {
    return (
      <Text {...theme().fg.muted} {...zoneBg(theme().bg.overlay)} wrap="truncate">
        {(g.ascii ? '-' : '─').repeat(width)}
      </Text>
    );
  }
  const w = gutter ? gutterWidth(width) : width;
  const text = truncate(line.text, w, g.ellipsis);
  return (
    <Text wrap="truncate" {...zoneBg(theme().bg.overlay)}>
      {gutter && theme().gutter && <Text>{gutterMark(line.selected === true, g)}</Text>}
      <Text
        {...selectionProps(line.selected === true, g)}
        {...(line.dim === true ? theme().fg.muted : {})}
      >
        {text}
        {pad(stringWidth(text), w)}
      </Text>
    </Text>
  );
}

export function Overlay({
  box,
  title,
  lines,
  footer,
  scroll = 0,
  focus,
  children,
}: OverlayProps): ReactNode {
  const g = glyphs();
  const inner = box.width - 2;
  // Тело без верхней и нижней рамки; подсказка занимает последнюю строку.
  const body = box.height - 2;
  const tail = footer === undefined ? 0 : 1;

  let room = Math.max(0, body - tail);
  const list = lines ?? [];
  const overflow = list.length > room;
  if (overflow) room = Math.max(0, room - 1);
  // Выбранная строка пикера окно не покидает: пока она влезает, тело стоит на
  // месте, дальше окно едет за ней.
  const wanted = focus === undefined ? scroll : Math.max(0, focus - room + 1);
  const start = Math.max(0, Math.min(wanted, Math.max(0, list.length - room)));
  const visible = list.slice(start, start + room);
  const below = list.length - (start + visible.length);

  return (
    <Box flexDirection="column" width={box.width} marginLeft={box.offset} marginTop={1}>
      <Text {...theme().border.active}>{topBorder(title, box.width, g)}</Text>
      <Box
        flexDirection="column"
        borderStyle={g.ascii ? 'classic' : 'single'}
        borderTop={false}
        {...borderBoxProps(theme().border.active)}
        width={box.width}
        height={box.height - 1}
      >
        {lines === undefined ? (
          children
        ) : (
          <>
            {visible.map((line, at) => (
              <Line key={start + at} line={line} width={inner} g={g} />
            ))}
            {below > 0 && (
              <Line
                key="ниже"
                line={{ text: ` ${g.ellipsis} ${below} ниже`, dim: true }}
                width={inner}
                g={g}
              />
            )}
            {Array.from({ length: Math.max(0, room - visible.length) }, (_, at) => (
              <Line key={`пусто-${at}`} line={{ text: '' }} width={inner} g={g} />
            ))}
          </>
        )}
        {footer !== undefined && (
          <Line line={{ text: footer, dim: true }} width={inner} g={g} gutter={false} />
        )}
      </Box>
    </Box>
  );
}

export interface OverlayHostProps {
  /** Вид оверлея-списка: детали, пикеры, справка (4.1–4.4). */
  view: OverlayView | null;
  /** Подтверждение 4.5–4.9: его тело рисует `dialog.tsx` внутри рамки. */
  confirm: { id: number; spec: DialogSpec } | null;
  scroll: number;
  focus: number | undefined;
  columns: number;
  rows: number;
  /** Колонок слева от панели: центр оверлея считается от них (§4.0). */
  panelLeft: number;
  onSubmit: () => void;
  onCancel: () => void;
}

/**
 * Открытый оверлей целиком: считает раскладку и выбирает тело — список строк
 * или подтверждение на существующем `Dialog` (§4.0).
 */
export function OverlayHost({
  view,
  confirm,
  scroll,
  focus,
  columns,
  rows,
  panelLeft,
  onSubmit,
  onCancel,
}: OverlayHostProps): ReactNode {
  if (confirm !== null) {
    const spec = confirm.spec;
    const box = overlayBox(
      CONFIRM_WIDTH,
      columns,
      rows,
      panelLeft,
      spec.info.length + spec.quote.length + 1,
    );
    return (
      <Overlay box={box} title={spec.title}>
        <Dialog
          key={confirm.id}
          info={spec.info}
          quote={spec.quote}
          footer={spec.footer}
          width={box.width - 2}
          height={box.height - 2}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      </Overlay>
    );
  }
  if (view === null) return null;
  const box = overlayBox(view.desired, columns, rows, panelLeft, view.lines.length + 1);
  return (
    <Overlay
      box={box}
      title={view.title}
      lines={view.lines}
      footer={view.footer}
      scroll={scroll}
      {...(focus === undefined ? {} : { focus })}
    />
  );
}
