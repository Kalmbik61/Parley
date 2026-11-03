import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addressFromEnv, buildPlan, decideLayout, type Plan } from './plan.js';
import { parseContainers, parseEnv, parseListeners, parseOsRelease, type ProbeResult } from './probe.js';
import type { RemoteShell, RunResult } from './shell.js';
import { sha256 } from './templates.js';
import { probeInstalledEdit, probeProxyOnServer, probeWeb } from './web.js';

const IMAGE = 'ghcr.io/kalmbik61/parley-relay@sha256:' + 'a'.repeat(64);
const dir = path.join(__dirname, 'fixtures', 'course-vps');
const read = (name: string): string => readFileSync(path.join(dir, name), 'utf8');
const CADDY_ID = 'c1'.repeat(32);
const CADDYFILE_PATH = "cat '/opt/course-platform/deploy/Caddyfile'";
const OUR_FILE = "cat '/opt/evdev-site/caddy/parley-relay.caddy'";
const COURSE = { [`docker exec '${CADDY_ID}' caddy version`]: 'v2', [CADDYFILE_PATH]: read('Caddyfile'), [OUR_FILE]: read('parley-relay.caddy') };
const NAME = '82-146-37-224.sslip.io';

function baseProbe(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    os: parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\n'),
    arch: 'amd64',
    root: true,
    sudoPasswordless: true,
    docker: true,
    compose: true,
    listeners: parseListeners(read('ss-ltnp.txt')),
    containers: parseContainers(read('containers.jsonl')),
    web: null,
    activeCommand: null,
    previousTail: null,
    installEdit: null,
    proxyHealthy: null,
    ufwActive: false,
    install: parseEnv(read('env.txt')),
    previous: parseEnv(read('previous-env.txt')),
    ...over,
  };
}

function shellOf(answers: Record<string, string>): RemoteShell {
  return {
    async run(command): Promise<RunResult> {
      const file = /^base64 -w0 ('.*')$/.exec(command);
      const plain = file === null ? undefined : answers[`cat ${file[1]}`];
      const out = plain !== undefined ? Buffer.from(plain, 'utf8').toString('base64') : answers[command];
      return { code: out === undefined ? 1 : 0, stdout: out ?? '', stderr: '' };
    },
  };
}

async function surveyed(answers: Record<string, string>, over: Partial<ProbeResult> = {}): Promise<ProbeResult> {
  const probe = baseProbe(over);
  return { ...probe, web: await probeWeb(probe, shellOf(answers)) };
}

const plan = (probe: ProbeResult, intent: 'install' | 'rollback' | 'remove' = 'install', removeData = false): Plan =>
  buildPlan({ intent, probe, decision: decideLayout(probe), name: NAME, image: IMAGE, removeData });
const runs = (p: Plan): string => p.steps.flatMap((s) => s.commands.map((c) => c.run)).join('\n');

describe('repeat and update (spec 6.2)', () => {
  it('course VPS: the .env says caddy, the live probe wins: install is allowed, rollback is blocked (previous was proxy)', async () => {
    const probe = await surveyed(COURSE);
    expect(plan(probe).blocked).toBeNull();
    expect(plan(probe).mode).toBe('caddy-site');
    expect(plan(probe, 'rollback').blocked).toMatch(/different layout; install again instead/);
  });

  it('our site is in Caddy but port 80 is held by nginx now → blocked with the text of the spec', async () => {
    const NGINX_ID = 'f5'.repeat(32);
    const nginx = { ...parseContainers(read('containers.jsonl'))[0]!, id: NGINX_ID, name: 'shop-nginx-1', image: 'nginx:1.27', labels: {}, networks: ['shop_default'], networkAliases: {}, networkMode: 'shop_default', path: 'nginx', args: [], mounts: [{ type: 'bind', source: '/srv/conf.d', destination: '/etc/nginx/conf.d', rw: true }] };
    const answers = { [`docker exec '${NGINX_ID}' nginx -v`]: '', [`docker exec '${NGINX_ID}' nginx -T`]: read('nginx-t-official.txt') };
    const probe = await surveyed(answers, {
      containers: [nginx],
      listeners: [],
      install: { RELAY_MODE: 'caddy-site', RELAY_DOMAIN: NAME, RELAY_WEB_FILE: '/opt/evdev-site/caddy/parley-relay.caddy', RELAY_WEB_EDIT: 'file' },
      installEdit: { file: '/opt/evdev-site/caddy/parley-relay.caddy', kind: 'file', sha256: sha256('x') },
    });
    expect(plan(probe).blocked).toBe(
      "Parley's site is in /opt/evdev-site/caddy/parley-relay.caddy of Caddy, but the server now looks different (port 80 is used by the Docker container shop-nginx-1 (nginx:1.27)). Remove the relay first, then install again.",
    );
  });

  it('a site of ours that the server no longer shows (the file is gone) does not block', async () => {
    const probe = await surveyed({ [`docker exec '${CADDY_ID}' caddy version`]: 'v2', [CADDYFILE_PATH]: read('Caddyfile') }, { installEdit: null });
    expect(plan(probe).blocked).toBeNull();
  });

  it('a working proxy install is kept and only updated; one that does not answer moves to the new layout with the address note', async () => {
    const env = { RELAY_MODE: 'proxy', RELAY_DOMAIN: 'r.example.com', RELAY_PROXY_PORT: '8787', RELAY_HTTPS_PORT: '443' };
    const alive = baseProbe({ listeners: [{ port: 80, processes: ['nginx'] }], containers: [], install: env, previous: null, proxyHealthy: true });
    expect(decideLayout(alive)).toMatchObject({ mode: 'proxy', kept: true, relayPort: 8787 });
    const kept = buildPlan({ intent: 'install', probe: alive, decision: decideLayout(alive), name: 'r.example.com', image: IMAGE });
    expect(kept.mode).toBe('proxy');
    expect(kept.notes.join(' ')).toContain('Your web server already serves the relay at r.example.com; Parley keeps this layout.');
    const dead = baseProbe({ listeners: [], containers: [], install: env, previous: null, proxyHealthy: false });
    const moved = buildPlan({ intent: 'install', probe: dead, decision: decideLayout(dead), name: 'r.example.com:8443'.split(':')[0]!, image: IMAGE });
    expect(moved.mode).toBe('caddy');
    const other = baseProbe({ listeners: [{ port: 443, processes: ['x'] }], containers: [], install: env, previous: null, proxyHealthy: false });
    const changed = buildPlan({ intent: 'install', probe: other, decision: decideLayout(other), name: 'r.example.com', image: IMAGE });
    expect(changed.notes.join(' ')).toContain('The relay address changes from r.example.com to r.example.com:8443; pair your phone again.');
  });

  it('caddy → caddy-site when there was no edit: allowed, start removes the orphan', async () => {
    const probe = await surveyed({ [`docker exec '${CADDY_ID}' caddy version`]: 'v2', [CADDYFILE_PATH]: read('Caddyfile') }, { install: { RELAY_MODE: 'caddy', RELAY_DOMAIN: NAME } });
    const p = plan(probe);
    expect(p.mode).toBe('caddy-site');
    expect(p.steps.find((s) => s.id === 'start')!.commands[0]!.run).toContain('--remove-orphans');
  });

  it('the checks of a repeat match what the install writes (files and web)', async () => {
    const p = plan(await surveyed(COURSE));
    const files = p.steps.find((s) => s.id === 'files')!;
    for (const command of files.commands.filter((c) => c.show.startsWith('write '))) {
      const body = Buffer.from(/printf %s '([^']+)'/.exec(command.run)![1]!, 'base64').toString();
      const name = /write \/opt\/parley-relay\/(\S+)/.exec(command.show)![1]!;
      expect(files.check).toContain(`${sha256(body)}  ${name}`);
    }
    const web = p.steps.find((s) => s.id === 'web')!;
    expect(web.check).toContain(sha256(p.web!.edits[0]!.content!));
  });
});

describe('rollback (spec 6.3)', () => {
  const env = { RELAY_MODE: 'caddy-site', RELAY_DOMAIN: NAME, RELAY_WEB_FILE: '/opt/evdev-site/caddy/parley-relay.caddy', RELAY_WEB_EDIT: 'file', RELAY_NETWORK: 'course-platform-prod_default', RELAY_PROXY_PORT: '8787' };
  it('inside one layout: restore, start', async () => {
    const probe = await surveyed(COURSE, { install: env, previous: { ...env } });
    const p = plan(probe, 'rollback');
    expect(p.blocked).toBeNull();
    expect(p.steps.map((s) => s.id)).toEqual(['restore', 'start']);
  });
  it('another domain, port, file or mode in previous → blocked', async () => {
    for (const change of [{ RELAY_DOMAIN: 'other.example.com' }, { RELAY_PROXY_PORT: '18787' }, { RELAY_WEB_FILE: '/x/y.caddy' }, { RELAY_MODE: 'proxy' }, { RELAY_ACME_PORT: '18080' }]) {
      const probe = await surveyed(COURSE, { install: env, previous: { ...env, ...change } });
      expect(plan(probe, 'rollback').blocked).toMatch(/different layout/);
    }
  });
  it('the .env must also match what the server shows: a caddy-site .env without our site is blocked', async () => {
    const probe = await surveyed({ [`docker exec '${CADDY_ID}' caddy version`]: 'v2', [CADDYFILE_PATH]: read('Caddyfile') }, { install: env, previous: { ...env } });
    expect(plan(probe, 'rollback').blocked).toMatch(/different layout/);
  });
});

describe('remove (spec 6.4)', () => {
  it('course VPS without reinstalling: web-undo, down, ufw, files; only parley-relay.caddy goes', async () => {
    const p = plan(await surveyed(COURSE), 'remove');
    expect(p.blocked).toBeNull();
    expect(p.steps.map((s) => s.id)).toEqual(['web-undo', 'down', 'ufw', 'files']);
    const undo = p.steps[0]!;
    const script = Buffer.from(/'([^']+)'/.exec(undo.commands[0]!.run)![1]!, 'base64').toString();
    expect(script).toContain("T='/opt/evdev-site/caddy/parley-relay.caddy'");
    expect(script).toContain('rm -f "$T"');
    expect(script).toContain(`docker exec '${CADDY_ID}' caddy validate`);
    expect(script).toContain(`docker exec '${CADDY_ID}' caddy reload`);
    expect(script).not.toContain('/opt/course-platform');
    expect(undo.check).toBe("[ ! -e '/opt/evdev-site/caddy/parley-relay.caddy' ]");
    expect(p.web!.edits[0]).toMatchObject({ action: 'remove', content: null, file: '/opt/evdev-site/caddy/parley-relay.caddy' });
  });
  it('a block in the Caddyfile is cut out and the rest stays', async () => {
    const original = read('Caddyfile.marker-block');
    const probe = await surveyed({ [`docker exec '${CADDY_ID}' caddy version`]: 'v2', [CADDYFILE_PATH]: original });
    const p = plan(probe, 'remove');
    expect(p.steps.map((s) => s.id)).toEqual(['web-undo', 'down', 'ufw', 'files']);
    expect(p.web!.edits[0]).toMatchObject({ action: 'remove-block', file: '/opt/course-platform/deploy/Caddyfile' });
    expect(p.steps[0]!.check).toContain('# BEGIN parley-relay');
  });
  it('no edit of ours → down, ufw, files as before; with data: the leftover volumes of the project go too; without: not', async () => {
    const quiet = baseProbe({ listeners: [], containers: [], install: { RELAY_MODE: 'caddy', RELAY_DOMAIN: NAME } });
    expect(plan(quiet, 'remove').steps.map((s) => s.id)).toEqual(['down', 'ufw', 'files']);
    expect(runs(plan(quiet, 'remove', true))).toContain('docker volume ls -q --filter label=com.docker.compose.project=parley-relay | xargs -r docker volume rm');
    expect(runs(plan(quiet, 'remove', false))).not.toContain('docker volume');
    expect(runs(plan(quiet, 'remove', true))).not.toContain('/var/backups');
  });
  it('the server changed and our site cannot be undone through it → blocked, nothing is torn down', async () => {
    const probe = baseProbe({
      listeners: [{ port: 80, processes: ['apache2'] }],
      containers: [],
      install: { RELAY_MODE: 'caddy-site', RELAY_DOMAIN: NAME, RELAY_WEB_FILE: '/opt/x/parley-relay.caddy' },
      installEdit: { file: '/opt/x/parley-relay.caddy', kind: 'file', sha256: sha256('x') },
    });
    probe.web = await probeWeb(probe, shellOf({}));
    const p = plan(probe, 'remove');
    expect(p.blocked).toMatch(/Parley's site is in \/opt\/x\/parley-relay\.caddy of Caddy, but the server now looks different/);
    expect(p.steps).toEqual([]);
  });
});

describe('addressFromEnv for the new layouts', () => {
  it('caddy-site → name; nginx-acme → name:8443; proxy → name', () => {
    expect(addressFromEnv({ RELAY_MODE: 'caddy-site', RELAY_DOMAIN: 'r.example.com', RELAY_HTTPS_PORT: '443' })?.address).toBe('r.example.com');
    expect(addressFromEnv({ RELAY_MODE: 'nginx-acme', RELAY_DOMAIN: 'r.example.com', RELAY_HTTPS_PORT: '8443' })?.address).toBe('r.example.com:8443');
    expect(addressFromEnv({ RELAY_MODE: 'proxy', RELAY_DOMAIN: 'r.example.com', RELAY_PROXY_PORT: '8787' })).toEqual({ address: 'r.example.com', proxyPort: 8787 });
    expect(addressFromEnv({ RELAY_MODE: 'nginx-acme', RELAY_DOMAIN: 'bad_domain', RELAY_HTTPS_PORT: '8443' })).toBeNull();
  });
});

describe('probeInstalledEdit', () => {
  it('reads the file the .env names; a foreign file or a bad path is nothing', async () => {
    const env = { RELAY_WEB_FILE: '/opt/evdev-site/caddy/parley-relay.caddy', RELAY_WEB_EDIT: 'file' };
    const found = await probeInstalledEdit(env, shellOf({ [OUR_FILE]: read('parley-relay.caddy') }));
    expect(found).toEqual({ file: env.RELAY_WEB_FILE, kind: 'file', sha256: sha256(read('parley-relay.caddy')) });
    expect(await probeInstalledEdit(env, shellOf({ [OUR_FILE]: read('foreign-parley-relay.caddy') }))).toBeNull();
    expect(await probeInstalledEdit({ RELAY_WEB_FILE: '/a/../b' }, shellOf({}))).toBeNull();
    expect(await probeInstalledEdit(null, shellOf({}))).toBeNull();
    const block = await probeInstalledEdit({ RELAY_WEB_FILE: '/opt/course-platform/deploy/Caddyfile', RELAY_WEB_EDIT: 'block' }, shellOf({ [CADDYFILE_PATH]: read('Caddyfile.marker-block') }));
    expect(block?.kind).toBe('block');
  });
});

describe('critic T5 fixes', () => {
  it('M1: the proxy check on the server asks the web server on loopback with the name resolved to it; no curl, no answer', async () => {
    const ran: string[] = [];
    const answer = (code: number, stdout: string): RemoteShell => ({
      async run(command): Promise<RunResult> {
        ran.push(command);
        return { code, stdout, stderr: '' };
      },
    });
    expect(await probeProxyOnServer('r.example.com', answer(0, '200'))).toBe(true);
    expect(ran[0]).toBe("curl -sk --max-time 5 --resolve 'r.example.com:443:127.0.0.1' -o /dev/null -w '%{http_code}' 'https://r.example.com/v1/health'");
    expect(await probeProxyOnServer('r.example.com', answer(0, '502'))).toBe(false);
    expect(await probeProxyOnServer('r.example.com', answer(127, ''))).toBe(false);
  });
  it('M1: any move off proxy says that the manual snippet stops working; keeping the layout does not', () => {
    const env = { RELAY_MODE: 'proxy', RELAY_DOMAIN: 'r.example.com', RELAY_PROXY_PORT: '8787', RELAY_HTTPS_PORT: '443' };
    const gone = baseProbe({ listeners: [], containers: [], install: env, previous: null, proxyHealthy: false });
    const moved = buildPlan({ intent: 'install', probe: gone, decision: decideLayout(gone), name: 'r.example.com', image: IMAGE });
    expect(moved.notes.join(' ')).toContain("Your web server's manual snippet for the relay (127.0.0.1:8787) stops working after this run.");
    const alive = baseProbe({ listeners: [{ port: 80, processes: ['nginx'] }], containers: [], install: env, previous: null, proxyHealthy: true });
    const kept = buildPlan({ intent: 'install', probe: alive, decision: decideLayout(alive), name: 'r.example.com', image: IMAGE });
    expect(kept.notes.join(' ')).not.toContain('stops working');
  });
  it('m1: our site is recorded but the web server holds no port 80 now → «start your web server»', async () => {
    const probe = baseProbe({
      listeners: [],
      containers: [],
      install: { RELAY_MODE: 'caddy-site', RELAY_DOMAIN: NAME, RELAY_WEB_FILE: '/opt/x/parley-relay.caddy' },
      installEdit: { file: '/opt/x/parley-relay.caddy', kind: 'file', sha256: sha256('x') },
    });
    probe.web = await probeWeb(probe, shellOf({}));
    const p = plan(probe, 'remove');
    expect(p.blocked).toMatch(/your web server is not running now \(no program uses port 80\)\. Start your web server and run the wizard again\./);
  });
  it('critic: a hand-stopped container beside a live Caddy holder does not block row 2', async () => {
    const live = await surveyed(COURSE);
    const stopped = { ...live.containers[0]!, id: '99'.repeat(32), name: 'old-site-1', running: false, restartPolicy: 'unless-stopped', boundPorts: [80], published: [], labels: {} };
    const probe = { ...live, containers: [...live.containers, stopped] };
    expect(decideLayout(probe)).toMatchObject({ mode: 'caddy-site', runtime: 'docker' });
  });
  it('critic: the snippet note only when the relay leaves its loopback port', () => {
    const env = { RELAY_MODE: 'proxy', RELAY_DOMAIN: 'r.example.com', RELAY_PROXY_PORT: '8787', RELAY_HTTPS_PORT: '443' };
    const busy = baseProbe({ listeners: [{ port: 80, processes: ['lighttpd'] }], containers: [], install: env, previous: null, proxyHealthy: false });
    const same = buildPlan({ intent: 'install', probe: busy, decision: decideLayout(busy), name: 'r.example.com', image: IMAGE });
    expect(same.mode).toBe('proxy');
    expect(same.notes.join(' ')).not.toContain('stops working');
    const taken = baseProbe({ listeners: [{ port: 80, processes: ['lighttpd'] }, { port: 8787, processes: ['x'] }], containers: [], install: env, previous: null, proxyHealthy: false });
    const moved = buildPlan({ intent: 'install', probe: taken, decision: decideLayout(taken), name: 'r.example.com', image: IMAGE });
    expect(moved.notes.join(' ')).toContain('(127.0.0.1:8787) stops working');
  });
  it('m2: a stopped container of somebody else with a restart policy that is set to publish 80 or 443 blocks the plan', () => {
    const stopped = { ...parseContainers(read('containers.jsonl'))[0]!, id: '99'.repeat(32), name: 'shop-nginx-1', running: false, restartPolicy: 'unless-stopped', boundPorts: [80, 443], published: [], labels: {} };
    const free = { listeners: [], containers: [stopped] };
    expect(decideLayout(baseProbe(free))).toEqual({
      mode: 'blocked',
      reason: 'Port 80 is assigned to the stopped container shop-nginx-1 (restart policy unless-stopped). Start it or remove it, then run the wizard again.',
    });
    expect(decideLayout(baseProbe({ ...free, containers: [{ ...stopped, boundPorts: [443] }] }))).toMatchObject({ mode: 'blocked', reason: expect.stringMatching(/^Port 443 is assigned/) });
    // With 443 held by somebody that runs, only 80 is ours to take.
    expect(decideLayout(baseProbe({ listeners: [{ port: 443, processes: ['haproxy'] }], containers: [{ ...stopped, boundPorts: [443] }] })).mode).toBe('caddy');
    // No restart policy, our own container or other ports: nothing waits for the ports.
    expect(decideLayout(baseProbe({ ...free, containers: [{ ...stopped, restartPolicy: 'no' }] })).mode).toBe('caddy');
    expect(decideLayout(baseProbe({ ...free, containers: [{ ...stopped, labels: { 'com.docker.compose.project': 'parley-relay' } }] })).mode).toBe('caddy');
    expect(decideLayout(baseProbe({ ...free, containers: [{ ...stopped, boundPorts: [8080] }] })).mode).toBe('caddy');
  });
});
