/**
 * Тест 1 куска 3.6 плана окна: комната стоит под сессией-создателем, комната
 * человека — под работой.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Room, WorkSession } from '@harnas/core';
import { refKey, type SessionRef } from '@harnas/protocol';
import type { ActivityEntry } from '../../store/activity.js';
import { EMPTY_HISTORY } from '../../layout/history.js';
import { useLayoutStore } from '../../layout/store.js';
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

    expect(screen.getByText('Closed')).toBeTruthy();
    const row = screen.getByText('S01 план').parentElement;
    expect(row?.className).toContain('opacity-60');
  });

  it('blocked — слово состояния «ждёт тебя» (раунд исправлений 1, тест 5 брифа куска 1.3)', () => {
    const ref: SessionRef = { projectPath: '/tmp/w-01', workId: 'w-01', sessionId: 's-01' };
    const activityByRef: Record<string, ActivityEntry> = {
      [refKey(ref)]: {
        ref,
        activity: {
          activity: 'blocked',
          subagents: 0,
          turnEndedAt: null,
          lastEventAt: null,
          source: 'hooks',
          exited: false,
          hooksMissing: false,
        },
        metrics: null,
      },
    };

    render(
      <SessionTree
        projectPath="/tmp/w-01"
        workId="w-01"
        sessions={[session('s-01', 'план')]}
        rooms={[]}
        selectedSessionId={null}
        activityByRef={activityByRef}
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

    expect(screen.getByText('Needs you')).toBeTruthy();
  });
});

describe('SessionTree — перетаскивание (тест 6 куска 2.6)', () => {
  function renderTree(workId: string): void {
    render(
      <SessionTree
        projectPath={`/tmp/${workId}`}
        workId={workId}
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
  }

  afterEach(() => {
    useLayoutStore.setState({ activeWorkKey: null, layouts: {}, hydrated: {}, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
  });

  it('у строки сессии неактивной работы нет data-draggable и курсор not-allowed, у активной — есть; HTML5-перетаскивания нет', () => {
    useLayoutStore.setState({ activeWorkKey: '/tmp/w-02 w-02' });
    renderTree('w-01');
    const inactive = document.querySelector<HTMLElement>('[data-session-id="s-01"]');
    expect(inactive?.hasAttribute('data-draggable')).toBe(false);
    expect(inactive?.className).toContain('cursor-not-allowed');
    expect(inactive?.getAttribute('draggable')).toBeNull();
    cleanup();

    renderTree('w-02');
    const active = document.querySelector<HTMLElement>('[data-session-id="s-01"]');
    expect(active?.hasAttribute('data-draggable')).toBe(true);
    expect(active?.className).not.toContain('cursor-not-allowed');
    expect(active?.getAttribute('draggable')).toBeNull();
  });
});
