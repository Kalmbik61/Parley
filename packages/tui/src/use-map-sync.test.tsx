/**
 * Синхронизация карты с журналом хуков: `SessionEnd` переводит сессию в `exited`
 * (дизайн TUI v2, 4.2 и таблица «SessionEnd → жизненный цикл exited»).
 *
 * Настоящий агент здесь не нужен: состояние приходит готовым от `activityOf`,
 * а карта живёт во временном проекте.
 */

import {
  addSession,
  createWork,
  readMap,
  transitionSession,
  updateMap,
  type SessionActivity,
  type WorkEntry,
} from '@harnas/core';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useMapSync } from './use-map-sync.js';

let home = '';
let project = '';
let logs = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
  logs = await mkdtemp(path.join(tmpdir(), 'harnas-logs-'));
  process.env['HARNAS_HOME'] = home;
});

afterEach(async () => {
  delete process.env['HARNAS_HOME'];
  await Promise.all([home, project, logs].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Состояние сессии, каким его отдаёт свёртка журнала (`activityOf`). */
const activity = (over: Partial<SessionActivity> = {}): SessionActivity => ({
  activity: 'idle',
  subagents: 0,
  turnEndedAt: null,
  lastEventAt: null,
  source: 'hooks',
  exited: false,
  hooksMissing: false,
  ...over,
});

function Probe({
  works,
  state,
  held = () => false,
}: {
  works: readonly WorkEntry[];
  state: SessionActivity | null;
  held?: (key: string) => boolean;
}): ReactNode {
  useMapSync({
    works,
    roots: { claudeRoot: logs, codexRoot: logs },
    index: () => undefined,
    activityOf: () => state,
    attached: null,
    held,
    push: () => {},
    fail: () => {},
  });
  return <Text>карта</Text>;
}

/** Работа с одной живой сессией: её и завершает `SessionEnd`. */
async function liveWork(): Promise<{ entry: WorkEntry; sessionId: string }> {
  const { work } = await createWork(project, { title: 'работа' });
  let sessionId = '';
  const map = await updateMap(project, work.id, (current) => {
    const session = addSession(current, { provider: 'claude', label: 'план', task: '' });
    sessionId = session.id;
    transitionSession(current, session.id, 'active');
  });
  return { entry: { projectPath: project, map }, sessionId };
}

const waitSession = async (
  workId: string,
  check: (status: string) => boolean,
  timeoutMs = 5000,
): Promise<void> => {
  const started = Date.now();
  for (;;) {
    const status = (await readMap(project, workId)).sessions[0]?.status ?? '';
    if (check(status)) return;
    if (Date.now() - started > timeoutMs) throw new Error(`карта не дождалась: ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('useMapSync', () => {
  it('SessionEnd без отчёта переводит сессию в exited с exitCode: null', async () => {
    const { entry } = await liveWork();

    const app = render(<Probe works={[entry]} state={activity({ exited: true })} />);
    try {
      await waitSession(entry.map.work.id, (status) => status === 'exited');
      const session = (await readMap(project, entry.map.work.id)).sessions[0];
      // Процесс завершился без харнесса: кода выхода у нас нет (чек-лист 15).
      expect(session?.history.at(-1)).toEqual({
        status: 'exited',
        at: expect.any(String),
        exitCode: null,
      });
    } finally {
      app.unmount();
    }
  }, 20_000);

  it('SessionEnd у сессии, чей PTY держит харнесс, карту не трогает', async () => {
    // Хук Claude Code срабатывает до выхода процесса: настоящий код выхода
    // принесёт сам выход, а переход по журналу его бы затёр нулём.
    const { entry } = await liveWork();

    const app = render(
      <Probe works={[entry]} state={activity({ exited: true })} held={() => true} />,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await waitSession(entry.map.work.id, (status) => status === 'active');
    } finally {
      app.unmount();
    }
  }, 20_000);

  it('SessionEnd у сессии с отчётом статус не меняет (чек-лист 5)', async () => {
    const { entry, sessionId } = await liveWork();
    const reported = await updateMap(project, entry.map.work.id, (current) => {
      transitionSession(current, sessionId, 'done');
    });

    const app = render(
      <Probe
        works={[{ projectPath: project, map: reported }]}
        state={activity({ exited: true })}
      />,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await waitSession(entry.map.work.id, (status) => status === 'done');
    } finally {
      app.unmount();
    }
  }, 20_000);

  it('без SessionEnd сессия остаётся active', async () => {
    const { entry } = await liveWork();

    const app = render(<Probe works={[entry]} state={activity()} />);
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await waitSession(entry.map.work.id, (status) => status === 'active');
    } finally {
      app.unmount();
    }
  }, 20_000);
});
