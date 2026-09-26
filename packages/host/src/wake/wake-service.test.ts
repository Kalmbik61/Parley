import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addMessage, addSession, createWork, pointerText, transitionSession, updateMap } from '@harnas/core';
import type { EventData, EventName, SessionRef } from '@harnas/protocol';
import type { HostContext } from '../context.js';
import { createActivityService } from '../activity/activity-service.js';
import type { ActivityService } from '../activity/activity-service.js';
import { createPtyManager } from '../pty/pty-manager.js';
import type { PtyLaunch } from '../pty/pty-process.js';
import { createWorksService } from '../works/works-service.js';
import type { WorksService } from '../works/works-service.js';
import { createWakeService } from './wake-service.js';
import type { WakeService, WakeServiceOptions } from './wake-service.js';

const STUB = fileURLToPath(new URL('../../test/stub-agent.mjs', import.meta.url));

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались условия');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let home = '';
let project = '';
let claudeRoot = '';
let codexRoot = '';
let broadcasts: Array<{ event: EventName; data: unknown }>;
let stoppers: Array<() => Promise<void> | void> = [];

function fakeHost(): HostContext {
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    clients: () => [],
    liveSessions: () => 0,
    broadcast: (event, data) => broadcasts.push({ event, data: data as EventData<EventName> }),
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
  };
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
  claudeRoot = await mkdtemp(path.join(tmpdir(), 'harnas-claude-'));
  codexRoot = await mkdtemp(path.join(tmpdir(), 'harnas-codex-'));
  process.env['HARNAS_HOME'] = home;
  broadcasts = [];
});

afterEach(async () => {
  for (const stop of stoppers) await stop();
  stoppers = [];
  delete process.env['HARNAS_HOME'];
  await Promise.all([home, project, claudeRoot, codexRoot].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Заводит активную сессию `launchedBy: host` в новой работе. */
async function activeSession(): Promise<{ workId: string; sessionId: string }> {
  const map = await createWork(project, { title: 'Работа' });
  let sessionId = '';
  await updateMap(project, map.work.id, (current) => {
    const created = addSession(current, { provider: 'claude', label: 'сессия', task: 'сделать' });
    sessionId = created.id;
    created.launchedBy = 'host';
    transitionSession(current, created.id, 'active');
  });
  return { workId: map.work.id, sessionId };
}

async function sendLetter(workId: string, to: string, text = 'тело письма — секрет'): Promise<void> {
  await updateMap(project, workId, (map) => {
    addMessage(map, { from: 's-00', to: [to], text });
  });
}

interface Rig {
  works: WorksService;
  activity: ActivityService;
  pty: ReturnType<typeof createPtyManager>;
  wake: WakeService;
  stream: () => string;
  ref: SessionRef;
}

/** Собирает works+activity+pty+wake вокруг одной сессии и запускает в ней стаб. */
async function rig(
  sessionId: string,
  workId: string,
  launchEnv: NodeJS.ProcessEnv = {},
  wakeOptions: WakeServiceOptions = {},
): Promise<Rig> {
  const host = fakeHost();
  const works = createWorksService(host, { debounceMs: 20 });
  const activity = createActivityService(host, works, { claudeRoot, codexRoot });
  const pty = createPtyManager(host);
  const wake = createWakeService(host, works, activity, pty, { enterDelayMs: 30, ...wakeOptions });

  await works.start();
  await activity.start();
  wake.start();

  const ref: SessionRef = { projectPath: project, workId, sessionId };
  const launch: PtyLaunch = {
    command: process.execPath,
    args: [STUB],
    cwd: project,
    env: { ...process.env, ...launchEnv },
  };
  pty.start(ref, launch);

  let stream = '';
  pty.on('output', (_ref, data) => {
    stream += data;
  });

  stoppers.push(async () => {
    await pty.stop(ref, { graceMs: 200 }).catch(() => {});
    wake.stop();
    await activity.stop();
    await works.stop();
  });

  await waitFor(() => stream.includes('STUB READY'));
  return { works, activity, pty, wake, stream: () => stream, ref };
}

describe('WakeService', () => {
  it('1: письмо простаивающей сессии печатается указателем — байт в байт, тело письма не течёт', async () => {
    const { workId, sessionId } = await activeSession();
    const { stream, ref } = await rig(sessionId, workId);

    await sendLetter(workId, sessionId, 'секретное тело письма');

    const expected = `echo: ${pointerText(1)}`;
    await waitFor(() => stream().includes(expected), 3000);
    expect(stream()).toContain(expected);
    expect(stream()).not.toContain('секретное тело письма');
    void ref;
  });

  it('2: письмо во время хода — указатель уходит только после Stop', async () => {
    const { workId, sessionId } = await activeSession();
    const { stream, pty, ref } = await rig(sessionId, workId, {
      STUB_HOOKS: '1',
      STUB_TURN_MS: '500',
      HARNAS_WORK_DIR: path.join(project, '.harnas', 'works', workId),
      HARNAS_SESSION_ID: sessionId,
    });

    pty.input(ref, 'привет\r');
    await settle(50);
    await sendLetter(workId, sessionId);

    // Ход ещё не закончился — указателя быть не должно.
    await settle(250);
    expect(stream()).not.toContain(`echo: ${pointerText(1)}`);

    // Ход закончился (Stop) — теперь указатель уходит.
    await waitFor(() => stream().includes('echo: привет'), 3000);
    await waitFor(() => stream().includes(`echo: ${pointerText(1)}`), 3000);
  }, 20_000);

  it('3: черновик блокирует указатель; после \\r черновик снят — указатель уходит', async () => {
    const { workId, sessionId } = await activeSession();
    const { stream, pty, ref } = await rig(sessionId, workId);

    pty.input(ref, 'пр');
    await sendLetter(workId, sessionId);
    await settle(300);
    expect(stream()).not.toContain(`echo: ${pointerText(1)}`);

    pty.input(ref, '\r');
    await waitFor(() => stream().includes(`echo: ${pointerText(1)}`), 3000);
  });

  it('4: три письма — один указатель с (3)', async () => {
    const { workId, sessionId } = await activeSession();
    const { stream } = await rig(sessionId, workId);

    // Одной записью карты, а не тремя: иначе гонка с наблюдателем работ могла
    // бы застать письма по одному и напечатать три отдельных указателя с (1),
    // а второй и третий заблокировались бы уже висящей попыткой (`in-flight`).
    await updateMap(project, workId, (map) => {
      addMessage(map, { from: 's-00', to: [sessionId], text: 'один' });
      addMessage(map, { from: 's-00', to: [sessionId], text: 'два' });
      addMessage(map, { from: 's-00', to: [sessionId], text: 'три' });
    });

    const expected = `echo: ${pointerText(3)}`;
    await waitFor(() => stream().includes(expected), 5000);
    expect(stream().split(expected)).toHaveLength(2);
  });

  it('5: без хуков и с малым pointerTimeoutMs — pointer-timeout, повторного набора нет', async () => {
    const { workId, sessionId } = await activeSession();
    const { stream } = await rig(sessionId, workId, {}, { pointerTimeoutMs: 300 });

    await sendLetter(workId, sessionId);

    const expected = `echo: ${pointerText(1)}`;
    await waitFor(() => stream().includes(expected), 3000);

    await waitFor(
      () => broadcasts.some((b) => b.event === 'host.notice' && (b.data as { kind: string }).kind === 'pointer-timeout'),
      2000,
    );

    // Ждём с запасом сверх таймаута — второй попытки быть не должно.
    await settle(400);
    expect(stream().split(expected)).toHaveLength(2);
  });

  it('6: пауза держит письма, resume — доставляет', async () => {
    const { workId, sessionId } = await activeSession();
    const { stream, wake } = await rig(sessionId, workId);

    wake.pause();
    expect(wake.paused()).toBe(true);
    await sendLetter(workId, sessionId);
    await settle(300);
    expect(stream()).not.toContain(`echo: ${pointerText(1)}`);

    wake.resume();
    expect(wake.paused()).toBe(false);
    await waitFor(() => stream().includes(`echo: ${pointerText(1)}`), 3000);
  });

  it('7: ввод человека между текстом и Enter — Enter не уходит, приходит pointer-cancelled', async () => {
    const { workId, sessionId } = await activeSession();
    const { stream, pty, ref } = await rig(sessionId, workId, {}, { enterDelayMs: 300 });

    await sendLetter(workId, sessionId);

    const raw = pointerText(1);
    await waitFor(() => stream().includes(raw), 3000);
    pty.input(ref, 'X');

    await settle(600);
    expect(stream()).not.toContain(`echo: ${raw}`);

    const cancelled = broadcasts.find(
      (b) => b.event === 'host.notice' && (b.data as { kind: string }).kind === 'pointer-cancelled',
    );
    expect(cancelled).toBeDefined();
    expect((cancelled?.data as { ref: SessionRef }).ref).toEqual(ref);
  });
});
