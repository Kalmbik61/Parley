import net from 'node:net';
import { isValidHost, shQuote } from './input.js';
import { holderOf, isOurs, type ContainerInfo, type ContainerMount, type PortHolder, type ProbeResult } from './probe.js';
import type { RemoteShell } from './shell.js';
import { sha256 } from './templates.js';

/**
 * Stage 3 of the probe (spec 3.3, 3.4, 5.3): what holds 80/443 and whether a site can be added to it.
 * Every command is a fixed template that only reads; values that came from the server pass the patterns below
 * and `shQuote`. A value that does not pass makes the web server «not supported» with a reason, never an error.
 */

export const ACTIVE_FILE = '/var/tmp/parley-relay-setup/active';

// --- patterns for values that come from the server (spec 3.4) ---

export const isContainerId = (value: string): boolean => /^[0-9a-f]{64}$/.test(value);
export const isContainerName = (value: string): boolean => /^\/?[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
export const isNetworkName = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
export function isSafePath(value: string): boolean {
  if (value.length > 256 || !/^\/([A-Za-z0-9._@+-]+\/)*[A-Za-z0-9._@+-]+$/.test(value)) return false;
  return !value.split('/').some((segment) => segment === '.' || segment === '..');
}
/** `host:port`; host is an IPv4 address, `localhost` or a host name. */
export function isAdminAddress(value: string): boolean {
  const match = /^([^:]+):(\d{1,5})$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) return false;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return false;
  return net.isIPv4(match[1]) || (match[1] === 'localhost' || (net.isIP(match[1]) === 0 && isValidHost(match[1])));
}

// --- parsers ---

export interface CaddyfileInfo {
  /** `import` paths at the top level (bracket depth 0). */
  imports: string[];
  /** `'off'`, the `host:port` given in the global options, or `null` when there is none. */
  admin: string | null;
}

/** Removes a `#` comment, keeping `#` inside quotes; also reports the brace delta outside quotes. */
function scanLine(line: string): { text: string; open: number; close: number } {
  let quote: string | null = null;
  let text = '';
  let open = 0;
  let close = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (quote !== null) {
      text += ch;
      if (ch === '\\' && quote === '"') text += line.charAt(++i);
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '`') quote = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(line.charAt(i - 1)))) break;
    else if (ch === '{') open++;
    else if (ch === '}') close++;
    text += ch;
  }
  return { text: text.trim(), open, close };
}

const unquote = (token: string): string => token.replace(/^(["'`])(.*)\1$/, '$2');

export function parseCaddyfile(text: string): CaddyfileInfo {
  const imports: string[] = [];
  let admin: string | null = null;
  let depth = 0;
  let globalSeen = false;
  let inGlobal = false;
  for (const line of text.split('\n')) {
    const { text: code, open, close } = scanLine(line);
    if (code !== '') {
      if (depth === 0) {
        const importMatch = /^import\s+(\S+)/.exec(code);
        if (importMatch?.[1] !== undefined) imports.push(unquote(importMatch[1]));
        else if (!globalSeen && /^\{(\s|$)/.test(code)) {
          globalSeen = true;
          inGlobal = true;
        }
      } else if (inGlobal && depth === 1) {
        const adminMatch = /^admin\s+(\S+)/.exec(code);
        if (adminMatch?.[1] !== undefined) admin = unquote(adminMatch[1]);
      }
    }
    depth = Math.max(0, depth + open - close);
    if (depth === 0) inGlobal = false;
  }
  return { imports, admin };
}

export interface NginxDump {
  mainFile: string | null;
  /** `include <dir>/*.conf;` lines inside `http { … }` of the main file: the directories. */
  httpIncludes: string[];
  /** Every file named in a `# configuration file …:` header. */
  files: string[];
}

export function parseNginxDump(text: string): NginxDump {
  const files: string[] = [];
  let mainBody: string[] | null = null;
  let current: string[] | null = null;
  for (const line of text.split('\n')) {
    const header = /^# configuration file (\/\S+):\s*$/.exec(line);
    if (header?.[1] !== undefined) {
      files.push(header[1]);
      current = [];
      if (files.length === 1) mainBody = current;
    } else current?.push(line);
  }
  const httpIncludes: string[] = [];
  let depth = 0;
  let httpDepth: number | null = null;
  for (const line of mainBody ?? []) {
    const { text: code, open, close } = scanLine(line);
    if (httpDepth === null && /^http\s*\{/.test(code)) httpDepth = depth + 1;
    else if (httpDepth !== null && depth === httpDepth) {
      const include = /^include\s+(\S+)\/\*\.conf\s*;/.exec(code);
      if (include?.[1] !== undefined) httpIncludes.push(include[1]);
    }
    depth = Math.max(0, depth + open - close);
    if (httpDepth !== null && depth < httpDepth) httpDepth = null;
  }
  return { mainFile: files[0] ?? null, httpIncludes, files };
}

/** The directory nginx includes our file from: `conf.d` first, then the first one. */
export const pickNginxDir = (dump: NginxDump): string | null => dump.httpIncludes.find((d) => d.endsWith('conf.d')) ?? dump.httpIncludes[0] ?? null;

/** Host path of a path inside a container: the longest matching `destination` (bind or volume; `:ro` does not matter). */
export function hostPathOf(mounts: ContainerMount[], containerPath: string): string | null {
  let best: ContainerMount | null = null;
  for (const m of mounts) {
    if (m.type !== 'bind' && m.type !== 'volume') continue;
    const dest = m.destination.replace(/\/+$/, '');
    if (dest === '' || (containerPath !== dest && !containerPath.startsWith(`${dest}/`))) continue;
    if (best === null || dest.length > best.destination.replace(/\/+$/, '').length) best = m;
  }
  if (best === null) return null;
  const rest = containerPath.slice(best.destination.replace(/\/+$/, '').length);
  return `${best.source.replace(/\/+$/, '')}${rest}`;
}

export interface CaddyStart {
  config: string | null;
  resume: boolean;
  /** `false`: not `caddy run`, or an adapter other than caddyfile. */
  supported: boolean;
}

/** `caddy run [--config X] [--adapter Y] [--resume]` from the process's argv (binary first). */
export function parseCaddyStart(argv: string[]): CaddyStart {
  const binary = (argv[0] ?? '').split('/').pop();
  if (binary !== 'caddy' || argv[1] !== 'run') return { config: null, resume: false, supported: false };
  let config: string | null = null;
  let adapter: string | null = null;
  let resume = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const eq = /^(--config|-c|--adapter|-a)=(.*)$/.exec(arg);
    const flag = eq?.[1] ?? arg;
    const value = eq !== null ? eq[2] : argv[i + 1];
    if (flag === '--config' || flag === '-c') {
      config = value ?? null;
      if (eq === null) i++;
    } else if (flag === '--adapter' || flag === '-a') {
      adapter = value ?? null;
      if (eq === null) i++;
    } else if (flag === '--resume' || flag === '-r') resume = true;
  }
  return { config, resume, supported: adapter === null || adapter === 'caddyfile' };
}

/** `argv[]=…` of `systemctl show -p ExecStart --value caddy`. */
export function parseExecStart(text: string): string[] {
  const match = /argv\[\]=([^;]*)/.exec(text);
  return match?.[1]?.trim().split(/\s+/).filter((t) => t !== '') ?? [];
}

/** Markers of our block in a Caddyfile (spec 5.3). */
export function countMarkers(text: string): { begin: number; end: number } {
  return { begin: (text.match(/^# BEGIN parley-relay\b.*$/gm) ?? []).length, end: (text.match(/^# END parley-relay\s*$/gm) ?? []).length };
}

/** Is this file one the wizard wrote (or the manual layout of the same shape)? Spec 5.3. */
export function isOurFile(content: string, proxyPort: string | undefined): boolean {
  if (/^# parley-relay:/m.test(content) || /\bparley-relay:8787\b/.test(content) || /\bparley-relay-acme\b/.test(content)) return true;
  return proxyPort !== undefined && /^\d{1,5}$/.test(proxyPort) && content.includes(`127.0.0.1:${proxyPort}`);
}

// --- the survey ---

export type WebKind = 'caddy' | 'nginx' | 'apache' | 'other';

export interface ActiveCommand {
  pid: number;
  id: string;
}

export interface WebSurvey {
  /** Holder of port 80. */
  holder: PortHolder;
  kind: WebKind;
  runtime: 'docker' | 'host' | null;
  container: { id: string; name: string; network: string | null } | null;
  /** Main configuration file: on the host and as the server sees it. */
  config: { host: string; container: string } | null;
  caddyfile: { sha256: string; text: string } | null;
  /** Address for `caddy reload --address`. */
  admin: string | null;
  /** Directory our file goes to (host and as the server sees it) and the suffix of its name. */
  include: { hostDir: string; containerDir: string; suffix: string } | null;
  /** Our earlier change: a file or a block between markers. */
  ours: { kind: 'file'; hostPath: string; sha256: string } | { kind: 'block' } | null;
  /** `parley-relay` / `parley-relay-acme` already belong to somebody else in the chosen network. */
  nameClash: boolean;
  /** Why a site cannot be added; empty — it can. */
  reasons: string[];
  /** The reasons that must stop the plan (a file of somebody else with our name, a broken marker, a name clash) instead of falling back to layout 5. */
  blockers: string[];
}

export const NAME_CLASH_REASON = 'The names parley-relay and parley-relay-acme are already used by another container in the web server network';
const BUILTIN_NETWORKS = new Set(['bridge', 'host', 'none']);

/** The user-defined network of a container: the one with our relay, else the first by name. */
export function chooseNetwork(container: ContainerInfo, all: ContainerInfo[]): string | null {
  const names = container.networks.filter((n) => !BUILTIN_NETWORKS.has(n)).sort();
  const withOurs = names.find((n) => all.some((c) => isOurs(c) && c.networks.includes(n)));
  return withOurs ?? names[0] ?? null;
}

const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/';

function resolveImport(configPath: string, imports: string[]): { dir: string; suffix: string } | null {
  for (const raw of imports) {
    const path = raw.startsWith('/') ? raw : `${dirOf(configPath)}/${raw}`;
    const match = /^(\/[^*]*)\/\*([A-Za-z0-9._-]{0,32})$/.exec(path);
    if (match?.[1] !== undefined) return { dir: match[1], suffix: match[2] ?? '' };
  }
  return null;
}

const empty = (holder: PortHolder, kind: WebKind, runtime: WebSurvey['runtime'], reasons: string[]): WebSurvey => ({
  holder,
  kind,
  runtime,
  container: null,
  config: null,
  caddyfile: null,
  admin: null,
  include: null,
  ours: null,
  nameClash: false,
  reasons,
  blockers: [],
});

/** Stage 3: what holds port 80 and what can be added to it. `null` when nothing holds it. Reads only. */
export async function probeWeb(probe: ProbeResult, shell: RemoteShell): Promise<WebSurvey | null> {
  const holder = holderOf(probe, 80);
  if (holder === null) return null;
  const as = { sudo: true };
  const run = (command: string): Promise<{ code: number; stdout: string }> => shell.run(command, as);

  if (holder.kind === 'unknown-docker') return empty(holder, 'other', 'docker', ['The container that holds port 80 is not in the list of running containers']);

  let kind: WebKind = 'other';
  let runtime: WebSurvey['runtime'] = null;
  let container: ContainerInfo | null = null;
  let hostUnit: 'caddy' | 'nginx' | null = null;
  if (holder.kind === 'container') {
    container = holder.container;
    runtime = 'docker';
    if (!isContainerId(container.id)) return empty(holder, 'other', 'docker', ['The container id has an unexpected form']);
    const id = shQuote(container.id);
    if ((await run(`docker exec ${id} caddy version`)).code === 0) kind = 'caddy';
    else if ((await run(`docker exec ${id} nginx -v`)).code === 0) kind = 'nginx';
    if (kind === 'other') return empty(holder, 'other', 'docker', [`The container ${container.name} is neither Caddy nor nginx`]);
  } else {
    if (holder.names.includes('caddy')) hostUnit = 'caddy';
    else if (holder.names.includes('nginx')) hostUnit = 'nginx';
    else if (holder.names.some((n) => n === 'apache2' || n === 'httpd')) return empty(holder, 'apache', null, ['Apache is not supported: add the site to it yourself']);
    if (hostUnit === null) return empty(holder, 'other', null, ['This web server is not supported: add the site to it yourself']);
    kind = hostUnit;
    runtime = 'host';
  }

  const reasons: string[] = [];
  const survey = empty(holder, kind, runtime, reasons);
  const block = (text: string): void => {
    reasons.push(text);
    survey.blockers.push(text);
  };

  if (container !== null) {
    if (container.networkMode === 'host') reasons.push('The web server container uses the host network');
    const network = chooseNetwork(container, probe.containers);
    if (network === null || !isNetworkName(network)) reasons.push('The web server container is only in the default bridge network, where containers cannot find each other by name');
    survey.container = { id: container.id, name: isContainerName(container.name) ? container.name.replace(/^\//, '') : container.id.slice(0, 12), network };
    if (network !== null) {
      const taken = (name: string): boolean =>
        probe.containers.some((c) => !isOurs(c) && c.id !== container?.id && c.networks.includes(network) && (c.name === name || (c.networkAliases[network] ?? []).includes(name)));
      if (taken('parley-relay') || taken('parley-relay-acme')) {
        survey.nameClash = true;
        block(NAME_CLASH_REASON);
      }
    }
  } else {
    const units = await run('systemctl is-active caddy nginx apache2 httpd');
    const states = units.stdout.split('\n').map((l) => l.trim());
    const active = hostUnit === 'caddy' ? states[0] === 'active' : states[1] === 'active';
    if (!active) reasons.push(`${hostUnit} on the host is not managed by systemd`);
  }

  const toHost = (containerPath: string): string | null => (container === null ? containerPath : hostPathOf(container.mounts, containerPath));
  const exec = (command: string): string => (container === null ? command : `docker exec ${shQuote(container.id)} ${command}`);

  if (kind === 'caddy') {
    let argv: string[] = [];
    let workdir = '';
    if (container !== null) {
      argv = [container.path, ...container.args];
      workdir = container.workdir;
    } else {
      const start = await run('systemctl show -p ExecStart --value caddy');
      argv = start.code === 0 ? parseExecStart(start.stdout) : [];
      const reload = await run('systemctl show -p ExecReload --value caddy');
      if (reload.code !== 0 || reload.stdout.trim() === '') reasons.push('The caddy systemd unit has no ExecReload, so the configuration cannot be reloaded');
    }
    const start = parseCaddyStart(argv);
    if (!start.supported) reasons.push('Caddy is not started as «caddy run» with the Caddyfile adapter');
    if (start.resume) reasons.push('Caddy runs with --resume: its configuration does not come from a Caddyfile');
    const configPath = start.config ?? (start.supported && container !== null && workdir !== '' ? `${workdir.replace(/\/+$/, '')}/Caddyfile` : null);
    if (start.supported && !start.resume && configPath === null) reasons.push('The Caddyfile path could not be determined');
    if (configPath !== null && start.supported && !start.resume) {
      const hostConfig = isSafePath(configPath) ? toHost(configPath) : null;
      if (!isSafePath(configPath)) reasons.push('The Caddyfile path has an unsupported form');
      else if (hostConfig === null) reasons.push('The Caddyfile is not on a mounted volume, so it cannot be changed from the host');
      else if (!isSafePath(hostConfig)) reasons.push('The Caddyfile path on the host has an unsupported form');
      else {
        const read = await run(`cat ${shQuote(hostConfig)}`);
        if (read.code !== 0) reasons.push('The Caddyfile could not be read');
        else {
          survey.config = { host: hostConfig, container: configPath };
          survey.caddyfile = { sha256: sha256(read.stdout), text: read.stdout };
          const info = parseCaddyfile(read.stdout);
          if (info.admin === 'off') reasons.push('The Caddy admin endpoint is off, so the configuration cannot be reloaded');
          else if (info.admin !== null && !isAdminAddress(info.admin)) reasons.push('The Caddy admin address has an unsupported form');
          else survey.admin = info.admin ?? '127.0.0.1:2019';
          const markers = countMarkers(read.stdout);
          if (markers.begin + markers.end > 2 || markers.begin !== markers.end) block('The Caddyfile has an unpaired or repeated parley-relay marker');
          else if (markers.begin === 1) survey.ours = { kind: 'block' };
          const target = resolveImport(configPath, info.imports);
          if (target !== null) {
            const hostDir = isSafePath(target.dir) ? toHost(target.dir) : null;
            if (hostDir === null || !isSafePath(hostDir)) reasons.push('The directory the Caddyfile imports sites from is not on a mounted volume');
            else survey.include = { hostDir, containerDir: target.dir, suffix: target.suffix };
          }
        }
      }
    }
  } else {
    const dump = await run(exec('nginx -T'));
    const parsed = dump.code === 0 ? parseNginxDump(dump.stdout) : null;
    const dir = parsed === null ? null : pickNginxDir(parsed);
    if (dir === null || parsed === null) reasons.push('The nginx configuration has no include <directory>/*.conf in its http block');
    else {
      const hostDir = isSafePath(dir) ? toHost(dir) : null;
      if (hostDir === null || !isSafePath(hostDir)) reasons.push('The nginx include directory is not on a mounted volume');
      else {
        survey.include = { hostDir, containerDir: dir, suffix: '.conf' };
        if (parsed.mainFile !== null) survey.config = { host: toHost(parsed.mainFile) ?? parsed.mainFile, container: parsed.mainFile };
      }
    }
  }

  if (survey.include !== null && survey.ours === null) {
    const hostPath = `${survey.include.hostDir}/parley-relay${survey.include.suffix}`;
    const read = await run(`cat ${shQuote(hostPath)}`);
    if (read.code === 0) {
      if (isOurFile(read.stdout, probe.install?.RELAY_PROXY_PORT)) survey.ours = { kind: 'file', hostPath, sha256: sha256(read.stdout) };
      else block(`${hostPath} exists and was not written by Parley`);
    }
  }
  return survey;
}

export interface PreviousCommand {
  /** Alive: the plan is blocked. */
  active: ActiveCommand | null;
  /** Dead: the end of its log, shown in the plan notes. */
  tail: { id: string; text: string } | null;
}

/** The previous run's command: alive (blocks the plan) or dead (its log tail is shown). Spec 7.3. */
export async function probeActive(shell: RemoteShell): Promise<PreviousCommand> {
  const none: PreviousCommand = { active: null, tail: null };
  const file = await shell.run(`cat ${ACTIVE_FILE}`, { sudo: true });
  const match = file.code === 0 ? /^(\d{1,9}) ([a-z][a-z0-9-]{0,31})$/.exec(file.stdout.trim()) : null;
  if (match?.[1] === undefined || match[2] === undefined) return none;
  const alive = await shell.run(`kill -0 ${match[1]}`, { sudo: true });
  if (alive.code === 0) return { active: { pid: Number(match[1]), id: match[2] }, tail: null };
  const log = await shell.run(`tail -n 20 /var/tmp/parley-relay-setup/${match[2]}.log`, { sudo: true });
  return { active: null, tail: log.code === 0 && log.stdout.trim() !== '' ? { id: match[2], text: log.stdout } : null };
}
