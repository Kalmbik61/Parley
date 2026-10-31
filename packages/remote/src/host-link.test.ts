import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LineDecoder } from '@parley/protocol';
import { createHostLink, refKey } from './host-link.js';
import type { HostLink } from './host-link.js';
import { createLog } from './log.js';

interface Stub {
  received: { method: string; params: unknown }[];
  worksListCalls: number;
  hellos: unknown[];
  conns: Set<net.Socket>;
  /** Что стаб шлёт сразу после ответа на hello. */
  replay: unknown[];
  features: string[];
  /** Ответ на works.list; функция получает кадр и сокет. */
  onWorksList: (reply: (result: unknown) => void, socket: net.Socket, id: number) => void;
  broadcast(msg: unknown): void;
  close(): Promise<void>;
}

const snap = (revision: number) => ({ entries: [], branches: {}, revision });
const ref = (n: string) => ({ projectPath: '/p', workId: 'w', sessionId: n });
const act = (n: string, activity: string) => ({ event: 'activity.changed', data: { ref: ref(n), activity, metrics: null } });

let dir: string;
let sock: string;
let tokenFile: string;
let logFile: string;
let links: HostLink[];
let stubs: Stub[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'hl-'));
  sock = path.join(dir, 'h.sock');
  tokenFile = path.join(dir, 'host.token');
  logFile = path.join(dir, 'bridge.log');
  await writeFile(tokenFile, 'secret-token-aaaa\n');
  links = [];
  stubs = [];
});
afterEach(async () => {
  for (const l of links) await l.stop();
  for (const s of stubs) await s.close();
  await rm(dir, { recursive: true, force: true });
});

async function startStub(init: Partial<Stub> = {}): Promise<Stub> {
  const stub: Stub = {
    received: [],
    worksListCalls: 0,
    hellos: [],
    conns: new Set(),
    replay: [],
    features: ['remote-policy-1', 'compact-works'],
    onWorksList: (reply) => reply(snap(1)),
    broadcast(msg) {
      for (const c of stub.conns) c.write(`${JSON.stringify(msg)}\n`);
    },
    async close() {
      for (const c of stub.conns) c.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
    ...init,
  };
  const server = net.createServer((c) => {
    stub.conns.add(c);
    c.on('close', () => stub.conns.delete(c));
    c.on('error', () => {});
    const dec = new LineDecoder();
    c.on('data', (chunk) => {
      for (const m of dec.push(chunk) as { id: number; method: string; params: unknown }[]) {
        stub.received.push({ method: m.method, params: m.params });
        const send = (result: unknown) => c.write(`${JSON.stringify({ id: m.id, result })}\n`);
        if (m.method === 'hello') {
          stub.hellos.push(m.params);
          c.write(
            `${JSON.stringify({ id: m.id, result: { features: stub.features } })}\n` +
              stub.replay.map((e) => `${JSON.stringify(e)}\n`).join(''),
          );
        } else if (m.method === 'works.list') {
          stub.worksListCalls++;
          stub.onWorksList(send, c, m.id);
        } else send({ ok: true });
      }
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  stubs.push(stub);
  return stub;
}

function newLink(bootId?: string): HostLink {
  const link = createHostLink({
    socketPath: sock,
    tokenPath: tokenFile,
    log: createLog({ file: logFile }),
    backoff: { initialMs: 10, maxMs: 40 },
    ...(bootId ? { bootId } : {}),
  });
  links.push(link);
  return link;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('HostLink', () => {
  it('hello carries client remote and two features; offline -> reconnect with a fresh token and a new epoch', async () => {
    const link = newLink();
    link.start();
    await until(() => link.status === 'offline' && link.epoch === null); // стаба нет
    let stub = await startStub({ replay: [act('s1', 'busy')] });
    await until(() => link.status === 'online');
    expect(stub.hellos[0]).toMatchObject({
      token: 'secret-token-aaaa',
      client: 'remote',
      features: ['compact-works', 'rooms-mail'],
    });
    const epoch1 = link.epoch;
    expect(link.activity.size).toBe(1);

    await stub.close();
    stubs.pop();
    await until(() => link.status === 'offline');
    expect(link.activity.size).toBe(0);
    await writeFile(tokenFile, 'secret-token-bbbb\n');
    stub = await startStub();
    await until(() => link.status === 'online');
    expect(stub.hellos[0]).toMatchObject({ token: 'secret-token-bbbb' });
    expect(link.epoch).not.toBe(epoch1);
    expect(link.activity.size).toBe(0);
  });

  it('fails closed against a host without remote-policy-1', async () => {
    const stub = await startStub({ features: ['compact-works'] });
    const link = newLink();
    link.start();
    await until(() => link.status === 'incompatible');
    await expect(link.call('sessions.list', {})).rejects.toMatchObject({ code: 'host_offline' });
    expect(stub.received.map((r) => r.method)).toEqual(['hello']);
    expect(stub.worksListCalls).toBe(0);
  });

  it('caches the replay and later activity.changed events; the last per ref wins', async () => {
    const stub = await startStub({ replay: [act('a', 'busy'), act('b', 'busy')] });
    const link = newLink();
    link.start();
    await until(() => link.status === 'online');
    expect(link.activity.size).toBe(2);
    stub.broadcast(act('a', 'idle'));
    stub.broadcast(act('c', 'busy'));
    await until(() => link.activity.size === 3);
    await until(() => (link.activity.get(refKey(ref('a')))?.activity as unknown) === 'idle');
  });

  it('loads the snapshot via works.list: starting -> online; a newer works.changed is not rolled back', async () => {
    let release: (() => void) | undefined;
    const stub = await startStub({
      onWorksList: (reply) => {
        release = () => reply(snap(5));
      },
    });
    const link = newLink();
    link.start();
    await until(() => link.status === 'starting' && stub.worksListCalls === 1);
    expect(link.snapshot).toBeNull();
    stub.broadcast({ event: 'works.changed', data: snap(9) });
    await until(() => link.snapshot?.revision === 9);
    expect(link.status).toBe('starting');
    release?.();
    await until(() => link.status === 'online');
    expect(link.snapshot?.revision).toBe(9);
    await expect(link.call('x.y', {})).resolves.toEqual({ ok: true });
  });

  it('retries works.list on error and stays starting', async () => {
    let n = 0;
    const stub = await startStub({
      onWorksList: (reply, c, id) => {
        if (++n < 3) c.write(`${JSON.stringify({ id, error: { code: 'internal', message: 'x' } })}\n`);
        else reply(snap(2));
      },
    });
    const link = newLink();
    link.start();
    await until(() => stub.worksListCalls >= 1);
    expect(link.status).toBe('starting');
    await until(() => link.status === 'online');
    expect(stub.worksListCalls).toBe(3);
  });

  it('pending calls of a dropped epoch fail with host_offline', async () => {
    const stub = await startStub();
    const link = newLink();
    link.start();
    await until(() => link.status === 'online');
    stub.onWorksList = () => {};
    const p = link.call('hang', {});
    stub.conns.forEach((c) => c.destroy());
    await expect(p).rejects.toMatchObject({ code: 'host_offline' });
  });

  it('epochs differ within a run and between runs', async () => {
    const stub = await startStub();
    const a = newLink();
    a.start();
    await until(() => a.status === 'online');
    const e1 = a.epoch;
    stub.conns.forEach((c) => c.destroy());
    await until(() => a.status === 'offline');
    await until(() => a.status === 'online');
    expect(a.epoch).not.toBe(e1);
    const b = newLink();
    b.start();
    await until(() => b.status === 'online');
    expect(b.epoch).not.toBe(a.epoch);
    expect(b.epoch?.split(':')[0]).not.toBe(a.epoch?.split(':')[0]);
  });

  it('the run log never contains the token', async () => {
    await startStub();
    const link = newLink();
    link.start();
    await until(() => link.status === 'online');
    await link.stop();
    const log = await readFile(logFile, 'utf8').catch(() => '');
    expect(log).not.toContain('secret-token');
    expect(log).not.toContain('host.token');
  });
});
