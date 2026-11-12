/**
 * Mail and the first message for OpenCode (spec 2026-11-12, 4.5, plan O7): the brief, the pointer and the limit-return text go
 * through the session server's API, not into the terminal. `test/stub-qwen-tty.mjs` stands in for the TUI (it reports
 * whatever is TYPED into it, and journals SessionStart like the host's event bridge does at readiness); a fake server takes the
 * API prompts and journals the turn the bridge would. The real opencode never runs here.
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
import { createServer, type Server } from 'node:http';
import { createWorksService } from '../works/works-service.js';
import { createWakeService } from './wake-service.js';
import type { WakeService } from './wake-service.js';

const STUB = fileURLToPath(new URL('../../test/stub-qwen-tty.mjs', import.meta.url));
const POINTER = 'New messages (1). Call check_inbox.';
const BRIEF = '# Workspace w-0001\n\nTask: run the e2e suite\n\nCall `get_map` first.';
const SHOWN_BRIEF = BRIEF.replace(/\n/g, '\\n');
const PASSWORD = 'lab-secret-not-real';
const OPENCODE_ID = 'ses_parley000000000000000001';
/** A hook line as qwen journals it, with its own `timestamp`. */
const journalLine = (name: string, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ hook_event_name: name, timestamp: new Date().toISOString(), ...extra })}\n`;

let home = '';
let project = '';
let claudeRoot = '';
let codexRoot = '';
let broadcasts: Array<{ event: EventName; data: unknown }>;
let stoppers: Array<() => Promise<void> | void> = [];
let apiServer: Server | undefined;
let apiUp = true;
let apiStatus = 202;
/** `normal`: the turn is journaled after the answer (300 ms); `fast`: the whole turn is journaled BEFORE the answer returns; `batch`: the answer returns at once and the whole turn lands in the journal in ONE write 150 ms later (the fold sees no
 * `working`, only the end); `none`: no turn. */
let apiTurn: 'normal' | 'fast' | 'batch' | 'none' = 'normal';
let apiPosts: string[] = [];
let apiUrl = '';
const serverAddress = (): { url: string; password: string } | undefined => (apiUp ? { url: apiUrl, password: PASSWORD } : undefined);

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
  apiUp = true;
  apiStatus = 202;
  apiTurn = 'normal';
  apiPosts = [];
  const events = (): string => path.join(workPaths(project, currentWorkId()).events, `${currentSessionId()}.jsonl`);
  apiServer = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      if (req.method !== 'POST') return void res.writeHead(404).end();
      const text = (JSON.parse(body) as { text: string }).text;
      apiPosts.push(text);
      if (apiStatus < 300 && apiTurn === 'fast') {
        // The bridge is quicker than the answer: the turn starts and ends while the host still waits for the POST.
        void appendFile(events(), journalLine('UserPromptSubmit', { prompt: text }))
          .then(() => setTimeout(() => void appendFile(events(), journalLine('Stop') + journalLine('Notification', { notification_type: 'idle_prompt' })), 60));
        setTimeout(() => res.writeHead(apiStatus).end('{}'), 250);
        return;
      }
      if (apiStatus < 300 && apiTurn === 'batch') {
        setTimeout(() => void appendFile(events(), journalLine('UserPromptSubmit', { prompt: text }) + journalLine('Stop') + journalLine('Notification', { notification_type: 'idle_prompt' })), 150);
        res.writeHead(apiStatus).end('{}');
        return;
      }
      if (apiStatus < 300 && apiTurn === 'normal') {
        // What the event bridge journals when the server runs the queued prompt: a turn that starts and ends.
        void appendFile(events(), journalLine('UserPromptSubmit', { prompt: text })).then(() => setTimeout(() => void appendFile(events(), journalLine('Stop') + journalLine('Notification', { notification_type: 'idle_prompt' })), 300));
      }
      res.writeHead(apiStatus).end('{}');
    });
  });
  await new Promise<void>((resolve) => apiServer!.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(apiServer.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => apiServer!.close(() => resolve()));
  for (const stop of stoppers) await stop();
  stoppers = [];
  delete process.env['PARLEY_HOME'];
  await Promise.all([home, project, claudeRoot, codexRoot].map((dir) => rm(dir, { recursive: true, force: true })));
});

let currentRef: SessionRef | undefined;
const currentWorkId = (): string => currentRef!.workId;
const currentSessionId = (): string => currentRef!.sessionId;

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
  /** The stub already journals SessionStart at start, which is the bridge's readiness record. */
  ready: () => void;
}

async function rig(env: NodeJS.ProcessEnv = {}, enterDelayMs = 300): Promise<Rig> {
  const map = await createWork(project, { title: 'Work' });
  let sessionId = '';
  await updateMap(project, map.work.id, (current) => {
    const created = addSession(current, { provider: 'opencode', label: 'opencode', task: 'do it' });
    created.providerSessionId = OPENCODE_ID;
    sessionId = created.id;
    created.launchedBy = 'host';
    transitionSession(current, created.id, 'active');
  });
  const ref: SessionRef = { projectPath: project, workId: map.work.id, sessionId };
  currentRef = ref;
  await mkdir(workPaths(project, map.work.id).events, { recursive: true });

  const host = fakeHost();
  const works = createWorksService(host, { debounceMs: 20 });
  const activity = createActivityService(host, works, { silenceThresholdMs: 30_000, trustWaitMs: 60_000, claudeRoot, codexRoot });
  const pty = createPtyManager(host);
  const unlink = linkTerminalActivity(pty, activity);
  const wake = createWakeService(host, works, activity, pty, { launch: async () => {} }, { enterDelayMs, pointerTimeoutMs: 3000, opencodeServer: () => serverAddress(), opencodeTimeoutMs: 400 });
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
    provider: 'opencode',
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
    ready: () => {},
  };
}

describe('wake and opencode: delivery through the API', () => {
  it('the brief goes once through the API after readiness, never typed; the pointer of a waiting letter follows through the API too', async () => {
    const r = await rig();
    r.wake.deferFirst(r.ref, r.handle.pid, BRIEF);
    await r.letter();
    await waitFor(() => apiPosts.includes(BRIEF));
    // The brief's turn ends (journaled by the fake server), then the pointer goes the same way.
    await waitFor(() => apiPosts.includes(POINTER));
    expect(apiPosts.indexOf(BRIEF)).toBeLessThan(apiPosts.indexOf(POINTER));
    await settle(800);
    expect(count(apiPosts.join('\n'), BRIEF)).toBe(1);
    expect(apiPosts.filter((text) => text === POINTER)).toHaveLength(1);
    // Nothing reached the terminal: no typed field, no paste.
    expect(r.stream()).not.toContain('field:');
    expect(r.stream()).not.toContain('paste:');
    expect(r.stream()).not.toContain('turn:');
  }, 30_000);

  it('a 4xx from the server is a definite rejection: the brief is typed into the terminal instead, once', async () => {
    apiStatus = 400;
    const r = await rig();
    r.wake.deferFirst(r.ref, r.handle.pid, BRIEF);
    await waitFor(() => r.stream().includes(`turn: ${SHOWN_BRIEF}`));
    expect(apiPosts).toEqual([BRIEF]);
    await settle(600);
    expect(count(r.stream(), `turn: ${SHOWN_BRIEF}`)).toBe(1);
  }, 30_000);

  it('no server (stopped, never started): the pointer is typed like for any plain terminal, with no API call', async () => {
    apiUp = false;
    const r = await rig();
    await r.letter();
    await waitFor(() => r.stream().includes(`turn: ${POINTER}`));
    expect(apiPosts).toEqual([]);
  }, 30_000);

  const timeouts = (): number => broadcasts.filter((item) => item.event === 'host.notice' && (item.data as { kind?: string }).kind === 'pointer-timeout').length;

  it('a quick turn that starts and ends before the POST returns still counts as the answer: no pointer-timeout', async () => {
    apiTurn = 'fast';
    const r = await rig(); // pointerTimeoutMs is 3000
    await r.letter();
    await waitFor(() => apiPosts.includes(POINTER));
    // Past the safety timer of the pointer.
    await settle(3800);
    expect(timeouts()).toBe(0);
    expect(r.wake.inFlight(r.ref)).toBe(false);
  }, 30_000);

  it('a turn that lands in the journal as ONE batch after the answer (no working ever seen) still counts: no pointer-timeout', async () => {
    apiTurn = 'batch';
    const r = await rig();
    await r.letter();
    await waitFor(() => apiPosts.includes(POINTER));
    await settle(3800);
    expect(timeouts()).toBe(0);
    expect(r.wake.inFlight(r.ref)).toBe(false);
  }, 30_000);

  it('the deferred brief takes the same path: its quick turn leaves no pointer-timeout either', async () => {
    apiTurn = 'batch';
    const r = await rig();
    r.wake.deferFirst(r.ref, r.handle.pid, BRIEF);
    await waitFor(() => apiPosts.includes(BRIEF));
    await settle(3800);
    expect(timeouts()).toBe(0);
  }, 30_000);

  it('a delivery after which no turn happens at all still times out', async () => {
    apiTurn = 'none';
    const r = await rig();
    await r.letter();
    await waitFor(() => apiPosts.includes(POINTER));
    await waitFor(() => timeouts() > 0, 8000);
    expect(timeouts()).toBe(1);
  }, 30_000);
});
