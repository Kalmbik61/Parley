import type { WorkSession } from '@harnas/core';
import { mkdir, mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Text, useInput } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useActivity, type ActivityWork } from './use-activity.js';

let events = '';

beforeEach(async () => {
  events = path.join(await mkdtemp(path.join(tmpdir(), 'harnas-activity-')), 'events');
  await mkdir(events, { recursive: true });
});

afterEach(async () => {
  await rm(path.dirname(events), { recursive: true, force: true });
});

const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const hook = (name: string, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ hook_event_name: name, ...extra })}\n`;

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 's-01',
    provider: 'claude',
    label: 'план',
    task: '',
    parent: null,
    contextFrom: [],
    status: 'active',
    history: [],
    startedAt: '2026-09-05T09:00:00.000Z',
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: null,
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    ...over,
  };
}

/** Клавиша `s` объявляет первую сессию просмотренной — как подключение к панели. */
function Probe({ works }: { works: readonly ActivityWork[] }): ReactNode {
  const activity = useActivity({ works });
  useInput((input) => {
    if (input === 's') activity.markSeen('s-01');
  });
  const states = works.flatMap((work) => work.sessions.map((s) => activity.stateOf(s)));
  return (
    <Text>{`${states.join(',')}|${activity.workState('w1') ?? '—'}|${activity.hooksMissing}`}</Text>
  );
}

describe('useActivity', () => {
  it('читает журнал хуков и выводит состояние сессии', async () => {
    await appendFile(path.join(events, 's-01.jsonl'), hook('UserPromptSubmit'));
    const works: ActivityWork[] = [{ key: 'w1', eventsDir: events, sessions: [session()] }];

    const { lastFrame } = render(<Probe works={works} />);
    await settle();
    expect(lastFrame()).toBe('working|working|false');
  });

  it('новое событие в журнале доезжает через watcher', async () => {
    const works: ActivityWork[] = [{ key: 'w1', eventsDir: events, sessions: [session()] }];
    const { lastFrame } = render(<Probe works={works} />);
    await settle();
    expect(lastFrame()).toBe('idle|idle|false');

    await appendFile(
      path.join(events, 's-01.jsonl'),
      hook('Notification', { notification_type: 'permission_prompt' }),
    );
    await settle(300);
    expect(lastFrame()).toBe('blocked|blocked|false');
  });

  it('подключение к панели гасит unseen', async () => {
    await appendFile(path.join(events, 's-01.jsonl'), `${hook('UserPromptSubmit')}${hook('Stop')}`);
    const works: ActivityWork[] = [{ key: 'w1', eventsDir: events, sessions: [session()] }];

    const { stdin, lastFrame } = render(<Probe works={works} />);
    await settle();
    expect(lastFrame()).toBe('unseen|unseen|false');

    stdin.write('s');
    await settle();
    expect(lastFrame()).toBe('idle|idle|false');
  });

  it('точка работы — максимум по её сессиям, жизненный цикл перевешивает activity', async () => {
    await appendFile(path.join(events, 's-01.jsonl'), hook('UserPromptSubmit'));
    await appendFile(
      path.join(events, 's-02.jsonl'),
      hook('Notification', { notification_type: 'agent_needs_input' }),
    );
    const works: ActivityWork[] = [
      {
        key: 'w1',
        eventsDir: events,
        sessions: [
          session(),
          session({ id: 's-02', label: 'бэкенд' }),
          session({ id: 's-03', label: 'тесты', status: 'exited' }),
        ],
      },
    ];

    const { lastFrame } = render(<Probe works={works} />);
    await settle();
    expect(lastFrame()).toBe('working,blocked,exited|blocked|false');
  });

  it('каталога events/ нет — работает страховка, поднят флаг предупреждения', async () => {
    const works: ActivityWork[] = [
      { key: 'w1', eventsDir: path.join(events, 'нет'), sessions: [session()] },
    ];

    const { lastFrame } = render(<Probe works={works} />);
    await settle();
    expect(lastFrame()).toBe('idle|idle|true');
  });
});
