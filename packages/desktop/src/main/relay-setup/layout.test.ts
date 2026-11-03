import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPlan, decideLayout, type Plan } from './plan.js';
import { CADDYFILE_ACME, COMPOSE_ACME_DOCKER, COMPOSE_ACME_HOST, nginxSiteFile } from './templates.js';
import { parseContainers, parseEnv, parseListeners, parseOsRelease, type ContainerInfo, type ProbeResult } from './probe.js';
import type { RemoteShell, RunResult } from './shell.js';
import { probeWeb } from './web.js';

const IMAGE = 'ghcr.io/kalmbik61/parley-relay@sha256:' + 'a'.repeat(64);
const dir = path.join(__dirname, 'fixtures', 'course-vps');
const read = (name: string): string => readFileSync(path.join(dir, name), 'utf8');
const CADDY_ID = 'c1'.repeat(32);
const CADDYFILE_PATH = "cat '/opt/course-platform/deploy/Caddyfile'";
const OUR_FILE = "cat '/opt/evdev-site/caddy/parley-relay.caddy'";
const CHECK = `docker exec '${CADDY_ID}' caddy version`;

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

/** Probe with stage 3 done against the given server answers. */
async function surveyed(answers: Record<string, string>, over: Partial<ProbeResult> = {}): Promise<ProbeResult> {
  const probe = baseProbe(over);
  return { ...probe, web: await probeWeb(probe, shellOf(answers)) };
}

const COURSE = { [CHECK]: 'v2.11.4', [CADDYFILE_PATH]: read('Caddyfile'), [OUR_FILE]: read('parley-relay.caddy') };
const NAME = '82-146-37-224.sslip.io';
const plan = (probe: ProbeResult, name = NAME, intent: 'install' | 'rollback' | 'remove' = 'install'): Plan =>
  buildPlan({ intent, probe, decision: decideLayout(probe), name, image: IMAGE });

/** The script inside the `web` step's command. */
function scriptOf(p: Plan): string {
  const run = p.steps.find((s) => s.id === 'web')!.commands[0]!.run;
  const b64 = /^printf %s '([^']+)' \| base64 -d \| sh$/.exec(run)![1]!;
  return Buffer.from(b64, 'base64').toString('utf8');
}

describe('table of spec 4', () => {
  it('rows 1 and 1б: nobody holds 80 → own Caddy; only 443 busy → 8443; both busy → blocked', () => {
    const free = baseProbe({ listeners: [], containers: [] });
    expect(decideLayout(free)).toEqual({ mode: 'caddy', httpPort: 80, httpsPort: 443 });
    expect(decideLayout({ ...free, listeners: [{ port: 443, processes: ['haproxy'] }] })).toEqual({ mode: 'caddy', httpPort: 80, httpsPort: 8443 });
    expect(decideLayout({ ...free, listeners: [{ port: 443, processes: ['a'] }, { port: 8443, processes: ['b'] }] }).mode).toBe('blocked');
  });

  it('row 2: Docker Caddy holds 80 and 443 → caddy-site docker in its network', async () => {
    const layout = decideLayout(await surveyed(COURSE));
    expect(layout).toMatchObject({ mode: 'caddy-site', runtime: 'docker', network: 'course-platform-prod_default' });
  });

  it('row 4a: Caddy under systemd holds 80 and 443 → caddy-site host on a free loopback port', async () => {
    const answers = {
      'systemctl is-active caddy nginx apache2 httpd': 'active\ninactive\ninactive\ninactive\n',
      'systemctl show -p ExecStart --value caddy': '{ path=/usr/bin/caddy ; argv[]=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile ; }',
      'systemctl show -p ExecReload --value caddy': '{ path=/usr/bin/caddy ; argv[]=/usr/bin/caddy reload ; }',
      "cat '/etc/caddy/Caddyfile'": 'import /etc/caddy/conf.d/*.caddy\n',
    };
    const probe = await surveyed(answers, { listeners: [{ port: 80, processes: ['caddy'] }, { port: 443, processes: ['caddy'] }, { port: 8787, processes: ['x'] }], containers: [] });
    expect(decideLayout(probe)).toMatchObject({ mode: 'caddy-site', runtime: 'host', network: null, relayPort: 18787 });
    const p = plan(probe, 'r.example.com');
    expect(p.steps.map((s) => s.id)).toEqual(['docker', 'dir', 'files', 'image', 'start', 'web']);
    expect(Buffer.from(/'([^']+)'/.exec(p.steps.find((s) => s.id === 'files')!.commands.find((c) => c.show.startsWith('write /opt/parley-relay/compose.yml'))!.run)![1]!, 'base64').toString()).toContain('127.0.0.1:${RELAY_PROXY_PORT');
    const script = scriptOf(p);
    expect(script).toContain('systemctl reload caddy');
    expect(script).not.toContain('caddy validate');
    expect(Buffer.from(/printf %s '([^']+)' \| base64 -d >/.exec(script)![1]!, 'base64').toString()).toContain('reverse_proxy 127.0.0.1:18787');
  });

  it('row 5 reasons: each unsuitable server falls back to the snippet and says why', async () => {
    const reasonOf = (probe: ProbeResult): string => {
      const layout = decideLayout(probe);
      expect(layout.mode).toBe('proxy');
      return layout.mode === 'proxy' ? `${layout.holder} | ${layout.reason ?? ''}` : '';
    };
    expect(reasonOf(await surveyed({}, { listeners: [{ port: 80, processes: ['apache2'] }], containers: [] }))).toMatch(/Apache \(apache2\) \| Apache is not supported/);
    expect(reasonOf(await surveyed({}, { listeners: [{ port: 80, processes: ['traefik'] }], containers: [] }))).toMatch(/^traefik \| /);
    expect(reasonOf(await surveyed({}, { listeners: [{ port: 80, processes: ['docker-proxy'] }], containers: [] }))).toMatch(/^a Docker container \| .*not in the list/);
    expect(reasonOf(await surveyed({ [CHECK]: 'v2' }))).toMatch(/Caddyfile could not be read/);
    expect(reasonOf(await surveyed({ ...COURSE, [CADDYFILE_PATH]: read('Caddyfile.admin-off') }))).toMatch(/admin endpoint is off/);
    // Caddy holds 80 only: the same Caddy must hold both.
    const only80 = await surveyed(COURSE, {});
    const c = only80.containers.map((x) => (x.id === CADDY_ID ? { ...x, published: x.published.filter((p) => p.hostPort === 80) } : x));
    expect(reasonOf({ ...only80, containers: c, listeners: only80.listeners.filter((l) => l.port !== 443) })).toMatch(/both port 80 and port 443/);
    // nginx is layout 5 until its own layout exists.
    const nginx: ContainerInfo = { ...parseContainers(read('containers.jsonl'))[0]!, id: 'f5'.repeat(32), name: 'shop-nginx-1', image: 'nginx:1.27' };
    const probe = await surveyed({ [`docker exec '${nginx.id}' nginx -v`]: '' }, { containers: [nginx], listeners: [] });
    expect(reasonOf(probe)).toMatch(/shop-nginx-1 \(nginx:1.27\)/);
  });

  it('row 5 behind a container in a user network: the relay joins it and the snippet points at parley-relay:8787', async () => {
    const probe = await surveyed({ [CHECK]: 'v2' }); // Caddyfile unreadable → layout 5
    const layout = decideLayout(probe);
    expect(layout).toMatchObject({ mode: 'proxy', network: 'course-platform-prod_default' });
    const p = plan(probe);
    expect(p.proxy?.snippet).toContain('parley-relay:8787');
    expect(p.mode).toBe('proxy');
    const files = p.steps.find((s) => s.id === 'files')!;
    expect(files.commands.some((c) => c.show.includes('name: ${RELAY_NETWORK'))).toBe(true);
    expect(p.steps.find((s) => s.id === 'start')!.check).toContain('grep -qx parley-relay');
    expect(p.notes.join(' ')).toMatch(/joins its Docker network course-platform-prod_default/);
    expect(p.web).toMatchObject({ network: 'course-platform-prod_default', edits: [] });
  });

  it('no free loopback port → blocked', () => {
    const probe = baseProbe({ listeners: [{ port: 80, processes: ['nginx'] }, { port: 8787, processes: [] }, { port: 18787, processes: [] }, { port: 28787, processes: [] }], containers: [] });
    expect(decideLayout(probe)).toMatchObject({ mode: 'blocked', reason: expect.stringMatching(/no local port/) });
  });

  it('a file of somebody else with our name, a broken marker or a clashing name block the plan', async () => {
    const foreign = decideLayout(await surveyed({ ...COURSE, [OUR_FILE]: read('foreign-parley-relay.caddy') }));
    expect(foreign).toMatchObject({ mode: 'blocked', reason: expect.stringMatching(/was not written by Parley/) });
    const marker = decideLayout(await surveyed({ ...COURSE, [CADDYFILE_PATH]: read('Caddyfile.marker-single') }));
    expect(marker).toMatchObject({ mode: 'blocked', reason: expect.stringMatching(/marker/) });
    const probe = baseProbe();
    const stranger: ContainerInfo = { ...probe.containers[1]!, id: 'd3'.repeat(32), name: 'parley-relay', labels: {}, networks: ['course-platform-prod_default'] };
    const clash = decideLayout(await surveyed(COURSE, { containers: [...probe.containers, stranger] }));
    expect(clash).toMatchObject({ mode: 'blocked', reason: expect.stringMatching(/parley-relay-acme are already used/) });
  });
});

describe('course VPS: install plan', () => {
  it('caddy-site docker; steps; the edit replaces the manual file; Docker validate and reload', async () => {
    const p = plan(await surveyed(COURSE));
    expect(p.blocked).toBeNull();
    expect(p.mode).toBe('caddy-site');
    expect(p.address).toBe(NAME);
    expect(p.steps.map((s) => s.id)).toEqual(['docker', 'dir', 'files', 'image', 'start', 'web']);
    expect(p.steps.find((s) => s.id === 'start')!.commands[0]!.run).toContain('up -d --remove-orphans --quiet-pull');
    expect(p.steps.find((s) => s.id === 'start')!.check).toContain('grep -qx parley-relay');
    const card = p.web!.edits[0]!;
    expect(card).toMatchObject({ server: 'Caddy (Docker)', file: '/opt/evdev-site/caddy/parley-relay.caddy', action: 'replace' });
    expect(card.content).toBe(`# parley-relay: added by the Parley relay setup wizard. Remove it with the wizard (Remove relay).\n${NAME} {\n\treverse_proxy parley-relay:8787\n}\n`);
    expect(card.check).toBe(`docker exec '${CADDY_ID}' caddy validate --config '/etc/caddy/Caddyfile' --adapter caddyfile`);
    expect(card.reload).toBe(`docker exec '${CADDY_ID}' caddy reload --config '/etc/caddy/Caddyfile' --adapter caddyfile --address '127.0.0.1:2019'`);
    expect(card.backup).toMatch(/^\/var\/backups\/parley-relay\/<time>-parley-relay\.caddy$/);
    expect(p.web!.network).toBe('course-platform-prod_default');
    expect(p.notes.join(' ')).toMatch(/reload applies your server's whole configuration/);
    const env = Buffer.from(/'([^']+)'/.exec(p.steps.find((s) => s.id === 'files')!.commands.find((c) => c.show.startsWith('write /opt/parley-relay/.env'))!.run)![1]!, 'base64').toString();
    expect(env).toContain('RELAY_MODE=caddy-site\n');
    expect(env).toContain('RELAY_WEB_FILE=/opt/evdev-site/caddy/parley-relay.caddy\nRELAY_WEB_EDIT=file\nRELAY_NETWORK=course-platform-prod_default\n');
  });

  it('the Caddyfile of the course is not changed (no write to it in the script)', async () => {
    const script = scriptOf(plan(await surveyed(COURSE)));
    expect(script).toContain("T='/opt/evdev-site/caddy/parley-relay.caddy'");
    expect(script).not.toContain('/opt/course-platform');
  });

  it('a clean server without the manual file → add', async () => {
    const p = plan(await surveyed({ [CHECK]: 'v2', [CADDYFILE_PATH]: read('Caddyfile') }));
    expect(p.web!.edits[0]).toMatchObject({ action: 'add', file: '/opt/evdev-site/caddy/parley-relay.caddy', backup: 'none (the file is new)' });
  });

  it('without an import directory the block is appended to the Caddyfile; an earlier block is replaced', async () => {
    const plain = 'example.com {\n\trespond "ok"\n}\n';
    const appended = plan(await surveyed({ [CHECK]: 'v2', [CADDYFILE_PATH]: plain }));
    expect(appended.web!.edits[0]).toMatchObject({ action: 'append', file: '/opt/course-platform/deploy/Caddyfile' });
    expect(appended.web!.edits[0]!.content).toMatch(/^\n# BEGIN parley-relay/);
    const again = plan(await surveyed({ [CHECK]: 'v2', [CADDYFILE_PATH]: read('Caddyfile.marker-block') }));
    expect(again.web!.edits[0]).toMatchObject({ action: 'replace', file: '/opt/course-platform/deploy/Caddyfile' });
    expect(again.web!.edits[0]!.content!.match(/# BEGIN parley-relay/g)).toHaveLength(1);
  });

  it('the web check needs the sha and the running server to know the site; a missing tool makes the step run', async () => {
    const check = plan(await surveyed(COURSE)).steps.find((s) => s.id === 'web')!.check!;
    expect(check).toMatch(/^\[ "\$\(sha256sum '[^']+' \| cut -d' ' -f1\)" = '[0-9a-f]{64}' \] && docker exec '[0-9a-f]{64}' wget -qO- 'http:\/\/127\.0\.0\.1:2019\/config\/' \| grep -qF '82-146-37-224\.sslip\.io'$/);
  });

  it('a live command of the previous run blocks; the tail of a dead one is in the notes', async () => {
    expect(plan(await surveyed(COURSE, { activeCommand: { id: 'image' } })).blocked).toMatch(/still running on the server: image/);
    const p = plan(await surveyed(COURSE, { previousTail: { id: 'files', text: 'line one\nE: dpkg was interrupted\n' } }));
    expect(p.notes.join('\n')).toMatch(/stopped in the command «files».*dpkg was interrupted/);
  });

  it('every command is a fixed template: server values only appear quoted or inside base64', async () => {
    const p = plan(await surveyed(COURSE));
    const stripped = p.steps
      .flatMap((s) => [s.check ?? '', ...s.commands.map((c) => c.run)])
      .map((c) => c.replace(/'[^']*'/g, "'Q'"))
      .join('\n');
    // After quoting is removed, no id, path, network or name of the server is left in any command.
    for (const value of [CADDY_ID, 'course-platform-prod', '/opt/evdev-site', '/opt/course-platform', NAME]) expect(stripped).not.toContain(value);
  });
});

describe('nginx-acme (spec 4 rows 3 and 4б, 4.1)', () => {
  const NGINX_ID = 'f5'.repeat(32);
  const nginxContainer = (over: Partial<ContainerInfo> = {}): ContainerInfo => ({
    id: NGINX_ID,
    name: 'shop-nginx-1',
    image: 'nginx:1.27',
    labels: { 'com.docker.compose.project': 'shop' },
    path: 'nginx',
    args: [],
    workdir: '',
    mounts: [{ type: 'bind', source: '/srv/nginx/conf.d', destination: '/etc/nginx/conf.d', rw: false }],
    published: [{ hostPort: 80, hostIp: '0.0.0.0' }, { hostPort: 443, hostIp: '0.0.0.0' }],
    networks: ['shop_default'],
    networkAliases: {},
    networkMode: 'shop_default',
    ...over,
  });
  const DUMP = read('nginx-t-official.txt');
  const dockerAnswers = (dump = DUMP): Record<string, string> => ({ [`docker exec '${NGINX_ID}' nginx -v`]: 'nginx version: nginx/1.27.0', [`docker exec '${NGINX_ID}' nginx -T`]: dump });
  const dockerProbe = (over: Partial<ProbeResult> = {}, c: Partial<ContainerInfo> = {}): Promise<ProbeResult> =>
    surveyed(dockerAnswers(), { containers: [nginxContainer(c)], listeners: [], ...over });
  const hostAnswers: Record<string, string> = {
    'systemctl is-active caddy nginx apache2 httpd': 'inactive\nactive\ninactive\ninactive\n',
    'nginx -T': DUMP,
  };
  const hostProbe = (over: Partial<ProbeResult> = {}, answers = hostAnswers): Promise<ProbeResult> =>
    surveyed(answers, { containers: [], listeners: [{ port: 80, processes: ['nginx'] }, { port: 443, processes: ['nginx'] }], ...over });
  const NAME = 'relay.example.com';

  it('row 3: nginx in Docker → nginx-acme in its network, the address carries 8443', async () => {
    const probe = await dockerProbe();
    expect(decideLayout(probe)).toMatchObject({ mode: 'nginx-acme', runtime: 'docker', network: 'shop_default' });
    const p = plan(probe, NAME);
    expect(p.blocked).toBeNull();
    expect(p.mode).toBe('nginx-acme');
    expect(p.address).toBe(`${NAME}:8443`);
    expect(p.steps.map((s) => s.id)).toEqual(['docker', 'dir', 'files', 'image', 'web', 'start']);
    expect(plan({ ...probe, ufwActive: true }, NAME).steps.map((s) => s.id)).toEqual(['docker', 'dir', 'files', 'image', 'ufw', 'web', 'start']);
    expect(p.steps.find((s) => s.id === 'ufw') ?? plan({ ...probe, ufwActive: true }, NAME).steps.find((s) => s.id === 'ufw')!.commands[0]!.run).toContain('8443/tcp');
    expect(p.steps.find((s) => s.id === 'image')!.commands.map((c) => c.show).join('\n')).toMatch(/parley-relay@sha256:a+\ndocker pull caddy:2\.11\.7@sha256:/);
    const start = p.steps.find((s) => s.id === 'start')!;
    expect(start.check).toContain('grep -qx parley-relay &&');
    expect(start.check).toContain('grep -qx parley-relay-acme');
    const card = p.web!.edits[0]!;
    expect(card).toMatchObject({ server: 'nginx (Docker)', file: '/srv/nginx/conf.d/parley-relay.conf', action: 'add', content: nginxSiteFile(NAME, 'docker', null) });
    expect(card.content).toContain('resolver 127.0.0.11 valid=30s;');
    expect(card.check).toContain(`docker exec '${NGINX_ID}' nginx -t`);
    expect(card.check).toContain(`conflicting server name "${NAME}"`);
    expect(card.check).toContain('# configuration file /etc/nginx/conf.d/parley-relay.conf:');
    expect(card.reload).toBe(`docker exec '${NGINX_ID}' nginx -s reload`);
    expect(p.web!.network).toBe('shop_default');
    expect(p.notes.join(' ')).toMatch(/Port 443 stays yours: the relay answers on port 8443/);
  });

  it('the files: network compose with two services, the ACME Caddyfile, the new .env keys', async () => {
    const p = plan(await dockerProbe(), NAME);
    const body = (file: string): string => Buffer.from(/'([^']+)'/.exec(p.steps.find((s) => s.id === 'files')!.commands.find((c) => c.show.startsWith(`write /opt/parley-relay/${file}`))!.run)![1]!, 'base64').toString();
    expect(body('compose.yml')).toBe(COMPOSE_ACME_DOCKER);
    expect(body('Caddyfile')).toBe(CADDYFILE_ACME);
    expect(COMPOSE_ACME_DOCKER).toMatch(/^ {2}parley-relay:$/m);
    expect(COMPOSE_ACME_DOCKER).toMatch(/^ {2}parley-relay-acme:$/m);
    expect(CADDYFILE_ACME).toContain('disable_tlsalpn_challenge');
    expect(CADDYFILE_ACME).toContain('reverse_proxy parley-relay:8787');
    const env = body('.env');
    expect(env).toContain('RELAY_MODE=nginx-acme\n');
    expect(env).toContain('RELAY_HTTPS_PORT=8443\n');
    expect(env).toContain('RELAY_WEB_RUNTIME=docker\nRELAY_WEB_FILE=/srv/nginx/conf.d/parley-relay.conf\nRELAY_WEB_EDIT=file\nRELAY_NETWORK=shop_default\n');
    expect(env).not.toContain('RELAY_ACME_PORT');
    // This layout keeps its own Caddyfile: the files check does not demand its absence.
    expect(p.steps.find((s) => s.id === 'files')!.check).not.toContain('! -e Caddyfile');
  });

  it('row 4б: nginx under systemd → nginx-acme with Caddy HTTP on loopback', async () => {
    const probe = await hostProbe({}, hostAnswers);
    expect(decideLayout(probe)).toMatchObject({ mode: 'nginx-acme', runtime: 'host', network: null, acmePort: 18080 });
    const busy = await hostProbe({ listeners: [{ port: 80, processes: ['nginx'] }, { port: 18080, processes: ['x'] }] });
    expect(decideLayout(busy)).toMatchObject({ mode: 'nginx-acme', acmePort: 28080 });
    const p = plan(probe, NAME);
    expect(p.steps.map((s) => s.id)).toEqual(['docker', 'dir', 'files', 'image', 'web', 'start']);
    const card = p.web!.edits[0]!;
    expect(card).toMatchObject({ server: 'nginx (systemd)', file: '/etc/nginx/conf.d/parley-relay.conf', action: 'add', reload: 'nginx -s reload' });
    expect(card.content).toContain('proxy_pass http://127.0.0.1:18080;');
    expect(card.content).not.toContain('resolver');
    expect(card.check).toMatch(/^out=\$\(nginx -t 2>&1\) && ! echo "\$out" \| grep -qF 'conflicting server name "relay\.example\.com"' && nginx -T 2>\/dev\/null \| grep -qF '# configuration file \/etc\/nginx\/conf\.d\/parley-relay\.conf:'$/);
    const body = (file: string): string => Buffer.from(/'([^']+)'/.exec(p.steps.find((s) => s.id === 'files')!.commands.find((c) => c.show.startsWith(`write /opt/parley-relay/${file}`))!.run)![1]!, 'base64').toString();
    expect(body('compose.yml')).toBe(COMPOSE_ACME_HOST);
    expect(COMPOSE_ACME_HOST).toContain("'127.0.0.1:${RELAY_ACME_PORT:?set RELAY_ACME_PORT}:80'");
    expect(body('.env')).toContain('RELAY_ACME_PORT=18080\n');
    expect(body('.env')).not.toContain('RELAY_NETWORK');
  });

  it('a file of ours is replaced; one of somebody else blocks', async () => {
    const path = "base64 -w0 '/srv/nginx/conf.d/parley-relay.conf'";
    const ours = Buffer.from(nginxSiteFile(NAME, 'docker', null).replace('relay.example.com', 'old.example.com'), 'utf8').toString('base64');
    const probe = await surveyed({ ...dockerAnswers(), [path]: ours }, { containers: [nginxContainer()], listeners: [] });
    expect(plan(probe, NAME).web!.edits[0]).toMatchObject({ action: 'replace', file: '/srv/nginx/conf.d/parley-relay.conf' });
    const foreign = await surveyed({ ...dockerAnswers(), [path]: Buffer.from('server { listen 80; server_name x; }\n').toString('base64') }, { containers: [nginxContainer()], listeners: [] });
    expect(decideLayout(foreign)).toMatchObject({ mode: 'blocked', reason: expect.stringMatching(/was not written by Parley/) });
  });

  it('every reason that sends nginx to layout 5 is named', async () => {
    const reason = (layout: ReturnType<typeof decideLayout>): string => {
      expect(layout.mode).toBe('proxy');
      return layout.mode === 'proxy' ? layout.reason ?? '' : '';
    };
    const noInclude = DUMP.replace('    include /etc/nginx/conf.d/*.conf;\n', '');
    expect(reason(decideLayout(await surveyed(dockerAnswers(noInclude), { containers: [nginxContainer()], listeners: [] })))).toMatch(/no include <directory>\/\*\.conf/);
    expect(reason(decideLayout(await dockerProbe({}, { mounts: [] })))).toMatch(/not on a mounted volume/);
    expect(reason(decideLayout(await dockerProbe({}, { networks: ['bridge'], networkAliases: { bridge: [] } })))).toMatch(/default bridge network/);
    expect(reason(decideLayout(await dockerProbe({ listeners: [{ port: 8443, processes: ['x'] }] })))).toMatch(/port 8443/);
    expect(reason(decideLayout(await hostProbe({ listeners: [{ port: 80, processes: ['nginx'] }, { port: 8443, processes: ['x'] }] })))).toMatch(/port 8443/);
    expect(reason(decideLayout(await hostProbe({ listeners: [{ port: 80, processes: ['nginx'] }, { port: 18080, processes: ['a'] }, { port: 28080, processes: ['b'] }] })))).toMatch(/no local port/);
    expect(reason(decideLayout(await hostProbe({}, { ...hostAnswers, 'systemctl is-active caddy nginx apache2 httpd': 'inactive\ninactive\ninactive\ninactive\n' })))).toMatch(/not managed by systemd/);
  });
});
