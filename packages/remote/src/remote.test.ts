import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { controlStatusResult } from '@parley/protocol/remote';
import { createAuditLog } from './audit.js';
import { ControlError, createControlServer } from './control.js';
import type { ControlServer } from './control.js';
import { ensureDir, writeFileAtomic } from './files.js';
import { createLog } from './log.js';
import { remotePaths } from './paths.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'pr-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const mode = async (p: string) => (await stat(p)).mode & 0o777;

describe('files', () => {
  it('creates the dir 0700 and files 0600; an interrupted write keeps the old file', async () => {
    const paths = remotePaths(home);
    await writeFileAtomic(paths.remoteJson, 'old');
    expect(await mode(paths.dir)).toBe(0o700);
    expect(await mode(paths.remoteJson)).toBe(0o600);
    await expect(
      writeFileAtomic(paths.remoteJson, 'new', {
        beforeRename: () => {
          throw new Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    expect(await readFile(paths.remoteJson, 'utf8')).toBe('old');
    expect(await readdir(paths.dir)).toEqual(['remote.json']);
    await writeFileAtomic(paths.remoteJson, 'new');
    expect(await readFile(paths.remoteJson, 'utf8')).toBe('new');
  });

  it('tightens an existing directory to 0700', async () => {
    const dir = path.join(home, 'x');
    await ensureDir(dir);
    await ensureDir(dir);
    expect(await mode(dir)).toBe(0o700);
  });
});

describe('audit', () => {
  it('rotates at 5 MB keeping the last archive, and tails across it', async () => {
    const paths = remotePaths(home);
    const audit = createAuditLog({ file: paths.audit, archive: paths.auditArchive, maxBytes: 5 * 1024 * 1024 });
    const detail = 'x'.repeat(100_000);
    for (let i = 0; i < 60; i++) audit.append({ kind: 'call', outcome: detail, detail: `${i}:` });
    const size = (await stat(paths.audit)).size;
    expect(size).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect((await stat(paths.auditArchive)).size).toBeGreaterThan(0);
    expect(await mode(paths.audit)).toBe(0o600);
    const tail = audit.tail(3);
    expect(tail).toHaveLength(3);
    expect(tail.at(-1)?.detail?.startsWith('59:')).toBe(true);
  });

  it('clips detail and target to 256 characters', () => {
    const paths = remotePaths(home);
    const audit = createAuditLog({ file: paths.audit, archive: paths.auditArchive });
    audit.append({ kind: 'call', outcome: 'ok', detail: 'd'.repeat(5000), target: 't'.repeat(5000) });
    const [record] = audit.tail(1);
    expect(record!.detail!.length).toBeLessThanOrEqual(257);
    expect(record!.target!.length).toBeLessThanOrEqual(257);
  });
});

describe('control socket', () => {
  let server: ControlServer;
  let stopped = 0;
  const pushed: unknown[] = [];
  let sockPath: string;
  let token: string;

  beforeEach(async () => {
    const paths = remotePaths(home);
    sockPath = paths.controlSocket;
    stopped = 0;
    const log = createLog({ file: paths.log });
    server = createControlServer({
      socketPath: paths.controlSocket,
      tokenPath: paths.controlToken,
      audit: createAuditLog({ file: paths.audit, archive: paths.auditArchive }),
      log,
      callbacks: {
        status: () => ({ running: true, host: 'online', relay: 'connected', relayUrl: null, devices: 0, version: '1' }),
        configure: async () => {},
        presence: () => {},
        pushTest: async (params) => {
          pushed.push(params);
        },
        stop: () => {
          stopped++;
        },
      },
    });
    await server.start();
    token = await readFile(paths.controlToken, 'utf8');
  });
  afterEach(async () => {
    await server.close();
  });

  async function connect() {
    const socket = net.connect(sockPath);
    await new Promise<void>((r) => socket.once('connect', () => r()));
    let buf = '';
    const waiters: Array<(m: Record<string, unknown>) => void> = [];
    const queue: Array<Record<string, unknown>> = [];
    socket.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
        buf = buf.slice(i + 1);
        const w = waiters.shift();
        if (w) w(msg);
        else queue.push(msg);
      }
    });
    return {
      socket,
      send: (m: unknown) => socket.write(`${JSON.stringify(m)}\n`),
      next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise<Record<string, unknown>>((r) => waiters.push(r))),
    };
  }

  async function authed() {
    const c = await connect();
    c.send({ id: 1, method: 'hello', params: { token } });
    expect(await c.next()).toEqual({ id: 1, result: { ok: true } });
    return c;
  }

  it('files: token 0600, socket 0600', async () => {
    const paths = remotePaths(home);
    expect(await mode(paths.controlToken)).toBe(0o600);
    expect(await mode(paths.controlSocket)).toBe(0o600);
  });

  it('rejects a wrong token and answers status with the A1 schema', async () => {
    const bad = await connect();
    bad.send({ id: 1, method: 'hello', params: { token: 'nope' } });
    const reply = await bad.next();
    expect((reply.error as { code: string }).code).toBe('unauthorized');
    bad.socket.destroy();

    const c = await authed();
    c.send({ id: 2, method: 'status' });
    const status = await c.next();
    expect(controlStatusResult.safeParse(status.result).success).toBe(true);
    c.socket.destroy();
  });

  it('rejects requests before hello', async () => {
    const c = await connect();
    c.send({ id: 1, method: 'status' });
    expect(((await c.next()).error as { code: string }).code).toBe('unauthorized');
    c.socket.destroy();
  });

  it('devices.revoke: not_ready without a handler; with a handler the reply follows its completion', async () => {
    const c = await authed();
    const deviceId = 'A'.repeat(22);
    c.send({ id: 2, method: 'devices.revoke', params: { deviceId } });
    expect(((await c.next()).error as { code: string }).code).toBe('not_ready');

    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.register({
      'devices.revoke': async (p) => {
        calls.push(p.deviceId);
        await gate;
        calls.push('done');
      },
    });
    c.send({ id: 3, method: 'devices.revoke', params: { deviceId } });
    let replied = false;
    const pending = c.next().then((m) => {
      replied = true;
      return m;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([deviceId]);
    expect(replied).toBe(false);
    release();
    expect(await pending).toEqual({ id: 3, result: { ok: true } });
    expect(calls).toEqual([deviceId, 'done']);
    c.socket.destroy();
  });

  it('passes ControlError codes through and hides other errors; validates params', async () => {
    server.register({
      'pair.answer': async () => {
        throw new ControlError('stale_request');
      },
      reset: async () => {
        throw new Error('secret-detail');
      },
    });
    const c = await authed();
    c.send({ id: 2, method: 'pair.answer', params: { requestId: 'A'.repeat(22), allow: true } });
    expect(((await c.next()).error as { code: string }).code).toBe('stale_request');
    c.send({ id: 3, method: 'reset' });
    const r = await c.next();
    expect(JSON.stringify(r)).not.toContain('secret-detail');
    c.send({ id: 4, method: 'audit.tail', params: { limit: 999 } });
    expect(((await c.next()).error as { code: string }).code).toBe('bad_request');
    c.send({ id: 5, method: 'nope' });
    expect(((await c.next()).error as { code: string }).code).toBe('unknown_method');
    c.socket.destroy();
  });

  it('stop answers first then calls the callback; events reach authed clients', async () => {
    const c = await authed();
    server.emit('pair.failed', { requestId: 'A'.repeat(22), reason: 'timeout' });
    expect((await c.next()).event).toBe('pair.failed');
    c.send({ id: 2, method: 'stop' });
    expect(await c.next()).toEqual({ id: 2, result: { ok: true } });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(1);
    c.socket.destroy();
  });

  it('m1: requests of one connection run in order; stop waits for requests of other connections', async () => {
    const order: string[] = [];
    let release!: () => void;
    server.register({
      'devices.list': async () => {
        order.push('list-start');
        await new Promise<void>((r) => (release = r));
        order.push('list-end');
        return [];
      },
      'devices.revoke': async () => {
        order.push('revoke');
      },
    });
    const a = await authed();
    a.send({ id: 2, method: 'devices.list' });
    a.send({ id: 3, method: 'devices.revoke', params: { deviceId: 'A'.repeat(22) } });
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(['list-start']); // revoke ждёт
    const b = await authed();
    b.send({ id: 2, method: 'stop' });
    expect((await b.next()).result).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(stopped).toBe(0); // идущий list ещё не закончен
    release();
    expect((await a.next()).id).toBe(2);
    await new Promise((r) => setTimeout(r, 30));
    expect(stopped).toBe(1);
    expect(order[1]).toBe('list-end');
    a.socket.destroy();
    b.socket.destroy();
  });

  it('m2: push.test takes {deviceId}', async () => {
    const c = await authed();
    c.send({ id: 2, method: 'push.test', params: { deviceId: 'A'.repeat(22) } });
    expect((await c.next()).result).toEqual({ ok: true });
    expect(pushed).toEqual([{ deviceId: 'A'.repeat(22) }]);
    c.send({ id: 3, method: 'push.test', params: {} });
    expect(((await c.next()).error as { code: string }).code).toBe('bad_request');
    c.socket.destroy();
  });

  it('m12: a second bridge does not take over a live control socket', async () => {
    const paths = remotePaths(home);
    const second = createControlServer({
      socketPath: paths.controlSocket,
      tokenPath: paths.controlToken,
      audit: createAuditLog({ file: paths.audit, archive: paths.auditArchive }),
      log: createLog({ file: paths.log }),
      callbacks: {
        status: () => ({ running: true, host: 'online', relay: 'connected', relayUrl: null, devices: 0, version: '1' }),
        configure: async () => {},
        presence: () => {},
        pushTest: async () => {},
        stop: () => {},
      },
    });
    await expect(second.start()).rejects.toThrow(/already in use/);
    const c = await authed(); // первый жив и токен прежний
    c.socket.destroy();
  });

  it('m11: a secret on the truncation boundary leaves no prefix in the log', () => {
    const paths = remotePaths(home);
    const log = createLog({ file: paths.log });
    const secret = 'S3CRET-VALUE-0123456789';
    log.addSecret(secret);
    log.info('x', { note: `${'a'.repeat(190)}${secret}` });
    const text = readFileSync(paths.log, 'utf8');
    expect(text).not.toContain('S3CRET');
  });

  it('the run log never contains control.token', async () => {
    server.register({
      reset: async () => {
        throw new Error(`boom ${token}`);
      },
    });
    const c = await authed();
    c.send({ id: 2, method: 'reset' });
    await c.next();
    c.socket.destroy();
    const paths = remotePaths(home);
    createLog({ file: paths.log }).info('x', { token, text: 'hello', note: 'ok' });
    const log = await readFile(paths.log, 'utf8');
    expect(log).toContain('control.handler-failed');
    expect(log).not.toContain(token);
    expect(log).not.toContain('hello');
  });
});
