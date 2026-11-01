import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RelaySetupEvent, RelaySetupPhase } from '../../src/shared/relay-setup-types.js';
import { createKnownHosts } from '../../src/main/relay-setup/known-hosts.js';
import { createRunLog } from '../../src/main/relay-setup/log.js';
import { createRelaySetup } from '../../src/main/relay-setup/service.js';
import { connectSsh } from '../../src/main/relay-setup/ssh.js';
import { docker, dockerAvailable, exec, removeServer, saveImages, startServer, waitForSsh, type Flavour, type Server } from './stand.js';

/**
 * Full install on servers that run their own Docker (privileged containers, real apt, real `docker compose`).
 * Needs the images `parley-relay:stand` (built from packages/relay/Dockerfile) and `caddy:2` on this Mac; see README.
 * Not covered here: certificates (no ACME server in this stand), so the HTTPS health probe is replaced by a probe of
 * the relay container from inside the server.
 */
const ENABLED = process.env.RELAY_SETUP_STAND === '1' && dockerAvailable() && process.env.RELAY_SETUP_FULL === '1';
const FLAVOURS: Flavour[] = ['ubuntu24', 'debian12'];
const servers = new Map<Flavour, Server>();
let known = '';

function service(server: Server, ref: string, events: RelaySetupEvent[] = []) {
  const configured: string[] = [];
  return {
    configured,
    events,
    service: createRelaySetup({
      knownHosts: createKnownHosts(known),
      connect: connectSsh,
      log: createRunLog(path.join(path.dirname(known), 'relay-setup.log'), () => []),
      image: { ref, published: true },
      health: async () => {
        try {
          exec(server.name, "docker exec parley-relay-relay-1 node -e \"fetch('http://127.0.0.1:8787/v1/health').then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))\"");
          return { status: 200 };
        } catch {
          return { status: 502 };
        }
      },
      healthAttempts: 3,
      healthDelayMs: 1000,
      resolver: { resolve4: async () => ['203.0.113.7'], resolve6: async () => [] },
      configureBridge: async (address) => void configured.push(address),
      emit: (event) => events.push(event),
    }),
  };
}

async function start(server: Server, intent: 'install' | 'rollback' | 'remove', ref: string, removeData = false): Promise<{ phase: RelaySetupPhase; events: RelaySetupEvent[]; configured: string[] }> {
  const { service: wizard, events, configured } = service(server, ref);
  let phase = await wizard.call('begin', { host: 'localhost', port: server.port, user: 'root', auth: { kind: 'password' }, secrets: { password: 'stand-root-pw' }, intent });
  if (phase.phase === 'hostkey') phase = await wizard.call('trust', {});
  expect(phase.phase).toBe('plan');
  if (removeData) phase = await wizard.call('plan', { removeData: true });
  return { phase: await wizard.call('run', { removeData }), events, configured };
}

const done = (events: RelaySetupEvent[]) => events.filter((e) => e.event === 'step' && e.status === 'done').map((e) => (e as { id: string }).id);

describe.skipIf(!ENABLED)('relay setup stand: full install', () => {
  beforeAll(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'relay-stand-'));
    known = path.join(root, 'known_hosts');
    const imagesDir = path.join(root, 'images');
    saveImages(imagesDir);
    for (const flavour of FLAVOURS) {
      const server = startServer(flavour, `parley-stand-full-${flavour}`, undefined, { imagesDir });
      await waitForSsh(server.port);
      servers.set(flavour, server);
    }
  }, 900_000);

  afterAll(() => {
    for (const server of servers.values()) removeServer(server.name);
    removeServer('parley-stand-full-busy443');
  });

  it('443 taken by something else, 80 free → Caddy on 8443, the port is part of the address (acceptance 5)', async () => {
    const imagesDir = path.join(path.dirname(known), 'images');
    saveImages(imagesDir);
    const server = startServer('ubuntu24', 'parley-stand-full-busy443', undefined, { imagesDir, listen: 443 });
    await waitForSsh(server.port);
    const run = await start(server, 'install', 'parley-relay:stand');
    expect(run.phase).toMatchObject({ phase: 'done', address: '203-0-113-7.sslip.io:8443' });
    expect(run.configured).toEqual(['203-0-113-7.sslip.io:8443']);
    expect(exec(server.name, 'docker port parley-relay-caddy-1')).toMatch(/443\/tcp -> 0\.0\.0\.0:8443/);
    expect(exec(server.name, 'cat /opt/parley-relay/.env')).toContain('RELAY_HTTPS_PORT=8443');
  }, 900_000);

  it.each(FLAVOURS)('%s: clean install → re-run changes nothing', async (flavour) => {
    const server = servers.get(flavour)!;
    const first = await start(server, 'install', 'parley-relay:stand');
    expect(first.phase).toMatchObject({ phase: 'done', configured: true });
    // The stand preloads the image into the server's Docker, so the pull step finds it and is skipped (the registry is the human's to publish).
    expect(done(first.events)).toEqual(['docker', 'dir', 'files', 'start']);
    expect(exec(server.name, 'docker ps --format {{.Names}} | sort')).toBe('parley-relay-caddy-1\nparley-relay-relay-1');
    expect(exec(server.name, 'cat /opt/parley-relay/.env')).toContain('RELAY_IMAGE=parley-relay:stand');
    expect(exec(server.name, 'stat -c %a /opt/parley-relay/.env')).toBe('600');

    const second = await start(server, 'install', 'parley-relay:stand');
    expect(second.phase).toMatchObject({ phase: 'done' });
    expect(done(second.events)).toEqual([]);
  }, 900_000);

  it('ubuntu24: update keeps the data, roll back restores the old image, remove keeps data until confirmed', async () => {
    const server = servers.get('ubuntu24')!;
    exec(server.name, "docker exec parley-relay-relay-1 sh -c 'echo route > /data/marker'");

    const update = await start(server, 'install', 'parley-relay:stand2');
    expect(update.phase).toMatchObject({ phase: 'done' });
    expect(done(update.events)).toEqual(['files', 'start']);
    expect(exec(server.name, 'cat /opt/parley-relay/.env')).toContain('RELAY_IMAGE=parley-relay:stand2');
    expect(exec(server.name, 'cat /opt/parley-relay/previous/.env')).toContain('RELAY_IMAGE=parley-relay:stand\n');
    expect(exec(server.name, 'docker exec parley-relay-relay-1 cat /data/marker')).toBe('route');
    expect(exec(server.name, "docker inspect -f '{{.Config.Image}}' parley-relay-relay-1")).toBe('parley-relay:stand2');

    const back = await start(server, 'rollback', 'parley-relay:stand2');
    expect(back.phase).toMatchObject({ phase: 'done' });
    expect(exec(server.name, "docker inspect -f '{{.Config.Image}}' parley-relay-relay-1")).toBe('parley-relay:stand');
    expect(exec(server.name, 'docker exec parley-relay-relay-1 cat /data/marker')).toBe('route');

    const removed = await start(server, 'remove', 'parley-relay:stand');
    expect(removed.phase).toEqual({ phase: 'removed', docker: 'kept' });
    expect(exec(server.name, 'ls /opt/parley-relay 2>&1 || true')).toMatch(/No such file/);
    expect(exec(server.name, 'docker ps -a --format {{.Names}}')).toBe('');
    expect(docker(['exec', server.name, 'docker', 'volume', 'ls', '-q'])).toContain('parley-relay_relay-data');
    exec(server.name, 'docker --version');

    const again = await start(server, 'install', 'parley-relay:stand');
    expect(again.phase).toMatchObject({ phase: 'done' });
    expect(exec(server.name, 'docker exec parley-relay-relay-1 cat /data/marker')).toBe('route');
    const purge = await start(server, 'remove', 'parley-relay:stand', true);
    expect(purge.phase).toEqual({ phase: 'removed', docker: 'kept' });
    expect(docker(['exec', server.name, 'docker', 'volume', 'ls', '-q'])).not.toContain('parley-relay_relay-data');
  }, 900_000);
});
