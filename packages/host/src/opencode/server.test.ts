import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRef } from '@parley/protocol';
import type { Log } from '../log.js';
import { createOpencodeSupervisor, defaultLifeline, lstartOf, type OpencodeSupervisor, type PsRunner } from './server.js';

const STUB = fileURLToPath(new URL('../../test/stub-opencode.mjs', import.meta.url));
const LAB = fileURLToPath(new URL('../../../../tools/opencode-mock-lab/recorded/', import.meta.url));
const SERVER_ENV = { OPENCODE_CONFIG_CONTENT: '{"autoupdate":false}', OPENCODE_DISABLE_AUTOUPDATE: '1' };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function gone(pid: number, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > until) return false;
    await sleep(20);
  }
  return true;
}

interface Logged { level: string; msg: string; data?: object }
function captureLog(): Log & { lines: Logged[] } {
  const lines: Logged[] = [];
  return {
    lines,
    info: (msg, data) => lines.push({ level: 'info', msg, ...(data === undefined ? {} : { data }) }),
    warn: (msg, data) => lines.push({ level: 'warn', msg, ...(data === undefined ? {} : { data }) }),
    error: (msg, data) => lines.push({ level: 'error', msg, ...(data === undefined ? {} : { data }) }),
  };
}

let dir: string;
let pidFile: string;
let supervisors: OpencodeSupervisor[];
let strays: ChildProcess[];
const ref: SessionRef = { projectPath: '/project', workId: 'w-0001', sessionId: 's-01' };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'parley-opencode-'));
  pidFile = path.join(dir, 'pids');
  supervisors = [];
  strays = [];
});

afterEach(async () => {
  await Promise.all(supervisors.map((supervisor) => supervisor.stopAll()));
  for (const child of strays) {
    try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  // Nothing a test started may outlive it.
  for (const pid of await pidsOf()) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  await rm(dir, { recursive: true, force: true });
});

async function pidsOf(role?: string): Promise<number[]> {
  if (!existsSync(pidFile)) return [];
  return (await readFile(pidFile, 'utf8')).split('\n').filter(Boolean)
    .map((line) => line.split(' '))
    .filter(([name]) => role === undefined || name === role)
    .map(([, pid]) => Number(pid));
}

function supervisor(options: Partial<Parameters<typeof createOpencodeSupervisor>[0]> = {}): OpencodeSupervisor & { log: Logged[] } {
  const log = captureLog();
  const created = createOpencodeSupervisor({ home: dir, log, readyTimeoutMs: 5000, graceMs: 300, ...options });
  supervisors.push(created);
  return Object.assign(created, { log: log.lines });
}

function request(env: Record<string, string> = {}) {
  return {
    binary: STUB,
    cwd: dir,
    env: { PATH: process.env.PATH, STUB_OPENCODE_PID_FILE: pidFile, ...env },
    serverEnv: SERVER_ENV,
  };
}

const auth = (password: string): string => `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

describe('OpenCode server supervisor (O5)', () => {
  it('1. start: a loopback server that answers /api/info only with the session password; the run file has no secret', async () => {
    const envFile = path.join(dir, 'server-env.json');
    const sup = supervisor();
    const server = await sup.start(ref, request({ STUB_OPENCODE_ENV_FILE: envFile }));
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.password.length).toBeGreaterThanOrEqual(40);
    expect((await fetch(`${server.url}/api/info`, { headers: { authorization: auth(server.password) } })).status).toBe(200);
    expect((await fetch(`${server.url}/api/info`, { headers: { authorization: auth('wrong') } })).status).toBe(401);
    const env = JSON.parse(await readFile(envFile, 'utf8')) as { names: string[]; passwordSet: boolean; config: string };
    expect(env.passwordSet).toBe(true);
    expect(env.config).toBe(SERVER_ENV.OPENCODE_CONFIG_CONTENT);
    expect(env.names).toContain('OPENCODE_DISABLE_AUTOUPDATE');
    const records = JSON.parse(await readFile(sup.runFile(), 'utf8')) as Array<Record<string, unknown>>;
    expect(records).toEqual([{ workId: 'w-0001', sessionId: 's-01', pid: server.pid, pgid: server.pid, lstart: expect.any(String) }]);
    const port = new URL(server.url).port;
    expect(JSON.stringify(records)).not.toContain(server.password);
    expect(JSON.stringify(records)).not.toContain(port);
    expect(sup.get(ref)).toEqual(server);
  });

  it('2. a server that exits with "address in use" before it is ready is retried', async () => {
    const sup = supervisor();
    const server = await sup.start(ref, request({ STUB_OPENCODE_SERVE_MODE: `addr-in-use-once=${path.join(dir, 'marker')}` }));
    expect((await fetch(`${server.url}/api/info`, { headers: { authorization: auth(server.password) } })).status).toBe(200);
    expect(sup.log.some((line) => line.msg.includes('address in use') && (line.data as { attempt: number }).attempt === 1)).toBe(true);
  });

  it('3. a server that never answers: the start fails after the timeout and nothing is left running or recorded', async () => {
    const sup = supervisor({ readyTimeoutMs: 800 });
    await expect(sup.start(ref, request({ STUB_OPENCODE_SERVE_MODE: 'never-ready', STUB_OPENCODE_CHILD: '1' })))
      .rejects.toThrow(/did not answer within 1 s/);
    for (const pid of await pidsOf()) expect(await gone(pid)).toBe(true);
    expect(JSON.parse(await readFile(sup.runFile(), 'utf8'))).toEqual([]);
    expect(sup.get(ref)).toBeUndefined();
  });

  it('4. a server crash: onExit with a readable reason, its group gone, its record removed', async () => {
    const sup = supervisor();
    const exits: Array<{ ref: SessionRef; reason: string; code: number | null }> = [];
    sup.onExit((exitRef, exit) => exits.push({ ref: exitRef, reason: exit.reason, code: exit.code }));
    const server = await sup.start(ref, request({ STUB_OPENCODE_SERVE_MODE: 'crash-after=200', STUB_OPENCODE_CHILD: '1' }));
    await vi.waitFor(() => expect(exits).toHaveLength(1), { timeout: 5000 });
    expect(exits[0]).toMatchObject({ ref, reason: 'the OpenCode server of this session stopped unexpectedly' });
    expect(exits[0]?.reason).not.toContain(server.password);
    for (const pid of [server.pid, ...await pidsOf()]) expect(await gone(pid)).toBe(true);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(sup.runFile(), 'utf8'))).toEqual([]));
    expect(sup.get(ref)).toBeUndefined();
  });

  it('5. a planned stop (TUI exit) ends the whole group, a differently named child too, and runs the last poll first', async () => {
    const order: string[] = [];
    const sup = supervisor({
      beforeStop: async (stopRef, server) => {
        order.push(`poll ${stopRef.sessionId} ${alive(server.pid)}`);
      },
    });
    const exits: unknown[] = [];
    sup.onExit((exitRef) => exits.push(exitRef));
    const server = await sup.start(ref, request({ STUB_OPENCODE_CHILD: '1' }));
    const [child] = await pidsOf('child');
    expect(child !== undefined && alive(child)).toBe(true);
    await sup.stop(ref);
    order.push('stopped');
    expect(order).toEqual(['poll s-01 true', 'stopped']);
    for (const pid of [server.pid, ...await pidsOf()]) expect(alive(pid)).toBe(false);
    expect(exits).toEqual([]);
    expect(JSON.parse(await readFile(sup.runFile(), 'utf8'))).toEqual([]);
  });

  it('5b. a server that ignores SIGTERM is killed after the grace period', async () => {
    const sup = supervisor({ graceMs: 200 });
    await sup.start(ref, request({ STUB_OPENCODE_IGNORE_TERM: '1' }));
    const [serve] = await pidsOf('serve');
    await sup.stop(ref);
    expect(alive(serve!)).toBe(false);
  });

  it('6. resume: a new server with a new password; an old server of the same session is stopped first (exactly one)', async () => {
    const sup = supervisor();
    const first = await sup.start(ref, request());
    const second = await sup.start(ref, request());
    expect(second.password).not.toBe(first.password);
    expect(second.pid).not.toBe(first.pid);
    expect(alive(first.pid)).toBe(false);
    const serves = (await pidsOf('serve')).filter(alive);
    expect(serves).toHaveLength(1);
    const records = JSON.parse(await readFile(sup.runFile(), 'utf8')) as Array<{ pid: number }>;
    expect(records.map((item) => item.pid)).toEqual([second.pid]);
  });
});

describe('host-first death (O5 criterion 7)', () => {
  /** A lifeline started the way the supervisor starts it, held by the test instead of a host. */
  function lifeline(env: Record<string, string> = {}): ChildProcess {
    const { command, args } = defaultLifeline();
    const child = spawn(command, [...args, '300', STUB, 'serve', '--hostname', '127.0.0.1', '--port', '0'], {
      env: { PATH: process.env.PATH, OPENCODE_SERVER_PASSWORD: 'p', STUB_OPENCODE_PID_FILE: pidFile, STUB_OPENCODE_CHILD: '1', ...env },
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    strays.push(child);
    return child;
  }
  async function listening(child: ChildProcess): Promise<void> {
    await new Promise<void>((resolve) => {
      child.stdout?.on('data', (chunk: Buffer) => { if (chunk.toString().includes('server listening on')) resolve(); });
    });
    await vi.waitFor(async () => expect(await pidsOf('child')).toHaveLength(1));
  }

  it('closing the lifeline stdin, as on host death, kills the whole group, a differently named child included', async () => {
    const child = lifeline();
    await listening(child);
    const pids = [child.pid!, ...await pidsOf()];
    expect(pids.every(alive)).toBe(true);
    child.stdin?.destroy();
    for (const pid of pids) expect(await gone(pid)).toBe(true);
  });

  it('the backstop sweep kills a lifeline left alive with the same start time, leaves a reused pid alone, and runs only `ps -o lstart=`', async () => {
    const left = lifeline();
    await listening(left);
    // A pid now used by another program: alive, but recorded with another start time.
    const other = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
    strays.push(other);
    const calls: string[][] = [];
    const spy: PsRunner = async (args) => {
      calls.push([...args]);
      return (await import('node:child_process')).execFileSync('ps', [...args], { env: { ...process.env, LC_ALL: 'C' } }).toString();
    };
    const lstart = await lstartOf(left.pid!, spy);
    expect(lstart).not.toBeNull();
    const file = path.join(dir, 'run', 'opencode-servers.json');
    await (await import('node:fs/promises')).mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify([
      { workId: 'w-0001', sessionId: 's-01', pid: left.pid, pgid: left.pid, lstart },
      { workId: 'w-0001', sessionId: 's-02', pid: other.pid, pgid: other.pid, lstart: 'Mon Jan  1 00:00:00 2001' },
    ]));
    const groupPids = [left.pid!, ...await pidsOf()];
    calls.length = 0;
    const sup = supervisor({ ps: spy });
    expect(await sup.sweep()).toEqual({ killed: 1, skipped: 1 });
    for (const pid of groupPids) expect(await gone(pid)).toBe(true);
    expect(alive(other.pid!)).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([]);
    // Only the start time of the two recorded pids; never an environment (`e`, `eww`, `-E`) or a command line.
    expect(calls).toEqual([['-o', 'lstart=', '-p', String(left.pid)], ['-o', 'lstart=', '-p', String(other.pid)]]);
    for (const call of calls) expect(call.some((arg) => /^-?[a-zA-Z]*e/.test(arg) && arg !== 'lstart=')).toBe(false);
  });

  it('after a sweep, a resumed session has exactly one server', async () => {
    const left = lifeline();
    await listening(left);
    const sup = supervisor();
    const lstart = await lstartOf(left.pid!);
    const file = sup.runFile();
    await (await import('node:fs/promises')).mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify([{ workId: ref.workId, sessionId: ref.sessionId, pid: left.pid, pgid: left.pid, lstart }]));
    await sup.sweep();
    const server = await sup.start(ref, request());
    expect((await pidsOf('serve')).filter(alive)).toHaveLength(1);
    expect((JSON.parse(await readFile(file, 'utf8')) as Array<{ pid: number }>).map((item) => item.pid)).toEqual([server.pid]);
  });
});

describe('exposure (O5 criteria 8–9)', () => {
  it('the server listens on 127.0.0.1 only and its unauthenticated pages carry no identifier or secret', async () => {
    const sup = supervisor();
    const server = await sup.start(ref, request());
    const { hostname, port } = new URL(server.url);
    expect(hostname).toBe('127.0.0.1');
    // Not on the other loopback family or another interface.
    await expect(fetch(`http://[::1]:${port}/health`)).rejects.toThrow();
    const forbidden = [ref.sessionId, server.password, dir, userInfo().username];
    for (const page of ['/health', '/doc']) {
      const body = await (await fetch(`${server.url}${page}`)).text();
      for (const value of forbidden) expect(body).not.toContain(value);
    }
  });

  it('the recorded /health and /doc bodies of the mock lab carry no session id, password, working directory or user name', async () => {
    for (const name of ['health.head.txt', 'doc.head.txt']) {
      const body = await readFile(path.join(LAB, name), 'utf8');
      expect(body).toMatch(/<!doctype html>/i);
      expect(body).not.toMatch(/ses_[A-Za-z0-9]/);
      expect(body).not.toMatch(/OPENCODE_SERVER_PASSWORD|password/i);
      expect(body).not.toContain(userInfo().username);
      expect(body).not.toMatch(/\/Users\/|\/home\//);
    }
  });

  it('the password never reaches the log or the run file over a full start, crash and stop cycle', async () => {
    const sup = supervisor();
    const first = await sup.start(ref, request({ STUB_OPENCODE_SERVE_MODE: 'crash-after=150' }));
    await vi.waitFor(() => expect(sup.get(ref)).toBeUndefined(), { timeout: 5000 });
    const second = await sup.start(ref, request());
    const during = await readFile(sup.runFile(), 'utf8');
    await sup.stop(ref);
    const text = [JSON.stringify(sup.log), during, await readFile(sup.runFile(), 'utf8')].join('\n');
    for (const server of [first, second]) {
      expect(text).not.toContain(server.password);
      expect(text).not.toContain(server.url);
    }
  });
});
