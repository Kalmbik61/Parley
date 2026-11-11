/**
 * Mail and the first message for Qwen Code (spec 2026-11-11, 3.4 and its amendment): typed text (not a paste), then
 * `\r` after the pause, with every guard of `typeAndSubmit` and the pointer. Nothing is typed before the process is
 * ready (OSC 7501 idle + the Parley MCP list), into a dialog (OSC `blocked`), during a turn, over the human's typing,
 * into another process, or twice. The real qwen never runs here: `test/stub-qwen-tty.mjs` reports what reached it.
 */

import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addSession, createWork, transitionSession, updateMap, workPaths } from '@parley/core';
import type { EventData, EventName, SessionRef } from '@parley/protocol';
import { linkTerminalActivity } from '../activity/terminal-link.js';
import { createActivityService } from '../activity/activity-service.js';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import { createPtyManager } from '../pty/pty-manager.js';
import type { PtyHandle, PtyManager } from '../pty/pty-manager.js';
import type { QwenStatus } from '../pty/qwen-terminal.js';
import { createWorksService } from '../works/works-service.js';
import { createWakeService } from './wake-service.js';
import type { WakeService } from './wake-service.js';

const STUB = fileURLToPath(new URL('../../test/stub-qwen-tty.mjs', import.meta.url));
const POINTER = 'New messages (1). Call check_inbox.';
const BRIEF = '# Workspace w-0001\n\nTask: run the e2e suite\n\nCall `get_map` first.';
const SHOWN_BRIEF = BRIEF.replace(/\n/g, '\\n');
const IDLE: QwenStatus = { state: 'idle', kind: null, msg: null };
/** A hook line as qwen journals it, with its own `timestamp`. */
const journalLine = (name: string, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ hook_event_name: name, timestamp: new Date().toISOString(), ...extra })}\n`;

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
  await Promise.all([home, project, claudeRoot, codexRoot].map((dir) => rm(dir, { recursive: true, force: true })));
});

const waitFor = async (check: () => boolean, timeoutMs = 8000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

interface Rig {
  ref: SessionRef;
  pty: PtyManager;
  activity: ActivityService;
  wake: WakeService;
  handle: PtyHandle;
  stream: () => string;
  letter: () => Promise<void>;
  /** The process reports OSC 7501 idle and its Parley MCP client lists the tools. */
  ready: () => void;
}

async function rig(env: NodeJS.ProcessEnv = {}, enterDelayMs = 300): Promise<Rig> {
  const map = await createWork(project, { title: 'Work' });
  let sessionId = '';
  await updateMap(project, map.work.id, (current) => {
    const created = addSession(current, { provider: 'qwen', label: 'qwen', task: 'do it' });
    sessionId = created.id;
    created.launchedBy = 'host';
    transitionSession(current, created.id, 'active');
  });
  const ref: SessionRef = { projectPath: project, workId: map.work.id, sessionId };
  await mkdir(workPaths(project, map.work.id).events, { recursive: true });

  const host = fakeHost();
  const works = createWorksService(host, { debounceMs: 20 });
  const activity = createActivityService(host, works, { silenceThresholdMs: 30_000, trustWaitMs: 60_000, claudeRoot, codexRoot });
  const pty = createPtyManager(host);
  const unlink = linkTerminalActivity(pty, activity);
  const wake = createWakeService(host, works, activity, pty, { launch: async () => {} }, { enterDelayMs, pointerTimeoutMs: 3000 });
  await works.start();
  await activity.start();
  wake.start();

  let stream = '';
  pty.on('output', (_ref, data) => {
    stream += data;
  });
  const handle = pty.start(ref, {
    command: process.execPath,
    args: [STUB],
    cwd: project,
    env: { ...process.env, PARLEY_WORK_DIR: workPaths(project, map.work.id).dir, PARLEY_SESSION_ID: sessionId, ...env },
    provider: 'qwen',
  });
  stoppers.push(async () => {
    unlink();
    await pty.stop(ref, { graceMs: 200 }).catch(() => {});
    wake.stop();
    await activity.stop();
    await works.stop();
  });
  await waitFor(() => stream.includes('stub-qwen-tty ready') && pty.get(ref)?.bracketedPaste() === true);

  return {
    ref,
    pty,
    activity,
    wake,
    handle,
    stream: () => stream,
    letter: () =>
      updateMap(project, map.work.id, (current, letters) => {
        letters.add({ roomId: null, kind: 'note', from: 's-00', to: [sessionId], text: 'letter body — secret' });
      }).then(() => undefined),
    ready: () => {
      activity.qwenStatus(ref, IDLE);
      activity.mcpListed(ref, activity.processGeneration(ref));
    },
  };
}

describe('wake and qwen: the deferred brief', () => {
  it('is typed once after ready, as text with its paragraphs, then Enter; a waiting letter follows after that turn', async () => {
    const r = await rig();
    r.wake.deferFirst(r.ref, r.handle.pid, BRIEF);
    await r.letter();
    await settle(600);
    expect(r.stream()).not.toContain('field:');
    r.ready();
    await waitFor(() => r.stream().includes(`turn: ${SHOWN_BRIEF}`));
    expect(r.stream()).toContain(`field: ${SHOWN_BRIEF}`);
    expect(r.stream()).not.toContain('paste:');
    // The pointer waits for the brief's turn to end, then goes the same way.
    await waitFor(() => r.stream().includes(`turn: ${POINTER}`));
    expect(r.stream().indexOf(`turn: ${SHOWN_BRIEF}`)).toBeLessThan(r.stream().indexOf(`turn: ${POINTER}`));
    await settle(800);
    expect(count(r.stream(), `turn: ${SHOWN_BRIEF}`)).toBe(1);
    expect(count(r.stream(), `turn: ${POINTER}`)).toBe(1);
  }, 20_000);

  it('a startup dialog blocks it: not ready, or ready but OSC blocked; nothing reaches the terminal', async () => {
    const r = await rig();
    r.wake.deferFirst(r.ref, r.handle.pid, BRIEF);
    r.activity.qwenStatus(r.ref, { state: 'blocked', kind: 'auth', msg: 'Authentication required' });
    r.activity.mcpListed(r.ref, r.activity.processGeneration(r.ref));
    await settle(800);
    expect(r.stream()).not.toContain('field:');
    r.activity.qwenStatus(r.ref, IDLE);
    await waitFor(() => r.stream().includes(`turn: ${SHOWN_BRIEF}`));
  }, 20_000);

  it('a brief for another process (stale pid) is never typed', async () => {
    const r = await rig();
    r.wake.deferFirst(r.ref, r.handle.pid + 100_000, BRIEF);
    r.ready();
    await settle(1000);
    expect(r.stream()).not.toContain('field:');
  }, 20_000);

  it('the host stopping between typing and Enter sends no Enter, and a restarted wake does not type it again', async () => {
    const r = await rig();
    r.ready();
    await waitFor(() => r.activity.get(r.ref)?.activity.lastEventAt != null);
    r.wake.deferFirst(r.ref, r.handle.pid, BRIEF);
    await waitFor(() => r.stream().includes('field:'));
    r.wake.stop();
    await settle(800);
    expect(r.stream()).not.toContain('turn:');
    r.wake.start();
    await settle(800);
    expect(r.stream().split('\n').filter((line) => line.startsWith('turn:')).length).toBe(0);
    expect(r.stream()).not.toContain('turn:');
  }, 20_000);
});

describe('wake and qwen: the mail pointer', () => {
  it('an idle ready session that never ran a turn gets the pointer', async () => {
    const r = await rig();
    r.ready();
    await r.letter();
    await waitFor(() => r.stream().includes(`turn: ${POINTER}`));
    expect(r.stream()).toContain(`field: ${POINTER}`);
    expect(r.stream()).not.toContain('paste:');
  }, 20_000);

  it('a pointer during a turn waits for its Stop; Stop followed by a new turn waits again', async () => {
    const r = await rig({ STUB_TURN_MS: '1500' });
    r.ready();
    await waitFor(() => r.activity.get(r.ref)?.activity.lastEventAt != null);
    // The human starts a turn; the letter arrives during it.
    r.pty.input(r.ref, 'first\r');
    await waitFor(() => r.activity.get(r.ref)?.activity.activity === 'working');
    await r.letter();
    await settle(900);
    expect(r.stream()).not.toContain(`field: ${POINTER}`);
    await waitFor(() => r.stream().includes(`turn: ${POINTER}`), 10_000);
    expect(count(r.stream(), `turn: ${POINTER}`)).toBe(1);
  }, 20_000);

  it('a new turn during the pause before Enter defers Enter; after that turn the same pointer is submitted once', async () => {
    const r = await rig({}, 1500);
    r.ready();
    await waitFor(() => r.activity.get(r.ref)?.activity.lastEventAt != null);
    // A turn ended (Stop): the session is idle, and the letter's pointer is typed.
    await r.letter();
    await waitFor(() => r.stream().includes(`field: ${POINTER}`));
    // A delayed hook of input submitted just before the pointer: a new turn runs during the pause before Enter.
    const events = path.join(workPaths(r.ref.projectPath, r.ref.workId).events, `${r.ref.sessionId}.jsonl`);
    await appendFile(events, journalLine('UserPromptSubmit', { prompt: 'human input' }));
    await waitFor(() => r.activity.get(r.ref)?.activity.activity === 'working');
    await settle(1800);
    expect(r.stream()).not.toContain(`turn: ${POINTER}`);
    // That turn ends: Enter goes on the pointer already in the field — no second pointer.
    await appendFile(events, journalLine('Stop') + journalLine('Notification', { notification_type: 'idle_prompt' }));
    await waitFor(() => r.stream().includes(`turn: ${POINTER}`), 10_000);
    await settle(800);
    expect(count(r.stream(), `turn: ${POINTER}`)).toBe(1);
    expect(count(r.stream(), `field: ${POINTER}`)).toBe(1);
    expect(r.stream()).not.toContain(`${POINTER}${POINTER}`);
  }, 30_000);

  it('the human typing during the pause before Enter: no Enter, the pointer stays in the field', async () => {
    const r = await rig();
    r.ready();
    await waitFor(() => r.activity.get(r.ref)?.activity.lastEventAt != null);
    await r.letter();
    await waitFor(() => r.stream().includes(`field: ${POINTER}`));
    r.pty.input(r.ref, 'x');
    await settle(800);
    expect(r.stream()).not.toContain(`turn: ${POINTER}`);
    expect(broadcasts.some((entry) => entry.event === 'host.notice' && (entry.data as { kind: string }).kind === 'pointer-cancelled')).toBe(true);
  }, 20_000);

  it('a dialog in the terminal (OSC blocked, from the pty) holds the pointer; it goes once the dialog closes', async () => {
    const r = await rig();
    r.ready();
    await waitFor(() => r.activity.get(r.ref)?.activity.lastEventAt != null);
    process.kill(r.handle.pid, 'SIGUSR1');
    await waitFor(() => r.activity.qwenBlocked(r.ref));
    await r.letter();
    await settle(900);
    expect(r.stream()).not.toContain('field:');
    // The dialog closes: only the terminal says so, no hook comes.
    process.kill(r.handle.pid, 'SIGUSR2');
    await waitFor(() => r.stream().includes(`turn: ${POINTER}`));
  }, 20_000);

  it('a dialog opening during the pause before Enter withholds Enter', async () => {
    const r = await rig();
    r.ready();
    await waitFor(() => r.activity.get(r.ref)?.activity.lastEventAt != null);
    await r.letter();
    await waitFor(() => r.stream().includes(`field: ${POINTER}`));
    process.kill(r.handle.pid, 'SIGUSR1');
    await settle(800);
    expect(r.stream()).not.toContain(`turn: ${POINTER}`);
  }, 20_000);
});
