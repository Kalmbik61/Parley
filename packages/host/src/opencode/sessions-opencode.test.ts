import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWork, parleyHome, readMap, workPaths } from '@parley/core';
import type { EventData, EventName, SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import type { Log } from '../log.js';
import type { ProviderVersions } from '../providers/versions.js';
import { createPtyManager } from '../pty/pty-manager.js';
import { createSessionsService } from '../sessions/sessions-service.js';
import type { WorksService } from '../works/works-service.js';
import { createOpencodeBridge } from './events.js';
import { createOpencodeSupervisor, type OpencodeSupervisor } from './server.js';

const STUB = fileURLToPath(new URL('../../test/stub-opencode.mjs', import.meta.url));

let broadcasts: Array<{ event: EventName; data: EventData<EventName> }> = [];
let logLines: string[] = [];
const log: Log = {
  info: (msg, data) => logLines.push(JSON.stringify({ msg, data })),
  warn: (msg, data) => logLines.push(JSON.stringify({ msg, data })),
  error: (msg, data) => logLines.push(JSON.stringify({ msg, data })),
};

function fakeHost(): HostContext {
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log,
    clients: () => [],
    liveSessions: () => 0,
    broadcast: (event, data) => broadcasts.push({ event, data: data as EventData<EventName> }),
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
  };
}
function fakeWorks(): WorksService {
  return {
    start: async () => {},
    snapshot: () => ({ entries: [], branches: {} }),
    entry: () => undefined,
    firstReadDone: () => false,
    onChange: () => () => {},
    stop: async () => {},
  };
}
function fakeActivity(): ActivityService {
  return { start: async () => {}, get: () => undefined, markSeen: () => {}, onChange: () => () => {}, stop: async () => {} };
}
const versions: ProviderVersions = { ready: Promise.resolve(), get: () => '2.2.7', fresh: async () => '2.2.7' };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function gone(pid: number, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > until) return false;
    await sleep(20);
  }
  return true;
}

let project = '';
let scratch = '';
let envKeys: string[] = [];
let supervisor: OpencodeSupervisor;
let passwords: string[] = [];
const setEnv = (key: string, value: string): void => {
  process.env[key] = value;
  envKeys.push(key);
};

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'parley-opencode-project-'));
  scratch = await mkdtemp(path.join(tmpdir(), 'parley-opencode-scratch-'));
  broadcasts = [];
  logLines = [];
  passwords = [];
  setEnv('PARLEY_OPENCODE_BIN', STUB);
  setEnv('PARLEY_SKILL_NAVIGATOR', '0');
  setEnv('STUB_OPENCODE_PID_FILE', path.join(scratch, 'pids'));
  setEnv('STUB_OPENCODE_ARGS_FILE', path.join(scratch, 'tui.json'));
  const real = createOpencodeSupervisor({ home: parleyHome(), log, graceMs: 300, readyTimeoutMs: 5000 });
  // Records the passwords the test then greps for; the service sees the same object.
  supervisor = {
    ...real,
    start: async (ref, request) => {
      const server = await real.start(ref, request);
      passwords.push(server.password);
      return server;
    },
  };
});

afterEach(async () => {
  await supervisor.stopAll();
  for (const pid of await pids()) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  for (const key of envKeys) delete process.env[key];
  envKeys = [];
  await rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(scratch, { recursive: true, force: true });
});

async function pids(role?: string): Promise<number[]> {
  const file = path.join(scratch, 'pids');
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => line.split(' '))
    .filter(([name]) => role === undefined || name === role).map(([, pid]) => Number(pid));
}

interface Tui { argv: string[]; server: string; session: string; passwordSet: boolean; passwordDigest: string; configSet: boolean; infoStatus: number }
async function tui(): Promise<Tui> {
  const file = path.join(scratch, 'tui.json');
  await vi.waitFor(async () => expect(existsSync(file)).toBe(true), { timeout: 10_000 });
  return JSON.parse(await readFile(file, 'utf8')) as Tui;
}

async function setup() {
  const pty = createPtyManager(fakeHost());
  const service = createSessionsService(fakeHost(), fakeWorks(), pty, fakeActivity(), { providerVersions: versions, opencode: supervisor });
  const work = await createWork(project, { title: 'Work', goal: '' });
  const ref = await service.create({ projectPath: project, workId: work.work.id, provider: 'opencode', label: 'oc', task: '', parent: null });
  return { pty, service, ref };
}

async function session(ref: SessionRef) {
  return (await readMap(ref.projectPath, ref.workId)).sessions.find((candidate) => candidate.id === ref.sessionId)!;
}

/** Every file under a directory, as bytes: the grep of criterion 9. */
async function filesUnder(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    const full = path.join(entry.parentPath, entry.name);
    if (entry.isFile() && (await stat(full)).size < 64 * 1024 * 1024) out.push(full);
  }
  return out;
}

describe('OpenCode sessions with the host server (O5)', () => {
  it('start: the TUI attaches to its own loopback server with the password and a Parley session id; stop ends the server', async () => {
    const { pty, service, ref } = await setup();
    const started = await tui();
    expect(started.server).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(started.argv).toEqual(['--server', started.server, '-s', expect.stringMatching(/^ses_[0-9a-f-]{36}$/), '--auto']);
    expect(started.passwordSet).toBe(true);
    expect(started.infoStatus).toBe(200);
    // The config documents go to the server, not to the TUI.
    expect(started.configSet).toBe(false);
    expect((await session(ref)).providerSessionId).toBe(started.session);
    const [serve] = await pids('serve');
    expect(alive(serve!)).toBe(true);
    await service.stop(ref);
    expect(pty.get(ref)).toBeUndefined();
    expect(alive(serve!)).toBe(false);
    expect(JSON.parse(await readFile(path.join(parleyHome(), 'run', 'opencode-servers.json'), 'utf8'))).toEqual([]);
  });

  it('5. the TUI exits by itself: the server group goes too (checked by pid)', async () => {
    setEnv('STUB_OPENCODE_CHILD', '1');
    const { pty, ref } = await setup();
    await tui();
    const group = (await pids()).filter((pid) => pid !== 0);
    pty.write(ref, 'STUB_EXIT\r');
    await vi.waitFor(() => expect(pty.get(ref)).toBeUndefined(), { timeout: 10_000 });
    for (const pid of group) expect(await gone(pid)).toBe(true);
  });

  it('6. resume: the same ses_ id with a new server and a new password', async () => {
    const { service, ref } = await setup();
    const first = await tui();
    await service.stop(ref);
    await rm(path.join(scratch, 'tui.json'));
    await service.launch(ref, 'resume', { by: 'human' });
    const second = await tui();
    expect(second.session).toBe(first.session);
    expect(second.argv.slice(2, 4)).toEqual(['-s', first.session]);
    expect(second.server).not.toBe(first.server);
    expect(second.passwordDigest).not.toBe(first.passwordDigest);
    expect((await pids('serve')).filter(alive)).toHaveLength(1);
    await service.stop(ref);
  });

  it('4. a server crash with a live TUI: the session is failed with a readable reason and the TUI is stopped', async () => {
    setEnv('STUB_OPENCODE_SERVE_MODE', 'crash-after=700');
    const { pty, ref } = await setup();
    await tui();
    await vi.waitFor(() => expect(pty.get(ref)).toBeUndefined(), { timeout: 10_000 });
    await vi.waitFor(async () => expect((await session(ref)).result).toBe('failed'), { timeout: 5000 });
    const notice = broadcasts.find((item) => item.event === 'host.notice' && (item.data as { kind: string }).kind === 'launch-failed');
    expect((notice?.data as { text: string } | undefined)?.text).toMatch(/stopped unexpectedly \(exit code 3\)\. Resume it/);
  });

  it('3. a server that never answers: the launch fails readably and no TUI or server is left', async () => {
    setEnv('STUB_OPENCODE_SERVE_MODE', 'never-ready');
    const pty = createPtyManager(fakeHost());
    const quick = createOpencodeSupervisor({ home: parleyHome(), log, graceMs: 200, readyTimeoutMs: 600 });
    const service = createSessionsService(fakeHost(), fakeWorks(), pty, fakeActivity(), { providerVersions: versions, opencode: quick });
    const work = await createWork(project, { title: 'Work', goal: '' });
    await expect(service.create({ projectPath: project, workId: work.work.id, provider: 'opencode', label: 'oc', task: '', parent: null }))
      .rejects.toThrow(/did not answer within 1 s/);
    expect(pty.list()).toEqual([]);
    for (const pid of await pids()) expect(await gone(pid)).toBe(true);
  });

  it('9. the password never reaches the map, the journal, the run file or the log', async () => {
    const { service, ref } = await setup();
    await tui();
    const runDuring = await readFile(path.join(parleyHome(), 'run', 'opencode-servers.json'), 'utf8');
    await service.stop(ref);
    await service.launch(ref, 'resume', { by: 'human' });
    await vi.waitFor(() => expect(passwords).toHaveLength(2));
    await service.stop(ref);
    expect(passwords).toHaveLength(2);
    const files = [...await filesUnder(project), ...await filesUnder(parleyHome())];
    expect(files.some((file) => file.endsWith('opencode-servers.json'))).toBe(true);
    const haystacks = [runDuring, logLines.join('\n'), JSON.stringify(broadcasts), JSON.stringify(await session(ref))];
    for (const file of files) haystacks.push((await readFile(file)).toString('latin1'));
    for (const password of passwords) {
      for (const text of haystacks) expect(text.includes(password)).toBe(false);
    }
  });

  it('O6: the event bridge follows the session: the readiness SessionStart in its journal and the hook chain; detached on exit', async () => {
    const hooked: Array<Record<string, unknown>> = [];
    const bridge = createOpencodeBridge({ log, hook: (request) => hooked.push(request.body), mcpPollMs: 50 });
    const pty = createPtyManager(fakeHost());
    const service = createSessionsService(fakeHost(), fakeWorks(), pty, fakeActivity(), { providerVersions: versions, opencode: supervisor, opencodeEvents: bridge });
    const work = await createWork(project, { title: 'Work', goal: '' });
    const ref = await service.create({ projectPath: project, workId: work.work.id, provider: 'opencode', label: 'oc', task: '', parent: null });
    const started = await tui();
    const journal = path.join(workPaths(ref.projectPath, ref.workId).events, `${ref.sessionId}.jsonl`);
    await vi.waitFor(async () => expect(existsSync(journal)).toBe(true), { timeout: 5000 });
    const first = JSON.parse((await readFile(journal, 'utf8')).split('\n')[0]!) as Record<string, unknown>;
    expect(first).toMatchObject({ hook_event_name: 'SessionStart', source: 'startup', session_id: started.session });
    expect(hooked[0]).toEqual(first);
    expect(bridge.ready(ref)).toBe(true);
    await service.stop(ref);
    expect(bridge.ready(ref)).toBe(false);
    expect(bridge.connections(ref)).toBe(0);
  });
});
