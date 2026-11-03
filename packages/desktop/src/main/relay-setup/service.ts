import net from 'node:net';
import { RELAY_MANUAL_URL, type RelayPlanView, type RelayRunView, type RelaySetupCallName, type RelaySetupCalls, type RelaySetupEvent, type RelaySetupEventBody, type RelaySetupPhase } from '../../shared/relay-setup-types.js';
import { ControlCallError } from '../remote-control.js';
import { addressesOf, checkHealth, domainPointsTo, firstIPv4, isPublicIPv4, type HealthFetcher, type Resolver } from './health.js';
import { isValidDomain, validateInput, type SetupInput } from './input.js';
import type { KnownHosts, HostKeyInfo } from './known-hosts.js';
import { probeActive, probeInstalledEdit, probeProxyOnServer, probeWeb } from './web.js';
import { addressFromEnv, buildPlan, decideLayout, sslipName, type Plan } from './plan.js';
import { probeBase, probeFull, type ProbeBase, type ProbeResult } from './probe.js';
import { redactSecrets, type RunLog } from './log.js';
import type { ConnectFn, SshConnection, SudoMode } from './ssh.js';
import { createShell, listPrivateKeys } from './ssh.js';
import type { RemoteShell } from './shell.js';
import { createCancelHandle, requestCancel, runPlan, type CancelHandle } from './steps.js';
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
  /** Events of the run record, numbered (`seq`) by the service. */
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

/** Spec 7.3: the commands run apart from the SSH channel, so the server goes on without the Mac. */
const LOST_MESSAGE = 'The connection to the server was lost. Commands keep running on the server and finish on their own; run the wizard again in a minute.';
/** Spec 7.2. */
const CANCELLED_MESSAGE = 'Cancelled. Run the setup again to finish: finished steps are skipped.';
const CANCELLED_DOWNLOAD_MESSAGE = 'Cancelled. A download may finish on the server by itself; running the setup again picks it up.';
const CANCELLED_HEALTH_MESSAGE = 'Cancelled. Use Check to test the relay again.';

/** Spec 8.1: lines kept per step in the run record (the log file keeps all of them). */
const RECORD_LINES = 200;

/** The run record changes by events only, so that a reader holding a snapshot at `seq` can replay the later ones. */
function applyEvent(view: RelayRunView, body: RelaySetupEventBody): void {
  switch (body.event) {
    case 'step': {
      const row = view.steps.find((step) => step.id === body.id);
      if (row !== undefined) row.status = body.status;
      // The download bar belongs to its step: it goes with it.
      if (body.status !== 'running' && view.progress?.step === body.id) view.progress = null;
      return;
    }
    case 'line': {
      const row = view.steps.find((step) => step.id === body.step);
      if (row === undefined) return;
      row.lines.push(body.text);
      if (row.lines.length > RECORD_LINES) row.lines.splice(0, row.lines.length - RECORD_LINES);
      return;
    }
    case 'progress':
      view.progress = { ...body.progress, step: body.step };
      return;
    case 'cancelling':
      view.cancelling = true;
      return;
    case 'phase':
      view.phase = body.phase;
      view.cancelling = false;
  }
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
    web: plan.web,
  };
}

export function createRelaySetup(deps: RelaySetupDeps): RelaySetupService {
  let session: Session | null = null;
  let idle: NodeJS.Timeout | null = null;
  /** Where «Check» goes after a run: the address to test and whether the bridge has been told yet. */
  let pendingAddress: string | null = null;
  /** The cancel channel of the run in progress; `null` outside a run. */
  let runCancel: CancelHandle | null = null;
  /** The run record (spec 8.1): from Run to the outcome and after it, until `dismiss` or a new `begin`. In memory only. */
  let record: { view: RelayRunView } | null = null;
  /** Numbers the events of all records in turn, so a window that keeps its last `seq` across «New setup» loses nothing. */
  let seqCounter = 0;
  /** The health wait in progress (the session is already gone by then): a cancel stops it. */
  let healthWait: { cancelled: boolean; wake: () => void } | null = null;
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
    // The last log line of the run has been masked by now; the secrets are not kept for the next one.
    lastSecrets = [];
    runCancel = null;
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
    const masked = mask(message);
    end();
    return { phase: 'failed', step, message: masked };
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
        delete s.input.secrets.passphrase;
        s.waiting = 'passphrase';
        return { phase: 'need-passphrase', wrong: outcome.wrong };
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

  async function answers(address: string): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), 5000);
      });
      return (await Promise.race([deps.health(`https://${address}/v1/health`), timeout])).status === 200;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function finishProbe(s: Session, base: ProbeBase): Promise<RelaySetupPhase> {
    const shell = shellOf(s);
    const probe = await probeFull(base, shell);
    probe.web = await probeWeb(probe, shell);
    probe.installEdit = await probeInstalledEdit(probe.install, shell);
    // A working `proxy` install keeps its layout (spec 6.2): one attempt from this machine, five seconds.
    const env = probe.install;
    if (s.input.intent === 'install' && env?.RELAY_MODE === 'proxy' && isValidDomain(env.RELAY_DOMAIN ?? '')) {
      // Either answer keeps the layout: this machine's network (VPN, portal, DNS cache) can give a false refusal.
      const [mac, onServer] = await Promise.all([answers(env.RELAY_DOMAIN ?? ''), probeProxyOnServer(env.RELAY_DOMAIN ?? '', shell)]);
      probe.proxyHealthy = mac || onServer;
    }
    const previous = await probeActive(shell);
    probe.activeCommand = previous.active;
    probe.previousTail = previous.tail === null ? null : { id: previous.tail.id, text: mask(previous.tail.text) };
    s.probe = probe;
    return makePlan(s, false);
  }

  async function makePlan(s: Session, removeData: boolean): Promise<RelaySetupPhase> {
    const probe = s.probe;
    if (probe === null) return failed(null, 'No probe result');
    const decision = decideLayout(probe);
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
          if (v4 !== null && !isPublicIPv4(v4)) blocked = "This address is not reachable from the internet: enter the server's public address or your own domain.";
          else if (v4 === null) blocked = 'The server has no IPv4 address that can be used for a free host name. Enter your own domain.';
          else s.name = sslipName(v4);
        }
      }
    }

    const built = buildPlan({ intent: s.input.intent, probe, decision, name: s.name ?? 'unknown.invalid', image: deps.image.ref, removeData });
    const plan: Plan = blocked !== null ? { ...built, steps: [], blocked, address: null, proxy: null, web: null } : built;
    s.plan = plan;
    s.waiting = 'plan';
    touch();
    note(`plan ready: ${s.input.intent}, ${plan.steps.length} steps${plan.blocked !== null ? ', blocked' : ''}`);
    return { phase: 'plan', plan: view(plan), os: probe.os.pretty };
  }

  async function health(address: string): Promise<RelaySetupPhase> {
    let wake: () => void = () => undefined;
    const woken = new Promise<void>((resolve) => (wake = resolve));
    const wait = { cancelled: false, wake };
    healthWait = wait;
    const baseSleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let result;
    try {
      result = await checkHealth(address, {
        fetcher: deps.health,
        ...(deps.healthAttempts !== undefined ? { attempts: deps.healthAttempts } : {}),
        ...(deps.healthDelayMs !== undefined ? { delayMs: deps.healthDelayMs } : {}),
        // A cancel ends the pause between two attempts at once.
        sleep: (ms) => Promise.race([baseSleep(ms), woken]),
        cancelled: () => wait.cancelled,
      });
    } finally {
      healthWait = null;
    }
    if (!result.ok && result.cancelled === true) {
      pendingAddress = address;
      note('cancelled while waiting for the relay to answer');
      return { phase: 'cancelled', step: 'health', message: CANCELLED_HEALTH_MESSAGE };
    }
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

  /** Numbers the event, applies it to the record and sends it to the window. */
  function publish(rec: { view: RelayRunView }, body: RelaySetupEventBody): void {
    seqCounter += 1;
    rec.view.seq = seqCounter;
    applyEvent(rec.view, body);
    if (record === rec) deps.emit({ ...body, seq: rec.view.seq });
  }

  /** The synchronous part of «Run»: checks, the record, the start. The run itself goes on in the background. */
  function startRun(s: Session, removeData: boolean): RelaySetupPhase {
    if (s.plan === null || s.probe === null) return failed(null, 'No plan');
    if (s.plan.blocked !== null) throw bad('This plan cannot be run');
    if (s.input.intent === 'remove') {
      const rebuilt = buildPlan({ intent: 'remove', probe: s.probe, decision: decideLayout(s.probe), name: '', image: deps.image.ref, removeData });
      s.plan = rebuilt;
    }
    const plan = s.plan;
    const shell = shellOf(s);
    s.running = true;
    const cancel = createCancelHandle();
    runCancel = cancel;
    if (idle !== null) clearTimeout(idle);
    const rec = {
      view: {
        seq: seqCounter,
        intent: plan.intent,
        host: s.input.host,
        plan: view(plan),
        steps: plan.steps.map((step) => ({ id: step.id, title: step.title, status: 'pending' as const, lines: [] as string[] })),
        progress: null,
        cancelling: false,
        phase: { phase: 'running' } as RelaySetupPhase,
      } satisfies RelayRunView,
    };
    record = rec;
    execute(s, plan, shell, cancel, rec).then(
      (phase) => publish(rec, { event: 'phase', phase }),
      () => {
        // Whatever threw, the run is over: the connection goes and `begin` / `dismiss` work again.
        end();
        try {
          publish(rec, { event: 'phase', phase: { phase: 'failed', step: null, message: 'The setup run failed unexpectedly' } });
        } catch {
          // the window could not be told; the record has the outcome all the same
        }
      },
    );
    return { phase: 'running' };
  }

  async function execute(s: Session, plan: Plan, shell: RemoteShell, cancel: CancelHandle, rec: { view: RelayRunView }): Promise<RelaySetupPhase> {
    note(`run started: ${plan.intent} on ${s.input.host}`);
    const outcome = await runPlan(plan, shell, {
      step: (id, title, status) => {
        note(`step ${id}: ${status}`);
        publish(rec, { event: 'step', id, title, status });
      },
      line: (stepId, text) => {
        const clean = mask(text);
        void deps.log.write(clean).catch(() => {});
        publish(rec, { event: 'line', step: stepId, text: clean });
      },
      progress: (stepId, progress) => publish(rec, { event: 'progress', step: stepId, progress }),
      cancelling: () => {
        note('cancel requested: the run stops after the current step');
        publish(rec, { event: 'cancelling' });
      },
    }, cancel);
    const probe = s.probe;
    if (probe === null) return failed(null, 'No probe result');
    if (outcome.lost === true) return failed(outcome.failedStep, LOST_MESSAGE);
    if (outcome.stopped === true) {
      note(`cancelled at step ${outcome.failedStep ?? '-'}`);
      end();
      return { phase: 'cancelled', step: outcome.failedStep, message: outcome.interrupted === true ? CANCELLED_DOWNLOAD_MESSAGE : CANCELLED_MESSAGE };
    }
    end();
    if (!outcome.ok) return failed(outcome.failedStep, `The step «${outcome.failedStep}» failed. The server output is in the log above.`);
    if (plan.intent === 'remove') return { phase: 'removed', docker: 'kept' };
    // A cancel that arrived during the last step: it ran to the end, the wait for the relay is what is left to skip.
    const verify = (address: string): Promise<RelaySetupPhase> => {
      if (!cancel.requested) return health(address);
      pendingAddress = address;
      note('cancelled before the check of the relay');
      return Promise.resolve({ phase: 'cancelled', step: 'health', message: CANCELLED_HEALTH_MESSAGE });
    };
    if (plan.intent === 'rollback') {
      const restored = probe.previous === null ? null : addressFromEnv(probe.previous);
      if (restored === null) return failed(null, 'The restored configuration is not valid');
      if (restored.proxyPort !== null) {
        pendingAddress = restored.address;
        return { phase: 'proxy-pending', address: restored.address, ...proxySnippet('nginx', restored.proxyPort) };
      }
      return verify(restored.address);
    }
    if (plan.address === null) return failed(null, 'No address');
    if (plan.mode === 'proxy' && plan.proxy !== null) {
      pendingAddress = plan.address;
      return { phase: 'proxy-pending', address: plan.address, ...plan.proxy };
    }
    return verify(plan.address);
  }

  const handlers: { [N in RelaySetupCallName]: (params: RelaySetupCalls[N]['params']) => Promise<RelaySetupCalls[N]['result']> } = {
    async keys() {
      return { files: await (deps.listKeys ?? listPrivateKeys)(), agent: (deps.agentAvailable ?? ((): boolean => process.env.SSH_AUTH_SOCK !== undefined))() };
    },
    async begin(raw) {
      // Everything is validated before the first byte leaves this machine (acceptance 7).
      const checked = validateInput(raw);
      if (!checked.ok) throw new ControlCallError('bad_input', Object.values(checked.errors).join(' · '));
      if (session?.running === true || record?.view.phase.phase === 'running') throw bad('A setup run is in progress');
      end();
      // A new setup forgets the record of the previous run.
      record = null;
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
      return startRun(s, removeData === true);
    },
    async check() {
      if (pendingAddress === null) throw bad('Nothing to check');
      const rec = record;
      if (rec?.view.phase.phase === 'running') throw bad('A setup run is in progress');
      if (rec !== null) publish(rec, { event: 'phase', phase: { phase: 'running' } });
      let phase: RelaySetupPhase;
      try {
        phase = await health(pendingAddress);
      } catch {
        phase = { phase: 'failed', step: 'health', message: 'The check failed unexpectedly. Use Check again.' };
      }
      // The outcome of the check replaces the outcome of the run in the record, whatever happened.
      if (rec !== null) publish(rec, { event: 'phase', phase });
      return phase;
    },
    async state() {
      return record === null ? null : structuredClone(record.view);
    },
    async dismiss() {
      if (record?.view.phase.phase === 'running') throw bad('A setup run is in progress');
      record = null;
      return null;
    },
    async cancel() {
      if (session?.running === true && runCancel !== null) {
        // An interruptible step is ended through a second channel, the others finish first; the connection is
        // closed when the run ends.
        note('cancel requested during a run');
        await requestCancel(runCancel);
        return null;
      }
      if (healthWait !== null) {
        healthWait.cancelled = true;
        healthWait.wake();
        return null;
      }
      note('cancelled');
      end();
      return null;
    },
  };

  return {
    call(name, params) {
      return handlers[name](params as never) as Promise<RelaySetupCalls[typeof name]['result']>;
    },
    dispose() {
      end();
      record = null;
    },
  };
}
