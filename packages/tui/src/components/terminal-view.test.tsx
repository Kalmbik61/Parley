import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { pinTheme } from '../../test/theme-env.js';
import type { TerminalSegment, TerminalSnapshot } from '../pty/terminal-buffer.js';
import { PALETTES } from '../theme/palettes.js';

// Инверсию видно только в ANSI-кодах, а chalk решает про цвет при загрузке:
// включаем его до того, как Ink попадёт в модульный кэш этого файла. Уровень
// 3, не 1: часть проверок (план, кусок 5) идёт при `pinTheme(3)` и смотрит на
// настоящий truecolor hex палитры, а не на его приближение — именованным
// ANSI-цветам и инверсии уровень безразличен, так что старые проверки (тема
// уровня 1) этим не задеты (тот же приём, что в `sidebar-selection.test.tsx`).
process.env['FORCE_COLOR'] = '3';
const { render } = await import('ink-testing-library');
const { TerminalView, withCursor } = await import('./terminal-view.js');

const INVERSE = '\u001B[7m';

const seg = (text: string, style: Omit<TerminalSegment, 'text'> = {}): TerminalSegment => ({
  ...style,
  text,
});

/** Снимок PTY с разумными дефолтами: только то, что тест меняет явно. */
const snap = (
  lines: TerminalSegment[][],
  overrides: Partial<Omit<TerminalSnapshot, 'lines'>> = {},
): TerminalSnapshot => ({
  lines,
  cols: 10,
  rows: lines.length,
  altScreen: false,
  mouseTracking: 'none',
  bracketedPaste: false,
  cursor: { x: 0, y: 0, visible: false },
  ...overrides,
});

describe('withCursor', () => {
  it('ячейка под курсором становится отдельным инверсным сегментом', () => {
    expect(withCursor([seg('abcd')], 2)).toEqual([
      seg('ab'),
      seg('c', { inverse: true }),
      seg('d'),
    ]);
  });

  it('за концом строки курсор рисуется пробелом с отступом до своей колонки', () => {
    expect(withCursor([seg('ab')], 4)).toEqual([seg('ab'), seg('  '), seg(' ', { inverse: true })]);
    expect(withCursor([], 0)).toEqual([seg(' ', { inverse: true })]);
  });

  it('на инверсной ячейке курсор снимает инверсию, остальной стиль сохраняется', () => {
    expect(withCursor([seg('ab', { inverse: true, color: 'red' })], 1)).toEqual([
      seg('a', { inverse: true, color: 'red' }),
      seg('b', { inverse: false, color: 'red' }),
    ]);
  });

  it('широкий символ занимает две колонки, курсор попадает на него целиком', () => {
    expect(withCursor([seg('a漢b')], 1)).toEqual([
      seg('a'),
      seg('漢', { inverse: true }),
      seg('b'),
    ]);
    expect(withCursor([seg('a漢b')], 3)).toEqual([seg('a漢'), seg('b', { inverse: true })]);
  });
});

describe('TerminalView', () => {
  const snapshot = (cursor: TerminalSnapshot['cursor']): TerminalSnapshot => ({
    lines: [[seg('> привет')], []],
    cols: 20,
    rows: 2,
    altScreen: false,
    mouseTracking: 'none',
    bracketedPaste: false,
    cursor,
  });

  it('видимый курсор рисуется инверсией в своей строке', () => {
    const frame = render(
      <TerminalView snapshot={snapshot({ x: 2, y: 0, visible: true })} height={2} />,
    ).lastFrame();
    expect(frame).toContain(`${INVERSE}п`);
  });

  it('скрытый курсор не рисуется', () => {
    const frame = render(
      <TerminalView snapshot={snapshot({ x: 2, y: 0, visible: false })} height={2} />,
    ).lastFrame();
    expect(frame).not.toContain(INVERSE);
  });

  it('курсор за пределами панели по высоте не рисуется', () => {
    const frame = render(
      <TerminalView snapshot={snapshot({ x: 0, y: 1, visible: true })} height={1} />,
    ).lastFrame();
    expect(frame).not.toContain(INVERSE);
  });
});

/**
 * Зона агента: подстановка дефолтов и добивка (дизайн темы TUI, 5.3; план,
 * кусок 5). `styleProps` подставляет `fg.default`/`bg.agent` только пустым
 * сторонам ячейки — то, что гость окрасил сам, не трогается вовсе.
 */
describe('зона агента: подстановка дефолтов и добивка (кусок 5)', () => {
  pinTheme(3);

  const p = PALETTES.mocha;
  const hexBg = (hex: string): string => {
    const n = hex.replace('#', '');
    return `[48;2;${parseInt(n.slice(0, 2), 16)};${parseInt(n.slice(2, 4), 16)};${parseInt(n.slice(4, 6), 16)}m`;
  };
  const hexFg = (hex: string): string => {
    const n = hex.replace('#', '');
    return `[38;2;${parseInt(n.slice(0, 2), 16)};${parseInt(n.slice(2, 4), 16)};${parseInt(n.slice(4, 6), 16)}m`;
  };
  const AGENT_BG = hexBg(p.base);
  const DEFAULT_FG = hexFg(p.text);

  it('ячейка без фона получает bg.agent, ячейка с фоном гостя остаётся ровно со своим', () => {
    const frame =
      render(
        <TerminalView
          snapshot={snap([[seg('ab'), seg('cd', { backgroundColor: 'yellow' })]], { cols: 4 })}
          height={1}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain(AGENT_BG);
    // Именованный ANSI-фон гостя (bgYellow, код 43) — ровно то, что он задал.
    expect(frame).toContain('\u001B[43m');
  });

  it('ячейка без цвета получает fg.default, окрашенная гостем — не трогается', () => {
    const frame =
      render(
        <TerminalView
          snapshot={snap([[seg('ab'), seg('cd', { color: 'red' })]], { cols: 4 })}
          height={1}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain(DEFAULT_FG);
    // Именованный ANSI-цвет гостя (red, код 31) — не подменён.
    expect(frame).toContain('\u001B[31m');
  });

  it('строка короче ширины добита фоном зоны до snapshot.cols', () => {
    const frame =
      render(<TerminalView snapshot={snap([[seg('ab')]], { cols: 6 })} height={1} />).lastFrame() ??
      '';
    expect(stringWidth(frame)).toBe(6);
    expect(frame).toContain(AGENT_BG);
  });

  it('строки ниже реального содержимого гостя (height больше числа строк снимка) нарисованы и залиты', () => {
    const frame =
      render(
        <TerminalView snapshot={snap([[seg('ab')]], { cols: 6, rows: 1 })} height={3} />,
      ).lastFrame() ?? '';
    const lines = frame.split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(stringWidth(line)).toBe(6);
      expect(line).toContain(AGENT_BG);
    }
  });

  it('ширина после добивки — ровно snapshot.cols на всём наборе строк, включая широкие символы', () => {
    const rows: TerminalSegment[][] = [[seg('漢字')], [seg('a漢b')], [seg('ab')], []];
    const frame =
      render(
        <TerminalView snapshot={snap(rows, { cols: 8, rows: rows.length })} height={rows.length} />,
      ).lastFrame() ?? '';
    const lines = frame.split('\n');
    expect(lines).toHaveLength(rows.length);
    for (const line of lines) {
      expect(stringWidth(line)).toBe(8);
      expect(line).toContain(AGENT_BG);
    }
  });

  it('каретка на обычной ячейке в середине строки: инверсия и подставленные цвета видны вместе', () => {
    const frame =
      render(
        <TerminalView
          snapshot={snap([[seg('abcd')]], { cols: 4, cursor: { x: 2, y: 0, visible: true } })}
          height={1}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain(INVERSE);
    expect(frame).toContain(DEFAULT_FG);
    expect(frame).toContain(AGENT_BG);
  });

  it('каретка за концом строки остаётся видимой: инверсия на подставленных цветах', () => {
    const frame =
      render(
        <TerminalView
          snapshot={snap([[seg('ab')]], { cols: 6, cursor: { x: 4, y: 0, visible: true } })}
          height={1}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain(INVERSE);
    expect(frame).toContain(DEFAULT_FG);
    expect(frame).toContain(AGENT_BG);
  });

  it('каретка на уже инверсной ячейке гостя снимает инверсию, подстановка остаётся', () => {
    const frame =
      render(
        <TerminalView
          snapshot={snap([[seg('a'), seg('b', { inverse: true }), seg('c')]], {
            cols: 3,
            cursor: { x: 1, y: 0, visible: true },
          })}
          height={1}
        />,
      ).lastFrame() ?? '';
    // Единственная инверсная ячейка гостя была ровно под курсором — она
    // снята, и больше инверсии в кадре нет.
    expect(frame).not.toContain(INVERSE);
    expect(frame).toContain(DEFAULT_FG);
    expect(frame).toContain(AGENT_BG);
  });
});

/**
 * Сквозной инвариант (план, кусок 5, приёмка): на уровне ≤1 роли и так
 * пустые, а добивка обязана отсутствовать вовсе — кадр остаётся таким же,
 * как до темы. Общий `pinTheme(1)` из `setupFiles` уже действует, отдельно
 * его включать не нужно.
 */
describe('каретка на краю строки (кусок 5)', () => {
  pinTheme(3);

  it('курсор в состоянии переноса не делает строку шире панели', () => {
    // xterm оставляет `cursorX === cols`, пока строка напечатана во всю
    // ширину и перенос ещё не случился. Каретка в этот момент рисуется на
    // последней колонке, а не за ней: иначе залитая строка вылезает за зону.
    const snapshot: TerminalSnapshot = {
      lines: [[seg('abcd')]],
      cols: 4,
      rows: 1,
      altScreen: false,
      mouseTracking: 0,
      bracketedPaste: false,
      cursor: { x: 4, y: 0, visible: true },
    };
    const frame = render(<TerminalView snapshot={snapshot} height={1} />).lastFrame() ?? '';
    const ESC_CODE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
    expect(stringWidth(frame.replace(ESC_CODE, ''))).toBe(4);
    expect(frame).toContain(INVERSE);
  });
});

describe('зона агента без темы (уровень 1) — сквозной инвариант (кусок 5)', () => {
  it('короткая строка не добивается до ширины', () => {
    const frame = render(
      <TerminalView snapshot={snap([[seg('ab')]], { cols: 6 })} height={1} />,
    ).lastFrame();
    expect(frame).toBe('ab');
  });

  it('строк сверх реального содержимого гостя (height больше числа строк снимка) не рисуется', () => {
    const frame =
      render(
        <TerminalView snapshot={snap([[seg('ab')]], { cols: 6, rows: 1 })} height={3} />,
      ).lastFrame() ?? '';
    expect(frame.split('\n')).toHaveLength(1);
  });
});
