import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RelaySetupEvent, RelaySetupPhase } from '../../src/shared/relay-setup-types.js';
import { createKnownHosts } from '../../src/main/relay-setup/known-hosts.js';
import { createRunLog } from '../../src/main/relay-setup/log.js';
import { createRelaySetup, type RelaySetupService } from '../../src/main/relay-setup/service.js';
import { connectSsh } from '../../src/main/relay-setup/ssh.js';

/** Docker helpers of the relay setup stand: no shell, fixed arguments, containers named `parley-stand-*`. */

export const STAND_DIR = path.dirname(new URL(import.meta.url).pathname);

export function docker(args: string[], options: { input?: string } = {}): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
}

export function dockerAvailable(): boolean {
  try {
    docker(['info', '--format', '{{.ServerVersion}}']);
    return true;
  } catch {
    return false;
  }
}

export interface Server {
  name: string;
  port: number;
}

/** `*-docker`: Docker (and for `nginx-docker` an nginx on the host) is already part of the server, as on a server that runs other things. */
export type Flavour = 'ubuntu24' | 'debian12' | 'nginx' | 'alpine' | 'ubuntu24-docker' | 'nginx-docker';

const BUILD: Record<Flavour, { file: string; args: string[] }> = {
  ubuntu24: { file: 'Dockerfile.apt', args: ['BASE=ubuntu:24.04'] },
  debian12: { file: 'Dockerfile.apt', args: ['BASE=debian:12'] },
  nginx: { file: 'Dockerfile.apt', args: ['BASE=ubuntu:24.04', 'WITH_NGINX=1'] },
  alpine: { file: 'Dockerfile.alpine', args: [] },
  'ubuntu24-docker': { file: 'Dockerfile.apt', args: ['BASE=ubuntu:24.04', 'WITH_DOCKER=1'] },
  'nginx-docker': { file: 'Dockerfile.apt', args: ['BASE=ubuntu:24.04', 'WITH_NGINX=1', 'WITH_DOCKER=1'] },
};

export function buildImage(flavour: Flavour): string {
  const tag = `parley-stand-${flavour}`;
  const spec = BUILD[flavour];
  docker(['build', '-q', '-f', path.join(STAND_DIR, 'docker', spec.file), ...spec.args.flatMap((a) => ['--build-arg', a]), '-t', tag, path.join(STAND_DIR, 'docker')]);
  return tag;
}

/** `hostPort` fixes the published port (the key-change case needs the same host:port before and after a restart). */
export function startServer(flavour: Flavour, name = `parley-stand-${flavour}`, hostPort?: number, dind?: { imagesDir: string; listen?: number; offline?: boolean }): Server {
  const image = buildImage(flavour);
  removeServer(name);
  const dindArgs = dind === undefined ? [] : ['--privileged', '-v', '/var/lib/docker', '-v', `${dind.imagesDir}:/stand:ro`, '-e', 'STAND_DIND=1', ...(dind.listen !== undefined ? ['-e', `STAND_LISTEN=${dind.listen}`] : []), ...(dind.offline === true ? ['--dns', '127.0.0.1'] : [])];
  docker(['run', '-d', '--name', name, ...dindArgs, '-p', `127.0.0.1:${hostPort ?? ''}:22`, image]);
  const mapped = docker(['port', name, '22/tcp']).split('\n')[0] ?? '';
  const port = Number(mapped.slice(mapped.lastIndexOf(':') + 1));
  return { name, port };
}

/** Restart regenerates host keys that were deleted. */
export function restartServer(server: Server): void {
  docker(['restart', server.name]);
}

export async function freePort(): Promise<number> {
  const { default: net } = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

export function removeServer(name: string): void {
  try {
    docker(['rm', '-f', name]);
  } catch {
    // not there
  }
}

export function exec(name: string, command: string): string {
  return docker(['exec', name, 'sh', '-c', command]);
}

/** Waits until sshd answers with its banner. */
export async function waitForSsh(port: number, timeoutMs = 30_000): Promise<void> {
  const { default: net } = await import('node:net');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const banner = await new Promise<string>((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.setTimeout(1500, () => socket.destroy());
      socket.once('data', (data) => {
        socket.destroy();
        resolve(data.toString('utf8'));
      });
      socket.once('error', () => resolve(''));
      socket.once('close', () => resolve(''));
    });
    if (banner.startsWith('SSH-')) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`sshd on ${port} did not come up`);
}

/** A digest of everything the wizard must not touch on a server it only probed. */
export function snapshot(name: string, paths: string[]): string {
  const out = exec(name, `find ${paths.join(' ')} -type f 2>/dev/null | sort | xargs -r sha256sum`);
  return createHash('sha256').update(out).digest('hex');
}

/** Saves the locally built relay image (two tags, to model an update) and Caddy for the Docker inside the stand servers. */
export function saveImages(dir: string): void {
  mkdirSync(dir, { recursive: true });
  docker(['tag', 'parley-relay:stand', 'parley-relay:stand2']);
  docker(['save', '-o', path.join(dir, 'relay.tar'), 'parley-relay:stand', 'parley-relay:stand2']);
  // Caddy is pinned by digest in the compose file, so the server pulls it itself; the tarball only saves a round trip.
  docker(['save', '-o', path.join(dir, 'caddy.tar'), 'caddy:2.11.7']);
}

// --- web server cases (S1-S3, spec 10) ---

/** Writes a file into the server (parents are made). */
export function putFile(name: string, dest: string, content: string, mode = '0644'): void {
  docker(['exec', '-i', name, 'sh', '-c', `mkdir -p "$(dirname ${JSON.stringify(dest)})" && cat > ${JSON.stringify(dest)} && chmod ${mode} ${JSON.stringify(dest)}`], { input: content });
}

/** Copies a local directory's content into the server, bytes and modes as they are. */
export function putTree(name: string, localDir: string, dest: string): void {
  exec(name, `mkdir -p ${dest}`);
  docker(['cp', `${localDir}/.`, `${name}:${dest}`]);
}

/** The server's own Docker is up and the stand images are loaded. */
export function waitDockerReady(name: string, seconds = 240): void {
  exec(name, `i=0; while [ ! -e /run/stand-ready ] && [ $i -lt ${seconds} ]; do sleep 1; i=$((i+1)); done; [ -e /run/stand-ready ]`);
}

export const sha256Of = (name: string, file: string): string => exec(name, `sha256sum ${JSON.stringify(file)} | cut -d' ' -f1`);

/** The root of the stand's web server files (docker/course-vps). */
export const COURSE_DIR = path.join(STAND_DIR, 'docker', 'course-vps');

export interface Wizard {
  service: RelaySetupService;
  events: RelaySetupEvent[];
  configured: string[];
}

export interface WizardOptions {
  /** The address the wizard sees for the server (the sslip name comes from it). */
  ip?: string;
  /** Run inside the server; exit code 0 = the relay answers. */
  healthCommand?: string;
  ref?: string;
  root?: string;
}

/** The real service over real SSH; DNS, the bridge and the HTTPS probe are stubs (the probe is a command in the server). */
export function createWizard(server: Server, options: WizardOptions = {}): Wizard {
  const root = options.root ?? mkdtempSync(path.join(os.tmpdir(), 'relay-stand-'));
  const events: RelaySetupEvent[] = [];
  const configured: string[] = [];
  const health = options.healthCommand;
  const service = createRelaySetup({
    knownHosts: createKnownHosts(path.join(root, 'known_hosts')),
    connect: connectSsh,
    log: createRunLog(path.join(root, 'relay-setup.log'), () => []),
    image: { ref: options.ref ?? 'parley-relay:stand', published: true },
    health: async () => {
      if (health === undefined) return { status: 200 };
      try {
        exec(server.name, health);
        return { status: 200 };
      } catch {
        return { status: 502 };
      }
    },
    healthAttempts: 3,
    healthDelayMs: 1000,
    resolver: { resolve4: async () => [options.ip ?? '203.0.113.7'], resolve6: async () => [] },
    configureBridge: async (address) => void configured.push(address),
    emit: (event) => events.push(event),
  });
  return { service, events, configured };
}

/**
 * `run`, and when it answers `{ phase: 'running' }` (the run lives in the main process, spec 8.1) the final phase from
 * the `phase` event. Before that change `run` returns the final phase itself, so the same test works on both sides.
 */
export async function runToEnd(wizard: Wizard, params: { removeData: boolean }, timeoutMs = 900_000): Promise<RelaySetupPhase> {
  const seen = wizard.events.length;
  const first = await wizard.service.call('run', params);
  if (first.phase !== 'running') return first;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const event of wizard.events.slice(seen) as unknown as Array<{ event: string; phase?: RelaySetupPhase }>) {
      if (event.event === 'phase' && event.phase !== undefined && event.phase.phase !== 'running') return event.phase;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the run did not finish');
}

export interface Driven {
  plan: RelaySetupPhase;
  phase: RelaySetupPhase;
  wizard: Wizard;
  /** Ids of the steps that ran (not skipped). */
  done: string[];
}

/** One wizard session: begin (trust the key), plan, and run it when `execute` is not false. */
export async function drive(server: Server, intent: 'install' | 'rollback' | 'remove', options: WizardOptions & { removeData?: boolean; execute?: boolean } = {}): Promise<Driven> {
  const wizard = createWizard(server, options);
  let phase = await wizard.service.call('begin', { host: 'localhost', port: server.port, user: 'root', auth: { kind: 'password' }, secrets: { password: 'stand-root-pw' }, intent });
  if (phase.phase === 'hostkey') phase = await wizard.service.call('trust', {});
  if (options.removeData === true) phase = await wizard.service.call('plan', { removeData: true });
  const plan = phase;
  if (plan.phase !== 'plan' || plan.plan.blocked !== null || options.execute === false) {
    return { plan, phase: plan, wizard, done: [] };
  }
  const end = await runToEnd(wizard, { removeData: options.removeData === true });
  const done = wizard.events.filter((e) => e.event === 'step' && e.status === 'done').map((e) => (e as { id: string }).id);
  return { plan, phase: end, wizard, done };
}
