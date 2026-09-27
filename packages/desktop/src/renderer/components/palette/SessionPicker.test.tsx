import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { WorkEntry, WorkSession } from '@harnas/core';
import { SessionPicker, sessionCandidates } from './SessionPicker.js';

afterEach(cleanup);

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

const entry: WorkEntry = {
  projectPath: '/tmp/w-01',
  map: {
    schemaVersion: 2,
    rooms: [],
    work: { id: 'w-01', title: 'Работа', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    sessions: [session('s-01', 'план'), session('s-02', 'бэкенд'), session('s-03', 'фронт')],
    messages: [],
  },
};

describe('sessionCandidates (кусок 2.3, тест 12)', () => {
  it('не показывает сессии из openSessionIds — набор строится из id сессий, id панелей в нём нет', () => {
    const candidates = sessionCandidates(entry, new Set(['s-02']));

    expect(candidates.map((candidate) => candidate.ref.sessionId)).toEqual(['s-01', 's-03']);
  });

  it('пустой набор — все сессии работы', () => {
    const candidates = sessionCandidates(entry, new Set());
    expect(candidates.map((candidate) => candidate.ref.sessionId)).toEqual(['s-01', 's-02', 's-03']);
  });
});

describe('SessionPicker', () => {
  it('рендерит только переданных кандидатов и зовёт onSelect по клику', () => {
    const candidates = sessionCandidates(entry, new Set());
    const selected: string[] = [];

    render(
      <SessionPicker
        open
        candidates={candidates}
        onSelect={(ref) => selected.push(ref.sessionId)}
        onOpenChange={() => {}}
      />,
    );

    expect(screen.getByText('S01 план')).toBeTruthy();
    screen.getByText('S02 бэкенд').click();
    expect(selected).toEqual(['s-02']);
  });

  it('пустой список кандидатов — заметно, что открывать нечего', () => {
    render(<SessionPicker open candidates={[]} onSelect={() => {}} onOpenChange={() => {}} />);
    expect(screen.getByText('Every session here already has a panel')).toBeTruthy();
  });
});
