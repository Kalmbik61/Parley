import { describe, expect, it, vi } from 'vitest';

// Цвета в тестах по умолчанию выключены (stdout не TTY), а проверяем мы именно
// фон выбранного ряда — включаем их до импорта Ink и chalk.
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '1';
});

import type { SessionIndex, WorkEntry, WorkSession } from '@harnas/core';
import { render } from 'ink-testing-library';
import { buildRows } from '../work-rows.js';
import { SessionList } from './session-list.js';
import { WorkList } from './work-list.js';

/** Фон bright black — `48;5;8` в 256-цветной палитре chalk, `100` в базовой. */
const highlighted = (line: string): boolean =>
  line.includes('\u001B[100m') || line.includes('\u001B[48;5;8m');

function session(over: Partial<SessionIndex> = {}): SessionIndex {
  return {
    id: 's1',
    project: '-proj',
    projectPath: '/work',
    cwd: '/work',
    gitBranch: 'main',
    version: '2.1.247',
    file: `/root/${over.id ?? 's1'}.jsonl`,
    title: 'заголовок',
    titleSource: 'custom',
    startedAt: '2026-09-01T10:00:00.000Z',
    endedAt: new Date().toISOString(),
    durationMs: 12 * 60_000,
    records: 10,
    malformedLines: 0,
    models: {},
    tools: {},
    roles: {},
    recordTypes: {},
    primaryModel: 'claude-opus-5',
    subsessionCount: 0,
    provider: 'claude',
    tokens: null,
    ...over,
  };
}

function workSession(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 's-01',
    provider: 'codex',
    label: 'бэкенд',
    task: 'шаги 1–3',
    parent: null,
    contextFrom: [],
    status: 'active',
    history: [],
    startedAt: null,
    endedAt: null,
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    ...over,
  };
}

const entry: WorkEntry = {
  projectPath: '/dev/shop',
  map: {
    schemaVersion: 1,
    work: {
      id: 'w-0001',
      title: 'Авторизация',
      goal: '',
      status: 'active',
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-02T10:00:00.000Z',
    },
    sessions: [workSession(), workSession({ id: 's-02', label: 'ревью' })],
    messages: [],
  },
};

const lineWith = (frame: string, text: string): string =>
  frame.split('\n').find((line) => line.includes(text)) ?? '';

describe('подсветка выбранного ряда', () => {
  it('в списке сессий фон стоит только на выбранной строке', () => {
    const frame =
      render(
        <SessionList
          sessions={[session({ id: 'a', title: 'первая' }), session({ id: 'b', title: 'вторая' })]}
          selected={1}
          height={10}
          width={60}
        />,
      ).lastFrame() ?? '';

    expect(highlighted(lineWith(frame, 'вторая'))).toBe(true);
    expect(highlighted(lineWith(frame, 'первая'))).toBe(false);
  });

  it('в списке работ фон покрывает обе строки ряда сессии', () => {
    const rows = buildRows([entry]);
    const frame =
      render(<WorkList rows={rows} selected={1} height={12} width={40} />).lastFrame() ?? '';
    const lines = frame.split('\n');
    const at = lines.findIndex((line) => line.includes('бэкенд'));

    expect(highlighted(lines[at] ?? '')).toBe(true);
    // Вторая строка ряда — провайдер и модель: она часть того же ряда.
    expect(highlighted(lines[at + 1] ?? '')).toBe(true);
    expect(highlighted(lineWith(frame, 'ревью'))).toBe(false);
  });

  it('строка работы подсвечивается тем же фоном', () => {
    const rows = buildRows([entry]);
    const frame =
      render(<WorkList rows={rows} selected={0} height={12} width={40} />).lastFrame() ?? '';
    expect(highlighted(lineWith(frame, 'Авторизация'))).toBe(true);
  });
});
