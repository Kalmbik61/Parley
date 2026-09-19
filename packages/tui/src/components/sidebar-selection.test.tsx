import { describe, expect, it, vi } from 'vitest';

// Цвета в тестах по умолчанию выключены (stdout не TTY), а проверяем мы именно
// фон выбранной строки и цвет разделителя — включаем их до импорта Ink и chalk.
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '1';
});

import type { WorkSession } from '@harnas/core';
import { render } from 'ink-testing-library';
import { pinUnicodeGlyphs } from '../../test/glyphs-env.js';
import { Sidebar, type SidebarSession, type SidebarTarget, type SidebarWork } from './sidebar.js';

pinUnicodeGlyphs();

/** Фон bright black — `48;5;8` в 256-цветной палитре chalk, `100` в базовой. */
const highlighted = (line: string): boolean =>
  line.includes('\u001B[100m') || line.includes('\u001B[48;5;8m');

const cyan = (line: string): boolean =>
  line.includes('\u001B[36m') || line.includes('\u001B[38;5;6m');

/**
 * Строка-грань блока (план рамок, задача 3): рисуется обычным dim-текстом безо
 * всякого цвета по `navigating` — это задача 5. У остальных строк разделитель
 * и его цвет не тронуты.
 */
const isFrame = (line: string): boolean => line.includes('╭') || line.includes('╰');

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
    expect(highlighted(lineWith(lines, ' new'))).toBe(true);
    // Курсор не отбирает подсветку у выбранной работы и её сессии.
    expect(highlighted(lineWith(lines, 'Авторизация'))).toBe(true);
    expect(highlighted(lineWith(lines, 'Платежи'))).toBe(false);
  });

  it('в режиме навигации разделитель становится cyan (макет 1.5)', () => {
    // Грани блоков цвет по navigating не несут (тоже задача 5) — исключаем
    // их из проверки, оставляя её в силе для всех обычных строк.
    expect(
      frameOf(true)
        .filter((line) => !isFrame(line))
        .every(cyan),
    ).toBe(true);
    expect(frameOf(false).some(cyan)).toBe(false);
  });
});
