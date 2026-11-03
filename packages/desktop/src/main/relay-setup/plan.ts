import net from 'node:net';
import { isValidDomain, shQuote, type SetupIntent } from './input.js';
import type { RelayPlanWeb, RelayPullProgress } from '../../shared/relay-setup-types.js';
import { describePullProgress } from '../../shared/relay-run-view.js';
import { createPullProgress, pullCommand } from './pull-progress.js';
import { INSTALL_DIR, holderOf, isOurs, type PortHolder, type ProbeResult } from './probe.js';
import {
  CADDY_IMAGE,
  caddyBlockAppend,
  replaceCaddyBlock,
  caddySiteFile,
  managedFiles,
  nginxSiteFile,
  proxySnippet,
  removeCaddyBlock,
  sha256,
  type EnvValues,
  type ProxyServer,
  type SetupMode,
} from './templates.js';
import {
  BACKUP_DIR,
  afterShaOf,
  buildEditScript,
  caddyCommands,
  editCommand,
  nginxCommands,
  nginxStepCheck,
  webStepCheck,
  type CaddyTarget,
  type EditAction,
  type NginxTarget,
} from './web-edit.js';
import { NAME_CLASH_REASON, containerNetwork, isNetworkName, type WebSurvey } from './web.js';

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
  /** A cancel may end the running command (the image download); the other steps are finished first (spec 7.2). */
  interruptible?: boolean;
}

/** The layouts of spec 4: 1, 1б → `caddy`; 2, 4а → `caddy-site`; 3, 4б → `nginx-acme`; 5 → `proxy`. */
export type Layout =
  | { mode: 'caddy'; httpPort: 80; httpsPort: 443 | 8443 }
  | { mode: 'caddy-site'; runtime: 'docker' | 'host'; web: WebSurvey; network: string | null; relayPort: number }
  | { mode: 'nginx-acme'; runtime: 'docker' | 'host'; web: WebSurvey; network: string | null; acmePort: number | null }
  /** `kept`: an earlier `proxy` install already answers, so the layout stays (spec 6.2). */
  | { mode: 'proxy'; relayPort: number; server: ProxyServer; holder: string; reason: string | null; network: string | null; kept: boolean }
  | { mode: 'blocked'; reason: string };

const PROXY_PORT_CANDIDATES = [8787, 18787, 28787];
const ACME_PORT_CANDIDATES = [18080, 28080];
/** The port the relay is reachable on behind nginx. */
export const NGINX_ACME_PORT = 8443;

function serverKind(holder: PortHolder | null, web: WebSurvey | null): ProxyServer {
  if (holder?.kind === 'container') return web?.kind === 'nginx' ? 'nginx' : 'other';
  const names = holder?.kind === 'process' ? holder.names : [];
  if (names.includes('nginx')) return 'nginx';
  if (names.some((n) => n === 'apache2' || n === 'httpd')) return 'apache';
  return 'other';
}

function describeHolder(holder: PortHolder): string {
  if (holder.kind === 'container') return `the Docker container ${holder.container.name} (${holder.container.image})`;
  if (holder.kind === 'unknown-docker') return 'a Docker container';
  const names = holder.names.map((n) => (n === 'apache2' || n === 'httpd' ? `Apache (${n})` : n));
  return names.length > 0 ? names.join(', ') : 'another program';
}

/** The table of spec 4, in order; the first row whose conditions hold wins. «Busy» follows 3.2 (our containers do not count). */
export function decideLayout(probe: ProbeResult): Layout {
  const h80 = holderOf(probe, 80);
  const h443 = holderOf(probe, 443);
  // A working manual `proxy` install stays as it is: a new layout would change the address and break the person's snippet.
  const env = probe.install;
  if (env?.RELAY_MODE === 'proxy' && probe.proxyHealthy === true && isValidDomain(env.RELAY_DOMAIN ?? '')) {
    const port = Number(env.RELAY_PROXY_PORT ?? '8787');
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      const network = env.RELAY_NETWORK !== undefined && isNetworkName(env.RELAY_NETWORK) ? env.RELAY_NETWORK : null;
      return { mode: 'proxy', relayPort: port, server: serverKind(h80, probe.web), holder: h80 === null ? 'your web server' : describeHolder(h80), reason: null, network, kept: true };
    }
  }
  if (h80 === null) {
    // Only where our Caddy would take 80/443 itself: a stopped container of somebody else that comes back by itself would lose them.
    const wanted = h443 === null ? [80, 443] : [80];
    const waiting = probe.containers.find((c) => c.running === false && !isOurs(c) && !['', 'no'].includes(c.restartPolicy ?? '') && (c.boundPorts ?? []).some((port) => wanted.includes(port)));
    if (waiting !== undefined) {
      const port = (waiting.boundPorts ?? []).includes(80) ? 80 : 443;
      return { mode: 'blocked', reason: `Port ${port} is assigned to the stopped container ${waiting.name} (restart policy ${waiting.restartPolicy}). Start it or remove it, then run the wizard again.` };
    }
    if (h443 === null) return { mode: 'caddy', httpPort: 80, httpsPort: 443 };
    if (holderOf(probe, 8443) !== null) return { mode: 'blocked', reason: 'Ports 443 and 8443 are both taken' };
    return { mode: 'caddy', httpPort: 80, httpsPort: 8443 };
  }
  const web = probe.web;
  if (web !== null && web.blockers.length > 0) return { mode: 'blocked', reason: web.blockers[0] ?? 'The web server cannot be changed' };
  const freePort = PROXY_PORT_CANDIDATES.find((port) => holderOf(probe, port) === null);
  const usable = web !== null && web.reasons.length === 0 && web.caddyfile !== null && web.config !== null;

  if (usable && web.kind === 'caddy' && web.runtime === 'docker' && h80.kind === 'container' && h443?.kind === 'container' && h443.container.id === h80.container.id && web.container?.network) {
    return { mode: 'caddy-site', runtime: 'docker', web, network: web.container.network, relayPort: 8787 };
  }
  if (usable && web.kind === 'caddy' && web.runtime === 'host' && h443?.kind === 'process' && h443.names.includes('caddy') && freePort !== undefined) {
    return { mode: 'caddy-site', runtime: 'host', web, network: null, relayPort: freePort };
  }
  // Rows 3 and 4б: nginx forwards port 80 of our name to the relay's own Caddy on 8443.
  const nginxOk = web !== null && web.kind === 'nginx' && web.reasons.length === 0 && web.include !== null;
  const acmePort = ACME_PORT_CANDIDATES.find((port) => holderOf(probe, port) === null);
  let nginxReason: string | null = null;
  if (nginxOk && holderOf(probe, 8443) !== null) nginxReason = 'port 8443, where the relay would be reachable, is taken';
  else if (nginxOk && web.runtime === 'docker' && h80.kind === 'container' && web.container?.network) {
    return { mode: 'nginx-acme', runtime: 'docker', web, network: web.container.network, acmePort: null };
  } else if (nginxOk && web.runtime === 'host') {
    if (acmePort === undefined) nginxReason = 'no local port is free for the relay’s Caddy';
    else return { mode: 'nginx-acme', runtime: 'host', web, network: null, acmePort };
  }
  if (freePort === undefined) return { mode: 'blocked', reason: 'Port 80 is taken and no local port is free for the relay' };
  let reason: string | null = web?.reasons[0] ?? nginxReason;
  if (reason === null && web?.kind === 'caddy') reason = 'one Caddy must hold both port 80 and port 443';
  else if (reason === null && web?.kind === 'nginx') reason = 'nginx could not be set up automatically';
  let network: string | null = null;
  if (h80.kind === 'container' && h80.container.networkMode !== 'host') {
    const found = containerNetwork(h80.container, probe.containers);
    if (found.clash) return { mode: 'blocked', reason: NAME_CLASH_REASON };
    network = found.network;
  }
  return { mode: 'proxy', relayPort: freePort, server: serverKind(h80, web), holder: describeHolder(h80), reason, network, kept: false };
}

/** Address an install answers on, from its `.env` (the file came from the server, so every value is checked again). */
export function addressFromEnv(env: Record<string, string>): { address: string; proxyPort: number | null } | null {
  const domain = env.RELAY_DOMAIN ?? '';
  const httpsPort = Number(env.RELAY_HTTPS_PORT ?? '443');
  const proxyPort = Number(env.RELAY_PROXY_PORT ?? '8787');
  if (!isValidDomain(domain) || !Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535) return null;
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) return null;
  if (env.RELAY_MODE === 'proxy') return { address: domain, proxyPort };
  return { address: httpsPort === 443 ? domain : `${domain}:${httpsPort}`, proxyPort: null };
}

export const sslipName = (ip: string): string => `${ip.replace(/\./g, '-')}.sslip.io`;

/** The `host[:port]` for the Relay field and the QR. */
export function relayAddress(name: string, decision: Layout): string {
  if (decision.mode === 'nginx-acme') return `${name}:${NGINX_ACME_PORT}`;
  return decision.mode === 'caddy' && decision.httpsPort !== 443 ? `${name}:${decision.httpsPort}` : name;
}

export interface PlanContext {
  intent: SetupIntent;
  probe: ProbeResult;
  decision: Layout;
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
  /** What changes on the person's web server (spec 8.3). */
  web: RelayPlanWeb | null;
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

/** The step that fetches the images of the layout; the one place that builds it. Interruptible: see spec 7.2. */
function imageStep(images: string[]): PlanStep {
  const inspect = images.map((image) => `docker image inspect ${shQuote(image)} >/dev/null 2>&1`).join(' && ');
  return {
    id: 'image',
    title: images.length === 1 ? `Relay image ${images[0] ?? ''}` : `Images ${images.join(', ')}`,
    check: inspect,
    checkShow: images.map((image) => `docker image inspect ${image}`).join(' && '),
    interruptible: true,
    commands: images.map((image) => ({ run: pullCommand(image, shQuote), show: `docker pull ${image}` })),
  };
}

/** One edit of the person's web server (spec 5.1, 5.2): what is written and the commands around it. */
interface SiteEdit {
  action: EditAction;
  target: string;
  content: string;
  beforeSha: string | null;
  afterSha: string | null;
  kind: 'file' | 'block';
  /** `Caddy` or `nginx`, and where it runs. */
  server: string;
  serverName: 'Caddy' | 'nginx';
  check: string | null;
  reload: string;
  /** Docker: the container the check and the reload go to. */
  containerId: string | null;
  /** «Already done» for the step. */
  stepCheck: string;
  note: string;
}

function caddyEdit(layout: Extract<Layout, { mode: 'caddy-site' }>, name: string): SiteEdit | null {
  const { web } = layout;
  if (web.caddyfile === null || web.config === null) return null;
  const upstream = layout.runtime === 'docker' ? 'parley-relay:8787' : `127.0.0.1:${layout.relayPort}`;
  const caddy: CaddyTarget = {
    runtime: layout.runtime,
    containerId: web.container?.id ?? null,
    containerFile: layout.runtime === 'docker' ? web.config.container : null,
    admin: web.admin ?? '127.0.0.1:2019',
  };
  const commands = caddyCommands(caddy);
  const edit = (action: EditAction, target: string, content: string, beforeSha: string | null, existing: string | null, kind: 'file' | 'block'): SiteEdit => {
    const afterSha = afterShaOf(action, content, existing);
    return {
      action,
      target,
      content,
      beforeSha,
      afterSha,
      kind,
      server: caddy.runtime === 'docker' ? 'Caddy (Docker)' : 'Caddy (systemd)',
      serverName: 'Caddy',
      check: commands.check,
      reload: commands.reload,
      containerId: caddy.runtime === 'docker' ? caddy.containerId : null,
      stepCheck: webStepCheck(target, afterSha ?? '', caddy, name),
      note: 'none: Caddy checks the whole configuration while loading it and keeps the old one if it is bad',
    };
  };
  if (web.ours?.kind === 'file') return edit('replace', web.ours.hostPath, caddySiteFile(name, upstream), web.ours.sha256, null, 'file');
  const text = web.caddyfile.text;
  if (web.ours?.kind === 'block') {
    // Replaced where it stands: lines of the person after our block keep their place, and an unchanged block is no change.
    const updated = replaceCaddyBlock(text, name, upstream);
    if (updated === null) return null;
    return edit('replace', web.config.host, updated, web.caddyfile.sha256, null, 'block');
  }
  if (web.include !== null) return edit('add', `${web.include.hostDir}/parley-relay${web.include.suffix}`, caddySiteFile(name, upstream), null, null, 'file');
  return edit('append', web.config.host, caddyBlockAppend(text, name, upstream), web.caddyfile.sha256, text, 'block');
}

/** The nginx server block for our name (spec 4.1): one file in the directory nginx already includes. */
function nginxEdit(layout: Extract<Layout, { mode: 'nginx-acme' }>, name: string): SiteEdit | null {
  const { web } = layout;
  if (web.include === null) return null;
  const target = web.ours?.kind === 'file' ? web.ours.hostPath : `${web.include.hostDir}/parley-relay.conf`;
  const content = nginxSiteFile(name, layout.runtime, layout.acmePort, NGINX_ACME_PORT, web.ipv6);
  const afterSha = afterShaOf('replace', content, null);
  const nginx: NginxTarget = { runtime: layout.runtime, containerId: web.container?.id ?? null, name, file: `${web.include.containerDir}/parley-relay.conf` };
  const commands = nginxCommands(nginx);
  return {
    action: web.ours?.kind === 'file' ? 'replace' : 'add',
    target,
    content,
    beforeSha: web.ours?.kind === 'file' ? web.ours.sha256 : null,
    afterSha,
    kind: 'file',
    server: layout.runtime === 'docker' ? 'nginx (Docker)' : 'nginx (systemd)',
    serverName: 'nginx',
    check: commands.check,
    reload: commands.reload,
    containerId: layout.runtime === 'docker' ? nginx.containerId : null,
    stepCheck: nginxStepCheck(target, afterSha ?? '', nginx),
    note: 'nginx -t must pass without «conflicting server name» for our name, and nginx -T must list our file; nginx -s reload does not report its own failure',
  };
}

function webStep(edit: SiteEdit, id = 'web'): { step: PlanStep; card: NonNullable<RelayPlanWeb['edits'][number]> } {
  const script = buildEditScript({
    action: edit.action,
    target: edit.target,
    beforeSha: edit.beforeSha,
    content: edit.content,
    afterSha: edit.afterSha,
    check: edit.check,
    reload: edit.reload,
    containerId: edit.containerId,
  });
  const verb = { add: 'Add', replace: 'Replace', append: 'Append a block to', remove: 'Remove', 'remove-block': 'Remove our block from' }[edit.action];
  const backup = edit.beforeSha === null ? 'none (the file is new)' : `${BACKUP_DIR}/<time>-${edit.target.split('/').pop() ?? ''}`;
  const checkText = edit.check ?? edit.note;
  return {
    step: {
      id,
      title: `${verb} ${edit.target} (your ${edit.serverName})`,
      check: edit.stepCheck,
      checkShow: edit.stepCheck,
      commands: [
        {
          run: editCommand(script),
          show: `${verb.toLowerCase()} ${edit.target}\n    backup: ${backup}\n    check: ${checkText}\n    reload: ${edit.reload}\n    if a step fails, the file is restored`,
        },
      ],
    },
    card: {
      server: edit.server,
      file: edit.target,
      action: edit.action,
      content: edit.action === 'remove' || edit.action === 'remove-block' ? null : edit.content,
      backup,
      check: checkText,
      reload: edit.reload,
    },
  };
}

/** Our change in the person's web server that is there now: found by the probe of the holder of port 80, else the one `.env` names. */
interface PriorEdit {
  file: string;
  kind: 'file' | 'block';
  server: 'Caddy' | 'nginx';
  sha256: string;
  /** Found on the server that holds port 80 now (so it can be undone through that server). */
  live: boolean;
}

function priorEdit(probe: ProbeResult): PriorEdit | null {
  const { web } = probe;
  if (web?.ours?.kind === 'file') return { file: web.ours.hostPath, kind: 'file', server: web.kind === 'nginx' ? 'nginx' : 'Caddy', sha256: web.ours.sha256, live: true };
  if (web?.ours?.kind === 'block' && web.config !== null && web.caddyfile !== null) {
    return { file: web.config.host, kind: 'block', server: 'Caddy', sha256: web.caddyfile.sha256, live: true };
  }
  if (probe.installEdit !== null) {
    return { ...probe.installEdit, server: probe.install?.RELAY_MODE === 'nginx-acme' ? 'nginx' : 'Caddy', live: false };
  }
  return null;
}

/** What is seen on port 80 now, for the texts that say «the server now looks different». */
function seenOn80(probe: ProbeResult): string {
  const holder = holderOf(probe, 80);
  return holder === null ? 'no program uses port 80' : `port 80 is used by ${describeHolder(holder)}`;
}

/** Undoes our change (spec 6.4, 5.2): the same transaction, with the removal of our file or of our block. */
function undoEdit(probe: ProbeResult, prior: PriorEdit): { edit: SiteEdit } | { blocked: string } {
  const differs = `Parley's site is in ${prior.file} of ${prior.server}, but the server now looks different (${seenOn80(probe)}). `;
  const { web } = probe;
  // Our site is recorded but the web server holds no port 80 right now (a restart, a deploy): nothing is wrong, it must run first.
  if (!prior.live && holderOf(probe, 80) === null) {
    return { blocked: `Parley's site is in ${prior.file} of ${prior.server}, but your web server is not running now (${seenOn80(probe)}). Start your web server and run the wizard again.` };
  }
  if (!prior.live || web === null || web.kind !== (prior.server === 'nginx' ? 'nginx' : 'caddy')) {
    return { blocked: `${differs}Remove that site from the server by hand, then remove the relay.` };
  }
  if (web.reasons.length > 0) return { blocked: `${differs}It cannot be changed now: ${web.reasons[0] ?? 'unsupported'}. Remove that site by hand, then remove the relay.` };
  if (web.kind === 'nginx') {
    if (web.include === null) return { blocked: `${differs}Remove that site by hand.` };
    const nginx: NginxTarget = { runtime: web.runtime === 'docker' ? 'docker' : 'host', containerId: web.container?.id ?? null, name: '', file: `${web.include.containerDir}/parley-relay.conf` };
    const commands = nginxCommands(nginx, true);
    return {
      edit: {
        action: 'remove',
        target: prior.file,
        content: '',
        beforeSha: prior.sha256,
        afterSha: null,
        kind: 'file',
        server: nginx.runtime === 'docker' ? 'nginx (Docker)' : 'nginx (systemd)',
        serverName: 'nginx',
        check: commands.check,
        reload: commands.reload,
        containerId: nginx.runtime === 'docker' ? nginx.containerId : null,
        stepCheck: `[ ! -e ${shQuote(prior.file)} ]`,
        note: 'nginx -t must pass and nginx -T must no longer list our file',
      },
    };
  }
  if (web.config === null || web.caddyfile === null) return { blocked: `${differs}Remove that site by hand.` };
  const caddy: CaddyTarget = {
    runtime: web.runtime === 'docker' ? 'docker' : 'host',
    containerId: web.container?.id ?? null,
    containerFile: web.runtime === 'docker' ? web.config.container : null,
    admin: web.admin ?? '127.0.0.1:2019',
  };
  const commands = caddyCommands(caddy);
  const common = {
    server: caddy.runtime === 'docker' ? 'Caddy (Docker)' : 'Caddy (systemd)',
    serverName: 'Caddy' as const,
    check: commands.check,
    reload: commands.reload,
    containerId: caddy.runtime === 'docker' ? caddy.containerId : null,
    note: 'none: Caddy checks the whole configuration while loading it and keeps the old one if it is bad',
  };
  if (prior.kind === 'file') {
    return { edit: { ...common, action: 'remove', target: prior.file, content: '', beforeSha: prior.sha256, afterSha: null, kind: 'file', stepCheck: `[ ! -e ${shQuote(prior.file)} ]` } };
  }
  const without = removeCaddyBlock(web.caddyfile.text);
  if (without === null) return { blocked: `${differs}Remove that block by hand.` };
  return {
    edit: {
      ...common,
      action: 'remove-block',
      target: web.config.host,
      content: without,
      beforeSha: web.caddyfile.sha256,
      afterSha: afterShaOf('remove-block', without, null),
      kind: 'block',
      stepCheck: `! grep -qE '^# BEGIN parley-relay' ${shQuote(web.config.host)}`,
    },
  };
}

/** “Roll back” only inside one layout (spec 6.3). */
function rollbackBlock(probe: ProbeResult): string | null {
  const now = probe.install ?? {};
  const before = probe.previous ?? {};
  const keys = ['RELAY_MODE', 'RELAY_DOMAIN', 'RELAY_WEB_FILE', 'RELAY_NETWORK', 'RELAY_PROXY_PORT', 'RELAY_ACME_PORT'];
  const differs = 'The previous version used a different layout; install again instead';
  if (keys.some((key) => (now[key] ?? (key === 'RELAY_MODE' ? 'caddy' : '')) !== (before[key] ?? (key === 'RELAY_MODE' ? 'caddy' : '')))) return differs;
  // The `.env` must also match what the server shows now.
  const prior = priorEdit(probe);
  const withEdit = now.RELAY_MODE === 'caddy-site' || now.RELAY_MODE === 'nginx-acme';
  if (withEdit ? prior === null || prior.file !== now.RELAY_WEB_FILE : prior !== null) return differs;
  return null;
}

function installSteps(ctx: PlanContext, env: EnvValues, web: PlanStep | null): PlanStep[] {
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
  // `caddy` and `nginx-acme` run their own Caddy and so own a Caddyfile; the other layouts must have none.
  const ownCaddyfile = env.mode === 'caddy' || env.mode === 'nginx-acme';
  const sums = files.map((f) => `${sha256(f.content)}  ${f.name}`);
  const check = `cd ${D} && printf '%s\\n' ${sums.map(shQuote).join(' ')} | sha256sum -c --status -${ownCaddyfile ? '' : ' && [ ! -e Caddyfile ]'}`;
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
      ...(ownCaddyfile ? [] : [plain(`rm -f ${D}/Caddyfile`)]),
    ],
  });
  // The images the layout's compose file runs: `caddy` and `nginx-acme` bring their own Caddy.
  steps.push(imageStep(env.mode === 'nginx-acme' || env.mode === 'caddy' ? [ctx.image, CADDY_IMAGE] : [ctx.image]));
  if (ctx.probe.ufwActive && ctx.decision.mode === 'caddy') {
    steps.push(ufwRules(ctx.decision.httpsPort === 443 ? [80, 443] : [80, ctx.decision.httpsPort]));
  }
  if (ctx.probe.ufwActive && ctx.decision.mode === 'nginx-acme') steps.push(ufwRules([NGINX_ACME_PORT]));
  // `nginx-acme`: nginx must already forward our port 80 when our Caddy starts and asks for the certificate.
  if (env.mode === 'nginx-acme' && web !== null) steps.push(web);
  // The compose service is `relay` (own Caddy, loopback) or `parley-relay` (joins a network of the person's server).
  const service = env.network !== undefined ? 'parley-relay' : 'relay';
  const running = (name: string): string => `${COMPOSE} ps --status running --services | grep -qx ${name}`;
  const up = env.mode === 'nginx-acme' ? `${running('parley-relay')} && ${running('parley-relay-acme')}` : running(service);
  steps.push({
    id: 'start',
    title:
      env.mode === 'caddy'
        ? 'Start the relay and Caddy'
        : env.mode === 'nginx-acme'
          ? 'Start the relay and its Caddy'
        : env.network !== undefined
            ? `Start the relay in the Docker network ${env.network}`
            : 'Start the relay on 127.0.0.1',
    check: up,
    checkShow: up,
    rerunOnChange: true,
    commands: [plain(`${COMPOSE} up -d --remove-orphans --quiet-pull`)],
  });
  // `caddy-site`: the person's Caddy gets the certificate and proxies once the relay already answers.
  if (env.mode !== 'nginx-acme' && web !== null) steps.push(web);
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
      commands: [plain(`${COMPOSE} up -d --remove-orphans --quiet-pull`)],
    },
  ];
}

function removeSteps(ctx: PlanContext, undo: PlanStep | null): PlanStep[] {
  // `--remove-orphans`: a container of an earlier layout (compose no longer knows its service) would keep its volume in use and fail `down -v`.
  const down = ctx.removeData === true ? `${COMPOSE} down -v --remove-orphans` : `${COMPOSE} down --remove-orphans`;
  const rules = `if [ -f ${D}/ufw-rules ]; then grep -E '^[0-9]{1,5}/tcp$' ${D}/ufw-rules | while read -r rule; do ufw delete allow "$rule"; done; fi`;
  // Volumes left over from an earlier layout (compose no longer knows them) go with the data, found by the project label.
  const leftovers = 'docker volume ls -q --filter label=com.docker.compose.project=parley-relay | xargs -r docker volume rm';
  return [
    // Our site goes first: when the check or the reload after its removal fails the file comes back and the run stops,
    // so the person's server never points at a relay that is gone.
    ...(undo === null ? [] : [undo]),
    {
      id: 'down',
      title: ctx.removeData === true ? 'Stop the relay and delete its data (routes, device trust, certificates)' : 'Stop the relay (its data is kept)',
      check: `test ! -d ${D}`,
      checkShow: `test ! -d ${D}`,
      commands: [plain(down), ...(ctx.removeData === true ? [plain(leftovers)] : [])],
    },
    { id: 'ufw', title: 'Remove the firewall rules this wizard added', check: `test ! -d ${D}`, checkShow: `test ! -d ${D}`, commands: [plain(rules)] },
    { id: 'files', title: `Delete ${D}`, check: `test ! -d ${D}`, checkShow: `test ! -d ${D}`, commands: [plain(`rm -rf ${D}`)] },
  ];
}

export function buildPlan(ctx: PlanContext): Plan {
  const { probe, decision } = ctx;
  const empty = (blocked: string): Plan => ({ intent: ctx.intent, steps: [], notes: [], blocked, mode: null, address: null, proxy: null, web: null });
  if (!probe.os.supported) return empty(`Unsupported system: ${probe.os.pretty}. Follow the manual instructions instead.`);
  if (probe.arch === null) return empty('Unsupported processor architecture (amd64 and arm64 only)');
  if (probe.activeCommand !== null) {
    return empty(`A command of the previous run is still running on the server: ${probe.activeCommand.id}. Wait a minute and run the wizard again.`);
  }
  if (ctx.intent === 'rollback') {
    if (probe.install === null || probe.previous === null) return empty('There is no previous version to roll back to');
    const different = rollbackBlock(probe);
    if (different !== null) return empty(different);
    return { intent: 'rollback', steps: rollbackSteps(), notes: tailNotes(probe), blocked: null, mode: null, address: null, proxy: null, web: null };
  }
  if (ctx.intent === 'remove') {
    const prior = priorEdit(probe);
    if (probe.install === null && prior === null) return empty('No relay installed by this wizard was found');
    let undo: ReturnType<typeof webStep> | null = null;
    if (prior !== null) {
      const undone = undoEdit(probe, prior);
      if ('blocked' in undone) return empty(undone.blocked);
      undo = webStep(undone.edit, 'web-undo');
    }
    return {
      intent: 'remove',
      steps: removeSteps(ctx, undo?.step ?? null),
      notes: [
        'Docker and its packages stay installed.',
        ctx.removeData === true ? 'The relay data will be deleted.' : 'The relay data stays in Docker volumes.',
        ...(prior !== null ? [`Parley removes only its own ${prior.kind === 'block' ? 'block' : 'file'} from your ${prior.server} (${prior.file}); a backup stays in ${BACKUP_DIR}/. If the check or the reload fails, the file is restored and nothing else is removed.`] : []),
        ...tailNotes(probe),
      ],
      blocked: null,
      mode: null,
      address: null,
      proxy: null,
      web: undo === null || prior === null ? null : { summary: `Parley removes its site from your ${prior.server}.`, network: null, edits: [undo.card] },
    };
  }
  if (probe.docker && !probe.compose) {
    return empty('Docker is installed without the Compose plugin. Install docker-compose-plugin and run the wizard again.');
  }
  if (decision.mode === 'blocked') return empty(decision.reason);
  const edit = decision.mode === 'caddy-site' ? caddyEdit(decision, ctx.name) : decision.mode === 'nginx-acme' ? nginxEdit(decision, ctx.name) : null;
  // Our site in the person's server is never moved by the wizard (spec 6.2): the person removes the relay first.
  const prior = priorEdit(probe);
  if (prior !== null && (edit === null || edit.target !== prior.file)) {
    return empty(`Parley's site is in ${prior.file} of ${prior.server}, but the server now looks different (${seenOn80(probe)}). Remove the relay first, then install again.`);
  }
  if ((decision.mode === 'caddy-site' || decision.mode === 'nginx-acme') && edit === null) return empty('The web server configuration could not be prepared for the change');
  const network = decision.mode === 'caddy-site' || decision.mode === 'nginx-acme' || decision.mode === 'proxy' ? decision.network : null;
  const env: EnvValues = {
    mode: decision.mode,
    domain: ctx.name,
    image: ctx.image,
    httpPort: 80,
    httpsPort: decision.mode === 'caddy' ? decision.httpsPort : decision.mode === 'nginx-acme' ? NGINX_ACME_PORT : 443,
    proxyPort: decision.mode === 'caddy' || decision.mode === 'nginx-acme' ? 8787 : decision.relayPort,
    ...((decision.mode === 'caddy-site' || decision.mode === 'nginx-acme') && edit !== null ? { webRuntime: decision.runtime, webFile: edit.target, webEdit: edit.kind } : {}),
    ...(decision.mode === 'nginx-acme' && decision.acmePort !== null ? { acmePort: decision.acmePort } : {}),
    ...(network !== null ? { network } : {}),
  };
  const notes = [
    decision.mode === 'caddy-site' || decision.mode === 'nginx-acme'
      ? 'Parley changes your web server as shown below and nothing else of it. The rest of the server is touched only in /opt/parley-relay, the firewall rules of this wizard and the Docker packages.'
      : 'Only /opt/parley-relay, firewall rules of this wizard and the Docker packages are touched on the server.',
    'If your hosting provider has a firewall in front of the server, open the ports there yourself; the wizard cannot see it.',
    ...tailNotes(probe),
  ];
  const address = relayAddress(ctx.name, decision);
  const before = probe.install === null ? null : (addressFromEnv(probe.install)?.address ?? null);
  const wasProxy = probe.install?.RELAY_MODE === 'proxy';
  const wasPort = Number(probe.install?.RELAY_PROXY_PORT ?? '8787');
  // The snippet keeps working only while the relay stays on the loopback port it had.
  const loopback = decision.mode === 'proxy' ? network === null : decision.mode === 'caddy-site' && decision.runtime === 'host';
  const newPort = decision.mode === 'proxy' || decision.mode === 'caddy-site' ? decision.relayPort : null;
  if (wasProxy && Number.isInteger(wasPort) && !(loopback && newPort === wasPort)) {
    notes.push(`Your web server's manual snippet for the relay (127.0.0.1:${wasPort}) stops working after this run.`);
  }
  if (decision.mode === 'proxy' && decision.kept) notes.push(`Your web server already serves the relay at ${address}; Parley keeps this layout.`);
  else if (before !== null && before !== address) notes.push(`The relay address changes from ${before} to ${address}; pair your phone again.`);
  let proxy: Plan['proxy'] = null;
  let web: Plan['web'] = null;
  let webStepDef: PlanStep | null = null;
  if ((decision.mode === 'caddy-site' || decision.mode === 'nginx-acme') && edit !== null) {
    const built = webStep(edit);
    webStepDef = built.step;
    web = {
      summary:
        decision.mode === 'caddy-site'
          ? `${describeHolder(decision.web.holder)} holds ports 80 and 443. Parley adds the relay site to its Caddy.`
          : `${describeHolder(decision.web.holder)} holds port 80. Parley adds one server block to its nginx that forwards port 80 of ${ctx.name} to the relay's own Caddy.`,
      network,
      edits: [built.card],
    };
    notes.push(
      `Parley adds one ${decision.mode === 'caddy-site' ? 'site to your Caddy' : 'server block to your nginx'} (${edit.target}). A backup is kept in ${BACKUP_DIR}/. If the check or the reload fails, the file is restored and your server keeps its current configuration. The reload applies your server's whole configuration as it is on disk now.`,
    );
    if (decision.mode === 'nginx-acme') {
      notes.push(`Port 443 stays yours: the relay answers on port ${NGINX_ACME_PORT}, and its Caddy gets the certificate through port 80 of nginx. Open port ${NGINX_ACME_PORT} at your hosting provider if it has a firewall.`);
    }
    if (network !== null) notes.push(`The relay containers join the Docker network ${network} of your ${edit.serverName}; they answer there as parley-relay${decision.mode === 'nginx-acme' ? ' and parley-relay-acme' : ''}.`);
  } else if (decision.mode === 'proxy') {
    const upstream = network !== null ? 'parley-relay:8787' : undefined;
    proxy = proxySnippet(decision.server, decision.relayPort, upstream);
    web = { summary: `Port 80 is used by ${decision.holder}${decision.reason !== null ? ` (${decision.reason})` : ''}. Parley does not change it.`, network, edits: [] };
    notes.push(
      network !== null
        ? `Port 80 is used by ${decision.holder}, so Parley does not change it${decision.reason !== null ? `: ${decision.reason}` : ''}. The relay joins its Docker network ${network} and answers there as parley-relay:8787; add the snippet to your web server yourself.`
        : `Port 80 is used by ${decision.holder}, so Parley does not install Caddy${decision.reason !== null ? ` (${decision.reason})` : ''}. The relay listens on 127.0.0.1:${decision.relayPort}; add the snippet to your web server yourself.`,
    );
  } else if (decision.mode === 'caddy' && decision.httpsPort !== 443) {
    notes.push(`Port 443 is taken, so the relay will be reachable on port ${decision.httpsPort}.`);
  }
  return {
    intent: 'install',
    steps: installSteps(ctx, env, webStepDef),
    notes,
    blocked: null,
    mode: decision.mode,
    address,
    proxy,
    web,
  };
}

/**
 * The end of the log of a dead command of the previous run (spec 7.3). The log of an image download holds the raw lines
 * of the Docker Engine API; they go through the same summary as in a live run (layers and bytes), never as JSON.
 */
function tailNotes(probe: ProbeResult): string[] {
  if (probe.previousTail === null) return [];
  const raw = probe.previousTail.text.split('\n');
  let lines = raw.map((l) => l.trim().slice(0, 200)).filter((l) => l !== '');
  if (probe.previousTail.id.startsWith('image')) {
    const kept: string[] = [];
    let last: RelayPullProgress | null = null;
    const summary = createPullProgress({ onProgress: (p) => (last = p), onLog: (l) => kept.push(l.trim().slice(0, 200)), now: () => 0 });
    for (const line of raw) summary.feed(line);
    summary.finish();
    lines = kept.filter((l) => l !== '' && !l.startsWith('downloading:'));
    if (last !== null) lines.push(`downloading: ${describePullProgress(last)}`);
  }
  return [`The previous run stopped in the command «${probe.previousTail.id}»; the end of its log: ${lines.slice(-10).join(' | ')}`];
}

/** Is the host an IPv4 address (for the sslip name)? */
export const isIPv4 = (host: string): boolean => net.isIPv4(host);
