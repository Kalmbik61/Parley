/**
 * Qwen Code readiness (spec 2026-11-11, 3.4 and its amendment): `SessionStart` is not ready; the current process is ready
 * when its terminal reports OSC 7501 `state=idle` and its Parley MCP client listed the tools, or when its journal shows
 * input (a real prompt, `idle_prompt`, `auth_success`). Until then nothing of the new process reaches the fold, so
 * nothing is typed; `blocked:kind=auth` is startup attention at once, and silence past the grace is too.
 */

import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addSession, createWork, hookedSince, transitionSession, updateMap, workPaths } from '@parley/core';
import type { EventData, EventName, SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';
import type { QwenStatus } from '../pty/qwen-terminal.js';
import { createWorksService } from '../works/works-service.js';
import type { WorksService } from '../works/works-service.js';
import { createActivityService, QWEN_STARTUP_ATTENTION, QWEN_STARTUP_NO_STATUS } from './activity-service.js';
import type { ActivityService, ActivityServiceOptions } from './activity-service.js';

let home = '';
let project = '';
let claudeRoot = '';
let codexRoot = '';
let broadcasts: Array<{ event: EventName; data: unknown }>;
let services: Array<{ stop: () => Promise<void> }> = [];

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
  await Promise.all(services.map((service) => service.stop()));
  services = [];
  delete process.env['PARLEY_HOME'];
  await Promise.all([home, project, claudeRoot, codexRoot].map((dir) => rm(dir, { recursive: true, force: true })));
});

async function works(): Promise<WorksService> {
  const service = createWorksService(fakeHost());
  services.push(service);
  await service.start();
  return service;
}

function activity(worksService: WorksService, options: ActivityServiceOptions = {}): ActivityService {
  const service = createActivityService(fakeHost(), worksService, { silenceThresholdMs: 30_000, claudeRoot, codexRoot, ...options });
  services.push(service);
  return service;
}

const waitFor = async (check: () => boolean, timeoutMs = 5000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A hook line as qwen journals it: with its own `timestamp` (now, unless `extra` gives another). */
const hook = (name: string, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ hook_event_name: name, timestamp: new Date().toISOString(), ...extra })}\n`;
const IDLE: QwenStatus = { state: 'idle', kind: null, msg: null };
const WORKING: QwenStatus = { state: 'working', kind: null, msg: null };
const AUTH: QwenStatus = { state: 'blocked', kind: 'auth', msg: 'Authentication required' };

async function qwenSession(): Promise<SessionRef> {
  const map = await createWork(project, { title: 'Work' });
  let sessionId = '';
  await updateMap(project, map.work.id, (current) => {
    const created = addSession(current, { provider: 'qwen', label: 'qwen', task: 'do it' });
    sessionId = created.id;
    created.launchedBy = 'host';
    transitionSession(current, created.id, 'active');
  });
  await mkdir(workPaths(project, map.work.id).events, { recursive: true });
  return { projectPath: project, workId: map.work.id, sessionId };
}

const journal = (ref: SessionRef): string => path.join(workPaths(project, ref.workId).events, `${ref.sessionId}.jsonl`);

/** A started qwen process whose `SessionStart` is in the journal; the clock is the test's. */
async function started(options: ActivityServiceOptions = {}) {
  const ref = await qwenSession();
  const w = await works();
  const clock = { now: Date.now() };
  const a = activity(w, { now: () => clock.now, trustWaitMs: 20_000, ...options });
  await a.start();
  const launched = clock.now;
  a.processStarted(ref);
  await appendFile(journal(ref), hook('SessionStart', { source: 'startup' }));
  // The line is read, but stays out of the fold while the process is not ready.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { ref, a, clock, launched };
}

describe('qwen readiness', () => {
  it('starting → started: SessionStart alone is not ready; nothing counts as hooked', async () => {
    const { ref, a, launched } = await started();
    const act = a.get(ref)?.activity;
    expect(act?.lastEventAt).toBeNull();
    expect(act?.need).toBeNull();
    expect(hookedSince(act, launched)).toBe(false);
  });

  it('idle without the Parley MCP list is not ready; with it the process is ready and its lines count', async () => {
    const { ref, a, launched } = await started();
    a.qwenStatus(ref, IDLE);
    expect(a.get(ref)?.activity.lastEventAt).toBeNull();
    a.mcpListed(ref, a.processGeneration(ref));
    await waitFor(() => a.get(ref)?.activity.lastEventAt != null);
    expect(hookedSince(a.get(ref)?.activity, launched)).toBe(true);
    expect(a.get(ref)?.activity.need).toBeNull();
  });

  it('MCP listed before idle: ready on idle', async () => {
    const { ref, a } = await started();
    a.mcpListed(ref, a.processGeneration(ref));
    expect(a.get(ref)?.activity.lastEventAt).toBeNull();
    a.qwenStatus(ref, IDLE);
    await waitFor(() => a.get(ref)?.activity.lastEventAt != null);
  });

  it('blocked:kind=auth is startup attention at once, before the grace; idle + MCP later clears it', async () => {
    const { ref, a } = await started();
    a.qwenStatus(ref, AUTH);
    expect(a.get(ref)?.activity).toMatchObject({ activity: 'blocked', need: { kind: 'startup', detail: QWEN_STARTUP_ATTENTION } });
    expect(hookedSince(a.get(ref)?.activity, Date.now() + 60_000)).toBe(false);
    a.qwenStatus(ref, IDLE);
    a.mcpListed(ref, a.processGeneration(ref));
    await waitFor(() => a.get(ref)?.activity.need === null);
    expect(a.get(ref)?.activity.activity).not.toBe('blocked');
  });

  it('past the grace with status but not ready: attention with the sign-in-or-dialog text', async () => {
    const { ref, a, clock, launched } = await started();
    a.qwenStatus(ref, WORKING);
    clock.now = launched + 19_999;
    a.markSeen(ref);
    expect(a.get(ref)?.activity.need).toBeNull();
    clock.now = launched + 20_000;
    a.markSeen(ref);
    expect(a.get(ref)?.activity).toMatchObject({ activity: 'blocked', need: { kind: 'startup', detail: QWEN_STARTUP_ATTENTION } });
  });

  it('past the grace without any OSC 7501 (another qwen version): attention, never ready', async () => {
    const { ref, a, clock, launched } = await started();
    a.mcpListed(ref, a.processGeneration(ref));
    clock.now = launched + 20_000;
    a.markSeen(ref);
    expect(a.get(ref)?.activity).toMatchObject({ activity: 'blocked', need: { kind: 'startup', detail: QWEN_STARTUP_NO_STATUS } });
  });

  it('a real prompt in the journal is readiness evidence; Qwen\'s empty follow-up is not', async () => {
    const { ref, a } = await started();
    await appendFile(journal(ref), hook('UserPromptSubmit', { prompt: '' }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(a.get(ref)?.activity.lastEventAt).toBeNull();
    await appendFile(journal(ref), hook('UserPromptSubmit', { prompt: 'hello' }));
    await waitFor(() => a.get(ref)?.activity.activity === 'working');
  });

  it.each(['idle_prompt', 'auth_success'])('Notification %s is readiness evidence', async (type) => {
    const { ref, a } = await started();
    await appendFile(journal(ref), hook('Notification', { notification_type: type }));
    await waitFor(() => a.get(ref)?.activity.lastEventAt != null);
  });

  it('a new process generation forgets the previous one: its idle and MCP list do not count', async () => {
    const { ref, a } = await started();
    a.qwenStatus(ref, IDLE);
    a.mcpListed(ref, a.processGeneration(ref));
    await waitFor(() => a.get(ref)?.activity.lastEventAt != null);
    const before = a.get(ref)?.activity.lastEventAt;
    a.processStarted(ref);
    await appendFile(journal(ref), hook('SessionStart', { source: 'resume' }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(a.get(ref)?.activity.lastEventAt).toBe(before);
    a.qwenStatus(ref, IDLE);
    expect(a.get(ref)?.activity.lastEventAt).toBe(before);
    a.mcpListed(ref, a.processGeneration(ref));
    await waitFor(() => a.get(ref)?.activity.lastEventAt !== before);
  });

  it('a delayed read of the old journal after a fast resume does not make the replacement ready', async () => {
    const { ref, a, clock } = await started();
    // The old process wrote input and idle, but the host had not read them yet when the replacement was spawned.
    const old = new Date(clock.now - 5_000).toISOString();
    a.processStarted(ref);
    const before = a.get(ref)?.activity.lastEventAt;
    await appendFile(
      journal(ref),
      hook('UserPromptSubmit', { prompt: 'old', timestamp: old }) +
        hook('Notification', { notification_type: 'idle_prompt', timestamp: old }) +
        hook('SessionStart', { source: 'resume' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Read past the cached length and stamped by the file's fresh mtime, the old lines would have passed for new ones.
    expect(a.get(ref)?.activity.lastEventAt).toBe(before);
    expect(a.get(ref)?.activity.activity).not.toBe('working');
    expect(a.get(ref)?.activity.need).toBeNull();
    // The replacement's own input is readiness.
    await appendFile(journal(ref), hook('UserPromptSubmit', { prompt: 'hello' }));
    await waitFor(() => a.get(ref)?.activity.activity === 'working');
  });

  it('an MCP list of a replaced process generation does not certify its successor', async () => {
    const { ref, a } = await started();
    const previous = a.processGeneration(ref);
    a.processStarted(ref);
    expect(a.processGeneration(ref)).not.toBe(previous);
    await appendFile(journal(ref), hook('SessionStart', { source: 'resume' }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = a.get(ref)?.activity.lastEventAt;
    a.qwenStatus(ref, IDLE);
    // The old process's list request finishes after the restart.
    a.mcpListed(ref, previous);
    a.mcpListed(ref, null);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(a.get(ref)?.activity.lastEventAt).toBe(before);
    a.mcpListed(ref, a.processGeneration(ref));
    await waitFor(() => a.get(ref)?.activity.lastEventAt !== before);
  });

  it('a status report with no started process is ignored', async () => {
    const ref = await qwenSession();
    const a = activity(await works());
    await a.start();
    a.qwenStatus(ref, AUTH);
    expect(a.get(ref)?.activity.need ?? null).toBeNull();
  });

  it('ready: the hook mapping drives the turn (busy → idle)', async () => {
    const { ref, a } = await started();
    a.qwenStatus(ref, IDLE);
    a.mcpListed(ref, a.processGeneration(ref));
    await appendFile(journal(ref), hook('UserPromptSubmit', { prompt: 'brief' }));
    await waitFor(() => a.get(ref)?.activity.activity === 'working');
    await appendFile(journal(ref), hook('Stop', { context_usage: 0.1, context_limit: 1000 }) + hook('Notification', { notification_type: 'idle_prompt' }));
    await waitFor(() => a.get(ref)?.activity.activity === 'unseen');
  });
});
