import { describe, expect, it, vi } from 'vitest';

// Цвета в тестах по умолчанию выключены (stdout не TTY), а проверяем мы именно
// фон выбранной строки и цвет разделителя — включаем их до импорта Ink и
// chalk. Уровень 3 (не 1): часть проверок теперь идёт при `pinTheme(3)` и
// смотрит на настоящий truecolor hex палитры, а не на его приближение —
// chalk решает про уровень один раз при загрузке модуля, и на весь файл он
// общий (дизайн темы TUI, 7.1). Именованным ANSI-цветам ('cyan',
// 'blackBright') уровень безразличен — код тот же на 1, 2 и 3, так что старые
// проверки (уровень темы 1) этим не задеты.
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '3';
});

import type { WorkSession } from '@harnas/core';
import { render } from 'ink-testing-library';
import { pinUnicodeGlyphs } from '../../test/glyphs-env.js';
import { pinTheme } from '../../test/theme-env.js';
import { PALETTES } from '../theme/palettes.js';
import { Sidebar, type SidebarSession, type SidebarTarget, type SidebarWork } from './sidebar.js';

pinUnicodeGlyphs();

/** Фон bright black — `48;5;8` в 256-цветной палитре chalk, `100` в базовой. */
const highlighted = (line: string): boolean =>
  line.includes('\u001B[100m') || line.includes('\u001B[48;5;8m');

const cyan = (line: string): boolean =>
  line.includes('\u001B[36m') || line.includes('\u001B[38;5;6m');

/** Фон cyan — акцент кнопки `new` под курсором, а не общий blackBright (план рамок, задача 4). */
const accent = (line: string): boolean =>
  line.includes('\u001B[46m') || line.includes('\u001B[48;5;6m');

/**
 * Обычных (без ANSI) символов сразу после первого сброса фона строки — до
 * следующего управляющего кода. У компактной плашки кнопки там ещё остаётся
 * добивка пробелами, у подсветки на всю ширину строки — уже ничего: фон
 * тянется до самого разделителя (план рамок, задача 4).
 */
const plainAfterBackground = (line: string): number => {
  const reset = '\u001B[49m';
  const at = line.indexOf(reset);
  if (at < 0) return -1;
  const rest = line.slice(at + reset.length);
  const next = rest.indexOf('\u001B');
  return next < 0 ? rest.length : next;
};

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 's-01',
    provider: 'claude',
    label: 'план',
    task: '',
    parent: null,
    contextFrom: [],
    lifecycle: 'active',
    result: null,
    resultAt: null,
    closedAt: null,
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
    ...over,
  };
}

const work = (over: Partial<SidebarWork> = {}): SidebarWork => ({
  key: 'w1',
  number: 1,
  title: 'Авторизация',
  project: '~/dev/shop',
  branch: 'main',
  state: 'idle',
  done: false,
  ...over,
});

const item = (over: Partial<SidebarSession> = {}): SidebarSession => ({
  session: session(),
  state: 'idle',
  live: { durationMs: 60_000, tokens: null, model: null, lastRecordAt: null },
  unread: 0,
  subagents: 0,
  ...over,
});

const frameOf = (navigating = false, cursor: SidebarTarget | null = null): string[] =>
  (
    render(
      <Sidebar
        works={[work(), work({ key: 'w2', number: 2, title: 'Платежи' })]}
        sessions={[item(), item({ session: session({ id: 's-02', label: 'ревью' }) })]}
        selectedWork="w1"
        selectedSession="s-01"
        width={26}
        height={12}
        navigating={navigating}
        cursor={cursor}
      />,
    ).lastFrame() ?? ''
  ).split('\n');

const lineWith = (lines: readonly string[], text: string): string =>
  lines.find((line) => line.includes(text)) ?? '';

describe('сайдбар: подсветка и режим навигации', () => {
  it('фон стоит на выбранной работе вместе со второй строкой', () => {
    const lines = frameOf();
    expect(highlighted(lineWith(lines, 'Авторизация'))).toBe(true);
    expect(highlighted(lineWith(lines, '~/dev/shop · main'))).toBe(true);
    expect(highlighted(lineWith(lines, 'Платежи'))).toBe(false);
  });

  it('фон стоит на выбранной сессии вместе с компактной строкой', () => {
    const lines = frameOf();
    expect(highlighted(lineWith(lines, 'план'))).toBe(true);
    expect(highlighted(lineWith(lines, '1м'))).toBe(true);
    expect(highlighted(lineWith(lines, 'ревью'))).toBe(false);
  });

  it('строка под курсором подсвечена наравне с выбранными (макет 1.5)', () => {
    const lines = frameOf(true, { kind: 'new', key: '' });
    // У кнопки свой акцент — cyan, а не общий blackBright (план рамок, задача 4).
    expect(accent(lineWith(lines, ' new'))).toBe(true);
    // Курсор не отбирает подсветку у выбранной работы и её сессии.
    expect(highlighted(lineWith(lines, 'Авторизация'))).toBe(true);
    expect(highlighted(lineWith(lines, 'Платежи'))).toBe(false);
  });

  // Компактная плашка кнопки: фон только вокруг текста, а не на всю ширину
  // строки, как у обычной подсветки выбранного ряда (план рамок, задача 4).
  it('фон кнопки под курсором не тянется на всю ширину строки', () => {
    const lines = frameOf(true, { kind: 'new', key: '' });
    const button = lineWith(lines, ' new');
    const selectedWork = lineWith(lines, 'Авторизация');

    // За плашкой кнопки остаётся некрашеная добивка пробелами до разделителя.
    expect(plainAfterBackground(button)).toBeGreaterThan(10);
    // У обычной подсветки фон доходит до разделителя без зазора.
    expect(plainAfterBackground(selectedWork)).toBe(0);
  });

  // Грани блоков красятся тем же приёмом, что и боковые грани обычных строк —
  // исключений для строк-граней больше нет (план рамок, задача 5).
  it('в режиме навигации разделитель становится cyan (макет 1.5)', () => {
    expect(frameOf(true).every(cyan)).toBe(true);
    expect(frameOf(false).some(cyan)).toBe(false);
  });
});

/**
 * Кусок 3, приёмка: те же два места — фон выбранного ряда и цвет рамки — на
 * уровне 3 отдают настоящий truecolor hex палитры (`bg.selection` = selection,
 * `border.active` = cyan), а не его приближение. Роли и на уровне 1, и на
 * уровне 3 остаются теми же двумя ролями — меняется только то, что палитра
 * отдаёт на этом уровне (дизайн темы TUI, 4.1).
 */
describe('сайдбар: то же самое на уровне 3 — hex вместо имён ANSI', () => {
  pinTheme(3);

  const hexBg = (hex: string): string => {
    const n = hex.replace('#', '');
    const r = parseInt(n.slice(0, 2), 16);
    const g = parseInt(n.slice(2, 4), 16);
    const b = parseInt(n.slice(4, 6), 16);
    return `[48;2;${r};${g};${b}m`;
  };
  const hexFg = (hex: string): string => {
    const n = hex.replace('#', '');
    const r = parseInt(n.slice(0, 2), 16);
    const g = parseInt(n.slice(2, 4), 16);
    const b = parseInt(n.slice(4, 6), 16);
    return `[38;2;${r};${g};${b}m`;
  };
  const selectedHex = (line: string): boolean => line.includes(hexBg(PALETTES.mocha.selection));
  const frameHex = (line: string): boolean => line.includes(hexFg(PALETTES.mocha.cyan));
  const secondHex = (line: string): boolean => line.includes(hexFg(PALETTES.mocha.subtext));
  const mutedHex = (line: string): boolean => line.includes(hexFg(PALETTES.mocha.muted));
  const bold = (line: string): boolean => line.includes('\u001B[1m');

  it('фон выбранного ряда — hex `selection` палитры, а не имя ANSI', () => {
    const lines = frameOf();
    expect(selectedHex(lineWith(lines, 'Авторизация'))).toBe(true);
    expect(selectedHex(lineWith(lines, 'Платежи'))).toBe(false);
  });

  // Серый `surface` отличался от фона сайдбара на 1.4:1 и глазом не читался:
  // выбор теперь носит оттенок акцента и жирный текст.
  it('фон выбранного ряда — не прежний серый `surface`', () => {
    expect(PALETTES.mocha.selection).not.toBe(PALETTES.mocha.surface);
    expect(lineWith(frameOf(), 'Авторизация')).not.toContain(hexBg(PALETTES.mocha.surface));
  });

  it('выбранные работа и сессия жирные, остальные ряды — нет', () => {
    const lines = frameOf();
    expect(bold(lineWith(lines, 'Авторизация'))).toBe(true);
    expect(bold(lineWith(lines, 'план'))).toBe(true);
    expect(bold(lineWith(lines, 'Платежи'))).toBe(false);
    expect(bold(lineWith(lines, 'ревью'))).toBe(false);
  });

  // На подсветке тусклый `fg.muted` теряется: мета выбранного ряда — вторичным.
  // `fg.muted` не должно остаться нигде на выбранном ряду — ни в слове
  // состояния, ни в точке рядом с ним, ни в компактной строке.
  it('на выбранном ряду нет `fg.muted`: мета, слово и точка — `fg.second`', () => {
    const lines = frameOf();
    for (const text of ['Авторизация', '~/dev/shop · main', 'план', '1м']) {
      expect(secondHex(lineWith(lines, text))).toBe(true);
      expect(mutedHex(lineWith(lines, text))).toBe(false);
    }
  });

  it('невыбранные ряды рисуют мету и точку `fg.muted`, как раньше', () => {
    const lines = frameOf();
    for (const text of ['Платежи', 'ревью']) {
      expect(mutedHex(lineWith(lines, text))).toBe(true);
      expect(secondHex(lineWith(lines, text))).toBe(false);
    }
  });

  it('в режиме навигации рамка — hex `cyan` палитры, а не имя ANSI', () => {
    expect(frameOf(true).every(frameHex)).toBe(true);
    expect(frameOf(false).some(frameHex)).toBe(false);
  });
});
