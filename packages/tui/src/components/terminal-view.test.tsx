import { describe, expect, it } from 'vitest';
import type { TerminalSegment, TerminalSnapshot } from '../pty/terminal-buffer.js';

// Инверсию видно только в ANSI-кодах, а chalk решает про цвет при загрузке:
// включаем его до того, как Ink попадёт в модульный кэш этого файла.
process.env['FORCE_COLOR'] = '1';
const { render } = await import('ink-testing-library');
const { TerminalView, withCursor } = await import('./terminal-view.js');

const INVERSE = '\u001B[7m';

const seg = (text: string, style: Omit<TerminalSegment, 'text'> = {}): TerminalSegment => ({
  ...style,
  text,
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
