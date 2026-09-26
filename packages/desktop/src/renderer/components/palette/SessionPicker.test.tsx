import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { WorkEntry, WorkSession } from '@harnas/core';
import { panelId } from '../../lib/panel-id.js';
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
    status: 'active',
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
    schemaVersion: 1,
    work: { id: 'w-01', title: 'Работа', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    sessions: [session('s-01', 'план'), session('s-02', 'бэкенд'), session('s-03', 'фронт')],
    messages: [],
  },
};

describe('sessionCandidates', () => {
  it('не показывает сессии, у которых уже есть панель (тест 5)', () => {
    const openId = panelId({
      kind: 'terminal',
      ref: { projectPath: '/tmp/w-01', workId: 'w-01', sessionId: 's-02' },
      workKey: '/tmp/w-01 w-01',
    });

    const candidates = sessionCandidates(entry, new Set([openId]));

    expect(candidates.map((candidate) => candidate.ref.sessionId)).toEqual(['s-01', 's-03']);
  });

  it('без открытых панелей — все сессии работы', () => {
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
    expect(screen.getByText('У этой работы нет сессий без панели')).toBeTruthy();
  });
});
