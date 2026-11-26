/**
 * Сквозная связка «pty codex → сигналы → активность» на настоящем PTY и заглушке codex: заголовок
 * окна и уведомление процесса доходят до `activity.changed` тем же путём, что хуки Claude Code
 * (спека комнат Organic, 3.6). Настоящий codex не запускается.
 */

import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addSession, createWork, transitionSession, updateMap, workPaths } from '@parley/core';
import type { EventData, EventName, SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';
import { createPtyManager } from '../pty/pty-manager.js';
import type { PtyLaunch } from '../pty/pty-process.js';
import { createWorksService } from '../works/works-service.js';
import { createActivityService } from './activity-service.js';
import type { ActivityService, ActivityServiceOptions } from './activity-service.js';
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
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  claudeRoot = await mkdtemp(path.join(tmpdir(), 'parley-claude-'));
  codexRoot = await mkdtemp(path.join(tmpdir(), 'parley-codex-'));
  process.env['PARLEY_HOME'] = home;
  broadcasts = [];
});

afterEach(async () => {
  for (const stop of stoppers) await stop();
  stoppers = [];
  delete process.env['PARLEY_HOME'];
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
async function rig(
  provider: string,
  launchEnv: NodeJS.ProcessEnv = {},
  startupWaitMs = 60_000,
  serviceOptions: ActivityServiceOptions = {},
) {
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
    ...serviceOptions,
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
    // Поток заглушки — OSC 9 с командой, затем заголовок Action Required: одобрение, а не вопрос.
    expect(activity.get(ref)?.activity.need).toMatchObject({ kind: 'approval', detail: 'ls -la' });
    pty.input(ref, 'STUB_WORK\r');
    await waitFor(() => state(activity, ref) === 'working');
    expect(activity.get(ref)?.activity.need).toBeNull();
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

  it('claude: журнал прошлого запуска не пуст, новый процесс молчит срок — startup (хост видит запуск процесса)', async () => {
    const { ref, pty, activity, launch } = await rig('claude', {}, 60_000, { trustWaitMs: 300 });
    // Журнал прошлого запуска заведён после старта служб: его подхватит ближайшая настоящая запись в карту.
    const events = workPaths(project, ref.workId).events;
    await mkdir(events, { recursive: true });
    await appendFile(
      path.join(events, `${ref.sessionId}.jsonl`),
      `${JSON.stringify({ hook_event_name: 'SessionStart' })}\n${JSON.stringify({ hook_event_name: 'Stop' })}\n`,
    );
    // Пустой `updateMap` ничего не пишет и службу работ не будит (план 4, задача 1): нужна настоящая запись.
    await updateMap(project, ref.workId, (current) => {
      current.work.goal = 'запись в карту';
    });
    await waitFor(() => activity.get(ref)?.activity.lastEventAt != null);

    pty.start(ref, launch({ provider: 'claude' }));
    await waitFor(() => activity.get(ref)?.activity.need?.kind === 'startup');
    expect(state(activity, ref)).toBe('blocked');
    expect(activity.get(ref)?.activity.lastEventAt).toBeNull();
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

function controlledTerminal() {
  let emit: (data: string) => void = () => {};
  let finish = () => {};
  const write = vi.fn();
  const native = {
    pid: 42, write, resize() {}, kill: () => finish(),
    onData(listener: typeof emit) { emit = listener; return () => {}; },
    onExit(listener: (exit: { exitCode: number; signal: null }) => void) {
      finish = () => listener({ exitCode: 0, signal: null });
      return () => {};
    },
  };
  return { emit: (data: string) => emit(data), native, write };
}

it('publishes and replays OpenCode status without triggering canonical activity, and clears it on exit', async () => {
  const { ref, pty, activity, launch } = await rig('opencode');
  const { emit, native, write } = controlledTerminal();
  pty.start(ref, launch({ process: native }));
  await waitFor(() => activity.get(ref) !== undefined);
  const canonical = activity.get(ref);
  const legacy = activity.current()[0];
  const changed = vi.fn();
  const off = activity.onChange(changed);
  broadcasts.length = 0;
  const blocked = '\x1b]7501;state=blocked:kind=permission:app=opencode:msg=YWJj\x1b\\';
  emit(blocked + blocked);
  emit('\x1b]7501;state=clear:id=ses_child\x07');
  let messages = broadcasts.filter((item) => item.event === 'activity.changed');
  expect(messages).toHaveLength(1);
  expect(messages[0]?.data).toEqual({ ...legacy, ref, terminalStatus: { state: 'blocked', kind: 'permission' } });
  expect(activity.current()).toContainEqual(messages[0]?.data);
  expect(activity.current()[0]?.terminalStatus).toEqual({ state: 'blocked', kind: 'permission' });
  expect(activity.get(ref)).toBe(canonical);
  expect(changed).not.toHaveBeenCalled();

  emit('\x1b]7501;state=idle:app=opencode\x07');
  expect(activity.get(ref)?.activity.need).toBe(canonical?.activity.need);
  expect(changed).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  await pty.stop(ref);
  messages = broadcasts.filter((item) => item.event === 'activity.changed');
  expect(messages).toHaveLength(3);
  expect((messages.at(-1)?.data as EventData<'activity.changed'>).terminalStatus ?? null).toBeNull();
  expect(activity.current()).toContainEqual(messages.at(-1)?.data);
  off();
});

it('keeps Codex generic permission status out of authoritative actions and approval evidence', async () => {
  const { ref, pty, activity, launch } = await rig('codex');
  const { emit, native, write } = controlledTerminal();
  pty.start(ref, launch({ process: native }));
  emit('\x1b]0;Ready\x07');
  await waitFor(() => known(activity, ref));
  const canonical = activity.get(ref);
  const changed = vi.fn();
  const off = activity.onChange(changed);

  const generic = '\x1b]7501;state=blocked:kind=permission:app=codex:msg=bHMgLWxh\x07';
  emit(generic);
  expect(activity.current()[0]?.terminalStatus).toEqual({ state: 'blocked', kind: 'permission' });
  expect(activity.get(ref)).toBe(canonical);
  expect(changed).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();

  emit('\x1b]2;Action Required\x07');
  expect(activity.get(ref)?.activity.need).toMatchObject({ kind: 'question', detail: null });
  emit('\x1b]9;Approval requested: ls -la\x07');
  expect(activity.get(ref)?.activity.need).toMatchObject({ kind: 'approval', detail: 'ls -la' });

  const held = activity.get(ref);
  changed.mockClear();
  emit('\x1b]7501;state=idle:app=codex\x07\x1b]7501;state=clear\x07');
  expect(activity.current()[0]?.terminalStatus ?? null).toBeNull();
  expect(activity.get(ref)).toBe(held);
  expect(changed).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  off();
  await pty.stop(ref);
});
