import {
  addSession,
  createWork,
  readMap,
  transitionSession,
  updateMap,
  type WorkEntry,
} from '@harnas/core';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useLifecycle } from './use-lifecycle.js';
import type { LiveMetrics } from './work-rows.js';

let home = '';
let project = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
  process.env['HARNAS_HOME'] = home;
});

afterEach(async () => {
  delete process.env['HARNAS_HOME'];
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

const metrics = (lastRecordAt: string | null): LiveMetrics => ({
  durationMs: null,
  tokens: null,
  model: null,
  lastRecordAt,
});

function Probe({
  works,
  last,
  alive = true,
}: {
  works: WorkEntry[];
  last: string | null;
  /** Живой процесс сессии у харнесса: без него active в idle не уходит. */
  alive?: boolean;
}): ReactNode {
  useLifecycle({ works, live: () => metrics(last), alive: () => alive });
  return <Text>проба</Text>;
}

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> => {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('useLifecycle', () => {
  /** Работа с одной активной сессией: её и двигает метрика простоя. */
  const active = async (): Promise<{ workId: string; entry: WorkEntry }> => {
    const created = await createWork(project, { title: 'Авторизация' });
    const map = await updateMap(project, created.work.id, (current) => {
      const session = addSession(current, {
        provider: 'claude',
        label: 'бэкенд',
        task: 'шаги 1–3',
      });
      transitionSession(current, session.id, 'active');
    });
    return { workId: created.work.id, entry: { projectPath: project, map } };
  };

  it('молчащая дольше порога сессия уезжает в idle прямо в карте', async () => {
    const { workId, entry } = await active();
    const silent = new Date(Date.now() - 30 * 60_000).toISOString();

    const app = render(<Probe works={[entry]} last={silent} />);
    try {
      await waitFor(async () => (await readMap(project, workId)).sessions[0]?.status === 'idle');
      const session = (await readMap(project, workId)).sessions[0];
      expect(session?.history.at(-1)?.status).toBe('idle');
    } finally {
      app.unmount();
    }
  }, 20_000);

  it('свежая запись в логе возвращает сессию в active', async () => {
    const { workId } = await active();
    await updateMap(project, workId, (map) => {
      transitionSession(map, 's-01', 'idle');
    });
    const entry: WorkEntry = { projectPath: project, map: await readMap(project, workId) };

    const app = render(<Probe works={[entry]} last={new Date().toISOString()} />);
    try {
      await waitFor(async () => (await readMap(project, workId)).sessions[0]?.status === 'active');
    } finally {
      app.unmount();
    }
  }, 20_000);

  it('сессия без своего PTY в idle не уезжает: процесс проверить нечем', async () => {
    const { workId, entry } = await active();
    const silent = new Date(Date.now() - 30 * 60_000).toISOString();

    const app = render(<Probe works={[entry]} last={silent} alive={false} />);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await readMap(project, workId)).sessions[0]?.status).toBe('active');
    } finally {
      app.unmount();
    }
  }, 20_000);

  it('без молчания карта не переписывается вовсе', async () => {
    const { workId, entry } = await active();
    const before = await readMap(project, workId);

    const app = render(<Probe works={[entry]} last={new Date().toISOString()} />);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await readMap(project, workId)).toEqual(before);
    } finally {
      app.unmount();
    }
  }, 20_000);
});
