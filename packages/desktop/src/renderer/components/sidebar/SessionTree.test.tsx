/**
 * Тест 1 куска 3.6 плана окна: комната стоит под сессией-создателем, комната
 * человека — под работой.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Room, WorkSession } from '@harnas/core';
import { SessionTree } from './SessionTree.js';

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

function room(id: string, title: string, creator: string): Room {
  return { id, title, creator, members: [], createdAt: '2026-01-01T00:00:00.000Z' };
}

function noop(): void {}

describe('SessionTree — тест 1', () => {
  it('комната сессии стоит сразу под её строкой, комната человека — под работой', () => {
    render(
      <SessionTree
        projectPath="/tmp/w-01"
        workId="w-01"
        sessions={[session('s-01', 'план'), session('s-02', 'бэкенд')]}
        rooms={[room('r-01', 'Обсуждение задачи', 's-01'), room('r-02', 'Общая', 'human')]}
        selectedSessionId={null}
        activityByRef={{}}
        hasMail={false}
        onSelect={noop}
        onOpen={noop}
        onResume={noop}
        onStop={noop}
        onClose={noop}
        onDelete={noop}
        onCreateRoom={noop}
        onOpenMail={noop}
        onOpenRoom={noop}
        onOpenChanges={noop}
      />,
    );

    const rows = screen.getAllByRole('button').map((el) => el.textContent);
    // Комната человека — первой строкой, до дерева сессий.
    expect(rows[0]).toBe('Общая');
    // Комната S01 идёт сразу за строкой S01, до строки S02.
    const s01Index = rows.findIndex((text) => text?.includes('план'));
    const roomIndex = rows.findIndex((text) => text === 'Обсуждение задачи');
    const s02Index = rows.findIndex((text) => text?.includes('бэкенд'));
    expect(roomIndex).toBe(s01Index + 1);
    expect(roomIndex).toBeLessThan(s02Index);
  });

  it('у сессии без своих комнат ничего не добавляется', () => {
    render(
      <SessionTree
        projectPath="/tmp/w-01"
        workId="w-01"
        sessions={[session('s-01', 'план')]}
        rooms={[]}
        selectedSessionId={null}
        activityByRef={{}}
        hasMail={false}
        onSelect={noop}
        onOpen={noop}
        onResume={noop}
        onStop={noop}
        onClose={noop}
        onDelete={noop}
        onCreateRoom={noop}
        onOpenMail={noop}
        onOpenRoom={noop}
        onOpenChanges={noop}
      />,
    );

    expect(screen.queryByRole('button', { name: /Общая|Обсуждение/ })).toBeNull();
  });

  it('закрытая сессия — тусклая строка с пометкой «закрыта»', () => {
    const closedSession: WorkSession = { ...session('s-01', 'план'), lifecycle: 'closed' };
    render(
      <SessionTree
        projectPath="/tmp/w-01"
        workId="w-01"
        sessions={[closedSession]}
        rooms={[]}
        selectedSessionId={null}
        activityByRef={{}}
        hasMail={false}
        onSelect={noop}
        onOpen={noop}
        onResume={noop}
        onStop={noop}
        onClose={noop}
        onDelete={noop}
        onCreateRoom={noop}
        onOpenMail={noop}
        onOpenRoom={noop}
        onOpenChanges={noop}
      />,
    );

    expect(screen.getByText('закрыта')).toBeTruthy();
    const row = screen.getByText('S01 план').parentElement;
    expect(row?.className).toContain('opacity-60');
  });
});
