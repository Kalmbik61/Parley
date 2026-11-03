import { describe, expect, it } from 'vitest';
import { parseArch, parseContainers, parseEnv, parseListeners, parseOsRelease, parseUfwActive, probeBase, probeFull, PROBE } from './probe.js';
import type { RemoteShell, RunResult } from './shell.js';

const UBUNTU = 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\nID=ubuntu\n';
const SS = `State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6),("nginx",pid=811,fd=6))
LISTEN 0 128 [::]:22 [::]:* users:(("sshd",pid=1,fd=4))
LISTEN 0 4096 127.0.0.54:53 0.0.0.0:*
LISTEN 0 511 *:443 *:*
`;

describe('probe parsers', () => {
  it('reads os-release and knows the supported systems', () => {
    expect(parseOsRelease(UBUNTU)).toMatchObject({ supported: true, distro: 'ubuntu', codename: 'noble' });
    expect(parseOsRelease('ID=ubuntu\nVERSION_ID="22.04"\n')).toMatchObject({ supported: true, codename: 'jammy' });
    expect(parseOsRelease('ID=debian\nVERSION_ID="12"\n')).toMatchObject({ supported: true, codename: 'bookworm' });
    expect(parseOsRelease('ID=debian\nVERSION_ID="11"\n').supported).toBe(false);
    expect(parseOsRelease('ID=alpine\nVERSION_ID=3.20.3\nPRETTY_NAME="Alpine Linux v3.20"\n')).toMatchObject({ supported: false, distro: null, pretty: 'Alpine Linux v3.20' });
    expect(parseOsRelease('').supported).toBe(false);
  });
  it('maps the architecture', () => {
    expect(parseArch('x86_64\n')).toBe('amd64');
    expect(parseArch('aarch64')).toBe('arm64');
    expect(parseArch('armv7l')).toBeNull();
  });
  it('lists listeners with process names, loopback included', () => {
    expect(parseListeners(SS)).toEqual([
      { port: 22, processes: ['sshd'] },
      { port: 53, processes: [] },
      { port: 80, processes: ['nginx'] },
      { port: 443, processes: [] },
    ]);
  });
  it('reads ufw status and env files', () => {
    expect(parseUfwActive('Status: active\n')).toBe(true);
    expect(parseUfwActive('Status: inactive\n')).toBe(false);
    expect(parseEnv('A=1\n# c\nRELAY_DOMAIN=x.example.com\nbad line\n')).toEqual({ A: '1', RELAY_DOMAIN: 'x.example.com' });
  });
});

function fakeShell(answers: Record<string, Partial<RunResult>>): RemoteShell & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    async run(command) {
      ran.push(command);
      return { code: 127, stdout: '', stderr: '', ...answers[command] };
    },
  };
}

describe('parseContainers', () => {
  it('is fine with empty output and skips broken lines', () => {
    expect(parseContainers('')).toEqual([]);
    expect(parseContainers('\n  \n')).toEqual([]);
    expect(parseContainers('not json\n{"id":"a","name":"/x","labels":null,"ports":{"80/tcp":[{"HostIp":"::","HostPort":"80"}],"53/udp":[{"HostPort":"53"}],"1/tcp":null},"mounts":null,"networks":{"n":{}}}\n[]\n{"name":"no id"}')).toEqual([
      { id: 'a', name: 'x', image: '', labels: {}, path: '', args: [], workdir: '', mounts: [], published: [{ hostPort: 80, hostIp: '::' }], networks: ['n'], networkAliases: { n: [] }, networkMode: '', running: true, restartPolicy: '', boundPorts: [] },
    ]);
  });
  it('the inspect template is one single-quote-free constant', () => {
    expect(PROBE.containers.match(/'/g)).toHaveLength(2);
    expect(PROBE.containers.startsWith('docker ps -aq | xargs -r docker inspect --format ')).toBe(true);
  });
  it('stopped containers: running, restart policy and the ports they are set to publish are read', () => {
    const line = '{"id":"b","name":"/shop","running":false,"restart":"unless-stopped","ports":{},"bindings":{"80/tcp":[{"HostIp":"","HostPort":"80"}],"443/tcp":[{"HostPort":"443"}],"53/udp":[{"HostPort":"53"}]}}';
    expect(parseContainers(line)[0]).toMatchObject({ running: false, restartPolicy: 'unless-stopped', boundPorts: [80, 443], published: [] });
    // Older output without these keys counts as running.
    expect(parseContainers('{"id":"c","name":"/x"}')[0]).toMatchObject({ running: true, restartPolicy: '', boundPorts: [] });
  });
  it('stage 2: containers that were printed count even when inspect exits 1 (one vanished)', async () => {
    const base = { os: parseOsRelease(UBUNTU), arch: 'amd64' as const, root: true, sudoPasswordless: true };
    const line = '{"id":"a","name":"/x","ports":{"80/tcp":[{"HostIp":"0.0.0.0","HostPort":"80"}]}}';
    const probe = await probeFull(base, fakeShell({ [PROBE.containers]: { code: 1, stdout: `${line}\n` } }));
    expect(probe.containers.map((c) => c.name)).toEqual(['x']);
  });
  it('stage 2: no Docker gives an empty list', async () => {
    const base = { os: parseOsRelease(UBUNTU), arch: 'amd64' as const, root: true, sudoPasswordless: true };
    expect((await probeFull(base, fakeShell({ [PROBE.containers]: { code: 127, stdout: 'garbage' } }))).containers).toEqual([]);
    expect((await probeFull(base, fakeShell({ [PROBE.containers]: { code: 0, stdout: '' } }))).containers).toEqual([]);
  });
});

describe('probe stages', () => {
  it('stage 1 runs only unprivileged reads; root skips the sudo test', async () => {
    const shell = fakeShell({ [PROBE.os]: { code: 0, stdout: UBUNTU }, [PROBE.arch]: { code: 0, stdout: 'x86_64' }, [PROBE.uid]: { code: 0, stdout: '0\n' } });
    const base = await probeBase(shell);
    expect(base).toMatchObject({ root: true, sudoPasswordless: true, arch: 'amd64' });
    expect(shell.ran.sort()).toEqual([PROBE.arch, PROBE.os, PROBE.uid].sort());
  });
  it('a plain user without passwordless sudo is reported', async () => {
    const shell = fakeShell({ [PROBE.os]: { code: 0, stdout: UBUNTU }, [PROBE.arch]: { code: 0, stdout: 'aarch64' }, [PROBE.uid]: { code: 0, stdout: '1000' }, [PROBE.sudo]: { code: 1 } });
    expect(await probeBase(shell)).toMatchObject({ root: false, sudoPasswordless: false, arch: 'arm64' });
  });
  it('stage 2 reads ports, ufw, docker and the earlier install; every command is a read', async () => {
    const shell = fakeShell({
      [PROBE.listen]: { code: 0, stdout: SS },
      [PROBE.ufw]: { code: 0, stdout: 'Status: active' },
      [PROBE.docker]: { code: 0 },
      [PROBE.compose]: { code: 0 },
      [PROBE.env]: { code: 0, stdout: 'RELAY_DOMAIN=r.example.com\n' },
    });
    const base = { os: parseOsRelease(UBUNTU), arch: 'amd64' as const, root: true, sudoPasswordless: true };
    const probe = await probeFull(base, shell);
    expect(shell.ran).toContain(PROBE.containers);
    expect(probe).toMatchObject({ docker: true, compose: true, ufwActive: true, install: { RELAY_DOMAIN: 'r.example.com' }, previous: null });
    for (const command of shell.ran.filter((c) => c !== PROBE.containers)) expect(command).toMatch(/^(ss -ltnp|ufw status|docker --version|docker compose version|cat \/opt\/parley-relay\/(previous\/)?\.env)$/);
  });
});
