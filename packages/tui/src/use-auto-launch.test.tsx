/**
 * Автозапуск `pending` сессий, порождённых агентом: настройка `autoLaunch`
 * (дизайн TUI v2, 5.2). Настоящий процесс здесь не нужен: хук лишь решает,
 * кого запускать, а сам запуск — колбэк.
 */

import type { WorkEntry, WorkSession } from '@harnas/core';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useAutoLaunch } from './use-auto-launch.js';

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 's-01',
    provider: 'claude',
    label: 'план',
    task: 'составить план',
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

const entry = (sessions: WorkSession[]): WorkEntry => ({
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
    sessions,
    messages: [],
  },
});

/** pending от агента: у неё есть родитель. */
const spawned = (id = 's-02'): WorkSession =>
  session({ id, label: 'ревью', parent: 's-01', status: 'pending' });

function Probe({
  works,
  loading = false,
  enabled = true,
  launched,
}: {
  works: readonly WorkEntry[];
  loading?: boolean;
  enabled?: boolean;
  launched: string[];
}): ReactNode {
  useAutoLaunch({
    works,
    loading,
    enabled,
    launch: (_project, _workId, target) => launched.push(target.id),
  });
  return <Text>автозапуск</Text>;
}

describe('useAutoLaunch', () => {
  it('pending от агента, появившаяся после первого чтения, запускается один раз', () => {
    const launched: string[] = [];
    const app = render(<Probe works={[entry([session()])]} launched={launched} />);
    try {
      app.rerender(<Probe works={[entry([session(), spawned()])]} launched={launched} />);
      // Повторное чтение той же карты (бриф дописан, watcher сработал ещё раз).
      app.rerender(<Probe works={[entry([session(), spawned()])]} launched={launched} />);
      expect(launched).toEqual(['s-02']);
    } finally {
      app.unmount();
    }
  });

  it('pending из первого чтения не трогает: старые записи ждут человека', () => {
    const launched: string[] = [];
    const app = render(
      <Probe works={[entry([session(), spawned()])]} loading={true} launched={launched} />,
    );
    try {
      app.rerender(<Probe works={[entry([session(), spawned()])]} launched={launched} />);
      app.rerender(<Probe works={[entry([session(), spawned()])]} launched={launched} />);
      expect(launched).toEqual([]);
    } finally {
      app.unmount();
    }
  });

  it('pending без родителя не запускает: её завёл человек и запустит сам', () => {
    const launched: string[] = [];
    const app = render(<Probe works={[entry([session()])]} launched={launched} />);
    try {
      app.rerender(
        <Probe
          works={[entry([session(), session({ id: 's-02', status: 'pending' })])]}
          launched={launched}
        />,
      );
      expect(launched).toEqual([]);
    } finally {
      app.unmount();
    }
  });

  it('с выключенной настройкой не запускает никого', () => {
    const launched: string[] = [];
    const app = render(<Probe works={[entry([session()])]} enabled={false} launched={launched} />);
    try {
      app.rerender(
        <Probe works={[entry([session(), spawned()])]} enabled={false} launched={launched} />,
      );
      expect(launched).toEqual([]);
    } finally {
      app.unmount();
    }
  });
});
