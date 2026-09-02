import { addSession, createWork, updateMap } from '@harnas/core';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StatusEventInit } from './use-status.js';
import { useWorks } from './use-works.js';

let home = '';
let project = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
  process.env.HARNAS_HOME = home;
});

afterEach(async () => {
  delete process.env.HARNAS_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

function Probe({
  projectPath,
  events,
}: {
  projectPath: string;
  events: StatusEventInit[];
}): ReactNode {
  const { works, loading } = useWorks({
    projectPath,
    onEvents: (incoming) => events.push(...incoming),
  });
  const labels = works.flatMap((entry) => entry.map.sessions.map((session) => session.label));
  return <Text>{loading ? 'читаю' : `${works.length}|${labels.join(',')}`}</Text>;
}

const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Ждём кадр, повторяя действие: fs.watch прогревается не мгновенно (см. core/watch.test.ts). */
async function expectFrame(
  frame: () => string | undefined,
  poke: () => Promise<void>,
  predicate: (text: string) => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    await poke();

    const deadline = Date.now() + 400;
    while (Date.now() < deadline) {
      if (predicate(frame() ?? '')) return;
      await settle(25);
    }
    if (Date.now() - started > timeoutMs) throw new Error(`не дождались: ${frame() ?? ''}`);
  }
}

describe('useWorks', () => {
  it('читает карты работ проекта', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    await updateMap(project, created.work.id, (map) => {
      addSession(map, { provider: 'codex', label: 'бэкенд', task: 'шаги 1–3' });
    });

    const { lastFrame } = render(<Probe projectPath={project} events={[]} />);
    await expectFrame(
      lastFrame,
      () => Promise.resolve(),
      (text) => text === '1|бэкенд',
    );
  });

  it('watcher доносит новую pending-сессию событием', async () => {
    const created = await createWork(project, { title: 'Авторизация' });
    const events: StatusEventInit[] = [];
    const { lastFrame } = render(<Probe projectPath={project} events={events} />);

    await expectFrame(
      lastFrame,
      () => Promise.resolve(),
      (text) => text === '1|',
    );

    await updateMap(project, created.work.id, (map) => {
      addSession(map, { provider: 'codex', label: 'тесты', task: 'прогнать e2e' });
    });
    // Повторные пустые записи карты только будят watcher: сессия уже добавлена.
    await expectFrame(
      lastFrame,
      () => updateMap(project, created.work.id, () => {}).then(() => undefined),
      (text) => text === '1|тесты',
    );

    expect(events.map((event) => event.text)).toContain('Cx: pending «тесты» в «Авторизация»');
  });

  it('без единой работы список пуст, а не «читаю»', async () => {
    const { lastFrame } = render(<Probe projectPath={project} events={[]} />);
    await expectFrame(
      lastFrame,
      () => Promise.resolve(),
      (text) => text === '0|',
    );
  });
});
