import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RelaySetupEvent, RelaySetupPhase, RelaySetupRequest } from '../../shared/relay-setup-types.js';
import { ControlCallError } from '../remote-control.js';
import { createKnownHosts, type HostKeyInfo } from './known-hosts.js';
import { createRunLog } from './log.js';
import { createRelaySetup, type RelaySetupDeps } from './service.js';
import { ConnectionLostError } from './shell.js';
import type { ConnectFn, ConnectOutcome, ConnectRequest, SshConnection } from './ssh.js';

const KEY: HostKeyInfo = { type: 'ssh-ed25519', fingerprint: 'SHA256:' + 'k'.repeat(43) };
const UBUNTU = 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04"\n';
const ALPINE = 'ID=alpine\nVERSION_ID=3.20.3\nPRETTY_NAME="Alpine Linux v3.20"\n';
const SECRETS = { password: 'hunter2-SSH-pw', passphrase: 'pass-phrase-XYZ', sudoPassword: 'sudo-pw-123456' };

/** Unwraps `[sudo …] sh -c '<command>'` as `ssh.ts` builds it. */
function unwrap(line: string): { command: string; sudo: boolean } {
  const match = /^(sudo -n |sudo -S -p '' )?sh -c 'exec <\/dev\/null; (.*)'$/s.exec(line);
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
  /** The first command matching `match` waits for `release` (a cancel arrives meanwhile). */
  gate?: { match: RegExp; release: Promise<void>; started: () => void };
  /** Extra output lines of the first command matching `match` (progress, floods of lines). */
  output?: { match: RegExp; lines: string[] };
  /** The command with this text throws as if the connection dropped. */
  dropOn?: RegExp;
  /** The second channel ran the `kill` command: the gated command ends with 143 once released. */
  killed?: boolean;
  lines: string[];
  stdins: string[];
}

const READS = /^(cat \/etc\/os-release|uname -m|id -u|sudo -n true|ss -ltnp|ufw status|docker --version|docker compose version|docker ps -q \| xargs -r docker inspect --format '[^']*'|cat \/opt\/parley-relay\/(previous\/)?\.env)$/;

function connection(server: FakeServer): SshConnection {
  return {
    async exec(line, options) {
      server.lines.push(line);
      if (options.stdin !== undefined) server.stdins.push(options.stdin);
      const { command, sudo } = unwrap(line);
      const reply = (code: number, stdout = ''): { code: number; stdout: string; stderr: string } => ({ code, stdout, stderr: '' });
      if (sudo && line.startsWith("sudo -S") && options.stdin !== `${SECRETS.sudoPassword}\n`) return reply(1);
      if (command.includes('kill -s TERM -- -"$pid"')) {
        server.killed = true;
        return reply(0);
      }
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
      if (server.output?.match.test(command)) for (const line of server.output.lines) options.onLine?.(line);
      if (server.gate?.match.test(command)) {
        const { release, started } = server.gate;
        server.gate = undefined;
        started();
        await release;
      }
      if (server.killed === true) return reply(143);
      if (server.dropOn?.test(command)) throw new ConnectionLostError();
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

type Harness = Awaited<ReturnType<typeof setup>>;

/** `run` answers at once; the outcome comes as the next `phase` event (spec 8.1). */
async function runToEnd(h: Harness, removeData = false): Promise<RelaySetupPhase> {
  const from = h.events.length;
  expect(await h.service.call('run', { removeData })).toEqual({ phase: 'running' });
  let phase: RelaySetupPhase | undefined;
  await vi.waitFor(() => {
    const event = h.events.slice(from).find((e) => e.event === 'phase');
    expect(event).toBeDefined();
    phase = event?.event === 'phase' ? event.phase : undefined;
  });
  return phase as RelaySetupPhase;
}

const mutations = (server: FakeServer): string[] => server.lines.map((l) => unwrap(l.startsWith('<') ? "sh -c 'exec </dev/null; <closed>'" : l).command).filter((c) => !READS.test(c) && c !== 'true' && c !== '<closed>' && !/^(docker --version && |test -d |cd \/opt\/parley-relay && printf|docker image inspect |docker compose --project-directory \/opt\/parley-relay ps )/.test(c));

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

    const done = await runToEnd(h);
    expect(done).toEqual({ phase: 'done', address: '203-0-113-7.sslip.io', configured: true });
    expect(h.configure).toHaveBeenCalledWith('203-0-113-7.sslip.io');
    expect(mutations(h.server).join('\n')).toContain('images/create?fromImage=parley-relay&tag=stand');
    expect(mutations(h.server).join('\n')).toContain('setsid flock -n');
    expect(h.events.filter((e) => e.event === 'step' && e.status === 'done').length).toBeGreaterThan(3);
    expect(h.server.lines.at(-1)).toBe('<closed>');
  });

  it('a second run without changes only checks', async () => {
    const h = await setup({ installed: true });
    const plan = planOf(await trusted(h));
    expect(plan.steps.length).toBeGreaterThan(0);
    const done = await runToEnd(h);
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
    const failed = await runToEnd(h);
    expect(failed).toMatchObject({ phase: 'failed', step: 'health' });
    up = true;
    expect(await h.service.call('check', {})).toMatchObject({ phase: 'done', configured: true });
  });

  it('port 80 taken: runs without Caddy and finishes with the snippet, «Check» then configures', async () => {
    const h = await setup({ listen: 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=8,fd=6))\n' });
    await trusted(h, request({ domain: 'relay.example.com' }));
    const phase = await runToEnd(h);
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
    expect(await runToEnd(h, true)).toEqual({ phase: 'removed', docker: 'kept' });
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
    push(await runToEnd(h));
    // The step that fails prints the sudo password itself: the window and the log still get a masked line.
    const everything = JSON.stringify([returned, h.events, await h.service.call('state', {})]) + (await readFile(h.logFile, 'utf8'));
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
    await runToEnd(h);
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

describe('sslip for a non-public address (R8)', () => {
  it.each(['192.168.1.10', '10.0.0.5', '100.64.3.1', '172.20.0.9', '127.0.0.1', '169.254.1.1'])('%s is refused without a domain', async (ip) => {
    const h = await setup({}, { resolver: { resolve4: async () => [ip], resolve6: async () => [] } });
    const plan = planOf(await trusted(h, request({ host: ip })));
    expect(plan.blocked).toMatch(/not reachable from the internet/);
    await expect(h.service.call('run', { removeData: false })).rejects.toBeInstanceOf(ControlCallError);
  });
});

describe('a cancel never cuts a run in half (R4)', () => {
  function gate(match: RegExp) {
    let release!: () => void;
    let started!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const begun = new Promise<void>((r) => (started = r));
    return { gate: { match, release: hold, started }, release, begun };
  }
  const stepEvents = (h: Awaited<ReturnType<typeof setup>>): string[] => h.events.filter((e) => e.event === 'step').map((e) => (e.event === 'step' ? `${e.id}:${e.status}` : ''));

  it('begin is refused during a run; a step that cannot be interrupted finishes, then the run is cancelled and the connection closed', async () => {
    const g = gate(/apt-get update/);
    const h = await setup({ gate: g.gate });
    await trusted(h);
    const running = runToEnd(h);
    await g.begun;
    await expect(h.service.call('begin', request())).rejects.toMatchObject({ code: 'bad_request' });
    expect(await h.service.call('cancel', {})).toBeNull();
    expect(h.events).toContainEqual(expect.objectContaining({ event: 'cancelling' }));
    g.release();
    const phase = await running;
    expect(phase).toMatchObject({ phase: 'cancelled', step: 'dir', message: expect.stringContaining('Run the setup again to finish') });
    expect(stepEvents(h)).toContain('docker:done');
    expect(stepEvents(h)).toEqual(expect.arrayContaining(['dir:stopped', 'files:stopped', 'image:stopped', 'start:stopped']));
    // The step that was running finished; later steps never started; no kill was sent.
    expect(mutations(h.server).join('\n')).not.toContain('install -d -m 0755 /opt/parley-relay');
    expect(mutations(h.server).join('\n')).not.toContain('kill -s TERM');
    expect(h.server.lines.at(-1)).toBe('<closed>');
  });

  it('during the image step the second command kills the group: image stopped, phase cancelled, no later step', async () => {
    const g = gate(/images\/create\?fromImage=parley-relay/);
    const h = await setup({ gate: g.gate });
    await trusted(h);
    const running = runToEnd(h);
    await g.begun;
    const cancelling = h.service.call('cancel', {});
    // The fake releases the stuck command when the kill arrives, as a real killed process ends.
    await vi.waitFor(() => expect(h.server.killed).toBe(true));
    g.release();
    await cancelling;
    const phase = await running;
    expect(phase).toMatchObject({ phase: 'cancelled', step: 'image', message: expect.stringContaining('A download may finish on the server by itself') });
    expect(stepEvents(h)).toEqual(expect.arrayContaining(['image:stopped', 'start:stopped']));
    expect(stepEvents(h)).not.toContain('image:failed');
    expect(h.events).not.toContainEqual(expect.objectContaining({ event: 'cancelling' }));
    expect(mutations(h.server).join('\n')).not.toContain('up -d');
    expect(mutations(h.server).filter((c) => c.includes('kill -s TERM'))).toHaveLength(1);
    expect(h.server.lines.at(-1)).toBe('<closed>');
  });

  it('during start: «cancelling», start runs to the end, the wait for the relay is skipped → cancelled at health, Check is possible', async () => {
    const g = gate(/--quiet-pull/);
    const h = await setup({ gate: g.gate });
    await trusted(h);
    const running = runToEnd(h);
    await g.begun;
    await h.service.call('cancel', {});
    expect(h.events).toContainEqual(expect.objectContaining({ event: 'cancelling' }));
    g.release();
    expect(await running).toMatchObject({ phase: 'cancelled', step: 'health' });
    expect(stepEvents(h)).toContain('start:done');
    expect(mutations(h.server).join('\n')).not.toContain('kill -s TERM');
    expect(await h.service.call('check', {})).toEqual({ phase: 'done', address: '203-0-113-7.sslip.io', configured: true });
  });

  it('a cancel while the relay is awaited stops the wait: cancelled at health, Check tests again', async () => {
    let stuck!: () => void;
    const waiting = new Promise<void>((r) => (stuck = r));
    let answer = 503;
    const h = await setup({ installed: true }, {
      health: async () => {
        stuck();
        return { status: answer };
      },
      healthAttempts: 50,
      healthDelayMs: 60_000,
      sleep: undefined,
    });
    await trusted(h);
    const running = runToEnd(h);
    await waiting;
    expect(await h.service.call('cancel', {})).toBeNull();
    expect(await running).toMatchObject({ phase: 'cancelled', step: 'health' });
    answer = 200;
    expect((await h.service.call('check', {})).phase).toBe('done');
  });

  it('a dropped connection ends the run with the text of spec 7.3, not «step failed»', async () => {
    const h = await setup({ dropOn: /images\/create/ });
    await trusted(h);
    const phase = await runToEnd(h);
    expect(phase).toMatchObject({ phase: 'failed', step: 'image', message: expect.stringContaining('Commands keep running on the server and finish on their own') });
    expect(stepEvents(h)).toContain('image:stopped');
    expect(stepEvents(h)).not.toContain('image:failed');
  });
});

describe('the run record lives in main (spec 8.1)', () => {
  function held(match: RegExp) {
    let release!: () => void;
    let started!: () => void;
    const gate = { match, release: new Promise<void>((r) => (release = r)), started: () => started() };
    return { gate, release, begun: new Promise<void>((r) => (started = r)) };
  }
  const JSON_LINES = [
    '{"status":"Pulling fs layer","id":"821d9dafb26d"}',
    '{"status":"Downloading","progressDetail":{"current":5,"total":10},"id":"821d9dafb26d"}',
  ];

  it('run answers at once; state shows steps, lines and progress during the run and the outcome after it', async () => {
    const g = held(/--quiet-pull/);
    const img = held(/images\/create\?fromImage=parley-relay/);
    const h = await setup({ gate: img.gate, output: { match: /images\/create\?fromImage=parley-relay/, lines: JSON_LINES } });
    await trusted(h);
    expect(await h.service.call('state', {})).toBeNull();
    expect(await h.service.call('run', { removeData: false })).toEqual({ phase: 'running' });
    await img.begun;
    // During the image step the bar belongs to it ...
    expect((await h.service.call('state', {}))?.progress).toMatchObject({ step: 'image', layersTotal: 1, bytesDone: 5, bytesTotal: 10 });
    h.server.gate = g.gate;
    img.release();
    await g.begun;

    // ... and goes with it when the step ends.
    const mid = (await h.service.call('state', {}))!;
    expect(mid.phase).toEqual({ phase: 'running' });
    expect(mid).toMatchObject({ intent: 'install', host: '203.0.113.7', cancelling: false });
    expect(mid.steps.map((st) => [st.id, st.status])).toEqual([['docker', 'done'], ['dir', 'done'], ['files', 'done'], ['image', 'done'], ['start', 'running']]);
    expect(mid.steps.find((st) => st.id === 'docker')?.lines.length).toBeGreaterThan(0);
    expect(mid.progress).toBeNull();
    expect(mid.plan.steps.length).toBe(5);

    g.release();
    await vi.waitFor(async () => expect((await h.service.call('state', {}))?.phase.phase).toBe('done'));
    const end = (await h.service.call('state', {}))!;
    expect(end.phase).toEqual({ phase: 'done', address: '203-0-113-7.sslip.io', configured: true });
    expect(end.steps.at(-1)?.status).toBe('done');
    expect(h.events.at(-1)).toMatchObject({ event: 'phase', phase: { phase: 'done' } });
  });

  it('seq grows by one on every event and the state carries the number of the last one', async () => {
    const h = await setup({ output: { match: /images\/create\?fromImage=parley-relay/, lines: JSON_LINES } });
    await trusted(h);
    const done = await runToEnd(h);
    expect(done.phase).toBe('done');
    const seqs = h.events.map((e) => e.seq);
    expect(seqs.length).toBeGreaterThan(5);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect((await h.service.call('state', {}))?.seq).toBe(seqs.at(-1));
  });

  it('a window that read the state at seq N replays the events after N to reach the same record', async () => {
    const g = held(/--quiet-pull/);
    const h = await setup({ gate: g.gate });
    await trusted(h);
    await h.service.call('run', { removeData: false });
    await g.begun;
    const snapshot = (await h.service.call('state', {}))!;
    g.release();
    await vi.waitFor(async () => expect((await h.service.call('state', {}))?.phase.phase).toBe('done'));
    const final = (await h.service.call('state', {}))!;
    const later = h.events.filter((e) => e.seq > snapshot.seq);
    expect(later.length).toBeGreaterThan(0);
    const replayed = structuredClone(snapshot);
    for (const e of later) {
      replayed.seq = e.seq;
      if (e.event === 'step') replayed.steps.find((st) => st.id === e.id)!.status = e.status;
      if (e.event === 'line') replayed.steps.find((st) => st.id === e.step)!.lines.push(e.text);
      if (e.event === 'phase') replayed.phase = e.phase;
    }
    expect(replayed).toEqual(final);
  });

  it('keeps at most 200 lines per step; the log file keeps all of them', async () => {
    const flood = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    const h = await setup({ output: { match: /apt-get update/, lines: flood } });
    await trusted(h);
    await runToEnd(h);
    const docker = (await h.service.call('state', {}))!.steps.find((st) => st.id === 'docker')!;
    expect(docker.lines.length).toBe(200);
    expect(docker.lines).toContain('line 299');
    expect(docker.lines).not.toContain('line 0');
    const log = await readFile(h.logFile, 'utf8');
    expect(log).toContain('line 0\n');
    expect(log).toContain('line 299\n');
  });

  it('dismiss is refused during the run; afterwards it forgets the record; begin forgets it too', async () => {
    const g = held(/--quiet-pull/);
    const h = await setup({ gate: g.gate });
    await trusted(h);
    await h.service.call('run', { removeData: false });
    await g.begun;
    await expect(h.service.call('dismiss', {})).rejects.toMatchObject({ code: 'bad_request' });
    expect(await h.service.call('state', {})).not.toBeNull();
    g.release();
    await vi.waitFor(async () => expect((await h.service.call('state', {}))?.phase.phase).toBe('done'));
    // The record outlives the connection (it ended with the run): a reloaded window still finds it.
    expect(await h.service.call('state', {})).not.toBeNull();
    expect(await h.service.call('dismiss', {})).toBeNull();
    expect(await h.service.call('state', {})).toBeNull();

    const again = await setup();
    await trusted(again);
    await runToEnd(again);
    expect(await again.service.call('state', {})).not.toBeNull();
    await again.service.call('begin', request());
    expect(await again.service.call('state', {})).toBeNull();
  });

  it('begin is refused while the record says «running», also while the relay is awaited', async () => {
    let answer!: () => void;
    const waiting = new Promise<void>((r) => (answer = r));
    const h = await setup({ installed: true }, { health: async () => { answer(); return new Promise<{ status: number }>(() => undefined); } });
    await trusted(h);
    await h.service.call('run', { removeData: false });
    await waiting;
    await expect(h.service.call('begin', request())).rejects.toMatchObject({ code: 'bad_request' });
    await expect(h.service.call('dismiss', {})).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('Check updates the outcome in the record and tells the window', async () => {
    let up = false;
    const h = await setup({}, { health: async () => ({ status: up ? 200 : 502 }) });
    await trusted(h);
    expect(await runToEnd(h)).toMatchObject({ phase: 'failed', step: 'health' });
    expect((await h.service.call('state', {}))?.phase).toMatchObject({ phase: 'failed', step: 'health' });
    up = true;
    const from = h.events.length;
    expect(await h.service.call('check', {})).toMatchObject({ phase: 'done' });
    expect((await h.service.call('state', {}))?.phase).toMatchObject({ phase: 'done', configured: true });
    expect(h.events.slice(from).filter((e) => e.event === 'phase').map((e) => (e.event === 'phase' ? e.phase.phase : ''))).toEqual(['running', 'done']);
  });

  it('seq is one counter for the whole service: a new record never restarts it', async () => {
    const h = await setup();
    await trusted(h);
    await runToEnd(h);
    const last = (await h.service.call('state', {}))!.seq;
    await h.service.call('dismiss', {});
    // The host key is known by now: the second begin goes straight to the plan.
    expect((await h.service.call('begin', request())).phase).toBe('plan');
    const from = h.events.length;
    await runToEnd(h);
    expect(h.events[from]!.seq).toBe(last + 1);
    expect((await h.service.call('state', {}))!.seq).toBeGreaterThan(last);
  });

  it('a throw inside the run still ends it: the outcome is failed and begin / dismiss work again', async () => {
    let boom = true;
    const h = await setup({}, {
      emit: (event) => {
        if (boom && event.event === 'step' && event.status === 'running') {
          boom = false;
          throw new Error('window gone');
        }
      },
    });
    await trusted(h);
    await h.service.call('run', { removeData: false });
    await vi.waitFor(async () => expect((await h.service.call('state', {}))?.phase.phase).toBe('failed'));
    expect(h.server.lines.at(-1)).toBe('<closed>');
    expect(await h.service.call('dismiss', {})).toBeNull();
    expect((await h.service.call('begin', request())).phase).toBe('plan');
  });

  it('a throw inside Check leaves a failed outcome, not a record stuck at «running»', async () => {
    let broken = false;
    const h = await setup({}, {
      health: async () => ({ status: 502 }),
      sleep: async () => {
        if (broken) throw new Error('timer broke');
      },
    });
    await trusted(h);
    expect(await runToEnd(h)).toMatchObject({ phase: 'failed', step: 'health' });
    broken = true;
    expect(await h.service.call('check', {})).toMatchObject({ phase: 'failed', step: 'health' });
    expect((await h.service.call('state', {}))?.phase.phase).toBe('failed');
    expect(await h.service.call('dismiss', {})).toBeNull();
  });

  it('dispose drops the record', async () => {
    const h = await setup();
    await trusted(h);
    await runToEnd(h);
    h.service.dispose();
    expect(await h.service.call('state', {})).toBeNull();
  });
});

describe('failures are reported without leaking', () => {
  it('auth failure and key passphrase prompts', async () => {
    const h = await setup({}, {}, (_req, n) => (n === 1 ? { kind: 'passphrase-required', wrong: false } : undefined));
    expect(await h.service.call('begin', request({ auth: { kind: 'key', file: 'id_ed25519' } }))).toEqual({ phase: 'need-passphrase', wrong: false });
    await expect(h.service.call('provide', { passphrase: '' })).rejects.toMatchObject({ code: 'bad_input' });
    expect((await h.service.call('provide', { passphrase: SECRETS.passphrase })).phase).toBe('hostkey');
    expect(h.requests.at(-1)?.secrets.passphrase).toBe(SECRETS.passphrase);

    const denied = await setup({}, {}, () => ({ kind: 'auth-failed' }));
    expect(await denied.service.call('begin', request())).toEqual({ phase: 'auth-failed' });
  });
});
