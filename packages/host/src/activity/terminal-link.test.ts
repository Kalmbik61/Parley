/**
 * Сквозная связка «pty codex → сигналы → активность» на настоящем PTY и заглушке codex: заголовок
 * окна и уведомление процесса доходят до `activity.changed` тем же путём, что хуки Claude Code
 * (спека комнат Organic, 3.6). Настоящий codex не запускается.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addSession, createWork, transitionSession, updateMap } from '@harnas/core';
import type { EventData, EventName, SessionRef } from '@harnas/protocol';
import type { HostContext } from '../context.js';
import { createPtyManager } from '../pty/pty-manager.js';
import type { PtyLaunch } from '../pty/pty-process.js';
import { createWorksService } from '../works/works-service.js';
import { createActivityService } from './activity-service.js';
import type { ActivityService } from './activity-service.js';
import { linkTerminalActivity } from './terminal-link.js';

const CODEX_STUB = fileURLToPath(new URL('../../test/stub-codex.mjs', import.meta.url));

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
  await Promise.all(
    [home, project, claudeRoot, codexRoot].map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const waitFor = async (check: () => boolean, timeoutMs = 8000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались условия');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** Работа с одной активной сессией заданного провайдера и всё, что нужно, чтобы поднять в ней PTY. */
async function rig(provider: string, launchEnv: NodeJS.ProcessEnv = {}, startupWaitMs = 60_000) {
  const map = await createWork(project, { title: 'Работа' });
  let sessionId = '';
  await updateMap(project, map.work.id, (current) => {
    const created = addSession(current, { provider, label: 'сессия', task: 'сделать' });
    sessionId = created.id;
    created.launchedBy = 'host';
    transitionSession(current, created.id, 'active');
  });
  const ref: SessionRef = { projectPath: project, workId: map.work.id, sessionId };

  const host = fakeHost();
  const works = createWorksService(host, { debounceMs: 20 });
  const activity: ActivityService = createActivityService(host, works, {
    silenceThresholdMs: 30_000,
    startupWaitMs,
    claudeRoot,
    codexRoot,
  });
  const pty = createPtyManager(host);
  const unlink = linkTerminalActivity(pty, activity);
  await works.start();
  await activity.start();
  stoppers.push(async () => {
    unlink();
    await pty.stop(ref, { graceMs: 200 }).catch(() => {});
    await activity.stop();
    await works.stop();
  });

  const launch = (over: Partial<PtyLaunch> = {}): PtyLaunch => ({
    command: process.execPath,
    args: [CODEX_STUB],
    cwd: project,
    env: { ...process.env, ...launchEnv },
    provider,
    ...over,
  });
  return { ref, pty, activity, launch };
}

const state = (activity: ActivityService, ref: SessionRef): string | undefined =>
  activity.get(ref)?.activity.activity;

/**
 * Первый `Ready` заглушки — агент у приглашения, а не конец хода: состояние тусклое (`idle`), но хост «в курсе»
 * (`lastEventAt`) — по нему отправка из окна и будильник уже разрешены.
 */
const known = (activity: ActivityService, ref: SessionRef): boolean =>
  activity.get(ref)?.activity.lastEventAt != null;

describe('linkTerminalActivity', () => {
  it('Ready заглушки → idle (приглашение); ход (спиннер) → working; одобрение → blocked; Ready → unseen', async () => {
    const { ref, pty, activity, launch } = await rig('codex');
    pty.start(ref, launch());

    await waitFor(() => known(activity, ref));
    expect(state(activity, ref)).toBe('idle');
    pty.input(ref, 'STUB_WORK\r');
    await waitFor(() => state(activity, ref) === 'working');
    pty.input(ref, 'STUB_APPROVAL\r');
    await waitFor(() => state(activity, ref) === 'blocked');
    pty.input(ref, 'STUB_WORK\r');
    await waitFor(() => state(activity, ref) === 'working');
    pty.input(ref, 'STUB_READY\r');
    await waitFor(() => state(activity, ref) === 'unseen');
  }, 30_000);

  it('рассылается activity.changed — то, что окно превращает в «needs you» и уведомление macOS', async () => {
    const { ref, pty, activity, launch } = await rig('codex');
    pty.start(ref, launch());
    await waitFor(() => known(activity, ref));
    pty.input(ref, 'STUB_APPROVAL\r');
    await waitFor(() => state(activity, ref) === 'blocked');

    const sent = broadcasts
      .filter((entry) => entry.event === 'activity.changed')
      .map((entry) => (entry.data as { activity: { activity: string } }).activity.activity);
    expect(sent).toContain('blocked');
  }, 30_000);

  it('экран старта без заголовков: blocked через срок и уведомление startup-wait; Ready после доверия снимает', async () => {
    const { ref, pty, activity, launch } = await rig('codex', { STUB_CODEX_NO_TITLE: '1' }, 300);
    pty.start(ref, launch());

    await waitFor(() => state(activity, ref) === 'blocked');
    expect(
      broadcasts.some(
        (entry) =>
          entry.event === 'host.notice' && (entry.data as { kind: string }).kind === 'startup-wait',
      ),
    ).toBe(true);

    // Человек ответил на экран доверия, Codex дорисовал чат и написал заголовок: у приглашения, ход не кончался.
    pty.input(ref, 'STUB_READY\r');
    await waitFor(() => state(activity, ref) === 'idle');
    expect(known(activity, ref)).toBe(true);
  }, 30_000);

  it('процесс вышел — состояние по терминалу забыто', async () => {
    const { ref, pty, activity, launch } = await rig('codex');
    pty.start(ref, launch());
    await waitFor(() => known(activity, ref));
    pty.input(ref, 'STUB_WORK\r');
    await waitFor(() => state(activity, ref) === 'working');

    pty.input(ref, 'STUB_EXIT\r');
    await waitFor(() => pty.get(ref) === undefined);
    await waitFor(() => state(activity, ref) === 'idle');
  }, 30_000);

  it('процесс не codex (claude) — заголовки его потока состояния не задают', async () => {
    const { ref, pty, activity, launch } = await rig('claude');
    pty.start(ref, launch({ provider: 'claude' }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    pty.input(ref, 'STUB_WORK\r');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(state(activity, ref)).not.toBe('working');
    expect(state(activity, ref)).not.toBe('unseen');
  }, 30_000);

  it('новый процесс той же сессии (resume) начинает без состояния прошлого', async () => {
    const { ref, pty, activity, launch } = await rig('codex', { STUB_CODEX_READY_MS: '600' });
    pty.start(ref, launch());
    await waitFor(() => known(activity, ref));
    pty.input(ref, 'STUB_WORK\r');
    await waitFor(() => state(activity, ref) === 'working');
    pty.input(ref, 'STUB_READY\r');
    await waitFor(() => state(activity, ref) === 'unseen');
    pty.input(ref, 'STUB_EXIT\r');
    await waitFor(() => pty.get(ref) === undefined);

    // Второй процесс до своего первого заголовка молчит — прежнее `unseen` не переносится.
    pty.start(ref, launch());
    expect(state(activity, ref)).toBe('idle');
    expect(known(activity, ref)).toBe(false);
    // И его первый Ready — снова приглашение, а не конец хода, хотя у прошлого процесса ходы были.
    await waitFor(() => known(activity, ref));
    expect(state(activity, ref)).toBe('idle');
  }, 30_000);
});
