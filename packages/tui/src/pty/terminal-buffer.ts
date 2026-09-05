import xterm from '@xterm/headless';
import type { IBufferCell, Terminal } from '@xterm/headless';

/** Кусок строки с одинаковым оформлением — минимальная единица рендера в Ink. */
export interface TerminalSegment {
  text: string;
  /** Имя цвета chalk или #rrggbb; undefined — цвет терминала по умолчанию. */
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

/** Режим отслеживания мыши, который запросило приложение внутри PTY. */
export type MouseTracking = 'none' | 'x10' | 'vt200' | 'drag' | 'any';

export interface TerminalSnapshot {
  lines: TerminalSegment[][];
  cols: number;
  rows: number;
  /** Полноэкранный режим: приложение внутри рисует свой экран и само скроллит. */
  altScreen: boolean;
  /** Что гость просит слать ему по мыши — это надо включить и у себя. */
  mouseTracking: MouseTracking;
  /** Гость ждёт вставку в скобках ESC[200~ … ESC[201~. */
  bracketedPaste: boolean;
  /**
   * Курсор гостя: колонка и строка относительно видимой области, и показывает ли
   * он его вообще (DECTCEM, `ESC[?25h` / `ESC[?25l`). Хост-терминал свой курсор
   * прячет — Ink рисует кадр целиком, — так что каретку в панели рисуем сами.
   */
  cursor: { x: number; y: number; visible: boolean };
}

export interface TerminalBuffer {
  /** xterm парсит асинхронно: `done` зовётся, когда данные уже в буфере. */
  write(chunk: string, done?: () => void): void;
  resize(cols: number, rows: number): void;
  /** Прокрутка видимой области по скроллбэку: меньше нуля — вверх, больше — вниз. */
  scroll(lines: number): void;
  snapshot(): TerminalSnapshot;
  dispose(): void;
}

/** Базовая палитра ANSI 0-15 в именах, которые понимает Ink. */
const ANSI_16 = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'blackBright',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'whiteBright',
] as const;

const CUBE_STEPS = [0, 95, 135, 175, 215, 255];
const hex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** xterm-256: 0-15 базовые, 16-231 куб 6×6×6, 232-255 серая шкала. */
function paletteToColor(index: number): string | undefined {
  if (index < 16) return ANSI_16[index];
  if (index < 232) {
    const at = index - 16;
    const r = CUBE_STEPS[Math.floor(at / 36) % 6] ?? 0;
    const g = CUBE_STEPS[Math.floor(at / 6) % 6] ?? 0;
    const b = CUBE_STEPS[at % 6] ?? 0;
    return hex(r, g, b);
  }
  if (index < 256) {
    const level = 8 + (index - 232) * 10;
    return hex(level, level, level);
  }
  return undefined;
}

const rgbToColor = (value: number): string =>
  hex((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);

function foreground(cell: IBufferCell): string | undefined {
  if (cell.isFgDefault()) return undefined;
  if (cell.isFgPalette()) return paletteToColor(cell.getFgColor());
  if (cell.isFgRGB()) return rgbToColor(cell.getFgColor());
  return undefined;
}

function background(cell: IBufferCell): string | undefined {
  if (cell.isBgDefault()) return undefined;
  if (cell.isBgPalette()) return paletteToColor(cell.getBgColor());
  if (cell.isBgRGB()) return rgbToColor(cell.getBgColor());
  return undefined;
}

/** Стиль ячейки без текста — по нему решается, продолжать сегмент или начинать новый. */
function styleOf(cell: IBufferCell): Omit<TerminalSegment, 'text'> {
  const style: Omit<TerminalSegment, 'text'> = {};
  const color = foreground(cell);
  const backgroundColor = background(cell);

  if (color !== undefined) style.color = color;
  if (backgroundColor !== undefined) style.backgroundColor = backgroundColor;
  // Атрибуты xterm возвращают числа-флаги, а не boolean.
  if (cell.isBold()) style.bold = true;
  if (cell.isDim()) style.dim = true;
  if (cell.isItalic()) style.italic = true;
  if (cell.isUnderline()) style.underline = true;
  if (cell.isInverse()) style.inverse = true;
  return style;
}

const sameStyle = (a: Omit<TerminalSegment, 'text'>, b: Omit<TerminalSegment, 'text'>): boolean =>
  a.color === b.color &&
  a.backgroundColor === b.backgroundColor &&
  a.bold === b.bold &&
  a.dim === b.dim &&
  a.italic === b.italic &&
  a.underline === b.underline &&
  a.inverse === b.inverse;

/**
 * Состояние экрана PTY.
 *
 * Разбором управляющих последовательностей занимается @xterm/headless — тот же
 * VT-движок, что в VS Code, только без DOM. Альтернативный экран, скроллбэк и
 * позиционирование курсора он держит сам; снаружи нужен лишь снимок видимой
 * области (specs/pty.md).
 */
export function createTerminalBuffer(
  cols: number,
  rows: number,
  scrollback = 2000,
): TerminalBuffer {
  const terminal: Terminal = new xterm.Terminal({
    cols: Math.max(2, Math.floor(cols)),
    rows: Math.max(2, Math.floor(rows)),
    scrollback,
    allowProposedApi: true,
  });

  // Один переиспользуемый объект ячейки: на кадр их тысячи, аллокации ни к чему.
  let cellBuffer: IBufferCell | undefined;

  // Видимость курсора xterm наружу не отдаёт — ловим DECTCEM сами. Обработчик
  // возвращает false, чтобы xterm обработал последовательность как обычно.
  let cursorVisible = true;
  const dectcem = (params: (number | number[])[]): boolean => params.includes(25);
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    if (dectcem(params)) cursorVisible = true;
    return false;
  });
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    if (dectcem(params)) cursorVisible = false;
    return false;
  });

  return {
    write(chunk, done) {
      terminal.write(chunk, done);
    },

    resize(nextCols, nextRows) {
      terminal.resize(Math.max(2, Math.floor(nextCols)), Math.max(2, Math.floor(nextRows)));
    },

    scroll(lines) {
      // Колесо в панели, когда гость мышь не просил (дизайн 3.3): листаем свой
      // скроллбэк. Границы xterm держит сам, за край не уедет.
      terminal.scrollLines(Math.trunc(lines));
    },

    snapshot() {
      const buffer = terminal.buffer.active;
      const lines: TerminalSegment[][] = [];

      for (let y = 0; y < terminal.rows; y++) {
        const line = buffer.getLine(buffer.viewportY + y);
        const segments: TerminalSegment[] = [];

        if (line !== undefined) {
          let current: TerminalSegment | undefined;

          for (let x = 0; x < line.length; x++) {
            cellBuffer = line.getCell(x, cellBuffer);
            if (cellBuffer === undefined) continue;
            // Правая половина широкого символа: ширина 0, текста своего нет.
            if (cellBuffer.getWidth() === 0) continue;

            const chars = cellBuffer.getChars();
            const style = styleOf(cellBuffer);

            if (current !== undefined && sameStyle(current, style)) {
              current.text += chars === '' ? ' ' : chars;
            } else {
              current = { ...style, text: chars === '' ? ' ' : chars };
              segments.push(current);
            }
          }

          // Хвостовые пробелы без фона рисовать незачем.
          const last = segments[segments.length - 1];
          if (last !== undefined && last.backgroundColor === undefined) {
            last.text = last.text.replace(/\s+$/, '');
            if (last.text === '') segments.pop();
          }
        }

        lines.push(segments);
      }

      return {
        lines,
        cols: terminal.cols,
        rows: terminal.rows,
        altScreen: buffer.type === 'alternate',
        mouseTracking: terminal.modes.mouseTrackingMode,
        bracketedPaste: terminal.modes.bracketedPasteMode,
        cursor: {
          x: buffer.cursorX,
          // cursorY считается от baseY (низ буфера), а показываем мы от viewportY:
          // при прокрутке в скроллбэк курсор уезжает за пределы экрана.
          y: buffer.baseY + buffer.cursorY - buffer.viewportY,
          visible: cursorVisible,
        },
      };
    },

    dispose() {
      terminal.dispose();
    },
  };
}
