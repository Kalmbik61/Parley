import net from 'node:net';
import { shQuote, type SetupIntent } from './input.js';
import { INSTALL_DIR, isDockerProcess, type Listener, type ProbeResult } from './probe.js';
import { managedFiles, proxySnippet, sha256, type EnvValues, type ProxyServer, type SetupMode } from './templates.js';

/**
 * The command plan (spec 6.7 steps 4–5). Every step is «check → do»: the check is a command whose exit code 0 means
 * «already done» and the step is skipped. Commands are fixed templates; the only variable parts are values that
 * passed `input.ts` (or come from the fixed tables in `probe.ts`) and go through `shQuote`.
 */

export interface PlanCommand {
  /** What is sent to the server (as root). May carry a base64 file body. */
  run: string;
  /** What the person reads on the screen. */
  show: string;
}

export interface PlanStep {
  id: string;
  title: string;
  /** Exit code 0 → skip the step. `null` → always run. */
  check: string | null;
  checkShow: string | null;
  commands: PlanCommand[];
  /** Run even when the check passes, if an earlier step changed something (restart after new files or image). */
  rerunOnChange?: boolean;
}

export type PortDecision =
  | { mode: 'caddy'; httpPort: 80; httpsPort: 443 | 8443 }
  | { mode: 'proxy'; relayPort: number; server: ProxyServer }
  | { mode: 'blocked'; reason: string };

const PROXY_PORT_CANDIDATES = [8787, 18787, 28787];

/** Listeners that are not ours: our own earlier install (Docker's port proxy, with `.env` present) does not count. */
function foreign(probe: ProbeResult): Listener[] {
  if (probe.install === null) return probe.listeners;
  return probe.listeners.filter((l) => l.processes.length === 0 || !l.processes.every(isDockerProcess));
}

function serverKind(listener: Listener | undefined): ProxyServer {
  const names = listener?.processes ?? [];
  if (names.includes('nginx')) return 'nginx';
  if (names.some((n) => n === 'apache2' || n === 'httpd')) return 'apache';
  return 'other';
}

/** Busy ports (spec 6.7): both free → Caddy on 80/443; only 443 busy → Caddy on 8443; 80 busy → loopback + snippet. */
export function decidePorts(probe: ProbeResult): PortDecision {
  const busy = foreign(probe);
  const at = (port: number): Listener | undefined => busy.find((l) => l.port === port);
  if (at(80) !== undefined) {
    const relayPort = PROXY_PORT_CANDIDATES.find((port) => at(port) === undefined);
    if (relayPort === undefined) return { mode: 'blocked', reason: 'Port 80 is taken and no local port is free for the relay' };
    return { mode: 'proxy', relayPort, server: serverKind(at(80)) };
  }
  if (at(443) === undefined) return { mode: 'caddy', httpPort: 80, httpsPort: 443 };
  if (at(8443) !== undefined) return { mode: 'blocked', reason: 'Ports 443 and 8443 are both taken' };
  return { mode: 'caddy', httpPort: 80, httpsPort: 8443 };
}

export const sslipName = (ip: string): string => `${ip.replace(/\./g, '-')}.sslip.io`;

/** The `host[:port]` for the Relay field and the QR. */
export function relayAddress(name: string, decision: PortDecision): string {
  return decision.mode === 'caddy' && decision.httpsPort !== 443 ? `${name}:${decision.httpsPort}` : name;
}

export interface PlanContext {
  intent: SetupIntent;
  probe: ProbeResult;
  decision: PortDecision;
  /** The host name the certificate is issued for (own domain or sslip). */
  name: string;
  /** Full image reference. */
  image: string;
  /** `remove` only: the person confirmed deleting the data volumes. */
  removeData?: boolean;
}

export interface Plan {
  intent: SetupIntent;
  steps: PlanStep[];
  notes: string[];
  /** Set when the plan cannot be run; the screen shows the reason and no «Run». */
  blocked: string | null;
  mode: SetupMode | null;
  address: string | null;
  proxy: { snippet: string; certificateHint: string } | null;
}

const D = INSTALL_DIR;
const COMPOSE = `docker compose --project-directory ${D}`;

function writeFile(path: string, content: string, mode: string, showContent: boolean): PlanCommand {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const body = showContent ? `\n${content.replace(/\n$/, '').split('\n').map((l) => `    ${l}`).join('\n')}` : ' (content not shown)';
  return {
    run: `printf %s ${shQuote(b64)} | base64 -d > ${shQuote(path)} && chmod ${mode} ${shQuote(path)}`,
    show: `write ${path} (${Buffer.byteLength(content)} bytes, mode ${mode})${body}`,
  };
}

const plain = (cmd: string): PlanCommand => ({ run: cmd, show: cmd });

function dockerStep(probe: ProbeResult): PlanStep {
  const distro = probe.os.distro ?? 'ubuntu';
  const arch = probe.arch ?? 'amd64';
  const codename = probe.os.codename ?? 'noble';
  const base = `https://download.docker.com/linux/${distro}`;
  const line = `deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] ${base} ${codename} stable\n`;
  const apt = 'env DEBIAN_FRONTEND=noninteractive apt-get';
  return {
    id: 'docker',
    title: 'Docker from the official Docker apt repository',
    check: 'docker --version && docker compose version',
    checkShow: 'docker --version && docker compose version',
    commands: [
      plain(`${apt} update`),
      plain(`${apt} install -y ca-certificates curl`),
      plain('install -m 0755 -d /etc/apt/keyrings'),
      plain(`curl -fsSL ${base}/gpg -o /etc/apt/keyrings/docker.asc`),
      plain('chmod a+r /etc/apt/keyrings/docker.asc'),
      writeFile('/etc/apt/sources.list.d/docker.list', line, '0644', true),
      plain(`${apt} update`),
      plain(`${apt} install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`),
    ],
  };
}

function ufwRules(ports: number[]): PlanStep {
  const rule = (port: number): string => `${port}/tcp`;
  const checks = ports.map((p) => `ufw status | grep -qE ${shQuote(`^${p}/tcp +ALLOW`)}`).join(' && ');
  return {
    id: 'ufw',
    title: `Firewall (ufw is active): allow ${ports.join(' and ')}`,
    check: checks,
    checkShow: checks,
    commands: ports.map((p) =>
      plain(
        `ufw status | grep -qE ${shQuote(`^${p}/tcp +ALLOW`)} || { ufw allow ${rule(p)} comment parley-relay && echo ${rule(p)} >> ${D}/ufw-rules; }`,
      ),
    ),
  };
}

function installSteps(ctx: PlanContext, env: EnvValues): PlanStep[] {
  const files = managedFiles(env);
  const steps: PlanStep[] = [];
  steps.push(dockerStep(ctx.probe));
  steps.push({
    id: 'dir',
    title: `Directory ${D}`,
    check: `test -d ${D}`,
    checkShow: `test -d ${D}`,
    commands: [plain(`install -d -m 0755 ${D}`)],
  });
  const sums = files.map((f) => `${sha256(f.content)}  ${f.name}`);
  const check = `cd ${D} && printf '%s\\n' ${sums.map(shQuote).join(' ')} | sha256sum -c --status -${env.mode === 'proxy' ? ' && [ ! -e Caddyfile ]' : ''}`;
  steps.push({
    id: 'files',
    title: 'Configuration files (the previous ones are kept in previous/)',
    check,
    checkShow: check,
    commands: [
      plain(
        `cd ${D} && mkdir -p previous && if [ -f .env ]; then rm -f previous/compose.yml previous/Caddyfile previous/.env; for f in compose.yml Caddyfile .env; do if [ -f "$f" ]; then cp -p "$f" "previous/$f"; fi; done; fi`,
      ),
      ...files.map((f) => writeFile(`${D}/${f.name}`, f.content, f.mode, f.showContent)),
      ...(env.mode === 'proxy' ? [plain(`rm -f ${D}/Caddyfile`)] : []),
    ],
  });
  steps.push({
    id: 'image',
    title: `Relay image ${ctx.image}`,
    check: `docker image inspect ${shQuote(ctx.image)} >/dev/null 2>&1`,
    checkShow: `docker image inspect ${ctx.image}`,
    commands: [{ run: `docker pull ${shQuote(ctx.image)}`, show: `docker pull ${ctx.image}` }],
  });
  if (ctx.probe.ufwActive && ctx.decision.mode === 'caddy') {
    steps.push(ufwRules(ctx.decision.httpsPort === 443 ? [80, 443] : [80, ctx.decision.httpsPort]));
  }
  const up = `${COMPOSE} ps --status running --services | grep -qx relay`;
  steps.push({
    id: 'start',
    title: env.mode === 'caddy' ? 'Start the relay and Caddy' : 'Start the relay on 127.0.0.1',
    check: up,
    checkShow: up,
    rerunOnChange: true,
    commands: [plain(`${COMPOSE} up -d --remove-orphans`)],
  });
  return steps;
}

function rollbackSteps(): PlanStep[] {
  const same = `cd ${D} && cmp -s previous/.env .env && cmp -s previous/compose.yml compose.yml`;
  return [
    {
      id: 'restore',
      title: 'Restore the previous files and image',
      check: same,
      checkShow: same,
      commands: [
        plain(`cd ${D} && cp -p previous/compose.yml compose.yml && cp -p previous/.env .env`),
        plain(`cd ${D} && if [ -f previous/Caddyfile ]; then cp -p previous/Caddyfile Caddyfile; else rm -f Caddyfile; fi`),
      ],
    },
    {
      id: 'start',
      title: 'Restart with the previous image',
      check: null,
      checkShow: null,
      commands: [plain(`${COMPOSE} up -d --remove-orphans`)],
    },
  ];
}

function removeSteps(ctx: PlanContext): PlanStep[] {
  const down = ctx.removeData === true ? `${COMPOSE} down -v` : `${COMPOSE} down`;
  const rules = `if [ -f ${D}/ufw-rules ]; then grep -E '^[0-9]{1,5}/tcp$' ${D}/ufw-rules | while read -r rule; do ufw delete allow "$rule"; done; fi`;
  return [
    {
      id: 'down',
      title: ctx.removeData === true ? 'Stop the relay and delete its data (routes, device trust, certificates)' : 'Stop the relay (its data is kept)',
      check: `test ! -d ${D}`,
      checkShow: `test ! -d ${D}`,
      commands: [plain(down)],
    },
    { id: 'ufw', title: 'Remove the firewall rules this wizard added', check: `test ! -d ${D}`, checkShow: `test ! -d ${D}`, commands: [plain(rules)] },
    { id: 'files', title: `Delete ${D}`, check: `test ! -d ${D}`, checkShow: `test ! -d ${D}`, commands: [plain(`rm -rf ${D}`)] },
  ];
}

export function buildPlan(ctx: PlanContext): Plan {
  const { probe, decision } = ctx;
  const empty = (blocked: string): Plan => ({ intent: ctx.intent, steps: [], notes: [], blocked, mode: null, address: null, proxy: null });
  if (!probe.os.supported) return empty(`Unsupported system: ${probe.os.pretty}. Follow the manual instructions instead.`);
  if (probe.arch === null) return empty('Unsupported processor architecture (amd64 and arm64 only)');
  if (ctx.intent === 'rollback') {
    if (probe.install === null || probe.previous === null) return empty('There is no previous version to roll back to');
    return { intent: 'rollback', steps: rollbackSteps(), notes: [], blocked: null, mode: null, address: null, proxy: null };
  }
  if (ctx.intent === 'remove') {
    if (probe.install === null) return empty('No relay installed by this wizard was found');
    return {
      intent: 'remove',
      steps: removeSteps(ctx),
      notes: ['Docker and its packages stay installed.', ctx.removeData === true ? 'The relay data will be deleted.' : 'The relay data stays in Docker volumes.'],
      blocked: null,
      mode: null,
      address: null,
      proxy: null,
    };
  }
  if (probe.docker && !probe.compose) {
    return empty('Docker is installed without the Compose plugin. Install docker-compose-plugin and run the wizard again.');
  }
  if (decision.mode === 'blocked') return empty(decision.reason);
  const env: EnvValues = {
    mode: decision.mode,
    domain: ctx.name,
    image: ctx.image,
    httpPort: 80,
    httpsPort: decision.mode === 'caddy' ? decision.httpsPort : 443,
    proxyPort: decision.mode === 'proxy' ? decision.relayPort : 8787,
  };
  const notes = [
    'Only /opt/parley-relay, firewall rules of this wizard and the Docker packages are touched on the server.',
    'If your hosting provider has a firewall in front of the server, open the ports there yourself; the wizard cannot see it.',
  ];
  let proxy: Plan['proxy'] = null;
  if (decision.mode === 'proxy') {
    proxy = proxySnippet(decision.server, decision.relayPort);
    notes.push(`Port 80 is used by another web server, so Parley does not install Caddy. The relay listens on 127.0.0.1:${decision.relayPort}; add the snippet to your web server yourself.`);
  } else if (decision.httpsPort !== 443) {
    notes.push(`Port 443 is taken, so the relay will be reachable on port ${decision.httpsPort}.`);
  }
  return {
    intent: 'install',
    steps: installSteps(ctx, env),
    notes,
    blocked: null,
    mode: decision.mode,
    address: relayAddress(ctx.name, decision),
    proxy,
  };
}

/** Is the host an IPv4 address (for the sslip name)? */
export const isIPv4 = (host: string): boolean => net.isIPv4(host);
