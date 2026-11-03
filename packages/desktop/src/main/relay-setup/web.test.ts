import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseContainers, parseEnv, parseListeners, parseOsRelease, type ContainerInfo, type ProbeResult } from './probe.js';
import type { RemoteShell, RunResult } from './shell.js';
import { BLOCK_BEGIN, BLOCK_BEGIN_NL, BLOCK_END, caddyBlockAppend } from './templates.js';
import {
  chooseNetwork,
  countMarkers,
  hostPathOf,
  isAdminAddress,
  isContainerId,
  isNetworkName,
  isOurFile,
  isSafePath,
  LOCK_CHECK,
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
    previousTail: null,
    installEdit: null,
    proxyHealthy: null,
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
      // Files are read as `base64 -w0 <path>`; the tests list them as `cat <path>` with the plain text.
      const file = /^base64 -w0 ('.*')$/.exec(command);
      const plain = file === null ? undefined : answers[`cat ${file[1]}`];
      const answer = typeof plain === 'string' ? Buffer.from(plain, 'utf8').toString('base64') : answers[command];
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
    // The marker line the wizard writes carries a note after the name.
    expect(countMarkers('# BEGIN parley-relay (added by the Parley relay setup wizard; remove it with the wizard)\nx\n# END parley-relay\n')).toEqual({ begin: 1, end: 1 });
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
      ours: { kind: 'file', hostPath: '/opt/evdev-site/caddy/parley-relay.caddy', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
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
    expect((await probeWeb(probeOf(), shellOf(answers)))?.blockers).toHaveLength(1);
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

describe('critic fixes on the probe', () => {
  it('M1: the marker lines the wizard writes are recognised, from one constant; a longer name is not a marker', () => {
    expect(read('Caddyfile.marker-block')).toContain(`${BLOCK_BEGIN}\n`);
    expect(read('Caddyfile.marker-block')).toContain(`${BLOCK_END}\n`);
    for (const existing of ['a {\n}\n', 'a {\n}']) {
      expect(countMarkers(existing + caddyBlockAppend(existing, 'r.example.com', 'parley-relay:8787'))).toEqual({ begin: 1, end: 1 });
    }
    expect(countMarkers(`${BLOCK_BEGIN_NL}\n${BLOCK_END}\n`)).toEqual({ begin: 1, end: 1 });
    expect(countMarkers('# BEGIN parley-relay-foo\n# END parley-relay-foo\n')).toEqual({ begin: 0, end: 0 });
  });
  it('M1: a block of the wizard on the server is recognised as ours, not as a broken marker', async () => {
    const answers = { ...COURSE, "cat '/opt/course-platform/deploy/Caddyfile'": read('Caddyfile.marker-block') };
    const survey = await probeWeb(probeOf(), shellOf(answers));
    expect(survey?.ours).toEqual({ kind: 'block' });
    expect(survey?.blockers).toEqual([]);
  });
  it('m1: «./» and «//» in a relative import are noise, «..» is still refused', async () => {
    const run = async (imp: string): Promise<string[]> => {
      const answers = { ...COURSE, "cat '/opt/course-platform/deploy/Caddyfile'": `import ${imp}\n` };
      const probe = withCaddy((c) => ({ mounts: [...c.mounts, { type: 'bind', source: '/opt/course-platform/deploy/sites', destination: '/etc/caddy/sites2', rw: true }] }));
      const survey = await probeWeb(probe, shellOf(answers));
      return survey?.include === null ? ['none'] : [survey?.include?.hostDir ?? '', ...(survey?.reasons ?? [])];
    };
    expect((await run('./sites/*.caddy'))[0]).not.toBe('none');
    expect((await run('/etc/caddy//sites/*.caddy'))[0]).toBe('/opt/evdev-site/caddy');
    expect((await run('../x/*.caddy'))[0]).toBe('none');
  });
  it('m2: «admin {» keeps the default address and «admin :2019» becomes loopback', () => {
    expect(parseCaddyfile('{\n\tadmin {\n\t\torigins localhost\n\t}\n}\n').admin).toBeNull();
    expect(parseCaddyfile('{\n\tadmin :2019\n}\n').admin).toBe('127.0.0.1:2019');
    expect(isAdminAddress('127.0.0.1:2019')).toBe(true);
  });
  it('m3: nginx scanner honours single quotes across lines and quoted include paths', () => {
    const dump = parseNginxDump(read('nginx-t-quoted.txt'));
    expect(dump.httpIncludes).toEqual(['/etc/nginx/conf.d', '/etc/nginx/extra']);
    // A `}` inside a quoted string does not close the block, a `#` inside quotes is not a comment.
    expect(parseNginxDump('# configuration file /e/nginx.conf:\nhttp {\n  x "}#";\n  include /a/b/*.conf;\n}\n').httpIncludes).toEqual(['/a/b']);
  });
  it('m4: a network name that fails the pattern is not kept; a main file without a mount is not passed off as a host path', async () => {
    const odd = withCaddy(() => ({ networks: ['bad name'], networkAliases: { 'bad name': [] } }));
    const survey = await probeWeb(odd, shellOf(COURSE));
    expect(survey?.container?.network).toBeNull();
    expect(survey?.reasons.length).toBeGreaterThan(0);
    const NGINX_ID = 'f5'.repeat(32);
    const container: ContainerInfo = {
      id: NGINX_ID, name: 'n', image: 'nginx', labels: {}, path: 'nginx', args: [], workdir: '',
      mounts: [{ type: 'bind', source: '/srv/conf.d', destination: '/etc/nginx/conf.d', rw: true }],
      published: [{ hostPort: 80, hostIp: '0.0.0.0' }], networks: ['site_default'], networkAliases: {}, networkMode: 'site_default',
    };
    const answers = { [`docker exec '${NGINX_ID}' nginx -v`]: '', [`docker exec '${NGINX_ID}' nginx -T`]: read('nginx-t-official.txt') };
    const nginx = await probeWeb(probeOf({ listeners: [], containers: [container] }), shellOf(answers));
    expect(nginx?.include?.hostDir).toBe('/srv/conf.d');
    expect(nginx?.config).toBeNull();
  });
  it('m5: files are read as bytes; the hash is of the bytes on disk, and a non-UTF-8 file is refused', async () => {
    const survey = await probeWeb(probeOf(), shellOf(COURSE));
    expect(survey?.caddyfile?.text).toBe(read('Caddyfile'));
    expect(survey?.caddyfile?.sha256).toBe(createHash('sha256').update(readFileSync(path.join(dir, 'Caddyfile'))).digest('hex'));
    const shell: RemoteShell = {
      async run(command): Promise<RunResult> {
        if (command === `docker exec '${CADDY_ID}' caddy version`) return { code: 0, stdout: 'v2', stderr: '' };
        if (command.startsWith('base64 -w0')) return { code: 0, stdout: Buffer.from([0x23, 0xe9, 0x0a]).toString('base64'), stderr: '' };
        return { code: 1, stdout: '', stderr: '' };
      },
    };
    expect((await probeWeb(probeOf(), shell))?.reasons).toEqual([expect.stringMatching(/not valid UTF-8/)]);
  });
  it('m6: the server container itself having the alias parley-relay is a name clash', async () => {
    const probe = withCaddy((c) => ({ networkAliases: { ...c.networkAliases, 'course-platform-prod_default': ['caddy', 'parley-relay'] } }));
    expect((await probeWeb(probe, shellOf(COURSE)))?.nameClash).toBe(true);
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
    expect((await probeWeb(probe, shellOf(mine)))?.ours).toMatchObject({ kind: 'file', hostPath: '/srv/nginx/conf.d/parley-relay.conf' });
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
  const ACTIVE = 'cat /var/tmp/parley-relay-setup/active';
  it('a held lock blocks and names the command; a free lock with nothing left does not', async () => {
    expect((await probeActive(shellOf({ [LOCK_CHECK]: { code: 1 }, [ACTIVE]: 'files\n' }))).active).toEqual({ id: 'files' });
    expect((await probeActive(shellOf({ [LOCK_CHECK]: { code: 1 } }))).active).toEqual({ id: 'unknown' });
    expect(await probeActive(shellOf({ [LOCK_CHECK]: '' }))).toEqual({ active: null, tail: null });
  });
  it('a free lock with `active` left over: the command died, its log tail goes to the notes', async () => {
    const dead = await probeActive(shellOf({ [LOCK_CHECK]: '', [ACTIVE]: 'files\n', 'tail -n 20 /var/tmp/parley-relay-setup/files.log': 'E: dpkg was interrupted\n' }));
    expect(dead).toEqual({ active: null, tail: { id: 'files', text: 'E: dpkg was interrupted\n' } });
  });
  it('the id from the server is checked before it reaches a command; no pid, no kill', async () => {
    const shell = shellOf({ [LOCK_CHECK]: '', [ACTIVE]: '1; reboot x\n' });
    expect((await probeActive(shell)).tail).toBeNull();
    expect(shell.ran).toEqual([LOCK_CHECK, ACTIVE]);
  });
  it('the lock check passes without a state directory or without flock', () => {
    const { status } = spawnSync('/bin/sh', ['-c', LOCK_CHECK], { encoding: 'utf8' });
    expect(status).toBe(0);
    expect(LOCK_CHECK).toContain('command -v flock');
  });
});

describe('stage 3 only reads', () => {
  it('every command has a fixed read-only form', async () => {
    const READ = /^(docker exec '[0-9a-f]{64}' (caddy version|nginx -v|nginx -T)|nginx -T|systemctl (is-active caddy nginx apache2 httpd|show -p Exec(Start|Reload) --value caddy)|base64 -w0 '\/[A-Za-z0-9._@+/-]+'|cat \/var\/tmp\/parley-relay-setup\/active|tail -n 20 \/var\/tmp\/parley-relay-setup\/[a-z][a-z0-9-]*\.log)$/;
    const shells = [shellOf(COURSE), shellOf({})];
    await probeWeb(probeOf(), shells[0] as RemoteShell);
    await probeWeb(probeOf({ listeners: [{ port: 80, processes: ['caddy'] }], containers: [] }), shells[1] as RemoteShell);
    await probeWeb(probeOf({ listeners: [{ port: 80, processes: ['nginx'] }], containers: [] }), shells[1] as RemoteShell);
    const dead = shellOf({ [LOCK_CHECK]: '', 'cat /var/tmp/parley-relay-setup/active': 'x' });
    await probeActive(dead);
    shells.push(dead);
    const ran = shells.flatMap((s) => (s as ReturnType<typeof shellOf>).ran);
    expect(ran.length).toBeGreaterThan(5);
    for (const command of ran) expect(command === LOCK_CHECK || READ.test(command)).toBe(true);
  });
});
