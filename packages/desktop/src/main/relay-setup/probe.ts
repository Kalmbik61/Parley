import type { RemoteShell } from './shell.js';

/**
 * The read-only look at the server (spec 6.7 step 3). Every command here is a fixed string and changes nothing.
 * The parsers are pure so they can be tested against captured output.
 */

export const INSTALL_DIR = '/opt/parley-relay';

export const PROBE = {
  os: 'cat /etc/os-release',
  arch: 'uname -m',
  uid: 'id -u',
  sudo: 'sudo -n true',
  listen: 'ss -ltnp',
  ufw: 'ufw status',
  docker: 'docker --version',
  compose: 'docker compose version',
  env: `cat ${INSTALL_DIR}/.env`,
  previousEnv: `cat ${INSTALL_DIR}/previous/.env`,
} as const;

export type Distro = 'ubuntu' | 'debian';
export type Codename = 'jammy' | 'noble' | 'bookworm';

export interface OsInfo {
  id: string;
  versionId: string;
  pretty: string;
  supported: boolean;
  distro: Distro | null;
  codename: Codename | null;
}

export interface Listener {
  port: number;
  processes: string[];
}

export interface ProbeResult {
  os: OsInfo;
  arch: 'amd64' | 'arm64' | null;
  root: boolean;
  sudoPasswordless: boolean;
  docker: boolean;
  compose: boolean;
  listeners: Listener[];
  ufwActive: boolean;
  /** `.env` of the earlier install (the wizard writes it), `null` — none. */
  install: Record<string, string> | null;
  previous: Record<string, string> | null;
}

export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) env[match[1]] = match[2];
  }
  return env;
}

const SUPPORTED: Array<{ id: Distro; version: string; codename: Codename }> = [
  { id: 'ubuntu', version: '22.04', codename: 'jammy' },
  { id: 'ubuntu', version: '24.04', codename: 'noble' },
  { id: 'debian', version: '12', codename: 'bookworm' },
];

export function parseOsRelease(text: string): OsInfo {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) values[match[1]] = match[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  const id = (values.ID ?? '').toLowerCase();
  const versionId = values.VERSION_ID ?? '';
  const hit = SUPPORTED.find((entry) => entry.id === id && entry.version === versionId);
  return {
    id,
    versionId,
    pretty: (values.PRETTY_NAME ?? `${id} ${versionId}`).slice(0, 80),
    supported: hit !== undefined,
    distro: hit?.id ?? null,
    codename: hit?.codename ?? null,
  };
}

export function parseArch(text: string): 'amd64' | 'arm64' | null {
  const value = text.trim();
  if (value === 'x86_64' || value === 'amd64') return 'amd64';
  if (value === 'aarch64' || value === 'arm64') return 'arm64';
  return null;
}

/** `ss -ltnp`: local port and the process names of every TCP listener (any address, loopback included). */
export function parseListeners(text: string): Listener[] {
  const found = new Map<number, Set<string>>();
  for (const line of text.split('\n')) {
    const cells = line.trim().split(/\s+/);
    if (cells[0] !== 'LISTEN' || cells.length < 5) continue;
    const local = cells[3] ?? '';
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const names = found.get(port) ?? new Set<string>();
    for (const match of line.matchAll(/\("([^"]+)"/g)) if (match[1] !== undefined) names.add(match[1]);
    found.set(port, names);
  }
  return [...found].map(([port, names]) => ({ port, processes: [...names] })).sort((a, b) => a.port - b.port);
}

export const parseUfwActive = (text: string): boolean => /^Status:\s+active/m.test(text);

/** Is this process the Docker port proxy (our own earlier install holds the port)? */
export const isDockerProcess = (name: string): boolean => name === 'docker-proxy' || name === 'dockerd';

export interface ProbeBase {
  os: OsInfo;
  arch: ProbeResult['arch'];
  root: boolean;
  sudoPasswordless: boolean;
}

/** Stage 1: no privileges needed. */
export async function probeBase(shell: RemoteShell): Promise<ProbeBase> {
  const [os, arch, uid] = await Promise.all([shell.run(PROBE.os), shell.run(PROBE.arch), shell.run(PROBE.uid)]);
  const root = uid.stdout.trim() === '0';
  const sudo = root ? { code: 0 } : await shell.run(PROBE.sudo);
  return { os: parseOsRelease(os.stdout), arch: parseArch(arch.stdout), root, sudoPasswordless: sudo.code === 0 };
}

/** Stage 2: reads that need root (`ss -p`, `ufw`, Docker, the install directory). `shell` already elevates. */
export async function probeFull(base: ProbeBase, shell: RemoteShell): Promise<ProbeResult> {
  const as = { sudo: true };
  const [listen, ufw, docker, compose, env, previous] = await Promise.all([
    shell.run(PROBE.listen, as),
    shell.run(PROBE.ufw, as),
    shell.run(PROBE.docker, as),
    shell.run(PROBE.compose, as),
    shell.run(PROBE.env, as),
    shell.run(PROBE.previousEnv, as),
  ]);
  return {
    ...base,
    docker: docker.code === 0,
    compose: compose.code === 0,
    listeners: listen.code === 0 ? parseListeners(listen.stdout) : [],
    ufwActive: ufw.code === 0 && parseUfwActive(ufw.stdout),
    install: env.code === 0 ? parseEnv(env.stdout) : null,
    previous: previous.code === 0 ? parseEnv(previous.stdout) : null,
  };
}
