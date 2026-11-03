import type { RemoteShell } from './shell.js';
import type { ActiveCommand, WebSurvey } from './web.js';

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
  // One JSON line per running container; no containers or no Docker → empty output (`xargs -r` runs nothing).
  containers: `docker ps -q | xargs -r docker inspect --format '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"labels":{{json .Config.Labels}},"path":{{json .Path}},"args":{{json .Args}},"workdir":{{json .Config.WorkingDir}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}},"networks":{{json .NetworkSettings.Networks}},"networkMode":{{json .HostConfig.NetworkMode}}}'`,
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

export interface ContainerMount {
  type: string;
  source: string;
  destination: string;
  rw: boolean;
}

export interface ContainerInfo {
  id: string;
  /** Without the leading `/` Docker adds. */
  name: string;
  image: string;
  labels: Record<string, string>;
  path: string;
  args: string[];
  workdir: string;
  mounts: ContainerMount[];
  /** Published TCP ports (`HostPort` on the host side), one entry per host address. */
  published: Array<{ hostPort: number; hostIp: string }>;
  networks: string[];
  /** Per network: its aliases and DNS names (the container's own short id included by Docker). */
  networkAliases: Record<string, string[]>;
  networkMode: string;
}

export interface ProbeResult {
  os: OsInfo;
  arch: 'amd64' | 'arm64' | null;
  root: boolean;
  sudoPasswordless: boolean;
  docker: boolean;
  compose: boolean;
  listeners: Listener[];
  /** Running containers; empty without Docker or when the command failed. */
  containers: ContainerInfo[];
  ufwActive: boolean;
  /** The web server on 80/443 and what can be added to it (stage 3, `probeWeb`); `null` — not surveyed or nothing there. */
  web: WebSurvey | null;
  /** A command of the previous run still alive on the server (spec 7.3). */
  activeCommand: ActiveCommand | null;
  /** The end of the log of the previous run's last command, when that command is dead (shown in the plan notes). */
  previousTail: { id: string; text: string } | null;
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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

function aliasesOf(networks: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!isRecord(networks)) return result;
  for (const [name, net] of Object.entries(networks)) {
    result[name] = isRecord(net) ? [...strings(net.Aliases), ...strings(net.DNSNames)] : [];
  }
  return result;
}

function parseContainer(value: unknown): ContainerInfo | null {
  if (!isRecord(value) || str(value.id) === '') return null;
  const labels: Record<string, string> = {};
  if (isRecord(value.labels)) for (const [key, label] of Object.entries(value.labels)) if (typeof label === 'string') labels[key] = label;
  const mounts: ContainerMount[] = [];
  if (Array.isArray(value.mounts)) {
    for (const m of value.mounts) {
      if (isRecord(m)) mounts.push({ type: str(m.Type), source: str(m.Source), destination: str(m.Destination), rw: m.RW === true });
    }
  }
  const published: ContainerInfo['published'] = [];
  if (isRecord(value.ports)) {
    for (const [key, bindings] of Object.entries(value.ports)) {
      if (!key.endsWith('/tcp') || !Array.isArray(bindings)) continue;
      for (const b of bindings) {
        const hostPort = isRecord(b) ? Number(b.HostPort) : NaN;
        if (isRecord(b) && Number.isInteger(hostPort) && hostPort >= 1 && hostPort <= 65535) published.push({ hostPort, hostIp: str(b.HostIp) });
      }
    }
  }
  return {
    id: str(value.id),
    name: str(value.name).replace(/^\//, ''),
    image: str(value.image),
    labels,
    path: str(value.path),
    args: strings(value.args),
    workdir: str(value.workdir),
    mounts,
    published,
    networks: isRecord(value.networks) ? Object.keys(value.networks) : [],
    networkAliases: aliasesOf(value.networks),
    networkMode: str(value.networkMode),
  };
}

/** Output of `PROBE.containers`: one JSON object per line. Empty output is fine; broken lines are skipped. */
export function parseContainers(text: string): ContainerInfo[] {
  const found: ContainerInfo[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const container = parseContainer(JSON.parse(trimmed));
      if (container !== null) found.push(container);
    } catch {
      // not JSON: skip the line
    }
  }
  return found;
}

export const parseUfwActive = (text: string): boolean => /^Status:\s+active/m.test(text);

/** Is this process the Docker port proxy? */
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
  const [listen, ufw, docker, compose, containers, env, previous] = await Promise.all([
    shell.run(PROBE.listen, as),
    shell.run(PROBE.ufw, as),
    shell.run(PROBE.docker, as),
    shell.run(PROBE.compose, as),
    shell.run(PROBE.containers, as),
    shell.run(PROBE.env, as),
    shell.run(PROBE.previousEnv, as),
  ]);
  return {
    ...base,
    docker: docker.code === 0,
    compose: compose.code === 0,
    listeners: listen.code === 0 ? parseListeners(listen.stdout) : [],
    // Whatever the exit code: a container that vanished between `ps` and `inspect` makes inspect exit 1 but it still prints the rest.
    containers: parseContainers(containers.stdout),
    web: null,
    activeCommand: null,
    previousTail: null,
    ufwActive: ufw.code === 0 && parseUfwActive(ufw.stdout),
    install: env.code === 0 ? parseEnv(env.stdout) : null,
    previous: previous.code === 0 ? parseEnv(previous.stdout) : null,
  };
}

/** The compose project label of the containers the wizard installs. */
export const OUR_PROJECT = 'parley-relay';
export const isOurs = (container: ContainerInfo): boolean => container.labels['com.docker.compose.project'] === OUR_PROJECT;

export type PortHolder =
  | { kind: 'container'; container: ContainerInfo }
  | { kind: 'process'; names: string[] }
  | { kind: 'unknown-docker' };

/**
 * Who holds each busy port (spec 3.2). Busy = a listener from `ss` or a port published by a running container
 * (Docker without userland-proxy shows no listener). Our own containers (`parley-relay` project) hold nothing,
 * and neither does the Docker proxy that serves them. `.env` is not consulted.
 */
export function portHolders(probe: ProbeResult): Map<number, PortHolder> {
  const holders = new Map<number, PortHolder>();
  const ports = new Set<number>(probe.listeners.map((l) => l.port));
  for (const c of probe.containers) for (const p of c.published) ports.add(p.hostPort);
  for (const port of ports) {
    const publishers = probe.containers.filter((c) => c.published.some((p) => p.hostPort === port));
    const foreign = publishers.find((c) => !isOurs(c));
    if (foreign !== undefined) {
      holders.set(port, { kind: 'container', container: foreign });
      continue;
    }
    const names = probe.listeners.find((l) => l.port === port)?.processes ?? null;
    if (names === null) continue; // published by our container only, no listener
    const dockerOnly = names.length > 0 && names.every(isDockerProcess);
    if (publishers.length > 0 && (dockerOnly || names.length === 0)) continue;
    holders.set(port, dockerOnly ? { kind: 'unknown-docker' } : { kind: 'process', names });
  }
  return holders;
}

export const holderOf = (probe: ProbeResult, port: number): PortHolder | null => portHolders(probe).get(port) ?? null;
