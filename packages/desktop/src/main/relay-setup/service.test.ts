import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RelaySetupEvent, RelaySetupPhase, RelaySetupRequest } from '../../shared/relay-setup-types.js';
import { ControlCallError } from '../remote-control.js';
import { createKnownHosts, type HostKeyInfo } from './known-hosts.js';
import { createRunLog } from './log.js';
import { createRelaySetup, type RelaySetupDeps } from './service.js';
import type { ConnectFn, ConnectOutcome, ConnectRequest, SshConnection } from './ssh.js';

const KEY: HostKeyInfo = { type: 'ssh-ed25519', fingerprint: 'SHA256:' + 'k'.repeat(43) };
const UBUNTU = 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04"\n';
const ALPINE = 'ID=alpine\nVERSION_ID=3.20.3\nPRETTY_NAME="Alpine Linux v3.20"\n';
const SECRETS = { password: 'hunter2-SSH-pw', passphrase: 'pass-phrase-XYZ', sudoPassword: 'sudo-pw-123456' };

/** Unwraps `[sudo …] sh -c '<command>'` as `ssh.ts` builds it. */
function unwrap(line: string): { command: string; sudo: boolean } {
  const match = /^(sudo -n |sudo -S -p '' )?sh -c '(.*)'$/s.exec(line);
  if (!match) throw new Error(`unexpected command line: ${line}`);
  return { sudo: match[1] !== undefined, command: match[2]!.replace(/'\\''/g, "'") };
}

interface FakeServer {
  osRelease: string;
  uid: string;
  sudoNoPasswd: boolean;
  /** Everything is in place already (second run). */
  installed: boolean;
  listen: string;
  echoSecretOnFailure?: string;
  failCommand?: RegExp;
  lines: string[];
  stdins: string[];
}

const READS = /^(cat \/etc\/os-release|uname -m|id -u|sudo -n true|ss -ltnp|ufw status|docker --version|docker compose version|cat \/opt\/parley-relay\/(previous\/)?\.env)$/;

function connection(server: FakeServer): SshConnection {
  return {
    async exec(line, options) {
      server.lines.push(line);
      if (options.stdin !== undefined) server.stdins.push(options.stdin);
      const { command, sudo } = unwrap(line);
      const reply = (code: number, stdout = ''): { code: number; stdout: string; stderr: string } => ({ code, stdout, stderr: '' });
      if (sudo && line.startsWith("sudo -S") && options.stdin !== `${SECRETS.sudoPassword}\n`) return reply(1);
      if (command === 'cat /etc/os-release') return reply(0, server.osRelease);
      if (command === 'uname -m') return reply(0, 'x86_64\n');
      if (command === 'id -u') return reply(0, server.uid);
      if (command === 'sudo -n true') return reply(server.sudoNoPasswd ? 0 : 1);
      if (command === 'ss -ltnp') return reply(0, server.listen);
      if (command === 'true') return reply(0);
      if (command === 'ufw status') return reply(1);
      if (command === 'docker --version' || command === 'docker compose version') return reply(server.installed ? 0 : 127);
      if (command.startsWith('cat /opt/parley-relay/previous/.env')) return reply(1);
      if (command.startsWith('cat /opt/parley-relay/.env')) {
        return server.installed ? reply(0, 'RELAY_DOMAIN=203-0-113-7.sslip.io\nRELAY_MODE=caddy\n') : reply(1);
      }
      // Checks of the plan: pass when everything is installed.
      if (/^(docker --version && |test -d |cd \/opt\/parley-relay && printf|docker image inspect |docker compose --project-directory \/opt\/parley-relay ps )/.test(command)) {
        return reply(server.installed ? 0 : 1);
      }
      if (server.failCommand?.test(command)) {
        options.onLine?.(`error: authentication with ${server.echoSecretOnFailure ?? ''} failed`);
        return reply(100);
      }
      options.onLine?.(`ok: ${command.slice(0, 40)}`);
      return reply(0);
    },
    close() {
      server.lines.push('<closed>');
    },
  };
}

const mutations = (server: FakeServer): string[] => server.lines.map((l) => unwrap(l.startsWith('<') ? "sh -c '<closed>'" : l).command).filter((c) => !READS.test(c) && c !== 'true' && c !== '<closed>' && !/^(docker --version && |test -d |cd \/opt\/parley-relay && printf|docker image inspect |docker compose --project-directory \/opt\/parley-relay ps )/.test(c));

async function setup(over: Partial<FakeServer> = {}, deps: Partial<RelaySetupDeps> = {}, connectOutcome?: (req: ConnectRequest, calls: number) => ConnectOutcome | undefined) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-setup-'));
  const server: FakeServer = { osRelease: UBUNTU, uid: '0\n', sudoNoPasswd: true, installed: false, listen: 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))\n', lines: [], stdins: [], ...over };
  const events: RelaySetupEvent[] = [];
  const requests: ConnectRequest[] = [];
  const knownHosts = createKnownHosts(path.join(dir, 'known_hosts'));
  const configure = vi.fn(async () => undefined);
  const connect: ConnectFn = async (request, hosts) => {
    requests.push(request);
    const forced = connectOutcome?.(request, requests.length);
    if (forced !== undefined) return forced;
    const verdict = await hosts.verdict(request.host, request.port, KEY);
    if (verdict.kind === 'changed') return { kind: 'hostkey-changed', key: KEY, known: verdict.known };
    if (verdict.kind === 'unknown' && request.trusted !== KEY.fingerprint) return { kind: 'hostkey-unknown', key: KEY };
    return { kind: 'ok', connection: connection(server) };
  };
  const logFile = path.join(dir, 'relay-setup.log');
  const service = createRelaySetup({
    knownHosts,
    connect,
    log: createRunLog(logFile, () => []),
    image: { ref: 'parley-relay:stand', published: true },
    health: async () => ({ status: 200 }),
    healthAttempts: 2,
    healthDelayMs: 0,
    sleep: async () => undefined,
    resolver: { resolve4: async () => ['203.0.113.7'], resolve6: async () => [] },
    configureBridge: configure,
    emit: (event) => events.push(event),
    listKeys: async () => ['id_ed25519'],
    agentAvailable: () => true,
    idleMs: 60_000,
    ...deps,
  });
  return { service, server, events, requests, dir, logFile, knownHosts, configure };
}

const request = (over: Partial<RelaySetupRequest> = {}): RelaySetupRequest => ({
  host: '203.0.113.7',
  port: 22,
  user: 'root',
  auth: { kind: 'agent' },
  secrets: {},
  intent: 'install',
  ...over,
});

const planOf = (phase: RelaySetupPhase) => {
  if (phase.phase !== 'plan') throw new Error(`expected a plan, got ${phase.phase}`);
  return phase.plan;
};

async function trusted(h: Awaited<ReturnType<typeof setup>>, req: RelaySetupRequest = request()): Promise<RelaySetupPhase> {
  const first = await h.service.call('begin', req);
  expect(first.phase).toBe('hostkey');
  return h.service.call('trust', {});
}

describe('input is refused before any connection (acceptance 7)', () => {
  it.each([
    ['host', { host: '1.2.3.4; rm -rf /' }],
    ['host', { host: '$(reboot)' }],
    ['host', { host: 'a.com\nb' }],
    ['domain', { domain: 'my domain.com' }],
    ['user', { user: 'root; id' }],
    ['port', { port: '22; id' }],
  ])('bad %s', async (_field, over) => {
    const h = await setup();
    await expect(h.service.call('begin', request(over as Partial<RelaySetupRequest>))).rejects.toMatchObject({ code: 'bad_input' });
    expect(h.requests).toHaveLength(0);
    expect(h.server.lines).toHaveLength(0);
  });
});

describe('host key (acceptance 6)', () => {
  it('asks first, runs nothing until confirmed, and remembers the key', async () => {
    const h = await setup();
    const first = await h.service.call('begin', request());
    expect(first).toMatchObject({ phase: 'hostkey', fingerprint: KEY.fingerprint, keyType: 'ssh-ed25519' });
    expect(h.server.lines).toHaveLength(0);
    const second = await h.service.call('trust', {});
    expect(second.phase).toBe('plan');
    expect(h.requests.map((r) => r.trusted)).toEqual([null, KEY.fingerprint]);
    expect(await readFile(path.join(h.dir, 'known_hosts'), 'utf8')).toContain(KEY.fingerprint);
  });

  it('a changed key stops the run without a single command and without a way on', async () => {
    const h = await setup();
    await h.knownHosts.trust('203.0.113.7', 22, { ...KEY, fingerprint: 'SHA256:' + 'o'.repeat(43) });
    const phase = await h.service.call('begin', request({ auth: { kind: 'password' }, secrets: { password: SECRETS.password } }));
    expect(phase).toMatchObject({ phase: 'hostkey-changed', presented: KEY.fingerprint });
    expect(h.server.lines).toHaveLength(0);
    await expect(h.service.call('trust', {})).rejects.toBeInstanceOf(ControlCallError);
    await expect(h.service.call('run', { removeData: false })).rejects.toBeInstanceOf(ControlCallError);
  });
});

describe('unsupported system (acceptance 9)', () => {
  it('stops after the probe; only reads were sent', async () => {
    const h = await setup({ osRelease: ALPINE });
    const phase = await trusted(h);
    expect(phase).toMatchObject({ phase: 'unsupported', os: 'Alpine Linux v3.20' });
    expect(mutations(h.server)).toEqual([]);
    expect(h.server.lines.at(-1)).toBe('<closed>');
    await expect(h.service.call('run', { removeData: false })).rejects.toBeInstanceOf(ControlCallError);
  });
});

describe('install, re-run, health and the bridge', () => {
  it('first run shows the whole plan, runs it only on «Run», then health → configure', async () => {
    const h = await setup();
    const shown = planOf(await trusted(h));
    expect(shown.blocked).toBeNull();
    expect(shown.address).toBe('203-0-113-7.sslip.io');
    expect(mutations(h.server)).toEqual([]);

    const done = await h.service.call('run', { removeData: false });
    expect(done).toEqual({ phase: 'done', address: '203-0-113-7.sslip.io', configured: true });
    expect(h.configure).toHaveBeenCalledWith('203-0-113-7.sslip.io');
    expect(mutations(h.server).join('\n')).toContain("docker pull 'parley-relay:stand'");
    expect(h.events.filter((e) => e.event === 'step' && e.status === 'done').length).toBeGreaterThan(3);
    expect(h.server.lines.at(-1)).toBe('<closed>');
  });

  it('a second run without changes only checks', async () => {
    const h = await setup({ installed: true });
    const plan = planOf(await trusted(h));
    expect(plan.steps.length).toBeGreaterThan(0);
    const done = await h.service.call('run', { removeData: false });
    expect(done.phase).toBe('done');
    expect(mutations(h.server)).toEqual([]);
    expect(h.events.filter((e) => e.event === 'step' && e.status === 'done')).toEqual([]);
  });

  it('an unpublished image cannot be installed', async () => {
    const h = await setup({}, { image: { ref: 'x', published: false } });
    const plan = planOf(await trusted(h));
    expect(plan.blocked).toMatch(/published relay image/);
    await expect(h.service.call('run', { removeData: false })).rejects.toBeInstanceOf(ControlCallError);
    expect(mutations(h.server)).toEqual([]);
  });

  it('an own domain must point to the server', async () => {
    const h = await setup({}, { resolver: { resolve4: async (host) => (host === 'relay.example.com' ? ['198.51.100.9'] : ['203.0.113.7']), resolve6: async () => [] } });
    const plan = planOf(await trusted(h, request({ domain: 'relay.example.com' })));
    expect(plan.blocked).toMatch(/no A or AAAA record/);
    const ok = await setup({}, { resolver: { resolve4: async () => ['203.0.113.7'], resolve6: async () => [] } });
    expect(planOf(await trusted(ok, request({ domain: 'relay.example.com' }))).address).toBe('relay.example.com');
  });

  it('a relay that does not answer keeps «Check» available', async () => {
    let up = false;
    const h = await setup({}, { health: async () => ({ status: up ? 200 : 502 }) });
    await trusted(h);
    const failed = await h.service.call('run', { removeData: false });
    expect(failed).toMatchObject({ phase: 'failed', step: 'health' });
    up = true;
    expect(await h.service.call('check', {})).toMatchObject({ phase: 'done', configured: true });
  });

  it('port 80 taken: runs without Caddy and finishes with the snippet, «Check» then configures', async () => {
    const h = await setup({ listen: 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=8,fd=6))\n' });
    await trusted(h, request({ domain: 'relay.example.com' }));
    const phase = await h.service.call('run', { removeData: false });
    expect(phase).toMatchObject({ phase: 'proxy-pending', address: 'relay.example.com' });
    expect(h.configure).not.toHaveBeenCalled();
    expect(mutations(h.server).join('\n')).not.toMatch(/\/etc\/(nginx|apache2|httpd|caddy)/);
    expect(await h.service.call('check', {})).toMatchObject({ phase: 'done' });
    expect(h.configure).toHaveBeenCalledWith('relay.example.com');
  });
});

describe('remove (acceptance 4)', () => {
  it('keeps the data until a separate confirmation, then rebuilds the plan with it', async () => {
    const h = await setup({ installed: true });
    const first = planOf(await trusted(h, request({ intent: 'remove' })));
    expect(first.steps.flatMap((s) => s.commands).join('\n')).not.toContain('down -v');
    const withData = planOf(await h.service.call('plan', { removeData: true }));
    expect(withData.steps.flatMap((s) => s.commands).join('\n')).toContain('down -v');
    expect(await h.service.call('run', { removeData: true })).toEqual({ phase: 'removed', docker: 'kept' });
  });
});

describe('credentials (acceptance 8)', () => {
  it('sudo password: asked, wrong one refused, right one sent through stdin only', async () => {
    const h = await setup({ uid: '1000\n', sudoNoPasswd: false });
    const asked = await trusted(h);
    expect(asked.phase).toBe('need-sudo');
    expect(await h.service.call('provide', { sudoPassword: 'wrong-password' })).toEqual({ phase: 'need-sudo' });
    const plan = await h.service.call('provide', { sudoPassword: SECRETS.sudoPassword });
    expect(plan.phase).toBe('plan');
    for (const line of h.server.lines) expect(line).not.toContain(SECRETS.sudoPassword);
    expect(h.server.stdins.length).toBeGreaterThan(0);
  });

  it('no password, passphrase or sudo password reaches the log, the window or the disk', async () => {
    const h = await setup(
      { uid: '1000\n', sudoNoPasswd: false, failCommand: /docker pull/, echoSecretOnFailure: SECRETS.sudoPassword },
      {},
    );
    const returned: unknown[] = [];
    const push = (value: unknown): void => void returned.push(value);
    push(await h.service.call('begin', request({ auth: { kind: 'password' }, secrets: { password: SECRETS.password, passphrase: SECRETS.passphrase, sudoPassword: SECRETS.sudoPassword } })));
    push(await h.service.call('trust', {}));
    push(await h.service.call('run', { removeData: false }));
    // The step that fails prints the sudo password itself: the window and the log still get a masked line.
    const everything = JSON.stringify([returned, h.events]) + (await readFile(h.logFile, 'utf8'));
    for (const secret of Object.values(SECRETS)) expect(everything).not.toContain(secret);
    expect(everything).toContain('***');
    expect(everything).toContain('failed');
    for (const name of await readdir(h.dir)) {
      const file = path.join(h.dir, name);
      if ((await stat(file)).isFile()) for (const secret of Object.values(SECRETS)) expect(await readFile(file, 'utf8')).not.toContain(secret);
    }
    expect((await stat(h.logFile)).mode & 0o777).toBe(0o600);
  });

  it('credentials are gone after the run: nothing can be continued', async () => {
    const h = await setup();
    await trusted(h, request({ auth: { kind: 'password' }, secrets: { password: SECRETS.password } }));
    await h.service.call('run', { removeData: false });
    await expect(h.service.call('run', { removeData: false })).rejects.toBeInstanceOf(ControlCallError);
  });

  it('cancel and idle timeout close the connection', async () => {
    vi.useFakeTimers();
    try {
      const h = await setup({}, { idleMs: 1000 });
      await trusted(h);
      await vi.advanceTimersByTimeAsync(1500);
      expect(h.server.lines.at(-1)).toBe('<closed>');
      await expect(h.service.call('run', { removeData: false })).rejects.toBeInstanceOf(ControlCallError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('failures are reported without leaking', () => {
  it('auth failure and key passphrase prompts', async () => {
    const h = await setup({}, {}, (_req, n) => (n === 1 ? { kind: 'passphrase-required' } : undefined));
    expect(await h.service.call('begin', request({ auth: { kind: 'key', file: 'id_ed25519' } }))).toEqual({ phase: 'need-passphrase' });
    await expect(h.service.call('provide', { passphrase: '' })).rejects.toMatchObject({ code: 'bad_input' });
    expect((await h.service.call('provide', { passphrase: SECRETS.passphrase })).phase).toBe('hostkey');
    expect(h.requests.at(-1)?.secrets.passphrase).toBe(SECRETS.passphrase);

    const denied = await setup({}, {}, () => ({ kind: 'auth-failed' }));
    expect(await denied.service.call('begin', request())).toEqual({ phase: 'auth-failed' });
  });
});
