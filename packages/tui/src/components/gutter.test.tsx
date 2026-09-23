/**
 * Монохромный жёлоб (дизайн темы TUI, 4.3; план, кусок 6): на уровне 0
 * (`NO_COLOR`, не TTY, `TERM=dumb`) chalk снимает и фон, и `inverse` —
 * выбранный ряд списка не виден никак. Жёлоб делает выбор видимым глифом
 * `cursor` в колонке слева, отдельно от цвета.
 *
 * Общий уровень темы в тестах — 1 (`setupFiles`, `theme-env.ts`): здесь он
 * переопределяется на 0 там, где нужен сам жёлоб.
 *
 * Осторожно с `lastFrame()`: Ink обрезает хвостовые пробелы каждой строки,
 * если после них нет цвета (а на уровне 0 цвета нет вовсе) — значит
 * «добитая пробелами до width строка» в захваченном кадре короче, чем была
 * фактически нарисована. Там, где важна именно ОБЩАЯ ширина строки, тесты
 * ниже используют текст заведомо длиннее любой проверяемой ширины: тогда
 * работает усечение, а не добивка, хвостовых пробелов не остаётся, и
 * `stringWidth` кадра совпадает с шириной по построению.
 */

import type { WorkSession } from '@harnas/core';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { pinUnicodeGlyphs } from '../../test/glyphs-env.js';
import { pinTheme } from '../../test/theme-env.js';
import { applyGlyphsConfig, glyphs } from '../glyphs.js';
import { applyThemeConfig } from '../theme/index.js';
import { Line, type OverlayLine } from './overlay.js';
import {
  Sidebar,
  sidebarTargets,
  type SidebarProps,
  type SidebarSession,
  type SidebarTarget,
  type SidebarWork,
} from './sidebar.js';

pinUnicodeGlyphs();

const ESC = String.fromCharCode(27);
const ANSI_CODE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const hasAnsi = (text: string): boolean => ANSI_CODE.test(text);

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

function sidebarProps(
  width = 26,
  height = 16,
  cursor: SidebarTarget | null = null,
  ownWorks: readonly SidebarWork[] = works,
  ownSessions: readonly SidebarSession[] = sessions,
  room: SidebarProps['room'] = null,
  roomSelected = false,
): SidebarProps {
  return {
    works: ownWorks,
    sessions: ownSessions,
    selectedWork: 'w1',
    selectedSession: 's1',
    width,
    height,
    framed: false,
    cursor,
    room,
    roomSelected,
  };
}

const sidebarFrame = (...args: Parameters<typeof sidebarProps>): string[] =>
  (render(<Sidebar {...sidebarProps(...args)} />).lastFrame() ?? '').split('\n');

describe('жёлоб на уровне 0 — сайдбар (дизайн 4.3, кусок 6)', () => {
  pinTheme(0);

  it('маркер стоит ровно у выбранного ряда и ровно на одной его строке', () => {
    const lines = sidebarFrame();
    const work = lines.find((line) => line.includes('Alpha'));
    const project = lines.find((line) => line.includes('~/dev/alpha'));
    const beta = lines.find((line) => line.includes('Beta'));
    const workSession = lines.find((line) => line.includes('Session1'));
    const compact = lines.find((line) => line.includes('▤2'));
    const other = lines.find((line) => line.includes('Session2'));

    // Первая строка выбранной работы и выбранной сессии несёт маркер.
    expect(work?.startsWith('›')).toBe(true);
    expect(workSession?.startsWith('›')).toBe(true);
    // Вторая строка того же ряда (проект/компакт) — пробел, не маркер: у
    // двустрочного ряда маркер стоит только на первой строке (4.3).
    expect(project?.startsWith('›')).toBe(false);
    expect(project?.startsWith(' ')).toBe(true);
    expect(compact?.startsWith('›')).toBe(false);
    expect(compact?.startsWith(' ')).toBe(true);
    // Невыбранные ряды несут пробел, а не маркер.
    expect(beta?.startsWith('›')).toBe(false);
    expect(other?.startsWith('›')).toBe(false);

    // Ровно два маркера на весь кадр: первая строка работы + первая строка
    // сессии — считаем по всему кадру, а не по одной догадке.
    expect(lines.filter((line) => line.startsWith('›')).length).toBe(2);
  });

  // Приёмка (дизайн комнаты, 3-4, 6): у выбранной строки комнаты маркер
  // жёлоба стоит так же, как у любой строки списка — своей функцией
  // (`gutterMark`), общей с `SessionRow`.
  it('маркер жёлоба стоит у выбранной строки комнаты, а не у строки сессии', () => {
    const lines = sidebarFrame(26, 16, null, works, sessions, { letters: 3, unread: 1 }, true);
    const room = lines.find((line) => line.includes('комната'));
    const workSession = lines.find((line) => line.includes('Session1'));

    expect(room?.startsWith('›')).toBe(true);
    // Комната выбрана вместо сессии — строка сессии маркер уступает ей.
    expect(workSession?.startsWith('›')).toBe(false);
    expect(lines.filter((line) => line.startsWith('›')).length).toBe(2);
  });

  it('в кадре нет ни одного ANSI-кода — по регулярке, не на глаз', () => {
    const frame = sidebarFrame().join('\n');
    expect(hasAnsi(frame)).toBe(false);
  });

  it('усечение и многоточие считают уменьшенную ширину, а не прежнюю (сравнение с уровнем 1)', () => {
    // Заголовок ровно бюджета без жёлоба: `width(26) − head(3) − хвост(2) = 21`.
    const title = 'a'.repeat(21);
    const long: SidebarWork[] = [
      {
        key: 'w1',
        number: 1,
        title,
        project: '~/dev/alpha',
        branch: null,
        state: null,
        done: true,
      },
    ];

    applyThemeConfig('mocha', 1);
    const before = sidebarFrame(26, 6, null, long, []).find((line) => line.includes('a'));
    applyThemeConfig('mocha', 0);
    const after = sidebarFrame(26, 6, null, long, []).find((line) => line.includes('a'));

    // На уровне 1 (без жёлоба) заголовок этой длины влезает целиком.
    expect(before?.includes(title)).toBe(true);
    expect(before?.includes(glyphs().ellipsis)).toBe(false);
    // На уровне 0 бюджет на знак меньше — то же название уже не влезает.
    expect(after?.includes(title)).toBe(false);
    expect(after?.includes(glyphs().ellipsis)).toBe(true);
  });

  it('в ASCII-наборе маркер — `>`', () => {
    applyGlyphsConfig(true);
    try {
      const lines = sidebarFrame();
      const work = lines.find((line) => line.includes('Alpha'));
      expect(work?.startsWith('>')).toBe(true);
      expect(work?.startsWith('›')).toBe(false);
    } finally {
      applyGlyphsConfig(false);
    }
  });

  it('заголовок блока — то же содержимое, что и на уровне 1: колонку не отбирали (кусок 6, «где жёлоба нет»)', () => {
    applyThemeConfig('mocha', 1);
    const atOne = sidebarFrame();
    applyThemeConfig('mocha', 0);
    const atZero = sidebarFrame();

    const headerWith = (lines: readonly string[], text: string): string | undefined =>
      lines.find((line) => line.includes(text));

    expect(headerWith(atZero, 'работы')).toBe(headerWith(atOne, 'работы'));
    expect(headerWith(atZero, 'сессии')).toBe(headerWith(atOne, 'сессии'));
  });
});

describe('на уровне 1 жёлоба нет вовсе (сквозной инвариант, кусок 6)', () => {
  it('ни одна строка кадра не начинается с маркера', () => {
    for (const line of sidebarFrame()) {
      expect(line.startsWith('›')).toBe(false);
      expect(line.startsWith('>')).toBe(false);
    }
  });
});

describe('попадание мышью не зависит от жёлоба (3.3)', () => {
  it('sidebarTargets отдаёт те же цели на уровне 0 и на уровне 1: цель считается по строке, не по колонке', () => {
    const props = sidebarProps();

    applyThemeConfig('mocha', 1);
    const atOne = sidebarTargets(props);
    applyThemeConfig('mocha', 0);
    const atZero = sidebarTargets(props);

    expect(atZero).toEqual(atOne);
  });
});

describe('жёлоб на уровне 0 — оверлей (дизайн 4.3, кусок 6)', () => {
  pinTheme(0);
  const INNER = 28;

  it('инвариант по диапазону ширин: строка — ровно width, текст — на знак меньше', () => {
    const g = glyphs();
    // Заведомо длиннее любой ширины из набора: усечение всегда режет текст,
    // добивки после него нет, и хвостовой пробел не обрежется при захвате
    // кадра (см. заметку в шапке файла).
    const filler = 'a'.repeat(80);

    for (const width of [1, 2, 5, 10, 18, 28, 40]) {
      // Маркер — не пробел, поэтому виден даже на ширине 1 (вся колонка под ним).
      const selected =
        render(<Line line={{ text: filler, selected: true }} width={width} g={g} />).lastFrame() ??
        '';
      expect(stringWidth(selected)).toBe(width);
      expect(selected.startsWith(g.cursor)).toBe(true);

      // Ширина 1 у невыбранной строки — это один пробел без ничего после него:
      // Ink обрезает его как хвостовой (на реальном терминале пустая строка
      // неотличима от строки с одним пробелом), поэтому здесь не проверяется.
      if (width < 2) continue;
      const plain = render(<Line line={{ text: filler }} width={width} g={g} />).lastFrame() ?? '';
      expect(stringWidth(plain)).toBe(width);
      expect(plain.startsWith('›')).toBe(false);
    }
  });

  it('в кадре нет ни одного ANSI-кода', () => {
    const g = glyphs();
    const frame =
      render(<Line line={{ text: ' строка', selected: true }} width={INNER} g={g} />).lastFrame() ??
      '';
    expect(hasAnsi(frame)).toBe(false);
  });

  it('линейка и подвал не получают колонку — их ширина не уменьшается (кусок 6, «где жёлоба нет»)', () => {
    const g = glyphs();
    const rule: OverlayLine = { rule: true, text: '' };
    const footer: OverlayLine = { text: 'a'.repeat(80), dim: true };

    const ruleFrame = render(<Line line={rule} width={INNER} g={g} />).lastFrame() ?? '';
    const footerFrame =
      render(<Line line={footer} width={INNER} g={g} gutter={false} />).lastFrame() ?? '';

    expect(ruleFrame.startsWith('›')).toBe(false);
    expect(footerFrame.startsWith('›')).toBe(false);
    expect(stringWidth(ruleFrame)).toBe(INNER);
    expect(stringWidth(footerFrame)).toBe(INNER);
  });
});

/**
 * Узкая колонка: жёлоб берёт свой знак у текста, а не у рамки, и правая грань
 * блока остаётся на месте. Ширины ниже двенадцати сюда не входят намеренно:
 * там жёлоб спорит с правилом «ярлык не короче четырёх знаков» (дизайн TUI
 * v2, §7 и чек-лист 23), и оба правила одновременно не держатся — записано в
 * `TODOS.md`. Документированный минимум сайдбара — 18 (макет 1.2).
 */
describe('жёлоб на узком сайдбаре не съедает грань', () => {
  pinTheme(0);

  const long: SidebarWork[] = [
    { ...works[0]!, title: 'очень длинный заголовок работы', project: '~/dev/очень/длинный/путь' },
  ];

  for (const width of [12, 14, 18, 26]) {
    it(`ширина ${width}: правая грань цела, её не подменяет усечение`, () => {
      const frame =
        render(<Sidebar {...sidebarProps(width, 16, null, long, [])} framed />).lastFrame() ?? '';

      for (const line of frame.split('\n')) {
        if (line === '') continue;
        // Ink сам режет строку по ширине контейнера, поэтому кадр никогда не
        // бывает шире рамки: переполнение видно не шириной, а пропавшей
        // гранью — на её месте оказывается знак усечения.
        const edges = glyphs().frame;
        const last = [...line].at(-1);
        expect([edges.vertical, edges.topRight, edges.bottomRight]).toContain(last);
        expect(stringWidth(line)).toBeLessThanOrEqual(width);
      }
    });
  }
});
