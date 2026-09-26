import { describe, expect, it } from 'vitest';
import type { WorkEntry, WorkSession } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import { buildCommands, type CommandActions } from './commands.js';

function session(id: string, label: string): WorkSession {
  return {
    id,
    provider: 'claude',
    label,
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
    launchedBy: 'host',
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: null,
  };
}

const work: WorkEntry = {
  projectPath: '/tmp/w-01',
  map: {
    schemaVersion: 2,
    rooms: [],
    work: { id: 'w-01', title: 'Платежи', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    sessions: [session('s-01', 'план'), session('s-02', 'бэкенд'), session('s-03', 'фронт')],
    messages: [],
  },
};

const refA: SessionRef = { projectPath: '/tmp/w-01', workId: 'w-01', sessionId: 's-01' };
const refC: SessionRef = { projectPath: '/tmp/w-01', workId: 'w-01', sessionId: 's-03' };

function noopActions(): CommandActions {
  return {
    openSession: () => {},
    openMail: () => {},
    closeActivePanel: () => {},
    newSession: () => {},
    newWork: () => {},
    settings: () => {},
    toggleWake: () => {},
  };
}

describe('buildCommands — порядок (тест 3)', () => {
  it('при пустом запросе недавние сессии идут первыми, без дублей дальше по списку', () => {
    const commands = buildCommands({
      works: [work],
      lastSessionByWork: {},
      wakePaused: null,
      recentSessionRefs: [refC, refA],
      actions: noopActions(),
    });

    const ids = commands.map((command) => command.id);
    expect(ids.slice(0, 2)).toEqual(['session:/tmp/w-01 w-01:s-03', 'session:/tmp/w-01 w-01:s-01']);
    expect(ids.filter((id) => id === 'session:/tmp/w-01 w-01:s-03')).toHaveLength(1);
  });

  it('без недавних сессий — работа, потом её сессии по дереву, действия в конце', () => {
    const commands = buildCommands({
      works: [work],
      lastSessionByWork: {},
      wakePaused: false,
      recentSessionRefs: [],
      actions: noopActions(),
    });

    expect(commands[0]?.id).toBe('work:/tmp/w-01 w-01');
    expect(commands.slice(1, 4).map((command) => command.id)).toEqual([
      'session:/tmp/w-01 w-01:s-01',
      'session:/tmp/w-01 w-01:s-02',
      'session:/tmp/w-01 w-01:s-03',
    ]);
    expect(commands.at(-1)?.id).toBe('action:close-panel');
  });

  it('заголовок «пауза будильника» переключается по wakePaused', () => {
    const paused = buildCommands({
      works: [],
      lastSessionByWork: {},
      wakePaused: true,
      recentSessionRefs: [],
      actions: noopActions(),
    }).find((command) => command.id === 'action:toggle-wake');
    const running = buildCommands({
      works: [],
      lastSessionByWork: {},
      wakePaused: false,
      recentSessionRefs: [],
      actions: noopActions(),
    }).find((command) => command.id === 'action:toggle-wake');

    expect(paused?.title).toBe('Снять паузу будильника');
    expect(running?.title).toBe('Пауза будильника');
  });

  it('работа без сессий: команда работы существует, но запуск ничего не открывает', () => {
    const emptyWork: WorkEntry = {
      projectPath: '/tmp/w-02',
      map: {
        schemaVersion: 2,
        rooms: [],
        work: { id: 'w-02', title: 'Пусто', goal: '', status: 'active', createdAt: '2026-01-02', updatedAt: '2026-01-02' },
        sessions: [],
        messages: [],
      },
    };
    let opened = false;
    const commands = buildCommands({
      works: [emptyWork],
      lastSessionByWork: {},
      wakePaused: null,
      recentSessionRefs: [],
      actions: { ...noopActions(), openSession: () => (opened = true) },
    });

    const workCommand = commands.find((command) => command.id === 'work:/tmp/w-02 w-02');
    expect(workCommand).toBeDefined();
    void workCommand?.run();
    expect(opened).toBe(false);
  });

  it('«Вся почта работы» — только если в работе есть письма, сразу за командой работы', () => {
    const withMail: WorkEntry = {
      ...work,
      map: {
        ...work.map,
        messages: [{ id: 'm-1', roomId: null, from: 's-01', to: ['s-02'], at: '2026-01-01T10:00:00.000Z', text: 'т', kind: 'note', readBy: {} }],
      },
    };
    let openedMailFor: string | null = null;
    const commands = buildCommands({
      works: [withMail],
      lastSessionByWork: {},
      wakePaused: null,
      recentSessionRefs: [],
      actions: { ...noopActions(), openMail: (key) => (openedMailFor = key) },
    });

    expect(commands[1]?.id).toBe('mail:/tmp/w-01 w-01');
    void commands[1]?.run();
    expect(openedMailFor).toBe('/tmp/w-01 w-01');

    const withoutMail = buildCommands({
      works: [work],
      lastSessionByWork: {},
      wakePaused: null,
      recentSessionRefs: [],
      actions: noopActions(),
    });
    expect(withoutMail.some((command) => command.id.startsWith('mail:'))).toBe(false);
  });
});
