import { addSession, createWork, readMap, transitionSession, updateMap } from '@harnas/core';
import type { WorkEntry } from '@harnas/core';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSessionLink } from './use-session-link.js';

let home = '';
let project = '';
let logs = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
  // Корень истории Codex — временный каталог: настоящий ~/.codex не читаем.
  logs = await mkdtemp(path.join(tmpdir(), 'harnas-logs-'));
  process.env['HARNAS_HOME'] = home;
});

afterEach(async () => {
  delete process.env['HARNAS_HOME'];
  await Promise.all([home, project, logs].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Rollout-лог Codex того же вида, что читает адаптер core. */
async function writeRollout(id: string, cwd: string, at: string): Promise<void> {
  const dir = path.join(logs, '2026', '09', '02');
  await mkdir(dir, { recursive: true });
  const lines = [
    { timestamp: at, type: 'session_meta', payload: { id, timestamp: at, cwd } },
    { timestamp: at, type: 'turn_context', payload: { type: 'turn_context', cwd } },
  ]
    .map((record) => `${JSON.stringify(record)}\n`)
    .join('');
  await writeFile(path.join(dir, `rollout-2026-09-02T10-00-00-${id}.jsonl`), lines);
}

function Probe({ works }: { works: WorkEntry[] }): ReactNode {
  useSessionLink({ works, sessions: [], roots: { codexRoot: logs } });
  return <Text>проба</Text>;
}

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> => {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('useSessionLink', () => {
  /** Живая сессия провайдера, который id снаружи не принимает. */
  const live = async (provider: string): Promise<{ workId: string; entry: WorkEntry }> => {
    const created = await createWork(project, { title: 'Авторизация' });
    const map = await updateMap(project, created.work.id, (current) => {
      const session = addSession(current, { provider, label: 'бэкенд', task: 'шаги 1–3' });
      transitionSession(current, session.id, 'active');
    });
    return { workId: created.work.id, entry: { projectPath: project, map } };
  };

  it('живая codex-сессия привязывается к своему rollout-логу', async () => {
    const { workId, entry } = await live('codex');
    const startedAt = entry.map.sessions[0]?.startedAt as string;
    await writeRollout('чужая', '/другой/проект', startedAt);
    await writeRollout('наша', project, new Date(Date.parse(startedAt) + 1000).toISOString());

    const app = render(<Probe works={[entry]} />);
    try {
      await waitFor(
        async () => (await readMap(project, workId)).sessions[0]?.providerSessionId === 'наша',
      );
    } finally {
      app.unmount();
    }
  }, 20_000);

  it('claude по времени не привязывается: его id известен заранее', async () => {
    const { workId, entry } = await live('claude');
    const startedAt = entry.map.sessions[0]?.startedAt as string;
    await writeRollout('наша', project, startedAt);

    const app = render(<Probe works={[entry]} />);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await readMap(project, workId)).sessions[0]?.providerSessionId).toBeNull();
    } finally {
      app.unmount();
    }
  }, 20_000);
});
