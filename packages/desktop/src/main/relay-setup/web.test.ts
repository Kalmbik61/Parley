import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseContainers, parseEnv, parseListeners, parseOsRelease, type ContainerInfo, type ProbeResult } from './probe.js';
import type { RemoteShell, RunResult } from './shell.js';
import {
  chooseNetwork,
  countMarkers,
  hostPathOf,
  isAdminAddress,
  isContainerId,
  isNetworkName,
  isOurFile,
  isSafePath,
  NAME_CLASH_REASON,
  parseCaddyfile,
  parseCaddyStart,
  parseExecStart,
  parseNginxDump,
  pickNginxDir,
  probeActive,
  probeWeb,
} from './web.js';

const dir = path.join(__dirname, 'fixtures', 'course-vps');
const read = (name: string): string => readFileSync(path.join(dir, name), 'utf8');
const CADDY_ID = 'c1'.repeat(32);

function probeOf(over: Partial<ProbeResult> = {}): ProbeResult {
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
    ufwActive: false,
    install: parseEnv(read('env.txt')),
    previous: parseEnv(read('previous-env.txt')),
    ...over,
  };
}

type Answers = Record<string, string | { code: number; stdout?: string }>;
function shellOf(answers: Answers): RemoteShell & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    async run(command): Promise<RunResult> {
      ran.push(command);
      const answer = answers[command];
      if (answer === undefined) return { code: 1, stdout: '', stderr: '' };
      return typeof answer === 'string' ? { code: 0, stdout: answer, stderr: '' } : { code: answer.code, stdout: answer.stdout ?? '', stderr: '' };
    },
  };
}

const COURSE: Answers = {
  [`docker exec '${CADDY_ID}' caddy version`]: 'v2.11.4 h1:abc\n',
  "cat '/opt/course-platform/deploy/Caddyfile'": read('Caddyfile'),
  "cat '/opt/evdev-site/caddy/parley-relay.caddy'": read('parley-relay.caddy'),
};

describe('patterns (spec 3.4)', () => {
  it('container id, network and path', () => {
    expect(isContainerId('a'.repeat(64))).toBe(true);
    expect(isContainerId('a'.repeat(12))).toBe(false);
    expect(isContainerId(`${'a'.repeat(63)};`)).toBe(false);
    expect(isNetworkName('course-platform-prod_default')).toBe(true);
    expect(isNetworkName('a b')).toBe(false);
    expect(isSafePath('/opt/evdev-site/caddy')).toBe(true);
    for (const bad of ['relative/x', '/a/../b', '/a/./b', '/a//b', "/a/b'c", '/a b', '/a/$(x)', `/${'a'.repeat(300)}`, '/']) expect(isSafePath(bad)).toBe(false);
    expect(isAdminAddress('127.0.0.1:2019')).toBe(true);
    expect(isAdminAddress('localhost:2019')).toBe(true);
    expect(isAdminAddress('unix//run/caddy.sock')).toBe(false);
    expect(isAdminAddress('127.0.0.1:99999')).toBe(false);
    expect(isAdminAddress('a;b:80')).toBe(false);
  });
});

describe('parsers', () => {
  it('Caddyfile: top-level imports, admin from the global block, comments and quotes', () => {
    expect(parseCaddyfile(read('Caddyfile'))).toEqual({ imports: ['/etc/caddy/sites/*.caddy'], admin: null });
    expect(parseCaddyfile(read('Caddyfile.admin-off'))).toEqual({ imports: ['/etc/caddy/sites/*.caddy'], admin: 'off' });
    expect(parseCaddyfile(read('Caddyfile.admin-custom'))).toEqual({ imports: ['/etc/caddy/sites/*.caddy'], admin: '127.0.0.1:2020' });
    // An import inside a site block or in a comment is not top level; an `admin` outside the global block is ignored.
    expect(parseCaddyfile('a.com {\n\timport snippet\n\tadmin x:1\n}\n# import /x/*.caddy\nimport "/q/*.conf"\n').imports).toEqual(['/q/*.conf']);
  });
  it('markers', () => {
    expect(countMarkers(read('Caddyfile.marker-block'))).toEqual({ begin: 1, end: 1 });
    expect(countMarkers(read('Caddyfile.marker-single'))).toEqual({ begin: 1, end: 0 });
    expect(countMarkers(read('Caddyfile'))).toEqual({ begin: 0, end: 0 });
  });
  it('nginx -T: main file, http includes only, conf.d first', () => {
    const official = parseNginxDump(read('nginx-t-official.txt'));
    expect(official).toMatchObject({ mainFile: '/etc/nginx/nginx.conf', httpIncludes: ['/etc/nginx/conf.d'] });
    expect(official.files).toContain('/etc/nginx/conf.d/default.conf');
    const debian = parseNginxDump(read('nginx-t-debian.txt'));
    // `modules-enabled/*.conf` is outside `http`, `sites-enabled/*` has no `.conf`.
    expect(debian.httpIncludes).toEqual(['/etc/nginx/conf.d']);
    expect(pickNginxDir(debian)).toBe('/etc/nginx/conf.d');
    expect(pickNginxDir({ mainFile: null, httpIncludes: ['/a/b', '/c/conf.d'], files: [] })).toBe('/c/conf.d');
    expect(parseNginxDump('')).toEqual({ mainFile: null, httpIncludes: [], files: [] });
  });
  it('host path: the longest destination wins; :ro (rw false) does not matter; volumes count', () => {
    const mounts = [
      { type: 'bind', source: '/srv/etc', destination: '/etc', rw: true },
      { type: 'bind', source: '/opt/c/Caddyfile', destination: '/etc/caddy/Caddyfile', rw: false },
      { type: 'volume', source: '/var/lib/docker/volumes/v/_data', destination: '/data/', rw: true },
      { type: 'tmpfs', source: '', destination: '/tmp', rw: true },
    ];
    expect(hostPathOf(mounts, '/etc/caddy/Caddyfile')).toBe('/opt/c/Caddyfile');
    expect(hostPathOf(mounts, '/etc/caddy/sites')).toBe('/srv/etc/caddy/sites');
    expect(hostPathOf(mounts, '/data/x')).toBe('/var/lib/docker/volumes/v/_data/x');
    expect(hostPathOf(mounts, '/etcetera')).toBeNull();
    expect(hostPathOf(mounts, '/tmp/x')).toBeNull();
  });
  it('how Caddy starts', () => {
    expect(parseCaddyStart(['caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'])).toEqual({ config: '/etc/caddy/Caddyfile', resume: false, supported: true });
    expect(parseCaddyStart(['/usr/bin/caddy', 'run', '--environ', '--config=/etc/caddy/Caddyfile'])).toMatchObject({ config: '/etc/caddy/Caddyfile', supported: true });
    expect(parseCaddyStart(['caddy', 'run', '--resume'])).toMatchObject({ resume: true });
    expect(parseCaddyStart(['caddy', 'run', '--adapter', 'json']).supported).toBe(false);
    expect(parseCaddyStart(['caddy', 'reverse-proxy']).supported).toBe(false);
    expect(parseCaddyStart(['sh', 'run']).supported).toBe(false);
    expect(parseExecStart('{ path=/usr/bin/caddy ; argv[]=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile ; ignore_errors=no ; }')).toEqual([
      '/usr/bin/caddy', 'run', '--environ', '--config', '/etc/caddy/Caddyfile',
    ]);
    expect(parseExecStart('')).toEqual([]);
  });
  it('our file (spec 5.3)', () => {
    expect(isOurFile(read('parley-relay.caddy'), undefined)).toBe(true);
    expect(isOurFile('# parley-relay: added by the wizard\nx {}', undefined)).toBe(true);
    expect(isOurFile('x { reverse_proxy parley-relay-acme:80 }', undefined)).toBe(true);
    expect(isOurFile('x { reverse_proxy 127.0.0.1:18787 }', '18787')).toBe(true);
    expect(isOurFile('x { reverse_proxy 127.0.0.1:18787 }', '8787')).toBe(false);
    expect(isOurFile(read('foreign-parley-relay.caddy'), '8787')).toBe(false);
  });
});

describe('probeWeb: course VPS', () => {
  it('Caddy in Docker: network, directories, admin, our manual file recognised', async () => {
    const survey = await probeWeb(probeOf(), shellOf(COURSE));
    expect(survey).toMatchObject({
      kind: 'caddy',
      runtime: 'docker',
      container: { id: CADDY_ID, name: 'course-platform-prod-caddy-1', network: 'course-platform-prod_default' },
      config: { host: '/opt/course-platform/deploy/Caddyfile', container: '/etc/caddy/Caddyfile' },
      admin: '127.0.0.1:2019',
      include: { hostDir: '/opt/evdev-site/caddy', containerDir: '/etc/caddy/sites', suffix: '.caddy' },
      ours: { kind: 'file', hostPath: '/opt/evdev-site/caddy/parley-relay.caddy' },
      nameClash: false,
      reasons: [],
    });
    expect(survey?.caddyfile?.text).toBe(read('Caddyfile'));
    expect(survey?.caddyfile?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('the same mounts read-only give the same result', async () => {
    const containers = probeOf().containers.map((c) => ({ ...c, mounts: c.mounts.map((m) => ({ ...m, rw: false })) }));
    const survey = await probeWeb(probeOf({ containers }), shellOf(COURSE));
    expect(survey?.reasons).toEqual([]);
    expect(survey?.include?.hostDir).toBe('/opt/evdev-site/caddy');
  });
  it('nothing on port 80 → no survey; docker-proxy without a container → a reason', async () => {
    expect(await probeWeb(probeOf({ listeners: [], containers: [] }), shellOf({}))).toBeNull();
    const survey = await probeWeb(probeOf({ containers: [] }), shellOf({}));
    expect(survey?.reasons).toHaveLength(1);
  });
});

function withCaddy(change: (c: ContainerInfo) => Partial<ContainerInfo>, extra: ContainerInfo[] = []): ProbeResult {
  const base = probeOf();
  return probeOf({ containers: [...base.containers.map((c) => (c.id === CADDY_ID ? { ...c, ...change(c) } : c)), ...extra] });
}

describe('probeWeb: every unsupported layout has its own reason', () => {
  const reasonOf = async (probe: ProbeResult, answers: Answers = COURSE): Promise<string[]> => (await probeWeb(probe, shellOf(answers)))?.reasons ?? [];

  it('Caddyfile path with «..»', async () => {
    const probe = withCaddy((c) => ({ args: ['run', '--config', '/etc/caddy/../Caddyfile', '--adapter', 'caddyfile'], mounts: c.mounts }));
    expect(await reasonOf(probe)).toEqual([expect.stringMatching(/unsupported form/)]);
  });
  it('only the default bridge network', async () => {
    const probe = withCaddy(() => ({ networks: ['bridge'], networkAliases: { bridge: [] } }));
    expect(await reasonOf(probe)).toEqual([expect.stringMatching(/default bridge network/)]);
  });
  it('admin off', async () => {
    const answers = { ...COURSE, "cat '/opt/course-platform/deploy/Caddyfile'": read('Caddyfile.admin-off') };
    expect(await reasonOf(probeOf(), answers)).toEqual([expect.stringMatching(/admin endpoint is off/)]);
  });
  it('a custom admin address is used', async () => {
    const answers = { ...COURSE, "cat '/opt/course-platform/deploy/Caddyfile'": read('Caddyfile.admin-custom') };
    expect((await probeWeb(probeOf(), shellOf(answers)))?.admin).toBe('127.0.0.1:2020');
  });
  it('Caddyfile not on a mounted volume', async () => {
    const probe = withCaddy(() => ({ mounts: [] }));
    expect(await reasonOf(probe)).toEqual([expect.stringMatching(/not on a mounted volume/)]);
  });
  it('--resume', async () => {
    const probe = withCaddy(() => ({ args: ['run', '--resume'] }));
    expect(await reasonOf(probe)).toEqual([expect.stringMatching(/--resume/)]);
  });
  it('a foreign file with our name', async () => {
    const answers = { ...COURSE, "cat '/opt/evdev-site/caddy/parley-relay.caddy'": read('foreign-parley-relay.caddy') };
    expect(await reasonOf(probeOf(), answers)).toEqual([expect.stringMatching(/was not written by Parley/)]);
  });
  it('one marker only', async () => {
    const answers = { ...COURSE, "cat '/opt/course-platform/deploy/Caddyfile'": read('Caddyfile.marker-single') };
    expect(await reasonOf(probeOf(), answers)).toEqual([expect.stringMatching(/marker/)]);
  });
  it('a block between markers is ours', async () => {
    const answers = { ...COURSE, "cat '/opt/course-platform/deploy/Caddyfile'": read('Caddyfile.marker-block') };
    expect((await probeWeb(probeOf(), shellOf(answers)))?.ours).toEqual({ kind: 'block' });
  });
  it('another container named parley-relay (or with that alias) in the chosen network', async () => {
    const stranger = (over: Partial<ContainerInfo>): ContainerInfo => ({
      id: 'd3'.repeat(32), name: 'x', image: 'i', labels: { 'com.docker.compose.project': 'other' }, path: '', args: [], workdir: '', mounts: [], published: [],
      networks: ['course-platform-prod_default'], networkAliases: {}, networkMode: 'default', ...over,
    });
    for (const other of [stranger({ name: 'parley-relay' }), stranger({ networkAliases: { 'course-platform-prod_default': ['parley-relay-acme'] } })]) {
      const survey = await probeWeb(withCaddy(() => ({}), [other]), shellOf(COURSE));
      expect(survey).toMatchObject({ nameClash: true, reasons: [NAME_CLASH_REASON] });
    }
    // The same name in another network is no clash.
    const elsewhere = await probeWeb(withCaddy(() => ({}), [stranger({ name: 'parley-relay', networks: ['elsewhere'] })]), shellOf(COURSE));
    expect(elsewhere?.nameClash).toBe(false);
  });
  it('host network mode, and a container that is not Caddy or nginx', async () => {
    expect(await reasonOf(withCaddy(() => ({ networkMode: 'host' })))).toEqual([expect.stringMatching(/host network/)]);
    expect(await reasonOf(probeOf(), {})).toEqual([expect.stringMatching(/neither Caddy nor nginx/)]);
  });
  it('an id that is not 64 hex digits never reaches a command', async () => {
    const shell = shellOf(COURSE);
    const survey = await probeWeb(withCaddy(() => ({ id: 'x; rm -rf /' })), shell);
    expect(survey?.reasons).toHaveLength(1);
    expect(shell.ran).toEqual([]);
  });
});

describe('network choice is deterministic', () => {
  const server = (networks: string[]): ContainerInfo => ({
    id: CADDY_ID, name: 'c', image: 'caddy:2', labels: {}, path: 'caddy', args: [], workdir: '', mounts: [], published: [], networks, networkAliases: {}, networkMode: 'x',
  });
  const relay = (networks: string[]): ContainerInfo => ({ ...server(networks), id: 'e4'.repeat(32), name: 'r', labels: { 'com.docker.compose.project': 'parley-relay' } });
  it('independent of the order; our relay decides, else the first by name', () => {
    expect(chooseNetwork(server(['b_net', 'a_net']), [])).toBe('a_net');
    expect(chooseNetwork(server(['a_net', 'b_net']), [])).toBe('a_net');
    const s1 = server(['a_net', 'b_net']);
    expect(chooseNetwork(s1, [s1, relay(['b_net'])])).toBe('b_net');
    expect(chooseNetwork(server(['b_net', 'a_net']), [relay(['b_net'])])).toBe('b_net');
    expect(chooseNetwork(server(['bridge', 'host']), [])).toBeNull();
  });
});

describe('probeWeb: nginx and host servers', () => {
  const NGINX_ID = 'f5'.repeat(32);
  const nginxContainer = (mounts: ContainerInfo['mounts']): ContainerInfo => ({
    id: NGINX_ID, name: 'site-nginx-1', image: 'nginx:1.27', labels: { 'com.docker.compose.project': 'site' }, path: 'nginx', args: [], workdir: '', mounts,
    published: [{ hostPort: 80, hostIp: '0.0.0.0' }], networks: ['site_default'], networkAliases: {}, networkMode: 'site_default',
  });
  const docker = (...cmds: Array<[string, string | { code: number }]>): Answers => Object.fromEntries(cmds);

  it('nginx in Docker: conf.d on a volume', async () => {
    const probe = probeOf({ listeners: [], containers: [nginxContainer([{ type: 'bind', source: '/srv/nginx/conf.d', destination: '/etc/nginx/conf.d', rw: false }])] });
    const answers = docker([`docker exec '${NGINX_ID}' caddy version`, { code: 127 }], [`docker exec '${NGINX_ID}' nginx -v`, 'nginx version: nginx/1.27.0'], [`docker exec '${NGINX_ID}' nginx -T`, read('nginx-t-official.txt')]);
    expect(await probeWeb(probe, shellOf(answers))).toMatchObject({
      kind: 'nginx', runtime: 'docker', include: { hostDir: '/srv/nginx/conf.d', containerDir: '/etc/nginx/conf.d', suffix: '.conf' }, ours: null, reasons: [],
    });
    const mine = { ...answers, "cat '/srv/nginx/conf.d/parley-relay.conf'": '# parley-relay: added by the Parley relay setup wizard.\nserver {}\n' };
    expect((await probeWeb(probe, shellOf(mine)))?.ours).toEqual({ kind: 'file', hostPath: '/srv/nginx/conf.d/parley-relay.conf' });
  });
  it('nginx in Docker without a mount for conf.d → a reason', async () => {
    const probe = probeOf({ listeners: [], containers: [nginxContainer([])] });
    const answers = docker([`docker exec '${NGINX_ID}' caddy version`, { code: 127 }], [`docker exec '${NGINX_ID}' nginx -v`, ''], [`docker exec '${NGINX_ID}' nginx -T`, read('nginx-t-official.txt')]);
    expect((await probeWeb(probe, shellOf(answers)))?.reasons).toEqual([expect.stringMatching(/not on a mounted volume/)]);
  });
  const hostCaddy = (reload: string): Answers => ({
    'systemctl is-active caddy nginx apache2 httpd': 'active\ninactive\ninactive\ninactive\n',
    'systemctl show -p ExecStart --value caddy': '{ path=/usr/bin/caddy ; argv[]=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile ; ignore_errors=no ; }\n',
    'systemctl show -p ExecReload --value caddy': reload,
    "cat '/etc/caddy/Caddyfile'": 'import /etc/caddy/conf.d/*.caddy\n',
  });
  const hostProbe = (): ProbeResult => probeOf({ listeners: [{ port: 80, processes: ['caddy'] }], containers: [] });
  it('Caddy on the host under systemd with ExecReload', async () => {
    expect(await probeWeb(hostProbe(), shellOf(hostCaddy('{ path=/usr/bin/caddy ; argv[]=/usr/bin/caddy reload ; }\n')))).toMatchObject({
      kind: 'caddy', runtime: 'host', admin: '127.0.0.1:2019', include: { hostDir: '/etc/caddy/conf.d', suffix: '.caddy' }, reasons: [],
    });
  });
  it('a unit without ExecReload', async () => {
    expect((await probeWeb(hostProbe(), shellOf(hostCaddy(''))))?.reasons).toEqual([expect.stringMatching(/ExecReload/)]);
  });
  it('Apache and unknown servers are not supported', async () => {
    expect((await probeWeb(probeOf({ listeners: [{ port: 80, processes: ['apache2'] }], containers: [] }), shellOf({})))).toMatchObject({ kind: 'apache' });
    expect((await probeWeb(probeOf({ listeners: [{ port: 80, processes: ['traefik'] }], containers: [] }), shellOf({})))).toMatchObject({ kind: 'other' });
  });
});

describe('the previous run (spec 7.3)', () => {
  it('a live process blocks, a dead one or no file does not', async () => {
    expect(await probeActive(shellOf({ 'cat /var/tmp/parley-relay-setup/active': '4242 files\n', 'kill -0 4242': '' }))).toEqual({ pid: 4242, id: 'files' });
    expect(await probeActive(shellOf({ 'cat /var/tmp/parley-relay-setup/active': '4242 files\n', 'kill -0 4242': { code: 1 } }))).toBeNull();
    expect(await probeActive(shellOf({}))).toBeNull();
    const shell = shellOf({ 'cat /var/tmp/parley-relay-setup/active': '1; reboot x\n' });
    expect(await probeActive(shell)).toBeNull();
    expect(shell.ran).toEqual(['cat /var/tmp/parley-relay-setup/active']);
  });
});

describe('stage 3 only reads', () => {
  it('every command has a fixed read-only form', async () => {
    const READ = /^(docker exec '[0-9a-f]{64}' (caddy version|nginx -v|nginx -T)|nginx -T|systemctl (is-active caddy nginx apache2 httpd|show -p Exec(Start|Reload) --value caddy)|cat '\/[A-Za-z0-9._@+/-]+'|cat \/var\/tmp\/parley-relay-setup\/active|kill -0 \d+)$/;
    const shells = [shellOf(COURSE), shellOf({})];
    await probeWeb(probeOf(), shells[0] as RemoteShell);
    await probeWeb(probeOf({ listeners: [{ port: 80, processes: ['caddy'] }], containers: [] }), shells[1] as RemoteShell);
    await probeWeb(probeOf({ listeners: [{ port: 80, processes: ['nginx'] }], containers: [] }), shells[1] as RemoteShell);
    await probeActive(shellOf({ 'cat /var/tmp/parley-relay-setup/active': '7 x' }));
    const ran = shells.flatMap((s) => (s as ReturnType<typeof shellOf>).ran);
    expect(ran.length).toBeGreaterThan(5);
    for (const command of ran) expect(command).toMatch(READ);
  });
});
