import { describe, expect, it } from 'vitest';
import type { WorkEntry, WorkSession } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import { noticeTitle, sessionLabelFor, sessionRowLabel } from './participant.js';

describe('sessionRowLabel', () => {
  // Раунд исправлений 1 куска 3.3: `NEW_LABEL` core ('новая сессия') окно показывает по-английски.
  it('метка новой сессии из core — английская, обычная — как есть', () => {
    expect(sessionRowLabel('s-01', 'новая сессия')).toBe('S01 New session');
    expect(sessionRowLabel('s-02', 'новая')).toBe('S02 новая');
  });

  it('s-03 → S03, склеивается с ярлыком', () => {
    expect(sessionRowLabel('s-03', 'бэкенд')).toBe('S03 бэкенд');
  });

  it('пустой ярлык — только тег', () => {
    expect(sessionRowLabel('s-01', '')).toBe('S01');
  });

  it('чужая форма id печатается как есть', () => {
    expect(sessionRowLabel('manual-123', 'ручная')).toBe('manual-123 ручная');
  });
});

describe('noticeTitle', () => {
  it('S03 ждёт ответа', () => {
    expect(noticeTitle('s-03', 'ждёт ответа')).toBe('S03 ждёт ответа');
  });
});

function session(id: string, label = ''): WorkSession {
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

function entry(projectPath: string, workId: string, sessions: WorkSession[]): WorkEntry {
  return {
    projectPath,
    map: {
      schemaVersion: 2,
      rooms: [],
      work: { id: workId, title: 'Work', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      sessions,
      messages: [],
    },
  };
}

// Раунд исправлений 1 куска E.1: ярлык для `noticeText` в строке статуса
// (`shell/AppShell.tsx`) и уведомлении trust-wait (`App.tsx`).
describe('sessionLabelFor', () => {
  const ref: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-03' };

  it('находит сессию по адресу и отдаёт S03 + ярлык', () => {
    const entries = [entry('/tmp/p', 'w-01', [session('s-03', 'backend')])];
    expect(sessionLabelFor(entries, ref)).toBe('S03 backend');
  });

  it('ref: null — undefined (уведомления о карте, не о сессии)', () => {
    expect(sessionLabelFor([entry('/tmp/p', 'w-01', [session('s-03')])], null)).toBeUndefined();
  });

  it('сессия пропала из снимка — undefined, а не сырой sessionId', () => {
    expect(sessionLabelFor([entry('/tmp/p', 'w-01', [])], ref)).toBeUndefined();
  });

  it('работа с таким адресом не найдена — undefined', () => {
    expect(sessionLabelFor([], ref)).toBeUndefined();
  });
});
