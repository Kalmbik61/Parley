import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RelaySetupPhase } from '../../src/shared/relay-setup-types.js';
import { createKnownHosts } from '../../src/main/relay-setup/known-hosts.js';
import { createRunLog } from '../../src/main/relay-setup/log.js';
import { createRelaySetup, type RelaySetupService } from '../../src/main/relay-setup/service.js';
import { connectSsh } from '../../src/main/relay-setup/ssh.js';
import { dockerAvailable, exec, freePort, removeServer, restartServer, snapshot, startServer, waitForSsh, type Flavour, type Server } from './stand.js';

/**
 * Docker stand for the relay setup wizard (plan A18a). Real sshd in containers, the real `ssh2` client and the real
 * service; only DNS, the bridge and the HTTPS health probe are stubs.
 * Run: `RELAY_SETUP_STAND=1 pnpm --filter @parley/desktop exec vitest run test/relay-setup` (needs a running Docker).
 */
const ENABLED = process.env.RELAY_SETUP_STAND === '1' && dockerAvailable();

const servers = new Map<Flavour, Server>();
const dirs: string[] = [];
let keychange: Server | null = null;

async function wizard(): Promise<{ service: RelaySetupService; dir: string; configured: string[] }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-stand-'));
  dirs.push(dir);
  const configured: string[] = [];
  const service = createRelaySetup({
    knownHosts: createKnownHosts(path.join(dir, 'known_hosts')),
    connect: connectSsh,
    log: createRunLog(path.join(dir, 'relay-setup.log'), () => []),
    image: { ref: 'parley-relay:stand', published: true },
    health: async () => ({ status: 200 }),
    healthAttempts: 1,
    resolver: { resolve4: async () => ['203.0.113.7'], resolve6: async () => [] },
    configureBridge: async (address) => void configured.push(address),
    emit: () => undefined,
  });
  return { service, dir, configured };
}

const rootLogin = (server: Server, over: Record<string, unknown> = {}) => ({
  host: 'localhost',
  port: server.port,
  user: 'root',
  auth: { kind: 'password' as const },
  secrets: { password: 'stand-root-pw' },
  intent: 'install' as const,
  ...over,
});

async function begin(service: RelaySetupService, server: Server, over: Record<string, unknown> = {}): Promise<RelaySetupPhase> {
  const first = await service.call('begin', rootLogin(server, over) as never);
  if (first.phase !== 'hostkey') return first;
  return service.call('trust', {});
}

describe.skipIf(!ENABLED)('relay setup stand', () => {
  beforeAll(async () => {
    for (const flavour of ['ubuntu24', 'debian12', 'nginx', 'alpine'] as const) {
      const server = startServer(flavour);
      await waitForSsh(server.port);
      servers.set(flavour, server);
    }
  }, 600_000);

  afterAll(() => {
    for (const server of servers.values()) removeServer(server.name);
    if (keychange !== null) removeServer(keychange.name);
  });

  it.each(['ubuntu24', 'debian12'] as const)('%s: real SSH, host key trust on first use, read-only probe, full plan on screen', async (flavour) => {
    const server = servers.get(flavour)!;
    const { service, dir } = await wizard();
    const first = await service.call('begin', rootLogin(server) as never);
    expect(first).toMatchObject({ phase: 'hostkey', keyType: expect.stringMatching(/ed25519|rsa|ecdsa/) });
    const phase = await service.call('trust', {});
    expect(phase.phase).toBe('plan');
    if (phase.phase !== 'plan') return;
    expect(phase.plan.blocked).toBeNull();
    expect(phase.plan.steps.map((s) => s.id)).toEqual(['docker', 'dir', 'files', 'image', 'start']);
    expect(phase.os).toMatch(flavour === 'ubuntu24' ? /Ubuntu 24\.04/ : /Debian GNU\/Linux 12/);
    expect(await readFile(path.join(dir, 'known_hosts'), 'utf8')).toContain('[localhost]:');
    // Probing only: nothing exists yet on the server.
    expect(exec(server.name, 'ls /opt/parley-relay 2>&1 || true')).toMatch(/No such file/);
    await service.call('cancel', {});
  });

  it('a sudo user: the sudo password is asked for, a wrong one refused, the right one accepted', async () => {
    const server = servers.get('ubuntu24')!;
    const { service } = await wizard();
    const phase = await begin(service, server, { user: 'deploy', secrets: { password: 'stand-deploy-pw' } });
    expect(phase.phase).toBe('need-sudo');
    expect(await service.call('provide', { sudoPassword: 'nope' })).toEqual({ phase: 'need-sudo' });
    const plan = await service.call('provide', { sudoPassword: 'stand-deploy-pw' });
    expect(plan.phase).toBe('plan');
    await service.call('cancel', {});
  });

  it('a wrong SSH password is refused', async () => {
    const { service } = await wizard();
    const phase = await begin(service, servers.get('ubuntu24')!, { secrets: { password: 'wrong' } });
    expect(phase).toEqual({ phase: 'auth-failed' });
  });

  it('nginx on 80: proxy plan with a snippet, and /etc/nginx is byte for byte the same (acceptance 5)', async () => {
    const server = servers.get('nginx')!;
    const before = snapshot(server.name, ['/etc/nginx']);
    const { service } = await wizard();
    const phase = await begin(service, server, { domain: undefined });
    expect(phase.phase).toBe('plan');
    if (phase.phase !== 'plan') return;
    expect(phase.plan.proxy?.snippet).toContain('proxy_pass http://127.0.0.1:8787;');
    expect(phase.plan.steps.flatMap((s) => s.commands).join('\n')).not.toMatch(/\/etc\/nginx/);
    await service.call('cancel', {});
    expect(snapshot(server.name, ['/etc/nginx'])).toBe(before);
  });

  it('Alpine: stops after the probe and nothing on the server changed (acceptance 9)', async () => {
    const server = servers.get('alpine')!;
    const before = snapshot(server.name, ['/etc', '/opt', '/usr/local']);
    const { service } = await wizard();
    const phase = await begin(service, server);
    expect(phase).toMatchObject({ phase: 'unsupported', os: expect.stringContaining('Alpine') });
    expect(snapshot(server.name, ['/etc', '/opt', '/usr/local'])).toBe(before);
    expect(exec(server.name, 'ls /opt')).toBe('');
  });

  it('a changed host key stops the next run before authentication (acceptance 6)', async () => {
    const server = startServer('ubuntu24', 'parley-stand-keychange', await freePort());
    await waitForSsh(server.port);
    keychange = server;
    const { service } = await wizard();
    expect((await begin(service, server)).phase).toBe('plan');
    await service.call('cancel', {});
    // Same address, new key: the server was «replaced».
    exec(server.name, 'rm -f /etc/ssh/ssh_host_*');
    restartServer(server);
    await waitForSsh(server.port);
    const phase = await service.call('begin', rootLogin(server) as never);
    expect(phase).toMatchObject({ phase: 'hostkey-changed' });
    await expect(service.call('trust', {})).rejects.toBeTruthy();
  });
});
