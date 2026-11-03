import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPlan, decideLayout, relayAddress, sslipName } from './plan.js';
import { holderOf, parseContainers, parseEnv, parseListeners, parseOsRelease, type ContainerInfo, type Listener, type ProbeResult } from './probe.js';
import { CADDYFILE, COMPOSE_CADDY, proxySnippet } from './templates.js';

const IMAGE = 'ghcr.io/kalmbik61/parley-relay@sha256:' + 'a'.repeat(64);

function probe(over: Partial<ProbeResult> = {}, listeners: Listener[] = []): ProbeResult {
  return {
    os: parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04"\n'),
    arch: 'amd64',
    root: true,
    sudoPasswordless: true,
    docker: false,
    compose: false,
    listeners,
    containers: [],
    web: null,
    activeCommand: null,
    previousTail: null,
    ufwActive: false,
    install: null,
    previous: null,
    ...over,
  };
}
function container(name: string, project: string, ports: number[]): ContainerInfo {
  return {
    id: name,
    name,
    image: 'img',
    labels: { 'com.docker.compose.project': project },
    path: 'x',
    args: [],
    workdir: '',
    mounts: [],
    published: ports.map((hostPort) => ({ hostPort, hostIp: '0.0.0.0' })),
    networks: [],
    networkAliases: {},
    networkMode: 'default',
  };
}
const nginx: Listener[] = [{ port: 80, processes: ['nginx'] }, { port: 443, processes: ['nginx'] }];

describe('decideLayout (spec 6.7)', () => {
  it('both free → Caddy on 80/443', () => {
    expect(decideLayout(probe())).toEqual({ mode: 'caddy', httpPort: 80, httpsPort: 443 });
    expect(decideLayout(probe({}, [{ port: 22, processes: ['sshd'] }]))).toMatchObject({ mode: 'caddy', httpsPort: 443 });
  });
  it('443 busy, 80 free → Caddy on 8443', () => {
    expect(decideLayout(probe({}, [{ port: 443, processes: ['haproxy'] }]))).toEqual({ mode: 'caddy', httpPort: 80, httpsPort: 8443 });
  });
  it('443 and 8443 busy → blocked', () => {
    expect(decideLayout(probe({}, [{ port: 443, processes: [] }, { port: 8443, processes: [] }])).mode).toBe('blocked');
  });
  it('80 busy → loopback relay and a snippet for the server found', () => {
    expect(decideLayout(probe({}, nginx))).toMatchObject({ mode: 'proxy', relayPort: 8787, server: 'nginx', network: null });
    expect(decideLayout(probe({}, [{ port: 80, processes: ['apache2'] }]))).toMatchObject({ mode: 'proxy', server: 'apache' });
    expect(decideLayout(probe({}, [{ port: 80, processes: ['lighttpd'] }, { port: 8787, processes: [] }]))).toMatchObject({ mode: 'proxy', relayPort: 18787, server: 'other' });
  });
  it('docker-proxy on 80 and 443 with no container in the list → busy by an unknown container', () => {
    const own: Listener[] = [{ port: 80, processes: ['docker-proxy'] }, { port: 443, processes: ['docker-proxy'] }];
    expect(decideLayout(probe({ install: { RELAY_DOMAIN: 'x.example.com' } }, own)).mode).toBe('proxy');
    expect(holderOf(probe({}, own), 80)).toEqual({ kind: 'unknown-docker' });
  });
  it('our own container (parley-relay project) publishing 80/443 does not hold them: repeat of our install', () => {
    const own: Listener[] = [{ port: 80, processes: ['docker-proxy'] }, { port: 443, processes: ['docker-proxy'] }];
    const ours = container('parley-relay-relay-1', 'parley-relay', [80, 443]);
    expect(decideLayout(probe({ containers: [ours] }, own))).toEqual({ mode: 'caddy', httpPort: 80, httpsPort: 443 });
    expect(decideLayout(probe({ containers: [ours] }, own))).toEqual(decideLayout(probe({ install: { A: '1' }, containers: [ours] }, own)));
  });
  it('userland-proxy off: no listener in ss, a foreign container publishes 80 → 80 is busy', () => {
    const other = container('web-1', 'site', [80]);
    expect(holderOf(probe({ containers: [other] }), 80)).toEqual({ kind: 'container', container: other });
    expect(decideLayout(probe({ containers: [other] }))).toMatchObject({ mode: 'proxy', server: 'other' });
  });
});

describe('course VPS (run 2 of 2026-11-03)', () => {
  const dir = path.join(__dirname, 'fixtures', 'course-vps');
  const read = (name: string): string => readFileSync(path.join(dir, name), 'utf8');
  const course = (extra: Partial<ProbeResult> = {}): ProbeResult =>
    probe({ listeners: parseListeners(read('ss-ltnp.txt')), containers: parseContainers(read('containers.jsonl')), install: parseEnv(read('env.txt')), previous: parseEnv(read('previous-env.txt')), docker: true, compose: true, ...extra });
  it('parses the fixtures', () => {
    const [caddy, relay] = parseContainers(read('containers.jsonl'));
    expect(caddy).toMatchObject({ name: 'course-platform-prod-caddy-1', image: 'caddy:2', path: 'caddy', networks: ['course-platform-prod_default'] });
    expect(caddy?.published.map((p) => p.hostPort).sort()).toEqual([443, 443, 80, 80].sort());
    expect(caddy?.mounts.map((m) => `${m.source} → ${m.destination}`)).toEqual([
      '/opt/course-platform/deploy/Caddyfile → /etc/caddy/Caddyfile',
      '/opt/evdev-site/caddy → /etc/caddy/sites',
    ]);
    expect(relay).toMatchObject({ name: 'parley-relay-relay-1', published: [] });
    expect(parseEnv(read('previous-env.txt')).RELAY_MODE).toBe('proxy');
  });
  it('80 and 443 are held by the course Caddy container; the decision is not caddy', () => {
    const p = course();
    for (const port of [80, 443]) expect(holderOf(p, port)).toMatchObject({ kind: 'container', container: { name: 'course-platform-prod-caddy-1' } });
    expect(holderOf(p, 22)).toEqual({ kind: 'process', names: ['sshd'] });
    expect(decideLayout(p).mode).not.toBe('caddy');
    expect(decideLayout(course({ install: null, previous: null })).mode).not.toBe('caddy');
  });
});

describe('a command of the previous run is still alive (spec 7.3)', () => {
  it('blocks every intent with the command named', () => {
    const alive = probe({ activeCommand: { pid: 4242, id: 'files' } });
    for (const intent of ['install', 'rollback', 'remove'] as const) {
      const plan = buildPlan({ intent, probe: alive, decision: decideLayout(alive), name: 'x.example.com', image: IMAGE });
      expect(plan.blocked).toMatch(/still running on the server: files\. Wait a minute/);
      expect(plan.steps).toEqual([]);
    }
  });
});

describe('address', () => {
  it('sslip name and port', () => {
    expect(sslipName('203.0.113.7')).toBe('203-0-113-7.sslip.io');
    expect(relayAddress('r.example.com', { mode: 'caddy', httpPort: 80, httpsPort: 8443 })).toBe('r.example.com:8443');
    expect(relayAddress('r.example.com', { mode: 'caddy', httpPort: 80, httpsPort: 443 })).toBe('r.example.com');
    expect(relayAddress('r.example.com', { mode: 'proxy', relayPort: 8787, server: 'nginx', holder: 'nginx', reason: null, network: null })).toBe('r.example.com');
  });
});

describe('buildPlan: install', () => {
  const ctx = (p: ProbeResult, name = '203-0-113-7.sslip.io') => ({ intent: 'install' as const, probe: p, decision: decideLayout(p), name, image: IMAGE });

  it('is check → do for every step, with the image pinned by digest', () => {
    const plan = buildPlan(ctx(probe()));
    expect(plan.blocked).toBeNull();
    expect(plan.steps.map((s) => s.id)).toEqual(['docker', 'dir', 'files', 'image', 'start']);
    for (const step of plan.steps) {
      expect(step.check).not.toBeNull();
      expect(step.commands.length).toBeGreaterThan(0);
    }
    expect(plan.address).toBe('203-0-113-7.sslip.io');
    const text = JSON.stringify(plan.steps.map((s) => s.commands.map((c) => c.show)));
    expect(text).toContain(`docker pull ${IMAGE}`);
    expect(text).toContain('download.docker.com/linux/ubuntu');
    expect(text).not.toMatch(/curl[^"]*\|\s*(ba)?sh/);
  });

  it('writes Docker repo lines from the probe, not from free text', () => {
    const debian = probe({ os: parseOsRelease('ID=debian\nVERSION_ID="12"\n'), arch: 'arm64' });
    const plan = buildPlan(ctx(debian));
    const body = Buffer.from(/printf %s '([^']+)'/.exec(plan.steps[0]!.commands.find((c) => c.show.includes('docker.list'))!.run)![1]!, 'base64').toString();
    expect(body).toBe('deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable\n');
  });

  it('adds ufw rules only when ufw is active; 8443 goes into them and into the address', () => {
    expect(buildPlan(ctx(probe())).steps.some((s) => s.id === 'ufw')).toBe(false);
    const busy443 = probe({ ufwActive: true }, [{ port: 443, processes: ['haproxy'] }]);
    const plan = buildPlan(ctx(busy443, 'r.example.com'));
    const ufw = plan.steps.find((s) => s.id === 'ufw')!;
    expect(ufw.commands.map((c) => c.run).join('\n')).toMatch(/80\/tcp[\s\S]*8443\/tcp/);
    expect(plan.address).toBe('r.example.com:8443');
    expect(plan.notes.join(' ')).toMatch(/provider has a firewall/);
  });

  it('with port 80 busy it installs no Caddy, binds loopback and returns a snippet; foreign configs are not touched', () => {
    const plan = buildPlan(ctx(probe({}, nginx), 'r.example.com'));
    expect(plan.mode).toBe('proxy');
    expect(plan.proxy?.snippet).toContain('proxy_pass http://127.0.0.1:8787;');
    expect(plan.proxy?.snippet).toContain('Upgrade');
    const all = plan.steps.flatMap((s) => s.commands.map((c) => c.show)).join('\n');
    expect(all).not.toMatch(/nginx|apache|Caddyfile\b.*write/i);
    expect(all).not.toMatch(/\/etc\/(nginx|apache2|httpd|caddy)/);
    expect(all).toContain('127.0.0.1');
    expect(plan.steps.some((s) => s.id === 'ufw')).toBe(false);
    expect(plan.address).toBe('r.example.com');
  });

  it('blocks on an unsupported OS or CPU, and on Docker without Compose', () => {
    expect(buildPlan(ctx(probe({ os: parseOsRelease('ID=alpine\nVERSION_ID=3.20\n') }))).blocked).toMatch(/Unsupported system/);
    expect(buildPlan(ctx(probe({ arch: null }))).blocked).toMatch(/architecture/);
    expect(buildPlan(ctx(probe({ docker: true, compose: false }))).blocked).toMatch(/Compose/);
    expect(buildPlan(ctx(probe({}, [{ port: 80, processes: [] }, { port: 8787, processes: [] }, { port: 18787, processes: [] }, { port: 28787, processes: [] }]))).blocked).toMatch(/no local port/);
  });

  it('never puts the .env content on the screen', () => {
    const shown = buildPlan(ctx(probe())).steps.flatMap((s) => s.commands.map((c) => c.show)).join('\n');
    expect(shown).toContain('.env (');
    expect(shown).not.toContain('RELAY_IMAGE=');
  });
});

describe('buildPlan: rollback and remove', () => {
  const installed = probe({ install: { RELAY_DOMAIN: 'r.example.com' }, previous: { RELAY_DOMAIN: 'r.example.com' } });
  it('rollback needs a previous version', () => {
    expect(buildPlan({ intent: 'rollback', probe: probe({ install: {} }), decision: decideLayout(probe()), name: '', image: IMAGE }).blocked).toMatch(/previous/);
    const plan = buildPlan({ intent: 'rollback', probe: installed, decision: decideLayout(installed), name: '', image: IMAGE });
    expect(plan.blocked).toBeNull();
    expect(plan.steps.map((s) => s.id)).toEqual(['restore', 'start']);
  });
  it('remove keeps the data volumes unless the person confirmed, and says Docker stays', () => {
    const run = (removeData: boolean) =>
      buildPlan({ intent: 'remove', probe: installed, decision: decideLayout(installed), name: '', image: IMAGE, removeData }).steps.flatMap((s) => s.commands.map((c) => c.run));
    expect(run(false).join('\n')).toContain('down');
    expect(run(false).join('\n')).not.toContain('down -v');
    expect(run(true).join('\n')).toContain('down -v');
    expect(run(false).join('\n')).toContain('rm -rf /opt/parley-relay');
    expect(run(false).join('\n')).toContain('ufw-rules');
    const plan = buildPlan({ intent: 'remove', probe: installed, decision: decideLayout(installed), name: '', image: IMAGE });
    expect(plan.notes.join(' ')).toMatch(/Docker .* stay/);
  });
  it('remove without an install is blocked', () => {
    expect(buildPlan({ intent: 'remove', probe: probe(), decision: decideLayout(probe()), name: '', image: IMAGE }).blocked).toMatch(/No relay/);
  });
});

describe('templates', () => {
  const deploy = path.resolve(__dirname, '../../../../relay/deploy');
  it('stay identical to packages/relay/deploy (the files the README gives)', () => {
    expect(COMPOSE_CADDY).toBe(readFileSync(path.join(deploy, 'compose.yml'), 'utf8'));
    expect(CADDYFILE).toBe(readFileSync(path.join(deploy, 'Caddyfile'), 'utf8'));
  });
  it('the apache snippet proxies WebSocket upgrades', () => {
    expect(proxySnippet('apache', 9000).snippet).toContain('ws://127.0.0.1:9000/v1/');
  });
});
