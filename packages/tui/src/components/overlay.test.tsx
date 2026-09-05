/**
 * Раскладка оверлеев (макеты TUI v2, §4.0): ширины 48/56/64, центр по панели
 * либо по терминалу, высота `min(контент + 2, строки − 3)`, прокрутка.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { pinUnicodeGlyphs } from '../../test/glyphs-env.js';
import {
  CONFIRM_WIDTH,
  DETAILS_WIDTH,
  Overlay,
  overlayBox,
  OverlayHost,
  PICKER_WIDTH,
  type OverlayLine,
} from './overlay.js';

pinUnicodeGlyphs();

/** Панель начинается за сайдбаром и разделителем: 26 + 1 и 18 + 1. */
const WIDE_PANEL = 27;
const NARROW_PANEL = 19;

const lines = (count: number): OverlayLine[] =>
  Array.from({ length: count }, (_, at) => ({ text: ` строка ${at + 1}` }));

describe('геометрия оверлея (§4.0)', () => {
  it('ширина — своя, пока помещается в терминал минус 4', () => {
    expect(overlayBox(CONFIRM_WIDTH, 120, 40, WIDE_PANEL, 5).width).toBe(48);
    expect(overlayBox(PICKER_WIDTH, 120, 40, WIDE_PANEL, 5).width).toBe(56);
    expect(overlayBox(DETAILS_WIDTH, 120, 40, WIDE_PANEL, 5).width).toBe(64);
    // Узкий терминал: рамка ужимается, а не вылезает за край.
    expect(overlayBox(DETAILS_WIDTH, 50, 24, 0, 5).width).toBe(46);
  });

  it('центр — по панели, пока рамка с зазором в неё влезает', () => {
    // 120×40, сайдбар 26: панель 93 колонки, пикер 56 + 2 в неё помещается.
    const picker = overlayBox(PICKER_WIDTH, 120, 40, WIDE_PANEL, 5);
    expect(picker.wide).toBe(false);
    expect(picker.left).toBe(WIDE_PANEL + Math.floor((120 - WIDE_PANEL - 56) / 2));
  });

  it('не влезло в панель — центр по терминалу, оверлей ложится и на сайдбар', () => {
    // 80×24, сайдбар 18: панель 61, детали 64 + 2 в неё не влезают.
    const details = overlayBox(DETAILS_WIDTH, 80, 24, NARROW_PANEL, 5);
    expect(details.wide).toBe(true);
    expect(details.left).toBe(Math.floor((80 - 64) / 2));
    // Пикер той же ширины экрана остаётся в панели.
    expect(overlayBox(PICKER_WIDTH, 80, 24, NARROW_PANEL, 5).wide).toBe(false);
  });

  it('высота — min(контент + 2, строки − 3)', () => {
    expect(overlayBox(PICKER_WIDTH, 120, 40, WIDE_PANEL, 6).height).toBe(8);
    // Строка статуса и одна строка панели сверху остаются видны.
    expect(overlayBox(PICKER_WIDTH, 120, 24, WIDE_PANEL, 100).height).toBe(21);
  });
});

describe('рамка и тело (§4.0)', () => {
  const frameOf = (props: { lines: OverlayLine[]; scroll?: number; rows?: number }): string => {
    const rows = props.rows ?? 40;
    const box = overlayBox(PICKER_WIDTH, 120, rows, WIDE_PANEL, props.lines.length + 1);
    return (
      render(
        <Overlay
          box={box}
          title="работы"
          lines={props.lines}
          footer=" Enter — выбрать · Esc"
          {...(props.scroll === undefined ? {} : { scroll: props.scroll })}
        />,
      ).lastFrame() ?? ''
    );
  };

  it('заголовок стоит в верхней рамке, подсказка — последней строкой', () => {
    const frame = frameOf({ lines: lines(3) });
    expect(frame).toContain('┌ работы ─');
    expect(frame).toContain('└');
    expect(frame).toContain('Enter — выбрать · Esc');
    // Ширина рамки — ровно 56 колонок (§4.0).
    const top = frame.split('\n').find((line) => line.includes('┌')) ?? '';
    expect(top.trim()).toHaveLength(56);
  });

  it('контент не влез — прокрутка и «… N ниже» у нижней рамки', () => {
    // 12 строк тела при высоте терминала 12: видно меньше, чем есть.
    const frame = frameOf({ lines: lines(12), rows: 12 });
    expect(frame).toContain('строка 1');
    expect(frame).toMatch(/… \d+ ниже/);
    expect(frame).not.toContain('строка 12');

    // Прокрутка сдвигает окно, но не убегает за конец списка: первая строка
    // уезжает, последняя появляется.
    const scrolled = frameOf({ lines: lines(12), rows: 12, scroll: 20 });
    expect(scrolled).not.toContain('строка 1 ');
    expect(scrolled).toContain('строка 12');
  });

  it('линейка внутри рамки рисуется на всю ширину тела', () => {
    const frame = frameOf({ lines: [{ text: ' > фильтр' }, { rule: true, text: '' }] });
    expect(frame).toContain('─'.repeat(54));
  });
});

describe('подтверждение внутри рамки (макеты 4.5–4.9)', () => {
  it('заголовок стоит в рамке, тело рисует существующий Dialog', () => {
    const frame =
      render(
        <OverlayHost
          view={null}
          confirm={{
            id: 1,
            spec: {
              title: 'закрыть ● бэкенд',
              info: ['процессу будет послан SIGHUP · pid 48213'],
              quote: [],
              footer: 'Enter — закрыть · Esc',
            },
          }}
          scroll={0}
          focus={undefined}
          columns={120}
          rows={40}
          panelLeft={WIDE_PANEL}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
      ).lastFrame() ?? '';

    expect(frame).toContain('┌ закрыть ● бэкенд ─');
    expect(frame).toContain('SIGHUP · pid 48213');
    expect(frame).toContain('Enter — закрыть');
    // Ширина подтверждения — 48 колонок (§4.0).
    const top = frame.split('\n').find((line) => line.includes('┌')) ?? '';
    expect(top.trim()).toHaveLength(48);
  });
});
