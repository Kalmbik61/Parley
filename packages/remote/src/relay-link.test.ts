// Critic M1 on A7: the bridge's control socket checks the relay is alive, and a silent relay is cut and redialled.
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { BridgeLog } from './log.js';
import { createRelayLink, type RelayLink, type RelayState } from './relay-link.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until<T>(probe: () => T | undefined | null | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(10);
  }
}

/** A relay stub: answers `hello` with `ok`, and answers pings only while `answering`. */
async function stubRelay() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong: false });
  await new Promise<void>((r) => server.once('listening', () => r()));
  const stub = {
    server,
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hellos: 0,
    pings: 0,
    answering: true,
    sockets: [] as WebSocket[],
  };
  server.on('connection', (ws) => {
    stub.sockets.push(ws);
    ws.on('ping', (data) => {
      stub.pings += 1;
      if (stub.answering) ws.pong(data);
    });
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { t: string };
      if (frame.t === 'hello') {
        stub.hellos += 1;
        ws.send(JSON.stringify({ v: 1, t: 'ok' }));
      }
    });
  });
  return stub;
}

let link: RelayLink | null = null;
let relay: Awaited<ReturnType<typeof stubRelay>> | null = null;

afterEach(async () => {
  await link?.stop();
  link = null;
  for (const ws of relay?.sockets ?? []) ws.terminate();
  await new Promise<void>((r) => (relay ? relay.server.close(() => r()) : r()));
  relay = null;
});

describe('relay link liveness', () => {
  it('pings the relay; no pong within the timeout → cut, back to connecting, reconnected', async () => {
    relay = await stubRelay();
    const states: RelayState[] = [];
    const warnings: string[] = [];
    link = createRelayLink({
      relayUrl: relay.url,
      route: () => ({ routeId: 'A'.repeat(22), routeSecret: 'B'.repeat(43) }),
      devices: () => [],
      onIncoming: () => {},
      onState: (s) => states.push(s),
      log: {
        info() {},
        warn: (e: string) => warnings.push(e),
        error() {},
        addSecret() {},
      } as BridgeLog,
      backoff: { initialMs: 20, maxMs: 50 },
      pingIntervalMs: 40,
      pongTimeoutMs: 200,
    });
    link.start();
    await until(() => link!.state === 'connected');

    // A live relay keeps the link up well past the pong timeout.
    await sleep(400);
    expect(relay.pings).toBeGreaterThan(3);
    expect(relay.hellos).toBe(1);
    expect(link.state).toBe('connected');

    // The relay goes silent, as after a Mac sleep: the bridge notices on its own and dials again.
    relay.answering = false;
    await until(() => warnings.includes('relay.pong-timeout'), 2000);
    relay.answering = true;
    await until(() => relay!.hellos === 2 && link!.state === 'connected', 2000);
    expect(states).toEqual(['connecting', 'connected', 'connecting', 'connected']);
  });
});
