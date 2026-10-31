import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

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

export type Flavour = 'ubuntu24' | 'debian12' | 'nginx' | 'alpine';

const BUILD: Record<Flavour, { file: string; args: string[] }> = {
  ubuntu24: { file: 'Dockerfile.apt', args: ['BASE=ubuntu:24.04'] },
  debian12: { file: 'Dockerfile.apt', args: ['BASE=debian:12'] },
  nginx: { file: 'Dockerfile.apt', args: ['BASE=ubuntu:24.04', 'WITH_NGINX=1'] },
  alpine: { file: 'Dockerfile.alpine', args: [] },
};

export function buildImage(flavour: Flavour): string {
  const tag = `parley-stand-${flavour}`;
  const spec = BUILD[flavour];
  docker(['build', '-q', '-f', path.join(STAND_DIR, 'docker', spec.file), ...spec.args.flatMap((a) => ['--build-arg', a]), '-t', tag, path.join(STAND_DIR, 'docker')]);
  return tag;
}

/** `hostPort` fixes the published port (the key-change case needs the same host:port before and after a restart). */
export function startServer(flavour: Flavour, name = `parley-stand-${flavour}`, hostPort?: number, dind?: { imagesDir: string; listen?: number }): Server {
  const image = buildImage(flavour);
  removeServer(name);
  const dindArgs = dind === undefined ? [] : ['--privileged', '-v', '/var/lib/docker', '-v', `${dind.imagesDir}:/stand:ro`, '-e', 'STAND_DIND=1', ...(dind.listen !== undefined ? ['-e', `STAND_LISTEN=${dind.listen}`] : [])];
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
  docker(['save', '-o', path.join(dir, 'caddy.tar'), 'caddy:2']);
}
