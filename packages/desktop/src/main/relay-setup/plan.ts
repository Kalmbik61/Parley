import net from 'node:net';
import { shQuote, type SetupIntent } from './input.js';
import type { RelayPlanWeb } from '../../shared/relay-setup-types.js';
import { INSTALL_DIR, holderOf, type PortHolder, type ProbeResult } from './probe.js';
import {
  caddyBlockAppend,
  caddySiteFile,
  managedFiles,
  proxySnippet,
  removeCaddyBlock,
  sha256,
  type EnvValues,
  type ProxyServer,
  type SetupMode,
} from './templates.js';
import { BACKUP_DIR, afterShaOf, buildEditScript, caddyCommands, editCommand, webStepCheck, type CaddyTarget, type EditAction } from './web-edit.js';
import { chooseNetwork, type WebSurvey } from './web.js';

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

/** The layouts of spec 4: 1, 1б → `caddy`; 2, 4а → `caddy-site`; 5 → `proxy`. (Rows 3 and 4б, nginx, are layout 5 for now.) */
export type Layout =
  | { mode: 'caddy'; httpPort: 80; httpsPort: 443 | 8443 }
  | { mode: 'caddy-site'; runtime: 'docker' | 'host'; web: WebSurvey; network: string | null; relayPort: number }
  | { mode: 'proxy'; relayPort: number; server: ProxyServer; holder: string; reason: string | null; network: string | null }
  | { mode: 'blocked'; reason: string };

const PROXY_PORT_CANDIDATES = [8787, 18787, 28787];

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
  if (h80 === null) {
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
  if (freePort === undefined) return { mode: 'blocked', reason: 'Port 80 is taken and no local port is free for the relay' };
  let reason: string | null = web?.reasons[0] ?? null;
  if (reason === null && web?.kind === 'caddy') reason = 'one Caddy must hold both port 80 and port 443';
  else if (reason === null && web?.kind === 'nginx') reason = 'setting up nginx automatically is not available yet';
  const network = h80.kind === 'container' && h80.container.networkMode !== 'host' ? chooseNetwork(h80.container, probe.containers) : null;
  return { mode: 'proxy', relayPort: freePort, server: serverKind(h80, web), holder: describeHolder(h80), reason, network };
}

export const sslipName = (ip: string): string => `${ip.replace(/\./g, '-')}.sslip.io`;

/** The `host[:port]` for the Relay field and the QR. */
export function relayAddress(name: string, decision: Layout): string {
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

/** The step that fetches the images of the layout; the one place that builds it. */
function imageStep(images: string[]): PlanStep {
  const inspect = images.map((image) => `docker image inspect ${shQuote(image)} >/dev/null 2>&1`).join(' && ');
  return {
    id: 'image',
    title: images.length === 1 ? `Relay image ${images[0] ?? ''}` : `Images ${images.join(', ')}`,
    check: inspect,
    checkShow: images.map((image) => `docker image inspect ${image}`).join(' && '),
    commands: images.map((image) => ({ run: `docker pull ${shQuote(image)}`, show: `docker pull ${image}` })),
  };
}

/** One edit of the person's Caddy (spec 5.1, 5.2) and the cards the screen shows for it. */
interface CaddyEdit {
  action: EditAction;
  target: string;
  content: string;
  beforeSha: string | null;
  afterSha: string | null;
  kind: 'file' | 'block';
  caddy: CaddyTarget;
}

function caddyEdit(layout: Extract<Layout, { mode: 'caddy-site' }>, name: string): CaddyEdit | null {
  const { web } = layout;
  if (web.caddyfile === null || web.config === null) return null;
  const upstream = layout.runtime === 'docker' ? 'parley-relay:8787' : `127.0.0.1:${layout.relayPort}`;
  const caddy: CaddyTarget = {
    runtime: layout.runtime,
    containerId: web.container?.id ?? null,
    containerFile: layout.runtime === 'docker' ? web.config.container : null,
    admin: web.admin ?? '127.0.0.1:2019',
  };
  const edit = (action: EditAction, target: string, content: string, beforeSha: string | null, existing: string | null, kind: 'file' | 'block'): CaddyEdit => ({
    action, target, content, beforeSha, afterSha: afterShaOf(action, content, existing), kind, caddy,
  });
  if (web.ours?.kind === 'file') return edit('replace', web.ours.hostPath, caddySiteFile(name, upstream), web.ours.sha256, null, 'file');
  const text = web.caddyfile.text;
  if (web.ours?.kind === 'block') {
    const without = removeCaddyBlock(text);
    if (without === null) return null;
    return edit('replace', web.config.host, without + caddyBlockAppend(without, name, upstream), web.caddyfile.sha256, null, 'block');
  }
  if (web.include !== null) return edit('add', `${web.include.hostDir}/parley-relay${web.include.suffix}`, caddySiteFile(name, upstream), null, null, 'file');
  return edit('append', web.config.host, caddyBlockAppend(text, name, upstream), web.caddyfile.sha256, text, 'block');
}

function webStep(edit: CaddyEdit, name: string): { step: PlanStep; card: NonNullable<RelayPlanWeb['edits'][number]> } {
  const commands = caddyCommands(edit.caddy);
  const script = buildEditScript({
    action: edit.action,
    target: edit.target,
    beforeSha: edit.beforeSha,
    content: edit.content,
    afterSha: edit.afterSha,
    check: commands.check,
    reload: commands.reload,
  });
  const check = webStepCheck(edit.target, edit.afterSha ?? '', edit.caddy, name);
  const verb = { add: 'Add', replace: 'Replace', append: 'Append a block to', remove: 'Remove', 'remove-block': 'Remove our block from' }[edit.action];
  const backup = edit.beforeSha === null ? 'none (the file is new)' : `${BACKUP_DIR}/<time>-${edit.target.split('/').pop() ?? ''}`;
  const checkText = commands.check ?? 'none: Caddy checks the whole configuration while loading it and keeps the old one if it is bad';
  return {
    step: {
      id: 'web',
      title: `${verb} ${edit.target} (your Caddy)`,
      check,
      checkShow: check,
      commands: [
        {
          run: editCommand(script),
          show: `${verb.toLowerCase()} ${edit.target}\n    backup: ${backup}\n    check: ${checkText}\n    reload: ${commands.reload}\n    if a step fails, the file is restored`,
        },
      ],
    },
    card: {
      server: edit.caddy.runtime === 'docker' ? 'Caddy (Docker)' : 'Caddy (systemd)',
      file: edit.target,
      action: edit.action,
      content: edit.content,
      backup,
      check: checkText,
      reload: commands.reload,
    },
  };
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
  const sums = files.map((f) => `${sha256(f.content)}  ${f.name}`);
  const check = `cd ${D} && printf '%s\\n' ${sums.map(shQuote).join(' ')} | sha256sum -c --status -${env.mode !== 'caddy' ? ' && [ ! -e Caddyfile ]' : ''}`;
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
      ...(env.mode !== 'caddy' ? [plain(`rm -f ${D}/Caddyfile`)] : []),
    ],
  });
  steps.push(imageStep([ctx.image]));
  if (ctx.probe.ufwActive && ctx.decision.mode === 'caddy') {
    steps.push(ufwRules(ctx.decision.httpsPort === 443 ? [80, 443] : [80, ctx.decision.httpsPort]));
  }
  // The compose service is `relay` (own Caddy, loopback) or `parley-relay` (joins a network of the person's server).
  const service = env.network !== undefined ? 'parley-relay' : 'relay';
  const up = `${COMPOSE} ps --status running --services | grep -qx ${service}`;
  steps.push({
    id: 'start',
    title:
      env.mode === 'caddy'
        ? 'Start the relay and Caddy'
        : env.network !== undefined
          ? `Start the relay in the Docker network ${env.network}`
          : 'Start the relay on 127.0.0.1',
    check: up,
    checkShow: up,
    rerunOnChange: true,
    commands: [plain(`${COMPOSE} up -d --remove-orphans --quiet-pull`)],
  });
  // `caddy-site`: the person's Caddy gets the certificate and proxies once the relay already answers.
  if (web !== null) steps.push(web);
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
  const empty = (blocked: string): Plan => ({ intent: ctx.intent, steps: [], notes: [], blocked, mode: null, address: null, proxy: null, web: null });
  if (!probe.os.supported) return empty(`Unsupported system: ${probe.os.pretty}. Follow the manual instructions instead.`);
  if (probe.arch === null) return empty('Unsupported processor architecture (amd64 and arm64 only)');
  if (probe.activeCommand !== null) {
    return empty(`A command of the previous run is still running on the server: ${probe.activeCommand.id}. Wait a minute and run the wizard again.`);
  }
  if (ctx.intent === 'rollback') {
    if (probe.install === null || probe.previous === null) return empty('There is no previous version to roll back to');
    return { intent: 'rollback', steps: rollbackSteps(), notes: tailNotes(probe), blocked: null, mode: null, address: null, proxy: null, web: null };
  }
  if (ctx.intent === 'remove') {
    if (probe.install === null) return empty('No relay installed by this wizard was found');
    return {
      intent: 'remove',
      steps: removeSteps(ctx),
      notes: ['Docker and its packages stay installed.', ctx.removeData === true ? 'The relay data will be deleted.' : 'The relay data stays in Docker volumes.', ...tailNotes(probe)],
      blocked: null,
      mode: null,
      address: null,
      proxy: null,
      web: null,
    };
  }
  if (probe.docker && !probe.compose) {
    return empty('Docker is installed without the Compose plugin. Install docker-compose-plugin and run the wizard again.');
  }
  if (decision.mode === 'blocked') return empty(decision.reason);
  const edit = decision.mode === 'caddy-site' ? caddyEdit(decision, ctx.name) : null;
  if (decision.mode === 'caddy-site' && edit === null) return empty('The Caddyfile could not be prepared for the change');
  const network = decision.mode === 'caddy-site' || decision.mode === 'proxy' ? decision.network : null;
  const env: EnvValues = {
    mode: decision.mode,
    domain: ctx.name,
    image: ctx.image,
    httpPort: 80,
    httpsPort: decision.mode === 'caddy' ? decision.httpsPort : 443,
    proxyPort: decision.mode === 'caddy' ? 8787 : decision.relayPort,
    ...(decision.mode === 'caddy-site' && edit !== null ? { webRuntime: decision.runtime, webFile: edit.target, webEdit: edit.kind } : {}),
    ...(network !== null ? { network } : {}),
  };
  const notes = [
    decision.mode === 'caddy-site'
      ? 'Parley changes your web server as shown below and nothing else of it. The rest of the server is touched only in /opt/parley-relay, the firewall rules of this wizard and the Docker packages.'
      : 'Only /opt/parley-relay, firewall rules of this wizard and the Docker packages are touched on the server.',
    'If your hosting provider has a firewall in front of the server, open the ports there yourself; the wizard cannot see it.',
    ...tailNotes(probe),
  ];
  let proxy: Plan['proxy'] = null;
  let web: Plan['web'] = null;
  let webStepDef: PlanStep | null = null;
  if (decision.mode === 'caddy-site' && edit !== null) {
    const built = webStep(edit, ctx.name);
    webStepDef = built.step;
    web = { summary: `${describeHolder(decision.web.holder)} holds ports 80 and 443. Parley adds the relay site to its Caddy.`, network, edits: [built.card] };
    notes.push(
      `Parley adds one site to your Caddy (${edit.target}). A backup is kept in ${BACKUP_DIR}/. If the check or the reload fails, the file is restored and your server keeps its current configuration. The reload applies your server's whole configuration as it is on disk now.`,
    );
    if (network !== null) notes.push(`The relay container joins the Docker network ${network} of your Caddy; it answers there as parley-relay.`);
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
    address: relayAddress(ctx.name, decision),
    proxy,
    web,
  };
}

/** The end of the log of a dead command of the previous run (spec 7.3). */
function tailNotes(probe: ProbeResult): string[] {
  if (probe.previousTail === null) return [];
  const lines = probe.previousTail.text.split('\n').map((l) => l.trim().slice(0, 200)).filter((l) => l !== '').slice(-10);
  return [`The previous run stopped in the command «${probe.previousTail.id}»; the end of its log: ${lines.join(' | ')}`];
}

/** Is the host an IPv4 address (for the sslip name)? */
export const isIPv4 = (host: string): boolean => net.isIPv4(host);
