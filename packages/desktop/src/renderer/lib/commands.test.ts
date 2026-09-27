import { describe, expect, it } from 'vitest';
import type { WorkEntry, WorkSession } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import { buildCommands, recentSessionsFromHistory, type CommandActions } from './commands.js';

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
    openWork: () => {},
    openSession: () => {},
    openMail: () => {},
    openRoom: () => {},
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
      wakePaused: true,
      recentSessionRefs: [],
      actions: noopActions(),
    }).find((command) => command.id === 'action:toggle-wake');
    const running = buildCommands({
      works: [],
      wakePaused: false,
      recentSessionRefs: [],
      actions: noopActions(),
    }).find((command) => command.id === 'action:toggle-wake');

    expect(paused?.title).toBe('Resume auto-wake');
    expect(running?.title).toBe('Pause auto-wake');
  });

  // Кусок 2.7: работа открывается своей раскладкой — команда работы делает её
  // активной, а не открывает «последнюю сессию» (`lastSessionByWork` ушёл).
  it('работа без сессий: команда работы делает работу активной, сессий не открывает', () => {
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
    let openedWork: string | null = null;
    const commands = buildCommands({
      works: [emptyWork],
      wakePaused: null,
      recentSessionRefs: [],
      actions: { ...noopActions(), openSession: () => (opened = true), openWork: (key) => (openedWork = key) },
    });

    const workCommand = commands.find((command) => command.id === 'work:/tmp/w-02 w-02');
    expect(workCommand).toBeDefined();
    void workCommand?.run();
    expect(opened).toBe(false);
    expect(openedWork).toBe('/tmp/w-02 w-02');
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
      wakePaused: null,
      recentSessionRefs: [],
      actions: { ...noopActions(), openMail: (key) => (openedMailFor = key) },
    });

    expect(commands[1]?.id).toBe('mail:/tmp/w-01 w-01');
    void commands[1]?.run();
    expect(openedMailFor).toBe('/tmp/w-01 w-01');

    const withoutMail = buildCommands({
      works: [work],
      wakePaused: null,
      recentSessionRefs: [],
      actions: noopActions(),
    });
    expect(withoutMail.some((command) => command.id.startsWith('mail:'))).toBe(false);
  });

  it('комнаты работы — команды сразу за «вся почта работы» (кусок 3.6)', () => {
    const withRoom: WorkEntry = {
      ...work,
      map: { ...work.map, rooms: [{ id: 'r-01', title: 'Обсуждение', creator: 's-01', members: ['s-02'], createdAt: '2026-01-01' }] },
    };
    let opened: { workKey: string; roomId: string } | null = null;
    const commands = buildCommands({
      works: [withRoom],
      wakePaused: null,
      recentSessionRefs: [],
      actions: { ...noopActions(), openRoom: (key, roomId) => (opened = { workKey: key, roomId }) },
    });

    expect(commands[1]?.id).toBe('room:/tmp/w-01 w-01:r-01');
    void commands[1]?.run();
    expect(opened).toEqual({ workKey: '/tmp/w-01 w-01', roomId: 'r-01' });
  });
});

describe('recentSessionsFromHistory (кусок 2.7)', () => {
  it('вкладки-терминалы истории, свежие первыми, без повторов; прочие вкладки и чужие работы пропускаются', () => {
    const key = '/tmp/w-01 w-01';
    const refs = recentSessionsFromHistory(
      [
        { workKey: key, tabId: 'terminal:s-01', at: 1 },
        { workKey: key, tabId: null, at: 2 },
        { workKey: key, tabId: 'terminal:s-03', at: 3 },
        { workKey: key, tabId: 'mail', at: 4 },
        { workKey: '/tmp/gone gone', tabId: 'terminal:s-09', at: 5 },
        { workKey: key, tabId: 'terminal:s-01', at: 6 },
      ],
      [work],
    );

    expect(refs).toEqual([refA, refC]);
  });

  it('не больше 20', () => {
    const many: WorkEntry = {
      ...work,
      map: { ...work.map, sessions: Array.from({ length: 30 }, (_, i) => session(`s-${i}`, `x${i}`)) },
    };
    const entries = Array.from({ length: 30 }, (_, i) => ({ workKey: '/tmp/w-01 w-01', tabId: `terminal:s-${i}`, at: i }));
    const refs = recentSessionsFromHistory(entries, [many]);
    expect(refs).toHaveLength(20);
    expect(refs[0]?.sessionId).toBe('s-29');
  });
});
