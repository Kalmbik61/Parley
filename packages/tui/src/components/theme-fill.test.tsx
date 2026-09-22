/**
 * Заливка зон темы фоном (дизайн темы TUI, 5.1; план, кусок 4): у Ink нет
 * `backgroundColor` у `<Box>`, поэтому каждая строка зоны — один `<Text
 * backgroundColor>`, добитый пробелами до ширины зоны, и пустые строки тоже.
 * Заливка живёт только при `theme().fills` (уровни 2 и 3).
 *
 * `FORCE_COLOR` ставится до импорта Ink и chalk тем же приёмом, что и в
 * `sidebar-selection.test.tsx`: уровень цвета chalk решает один раз при
 * загрузке модуля.
 */

vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '3';
});

import type { WorkSession } from '@harnas/core';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { describe, expect, it, vi } from 'vitest';
import { pinUnicodeGlyphs } from '../../test/glyphs-env.js';
import { pinTheme } from '../../test/theme-env.js';
import { glyphs } from '../glyphs.js';
import { PALETTES } from '../theme/palettes.js';
import { Line, type OverlayLine } from './overlay.js';
import { Card, type CardProps } from './panel.js';
import { Sidebar, type SidebarSession, type SidebarTarget, type SidebarWork } from './sidebar.js';
import { StatusBar } from './status-bar.js';

pinUnicodeGlyphs();

const p = PALETTES.mocha;

/**
 * Фон-hex в 24-битной ANSI-записи chalk, без ведущего ESC — тот же приём, что
 * и `hexBg`/`hexFg` в `sidebar-selection.test.tsx`: подстрока всё равно
 * находится внутри полного кода `[48;2;r;g;bm`.
 */
const hexBg = (hex: string): string => {
  const n = hex.replace('#', '');
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return `[48;2;${r};${g};${b}m`;
};

/**
 * Снимает ANSI-коды (в т.ч. `dimColor` — он живёт и на уровне 1, вне заливки).
 * `RegExp` собран из строки, а не литералом — литерал с управляющим символом
 * ловит `no-control-regex`.
 */
const ESC = String.fromCharCode(27);
const ANSI_CODE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const stripAnsi = (line: string): string => line.replace(ANSI_CODE, '');

const SIDEBAR_BG = hexBg(p.mantle);
const SELECTION_BG = hexBg(p.surface);
const BADGE_BG = hexBg(p.cyan);
const PANEL_BG = hexBg(p.base);
const OVERLAY_BG = hexBg(p.crust);
const STATUS_BG = hexBg(p.mantle);

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 's-01',
    provider: 'claude',
    label: 'план',
    task: '',
    parent: null,
    contextFrom: [],
    status: 'active',
    history: [],
    startedAt: null,
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: null,
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: null,
    ...over,
  };
}

describe('заливка зон темы фоном (дизайн 5.1, кусок 4)', () => {
  pinTheme(3);

  describe('сайдбар', () => {
    const SIDEBAR_WIDTH = 26;
    const SIDEBAR_HEIGHT = 16;

    const works: SidebarWork[] = [
      {
        key: 'w1',
        number: 1,
        title: 'Alpha',
        project: '~/dev/alpha',
        branch: 'main',
        state: 'idle',
        done: false,
      },
      {
        key: 'w2',
        number: 2,
        title: 'Beta',
        project: '~/dev/beta',
        branch: 'dev',
        state: 'idle',
        done: false,
      },
    ];

    const sessions: SidebarSession[] = [
      {
        session: session({ id: 's1', label: 'Session1' }),
        state: 'active',
        live: { durationMs: 60_000, tokens: null, model: null, lastRecordAt: null },
        unread: 2,
        subagents: 0,
      },
      {
        session: session({ id: 's2', label: 'Session2' }),
        state: 'idle',
        live: { durationMs: 60_000, tokens: null, model: null, lastRecordAt: null },
        unread: 0,
        subagents: 0,
      },
    ];

    // Без рамки (как в `SidebarOverlay`): у каждой строки нет боковых граней,
    // и вся `width` целиком — зона фона (рамки заливку не несут, 5.2).
    function sidebarLines(cursor: SidebarTarget | null = null, width = SIDEBAR_WIDTH): string[] {
      return (
        render(
          <Sidebar
            works={works}
            sessions={sessions}
            selectedWork="w1"
            selectedSession="s1"
            width={width}
            height={SIDEBAR_HEIGHT}
            framed={false}
            cursor={cursor}
          />,
        ).lastFrame() ?? ''
      ).split('\n');
    }

    it('каждая строка блока несёт фон и её видимая ширина равна ширине блока (1)', () => {
      const lines = sidebarLines();
      // Выбранные строки несут bg.selection, а не bg.sidebar — отдельная
      // проверка ниже (3); здесь только не-выбранные строки блока.
      const rest = lines.filter((line) => !line.includes(SELECTION_BG));

      expect(rest.length).toBeGreaterThan(0);
      for (const line of rest) {
        expect(line.includes(SIDEBAR_BG)).toBe(true);
        // Видимая ширина — по колонкам (`string-width` сам снимает ANSI), не
        // длина строки: широкие символы иначе сдвинули бы счёт.
        expect(stringWidth(line)).toBe(SIDEBAR_WIDTH);
      }
    });

    it('пустые строки-заполнители залиты так же, как непустые (2)', () => {
      const lines = sidebarLines();
      const blanks = lines.filter((line) => stripAnsi(line).trim() === '');

      expect(blanks.length).toBeGreaterThan(0);
      for (const line of blanks) {
        expect(line.includes(SIDEBAR_BG)).toBe(true);
        expect(stringWidth(line)).toBe(SIDEBAR_WIDTH);
      }
    });

    it('выбранный ряд несёт bg.selection, а не bg.sidebar, на всю ширину (3)', () => {
      const lines = sidebarLines();
      const work = lines.find((line) => line.includes('Alpha'));
      const project = lines.find((line) => line.includes('~/dev/alpha'));
      const workSession = lines.find((line) => line.includes('Session1'));
      // Компактная строка выбранной сессии: `unread: 2` даёт узнаваемый `▤2`.
      const compact = lines.find((line) => line.includes('▤2'));

      for (const line of [work, project, workSession, compact]) {
        expect(line).toBeDefined();
        expect(line?.includes(SELECTION_BG)).toBe(true);
        expect(line?.includes(SIDEBAR_BG)).toBe(false);
        expect(stringWidth(line ?? '')).toBe(SIDEBAR_WIDTH);
      }

      // Невыбранная работа подсветку не несёт.
      const other = lines.find((line) => line.includes('Beta'));
      expect(other?.includes(SELECTION_BG)).toBe(false);
    });

    it('плашка `new` несёт bg.badge только под своим текстом (4)', () => {
      const lines = sidebarLines({ kind: 'new', key: '' });
      const button = lines.find((line) => line.includes(' new'));
      expect(button).toBeDefined();
      const line = button ?? '';

      expect(line.includes(BADGE_BG)).toBe(true);
      expect(stringWidth(line)).toBe(SIDEBAR_WIDTH);

      // Справа от плашки — фон строки (bg.sidebar), а не фон плашки: badge
      // закрывается, и bg.sidebar открывается заново до конца строки (chalk
      // переоткрывает внешний фон после вложенного сброса того же типа).
      const badgeAt = line.indexOf(BADGE_BG);
      const rowBgAfter = line.indexOf(SIDEBAR_BG, badgeAt + BADGE_BG.length);
      expect(rowBgAfter).toBeGreaterThan(badgeAt);
      // И больше фон плашки после этого места не встречается — добивка не
      // раскрашена под бейдж.
      expect(line.indexOf(BADGE_BG, rowBgAfter)).toBe(-1);
    });

    it('на вырожденных ширинах заливка не переносит строку и не вылезает за зону (7)', () => {
      for (const width of [4, 10, 18, 26, 60, 120]) {
        const lines = sidebarLines(null, width);
        expect(lines).toHaveLength(SIDEBAR_HEIGHT);
        for (const line of lines) {
          expect(stringWidth(line)).toBe(width);
        }
      }
    });
  });

  describe('карточка панели (5)', () => {
    const CARD_WIDTH = 40;

    const card = (over: Partial<CardProps> = {}): CardProps => ({
      session: session(),
      state: 'pending',
      parent: 'бэкенд',
      brief: 'brief.md',
      prefix: 'ctrl+q',
      atHarness: false,
      ...over,
    });

    it('каждая строка карточки, включая пустую хвостовую, несёт bg.panel на всю ширину', () => {
      const lines = (render(<Card card={card()} width={CARD_WIDTH} />).lastFrame() ?? '').split(
        '\n',
      );
      // Пустая строка сверху + заголовок + хотя бы одна хвостовая строка.
      expect(lines.length).toBeGreaterThan(2);
      for (const line of lines) {
        expect(line.includes(PANEL_BG)).toBe(true);
        expect(stringWidth(line)).toBe(CARD_WIDTH);
      }
    });
  });

  describe('оверлей (5)', () => {
    const INNER = 28;

    it('строка списка и линейка несут bg.overlay на всю ширину тела', () => {
      const g = glyphs();
      const listLine: OverlayLine = { text: ' строка' };
      const ruleLine: OverlayLine = { rule: true, text: '' };

      const listFrame = render(<Line line={listLine} width={INNER} g={g} />).lastFrame() ?? '';
      const ruleFrame = render(<Line line={ruleLine} width={INNER} g={g} />).lastFrame() ?? '';

      for (const frame of [listFrame, ruleFrame]) {
        expect(frame.includes(OVERLAY_BG)).toBe(true);
        expect(stringWidth(frame)).toBe(INNER);
      }
    });

    it('подвал и «N ниже» рисуются тем же `Line` и несут тот же фон (5.1)', () => {
      const g = glyphs();
      const footerFrame =
        render(<Line line={{ text: ' Enter — выбрать · Esc', dim: true }} width={INNER} g={g} />).lastFrame() ??
        '';
      const belowFrame =
        render(<Line line={{ text: ` ${g.ellipsis} 3 ниже`, dim: true }} width={INNER} g={g} />).lastFrame() ??
        '';

      for (const frame of [footerFrame, belowFrame]) {
        expect(frame.includes(OVERLAY_BG)).toBe(true);
        expect(stringWidth(frame)).toBe(INNER);
      }
    });

    it('пустая строка-заполнитель залита так же, как непустая', () => {
      const g = glyphs();
      const frame = render(<Line line={{ text: '' }} width={INNER} g={g} />).lastFrame() ?? '';
      expect(frame.includes(OVERLAY_BG)).toBe(true);
      expect(stringWidth(frame)).toBe(INNER);
    });

    it('выбранная строка списка несёт bg.selection, а не bg.overlay', () => {
      const g = glyphs();
      const frame =
        render(<Line line={{ text: ' выбрана', selected: true }} width={INNER} g={g} />).lastFrame() ?? '';
      expect(frame.includes(SELECTION_BG)).toBe(true);
      expect(frame.includes(OVERLAY_BG)).toBe(false);
      expect(stringWidth(frame)).toBe(INNER);
    });
  });

  describe('строка статуса (5)', () => {
    const WIDTH = 40;

    it('обычная строка (без событий) несёт bg.status на всю ширину', () => {
      const frame =
        render(<StatusBar count={0} event={null} width={WIDTH} prefix="ctrl+q" />).lastFrame() ?? '';
      expect(frame.includes(STATUS_BG)).toBe(true);
      expect(stringWidth(frame)).toBe(WIDTH);
    });

    it('ветка с событием несёт bg.status на всю ширину', () => {
      const frame =
        render(
          <StatusBar
            count={2}
            event={{ text: 'ревью ждёт ответа', hint: 'не подключена' }}
            width={WIDTH}
            prefix="ctrl+q"
          />,
        ).lastFrame() ?? '';
      expect(frame.includes(STATUS_BG)).toBe(true);
      expect(stringWidth(frame)).toBe(WIDTH);
    });

    it('режим навигации несёт bg.status на всю ширину', () => {
      const frame =
        render(
          <StatusBar count={0} event={null} width={WIDTH} prefix="ctrl+q" navigating />,
        ).lastFrame() ?? '';
      expect(frame.includes(STATUS_BG)).toBe(true);
      expect(stringWidth(frame)).toBe(WIDTH);
    });
  });
});

/**
 * Сквозной инвариант (план, куски 1–4; приёмка 6): на уровне ≤1 добивки нет
 * вовсе — кадр обязан остаться таким же, как до темы. Этот describe не
 * переопределяет уровень — работает общий `pinTheme(1)` из `setupFiles`, и
 * этот же тест страхует остальной набор (если он ушёл в другую сторону —
 * ушёл план, а не тест).
 */
describe('без заливки на уровне 1 — сквозной инвариант (6)', () => {
  const works: SidebarWork[] = [
    {
      key: 'w1',
      number: 1,
      title: 'Alpha',
      project: '~/dev/alpha',
      branch: 'main',
      state: 'idle',
      done: false,
    },
  ];

  it('сайдбар: ни фона, ни добивки', () => {
    const lines = (
      render(
        <Sidebar
          works={works}
          sessions={[]}
          selectedWork="w1"
          selectedSession={null}
          width={26}
          height={10}
          framed={false}
        />,
      ).lastFrame() ?? ''
    ).split('\n');

    for (const line of lines) {
      expect(line.includes(SIDEBAR_BG)).toBe(false);
      expect(line.includes(SELECTION_BG)).toBe(false);
    }
  });

  it('карточка панели: ни фона, ни добивки за пределы `room`', () => {
    const card: CardProps = {
      session: session(),
      state: 'pending',
      parent: null,
      brief: null,
      prefix: 'ctrl+q',
      atHarness: false,
    };
    const lines = (render(<Card card={card} width={40} />).lastFrame() ?? '').split('\n');

    for (const line of lines) {
      expect(line.includes(PANEL_BG)).toBe(false);
      // Без темы строки короче ширины карточки — добивки за `room` нет.
      expect(stringWidth(line)).toBeLessThan(40);
    }
  });

  it('оверлей: ни фона на строке списка, ни фона на пустом заполнителе', () => {
    const g = glyphs();
    const listFrame = render(<Line line={{ text: ' строка' }} width={30} g={g} />).lastFrame() ?? '';
    const emptyFrame = render(<Line line={{ text: '' }} width={30} g={g} />).lastFrame() ?? '';
    expect(listFrame.includes(OVERLAY_BG)).toBe(false);
    expect(emptyFrame.includes(OVERLAY_BG)).toBe(false);
  });

  it('строка статуса: без событий длина ровно `ctrl+q ?`, добивки до ширины нет', () => {
    const frame = render(<StatusBar count={0} event={null} width={60} prefix="ctrl+q" />).lastFrame() ?? '';
    expect(frame.includes(STATUS_BG)).toBe(false);
    // `fg.muted` красит хвост `dimColor`-ом и на уровне 1 (5.4, вне заливки) —
    // сравниваем текст без ANSI, а не полное отсутствие кодов в строке.
    expect(stripAnsi(frame).trim()).toBe('ctrl+q ?');
  });
});
