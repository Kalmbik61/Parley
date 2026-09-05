import { describe, expect, it, vi } from 'vitest';

// Цвета в тестах по умолчанию выключены (stdout не TTY), а проверяем мы именно
// фон выбранного ряда — включаем их до импорта Ink и chalk.
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '1';
});

import type { SessionIndex, Subsession, WorkEntry, WorkSession } from '@harnas/core';
import { render } from 'ink-testing-library';
import { pinUnicodeGlyphs } from '../../test/glyphs-env.js';
import { buildRows } from '../work-rows.js';
import { SessionList } from './session-list.js';
import { SubsessionList } from './subsession-list.js';
import { WorkList } from './work-list.js';

/** Фон bright black — `48;5;8` в 256-цветной палитре chalk, `100` в базовой. */
const highlighted = (line: string): boolean =>
  line.includes('\u001B[100m') || line.includes('\u001B[48;5;8m');

/** Запасной набор подсвечивает выбор reverse video (6.1). */
const inverted = (line: string): boolean => line.includes('\u001B[7m');

pinUnicodeGlyphs();

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
    lastUserRecordAt: null,
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

function subsession(over: Partial<Subsession> = {}): Subsession {
  return {
    agentId: 'a1',
    file: `/root/agent-${over.agentId ?? 'a1'}.jsonl`,
    workflowRunId: null,
    agentType: 'general-purpose',
    name: 'fix',
    task: 'починить парсер',
    taskSource: 'meta',
    toolUseId: 'toolu_1',
    models: ['claude-opus-5'],
    startedAt: '2026-09-01T10:00:00.000Z',
    endedAt: '2026-09-01T10:06:00.000Z',
    durationMs: 6 * 60_000,
    records: 12,
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

  it('в списке подсессий фон вместо стрелки — правило общее для всех списков', () => {
    const frame =
      render(
        <SubsessionList
          subsessions={[
            subsession({ agentId: 'a', task: 'первый' }),
            subsession({ agentId: 'b', task: 'второй' }),
          ]}
          selected={1}
          height={10}
          width={60}
        />,
      ).lastFrame() ?? '';

    expect(highlighted(lineWith(frame, 'второй'))).toBe(true);
    expect(highlighted(lineWith(frame, 'первый'))).toBe(false);
    // `▸` теперь значит «свёрнутая работа» — стрелки выбора в списках нет.
    expect(frame).not.toContain('▸');
  });

  it('в ASCII-наборе выбор — reverse video (6.1, 6.2)', () => {
    process.env.HARNAS_ASCII = '1';
    const rows = buildRows([entry]);
    const frame =
      render(<WorkList rows={rows} selected={0} height={12} width={40} />).lastFrame() ?? '';

    expect(inverted(lineWith(frame, 'Авторизация'))).toBe(true);
    expect(highlighted(lineWith(frame, 'Авторизация'))).toBe(false);
  });
});
