/**
 * Автозапуск `pending` сессий, порождённых агентом: настройка `autoLaunch`
 * (дизайн TUI v2, 5.2). Настоящий процесс здесь не нужен: хук лишь решает,
 * кого запускать, а сам запуск — колбэк.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type WorkEntry, type WorkSession, workPaths, writeHostLease } from '@harnas/core';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
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

const entry = (sessions: WorkSession[], projectPath = '/dev/shop'): WorkEntry => ({
  projectPath,
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

/**
 * Проверка аренды (`hostLeaseActive`) читает файл с диска и поэтому асинхронна:
 * решение о запуске в хуке принимается уже после `rerender`, а не в тот же тик.
 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

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

let projects: string[] = [];

afterEach(async () => {
  await Promise.all(projects.map((dir) => rm(dir, { recursive: true, force: true })));
  projects = [];
});

describe('useAutoLaunch', () => {
  it('pending от агента, появившаяся после первого чтения, запускается один раз', async () => {
    const launched: string[] = [];
    const app = render(<Probe works={[entry([session()])]} launched={launched} />);
    try {
      app.rerender(<Probe works={[entry([session(), spawned()])]} launched={launched} />);
      await flush();
      // Повторное чтение той же карты (бриф дописан, watcher сработал ещё раз).
      app.rerender(<Probe works={[entry([session(), spawned()])]} launched={launched} />);
      await flush();
      expect(launched).toEqual(['s-02']);
    } finally {
      app.unmount();
    }
  });

  it('pending из первого чтения не трогает: старые записи ждут человека', async () => {
    const launched: string[] = [];
    const app = render(
      <Probe works={[entry([session(), spawned()])]} loading={true} launched={launched} />,
    );
    try {
      app.rerender(<Probe works={[entry([session(), spawned()])]} launched={launched} />);
      await flush();
      app.rerender(<Probe works={[entry([session(), spawned()])]} launched={launched} />);
      await flush();
      expect(launched).toEqual([]);
    } finally {
      app.unmount();
    }
  });

  it('pending без родителя не запускает: её завёл человек и запустит сам', async () => {
    const launched: string[] = [];
    const app = render(<Probe works={[entry([session()])]} launched={launched} />);
    try {
      app.rerender(
        <Probe
          works={[entry([session(), session({ id: 's-02', status: 'pending' })])]}
          launched={launched}
        />,
      );
      await flush();
      expect(launched).toEqual([]);
    } finally {
      app.unmount();
    }
  });

  it('с выключенной настройкой не запускает никого', async () => {
    const launched: string[] = [];
    const app = render(<Probe works={[entry([session()])]} enabled={false} launched={launched} />);
    try {
      app.rerender(
        <Probe works={[entry([session(), spawned()])]} enabled={false} launched={launched} />,
      );
      await flush();
      expect(launched).toEqual([]);
    } finally {
      app.unmount();
    }
  });

  it('аренда с живым pid — autoLaunch не зовёт launch; с мёртвым pid — зовёт', async () => {
    const leased = await mkdtemp(path.join(tmpdir(), 'harnas-tui-lease-live-'));
    const free = await mkdtemp(path.join(tmpdir(), 'harnas-tui-lease-dead-'));
    projects.push(leased, free);

    await mkdir(workPaths(leased, 'w-0001').dir, { recursive: true });
    await writeHostLease(leased, 'w-0001', {
      pid: process.pid,
      startedAtProcess: null,
      since: new Date().toISOString(),
    });
    await mkdir(workPaths(free, 'w-0001').dir, { recursive: true });
    await writeHostLease(free, 'w-0001', {
      pid: 999_999,
      startedAtProcess: null,
      since: new Date().toISOString(),
    });

    const launched: string[] = [];
    const app = render(
      <Probe
        works={[entry([session()], leased), entry([session()], free)]}
        launched={launched}
      />,
    );
    try {
      app.rerender(
        <Probe
          works={[entry([session(), spawned('s-leased')], leased), entry([session(), spawned('s-free')], free)]}
          launched={launched}
        />,
      );
      await flush();
      expect(launched).toEqual(['s-free']);
    } finally {
      app.unmount();
    }
  });
});
