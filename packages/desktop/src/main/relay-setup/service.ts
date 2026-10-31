import net from 'node:net';
import { RELAY_MANUAL_URL, type RelayPlanView, type RelaySetupCallName, type RelaySetupCalls, type RelaySetupEvent, type RelaySetupPhase } from '../../shared/relay-setup-types.js';
import { ControlCallError } from '../remote-control.js';
import { addressesOf, checkHealth, domainPointsTo, firstIPv4, type HealthFetcher, type Resolver } from './health.js';
import { isValidDomain, validateInput, type SetupInput } from './input.js';
import type { KnownHosts, HostKeyInfo } from './known-hosts.js';
import { buildPlan, decidePorts, sslipName, type Plan } from './plan.js';
import { probeBase, probeFull, type ProbeBase, type ProbeResult } from './probe.js';
import { redactSecrets, type RunLog } from './log.js';
import type { ConnectFn, SshConnection, SudoMode } from './ssh.js';
import { createShell, listPrivateKeys } from './ssh.js';
import type { RemoteShell } from './shell.js';
import { runPlan } from './steps.js';
import { proxySnippet } from './templates.js';

export interface RelaySetupDeps {
  knownHosts: KnownHosts;
  connect: ConnectFn;
  log: RunLog;
  /** Image reference to install; `published` false → installing is refused (see `image.ts`). */
  image: { ref: string; published: boolean };
  health: HealthFetcher;
  healthAttempts?: number;
  healthDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  resolver: Resolver;
  /** Sets the Relay field of the bridge (`configure`). */
  configureBridge: (address: string) => Promise<void>;
  emit: (event: RelaySetupEvent) => void;
  listKeys?: () => Promise<string[]>;
  agentAvailable?: () => boolean;
  /** The person walked away from a plan on screen: the connection (and the credentials) are dropped. */
  idleMs?: number;
}

export interface RelaySetupService {
  call<N extends RelaySetupCallName>(name: N, params: RelaySetupCalls[N]['params']): Promise<RelaySetupCalls[N]['result']>;
  dispose(): void;
}

type Waiting = 'hostkey' | 'passphrase' | 'sudo' | 'plan' | null;

interface Session {
  input: SetupInput;
  trusted: string | null;
  pendingKey: HostKeyInfo | null;
  connection: SshConnection | null;
  sudo: SudoMode | null;
  base: ProbeBase | null;
  probe: ProbeResult | null;
  plan: Plan | null;
  name: string | null;
  waiting: Waiting;
  running: boolean;
}

const bad = (message: string): ControlCallError => new ControlCallError('bad_request', message);

function view(plan: Plan): RelayPlanView {
  return {
    intent: plan.intent,
    steps: plan.steps.map((s) => ({ id: s.id, title: s.title, check: s.checkShow, commands: s.commands.map((c) => c.show) })),
    notes: plan.notes,
    blocked: plan.blocked,
    address: plan.address,
    proxy: plan.proxy,
  };
}

/** Address a restored (rolled-back) install answers on; the `.env` came from the server, so it is checked again. */
function addressFromEnv(env: Record<string, string>): { address: string; proxyPort: number | null } | null {
  const domain = env.RELAY_DOMAIN ?? '';
  const httpsPort = Number(env.RELAY_HTTPS_PORT ?? '443');
  const proxyPort = Number(env.RELAY_PROXY_PORT ?? '8787');
  if (!isValidDomain(domain) || !Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535) return null;
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) return null;
  if (env.RELAY_MODE === 'proxy') return { address: domain, proxyPort };
  return { address: httpsPort === 443 ? domain : `${domain}:${httpsPort}`, proxyPort: null };
}

export function createRelaySetup(deps: RelaySetupDeps): RelaySetupService {
  let session: Session | null = null;
  let idle: NodeJS.Timeout | null = null;
  /** Where «Check» goes after a run: the address to test and whether the bridge has been told yet. */
  let pendingAddress: string | null = null;
  const idleMs = deps.idleMs ?? 10 * 60_000;

  const secretList = (s: Session | null): string[] =>
    s === null ? [] : [s.input.secrets.password, s.input.secrets.passphrase, s.input.secrets.sudoPassword].filter((v): v is string => v !== undefined);
  // The log keeps masking the secrets of the run that wrote it, even after the session object is gone.
  let lastSecrets: string[] = [];
  const mask = (text: string): string => redactSecrets(text, lastSecrets);
  const note = (text: string): void => void deps.log.write(mask(text)).catch(() => {});

  function end(): void {
    if (idle !== null) clearTimeout(idle);
    idle = null;
    if (session !== null) {
      session.connection?.close();
      // Credentials live in main memory for one run: overwritten, then dropped.
      session.input.secrets = {};
      session.sudo = null;
    }
    session = null;
  }

  function touch(): void {
    if (idle !== null) clearTimeout(idle);
    idle = setTimeout(() => {
      note('idle timeout: connection closed');
      end();
    }, idleMs);
    idle.unref();
  }

  function current(waiting: Waiting): Session {
    if (session === null || session.waiting !== waiting || session.running) throw bad('This step is not expected now');
    return session;
  }

  const failed = (step: string | null, message: string): RelaySetupPhase => {
    note(`failed: ${message}`);
    end();
    return { phase: 'failed', step, message: mask(message) };
  };

  async function connect(s: Session): Promise<RelaySetupPhase> {
    const outcome = await deps.connect(
      { host: s.input.host, port: s.input.port, user: s.input.user, auth: s.input.auth, secrets: s.input.secrets, trusted: s.trusted },
      deps.knownHosts,
    );
    switch (outcome.kind) {
      case 'ok':
        s.connection = outcome.connection;
        return afterConnect(s);
      case 'hostkey-unknown':
        s.pendingKey = outcome.key;
        s.waiting = 'hostkey';
        return { phase: 'hostkey', host: s.input.host, port: s.input.port, keyType: outcome.key.type, fingerprint: outcome.key.fingerprint };
      case 'hostkey-changed': {
        note(`host key changed for ${s.input.host}:${s.input.port}: stopped before authentication`);
        end();
        return { phase: 'hostkey-changed', host: s.input.host, port: s.input.port, known: outcome.known, presented: outcome.key.fingerprint };
      }
      case 'passphrase-required':
        s.waiting = 'passphrase';
        return { phase: 'need-passphrase' };
      case 'auth-failed':
        note('authentication failed');
        end();
        return { phase: 'auth-failed' };
      case 'error':
        return failed(null, outcome.message);
    }
  }

  async function elevation(s: Session, base: ProbeBase): Promise<boolean> {
    if (base.root) {
      s.sudo = { kind: 'root' };
      return true;
    }
    if (base.sudoPasswordless) {
      s.sudo = { kind: 'nopasswd' };
      return true;
    }
    const password = s.input.secrets.sudoPassword;
    if (password === undefined || s.connection === null) return false;
    const trial: SudoMode = { kind: 'password', password };
    const result = await createShell(s.connection, trial).run('true', { sudo: true });
    if (result.code !== 0) {
      delete s.input.secrets.sudoPassword;
      return false;
    }
    s.sudo = trial;
    return true;
  }

  function shellOf(s: Session): RemoteShell {
    if (s.connection === null || s.sudo === null) throw bad('Not connected');
    return createShell(s.connection, s.sudo);
  }

  async function afterConnect(s: Session): Promise<RelaySetupPhase> {
    if (s.connection === null) return failed(null, 'Not connected');
    // Before elevation: only commands that need no privileges.
    const plain = createShell(s.connection, { kind: 'root' });
    const base = await probeBase(plain);
    s.base = base;
    if (!base.os.supported || base.arch === null) {
      note(`unsupported system: ${base.os.pretty} / ${base.arch ?? 'unknown arch'}; nothing was changed`);
      const os = base.os.pretty;
      end();
      return { phase: 'unsupported', os, manualUrl: RELAY_MANUAL_URL };
    }
    if (!(await elevation(s, base))) {
      s.waiting = 'sudo';
      return { phase: 'need-sudo' };
    }
    return finishProbe(s, base);
  }

  async function finishProbe(s: Session, base: ProbeBase): Promise<RelaySetupPhase> {
    const probe = await probeFull(base, shellOf(s));
    s.probe = probe;
    return makePlan(s, false);
  }

  async function makePlan(s: Session, removeData: boolean): Promise<RelaySetupPhase> {
    const probe = s.probe;
    if (probe === null) return failed(null, 'No probe result');
    const decision = decidePorts(probe);
    let blocked: string | null = null;

    if (s.input.intent === 'install') {
      if (!deps.image.published) blocked = 'This build of Parley does not include a published relay image yet. Install the relay by hand using the README.';
      const serverIps = net.isIP(s.input.host) !== 0 ? [s.input.host] : await addressesOf(s.input.host, deps.resolver);
      if (blocked === null) {
        if (s.input.domain !== null) {
          if (!(await domainPointsTo(s.input.domain, serverIps, deps.resolver))) {
            blocked = `${s.input.domain} has no A or AAAA record pointing to this server (${serverIps.join(', ') || 'unknown address'}). Fix the DNS record and try again.`;
          } else s.name = s.input.domain;
        } else {
          const v4 = firstIPv4(serverIps);
          if (v4 === null) blocked = 'The server has no IPv4 address that can be used for a free host name. Enter your own domain.';
          else s.name = sslipName(v4);
        }
      }
    }

    const built = buildPlan({ intent: s.input.intent, probe, decision, name: s.name ?? 'unknown.invalid', image: deps.image.ref, removeData });
    const plan: Plan = blocked !== null ? { ...built, steps: [], blocked, address: null, proxy: null } : built;
    s.plan = plan;
    s.waiting = 'plan';
    touch();
    note(`plan ready: ${s.input.intent}, ${plan.steps.length} steps${plan.blocked !== null ? ', blocked' : ''}`);
    return { phase: 'plan', plan: view(plan), os: probe.os.pretty };
  }

  async function health(address: string): Promise<RelaySetupPhase> {
    const result = await checkHealth(address, {
      fetcher: deps.health,
      ...(deps.healthAttempts !== undefined ? { attempts: deps.healthAttempts } : {}),
      ...(deps.healthDelayMs !== undefined ? { delayMs: deps.healthDelayMs } : {}),
      ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    });
    if (!result.ok) {
      pendingAddress = address;
      return { phase: 'failed', step: 'health', message: `The relay did not answer over HTTPS at ${address}: ${result.detail}. Check the DNS, the firewall and the log, then use Check again.` };
    }
    let configured = true;
    try {
      await deps.configureBridge(address);
    } catch {
      configured = false;
    }
    pendingAddress = null;
    note(`relay healthy at ${address}; bridge configured: ${configured}`);
    return { phase: 'done', address, configured };
  }

  async function execute(s: Session, removeData: boolean): Promise<RelaySetupPhase> {
    if (s.plan === null || s.probe === null) return failed(null, 'No plan');
    if (s.plan.blocked !== null) throw bad('This plan cannot be run');
    if (s.input.intent === 'remove') {
      const rebuilt = buildPlan({ intent: 'remove', probe: s.probe, decision: decidePorts(s.probe), name: '', image: deps.image.ref, removeData });
      s.plan = rebuilt;
    }
    const plan = s.plan;
    const shell = shellOf(s);
    s.running = true;
    if (idle !== null) clearTimeout(idle);
    note(`run started: ${plan.intent} on ${s.input.host}`);
    const outcome = await runPlan(plan, shell, {
      step: (id, title, status) => {
        note(`step ${id}: ${status}`);
        deps.emit({ event: 'step', id, title, status });
      },
      line: (stepId, text) => {
        const clean = mask(text);
        void deps.log.write(clean).catch(() => {});
        deps.emit({ event: 'line', step: stepId, text: clean });
      },
    });
    const probe = s.probe;
    end();
    if (!outcome.ok) return failed(outcome.failedStep, `The step «${outcome.failedStep}» failed. The server output is in the log above.`);
    if (plan.intent === 'remove') return { phase: 'removed', docker: 'kept' };
    if (plan.intent === 'rollback') {
      const restored = probe.previous === null ? null : addressFromEnv(probe.previous);
      if (restored === null) return failed(null, 'The restored configuration is not valid');
      if (restored.proxyPort !== null) {
        pendingAddress = restored.address;
        return { phase: 'proxy-pending', address: restored.address, ...proxySnippet('nginx', restored.proxyPort) };
      }
      return health(restored.address);
    }
    if (plan.address === null) return failed(null, 'No address');
    if (plan.mode === 'proxy' && plan.proxy !== null) {
      pendingAddress = plan.address;
      return { phase: 'proxy-pending', address: plan.address, ...plan.proxy };
    }
    return health(plan.address);
  }

  const handlers: { [N in RelaySetupCallName]: (params: RelaySetupCalls[N]['params']) => Promise<RelaySetupCalls[N]['result']> } = {
    async keys() {
      return { files: await (deps.listKeys ?? listPrivateKeys)(), agent: (deps.agentAvailable ?? ((): boolean => process.env.SSH_AUTH_SOCK !== undefined))() };
    },
    async begin(raw) {
      // Everything is validated before the first byte leaves this machine (acceptance 7).
      const checked = validateInput(raw);
      if (!checked.ok) throw new ControlCallError('bad_input', Object.values(checked.errors).join(' · '));
      end();
      const s: Session = { input: checked.value, trusted: null, pendingKey: null, connection: null, sudo: null, base: null, probe: null, plan: null, name: null, waiting: null, running: false };
      session = s;
      lastSecrets = secretList(s);
      note(`begin: ${s.input.intent} on ${s.input.host}:${s.input.port} as ${s.input.user} (${s.input.auth.kind})`);
      touch();
      return connect(s);
    },
    async trust() {
      const s = current('hostkey');
      if (s.pendingKey === null) throw bad('No host key to confirm');
      await deps.knownHosts.trust(s.input.host, s.input.port, s.pendingKey);
      note(`host key trusted: ${s.pendingKey.fingerprint}`);
      s.trusted = s.pendingKey.fingerprint;
      s.waiting = null;
      touch();
      return connect(s);
    },
    async provide(params) {
      const waiting = session?.waiting;
      if (waiting !== 'passphrase' && waiting !== 'sudo') throw bad('This step is not expected now');
      const s = current(waiting);
      const value = waiting === 'passphrase' ? params.passphrase : params.sudoPassword;
      if (typeof value !== 'string' || value === '' || value.length > 512 || /[\0\r\n]/.test(value)) throw new ControlCallError('bad_input', 'Enter a single line of up to 512 characters');
      if (waiting === 'passphrase') s.input.secrets.passphrase = value;
      else s.input.secrets.sudoPassword = value;
      lastSecrets = secretList(s);
      s.waiting = null;
      touch();
      if (waiting === 'passphrase') return connect(s);
      if (s.base === null) return failed(null, 'No probe result');
      if (!(await elevation(s, s.base))) {
        s.waiting = 'sudo';
        return { phase: 'need-sudo' };
      }
      return finishProbe(s, s.base);
    },
    async plan({ removeData }) {
      const s = current('plan');
      touch();
      return makePlan(s, removeData === true);
    },
    async run({ removeData }) {
      const s = current('plan');
      return execute(s, removeData === true);
    },
    async check() {
      if (pendingAddress === null) throw bad('Nothing to check');
      return health(pendingAddress);
    },
    async cancel() {
      note('cancelled');
      end();
      return null;
    },
  };

  return {
    call(name, params) {
      return handlers[name](params as never) as Promise<RelaySetupCalls[typeof name]['result']>;
    },
    dispose: end,
  };
}
