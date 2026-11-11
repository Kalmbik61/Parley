// T9a harness, slice H2c-1: one arm of one goal, through real processes. The classic arm is the real `server.js` with its direct tools; the replacement
// arm is the same `server.js` launched by a decision file and a nonce, with a load-time preload that (a) proves the five reads in the registry and (b)
// gives the live backend a real broker over a fixture policy source, so `code_execute` really runs a script in the real sandboxed helper and its reads go
// to the real host (H2b). Faults that act on a running arm (abort, kill-helper, a mid-run policy change, limits, a second run) are H2c-2.
//
// The preload mints the fixture policy source, and a static guard keeps that mint out of every file that is not a `*.test.ts`: this module therefore
// only builds the preload text around an expression the TEST passes in (`mintExpression`).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Client as ClientClass } from '@modelcontextprotocol/sdk/client/index.js';
import type { StdioClientTransport as StdioClass } from '@modelcontextprotocol/sdk/client/stdio.js';
import { newLaunchNonce, writeLaunchDecision } from '../packages/core/src/mcp/code-mode/launch-decision.js';
import { resolveRunLimits } from '../packages/core/src/mcp/code-mode/limits.js';
import { inspectRunRecord, runRecordPath } from '../packages/core/src/mcp/code-mode/run-record.js';
import { readStoredMap, workPaths } from '../packages/core/src/work/store.js';
import { type BuiltData, restoreForArm, withHome } from './parley-token-benchmark-replay-data.js';
import { startReplayHost } from './parley-token-benchmark-replay-host.js';
import { type Arm, type ArmObservation, type ExecuteLike, type ExecuteWire, type RecordState, type ToolDescriptor, valueAt } from './parley-token-benchmark-replay-judge.js';
import type { Goal, Json, Obj } from './parley-token-benchmark-replay-schema.js';

// ---------- the scripts: what a goal asks each arm to do ----------

/** Where one answer value comes from: classic, the `call`-th call's result; replacement, the run's final value. `project` keeps only those keys of each element. */
export interface ExtractSpec { readonly call?: number; /** The call's whole MCP result (`content`, `isError`) instead of the text parsed out of it (classic), or the whole execute result (`status`, `error`, `value`, ...) instead of the final value (replacement). */ readonly raw?: boolean;
  /** The answer is whether the value found equals this (a fact derived from a result, never inferred from a missing one). */ readonly is?: Json;
  /** The arrays at `path` of these calls, put together in this order (instead of `call`). */ readonly calls?: readonly number[]; readonly path: string; readonly project?: readonly string[]; /** The text found at `path` is JSON text and is parsed before anything else is done to it (a text page of the broker carries a JSON document as text). */ readonly parse?: 'json'; /** The answer is an object built from the (parsed) value: each member is the value at a path of it, optionally with `project` on it (names the answer wants that the record spells differently). */ readonly shape?: Readonly<Record<string, string | { readonly path: string; readonly project?: readonly string[] }>>;
  /** An array answer keeps only the elements whose members equal these (the limit diagnostics of a result, whatever else it reports). */ readonly where?: Readonly<Record<string, string>>;
  /** An array answer loses its first `skip` elements (the caller's own row). */ readonly skip?: number; /** A string answer, or each string of an array answer, is cut to its first `prefix` characters (the final value of a script run is capped, so the classic arm is cut the same way). */ readonly prefix?: number }
export type Extract = Readonly<Record<string, ExtractSpec>>;
export interface ClassicScript { readonly calls: readonly { readonly name: string; readonly args: Obj }[]; readonly extract: Extract }
export interface ReplacementScript {
  readonly code: string;
  readonly search?: string;
  readonly extract: Extract;
  /** The second script request of a `concurrentRuns` goal (default: a script that reads nothing). */
  readonly second?: string;
  /** The further script request after the run ended, for a goal that states `nextRun` (default: a script that reads nothing). */
  readonly next?: string;
}
export type ArmScript = ClassicScript | ReplacementScript;

const MISSING_PATH = (v: unknown): boolean => typeof v === 'symbol';
const pick = (v: unknown, keys: readonly string[]): unknown => (typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.fromEntries(keys.filter((k) => k in v).map((k) => [k, (v as Obj)[k]])) : v);

/** A classic call argument may be `{ "$from": { call, path } }`: the value at `path` of an earlier call's result (a continuation cursor the agent was given). A missing one is a failed script, by name. */
export function resolveArgs(args: Obj, results: readonly unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (isRec(v) && Object.keys(v).length === 1 && isRec(v['$from'])) {
      const from = v['$from'];
      const found = typeof from['call'] === 'number' && typeof from['path'] === 'string' && from['call'] < results.length ? valueAt(results[from['call']], from['path']) : undefined;
      if (MISSING_PATH(found) || found === null || found === undefined) throw new ArmError(`argument ${k}: nothing at ${String(from['path'])} of call ${String(from['call'])}`);
      out[k] = found;
    } else out[k] = v;
  }
  return out;
}

/** The goal's answer from what the arm produced. A name whose path is missing is left out, so `present` and `absent` criteria can tell. */
export function extractAnswer(extract: Extract, sources: readonly unknown[], raws: readonly unknown[] = []): Obj {
  const out: Obj = {};
  for (const [name, spec] of Object.entries(extract)) {
    const from = (i: number): unknown => (spec.raw === true ? raws[i] : sources[i]);
    const at = (i: number): unknown => (spec.path === '' ? from(i) : valueAt(from(i), spec.path));
    let found: unknown;
    if (spec.calls !== undefined) {
      const parts = spec.calls.map(at);
      if (parts.some((x) => MISSING_PATH(x) || !Array.isArray(x))) continue;
      found = parts.flat();
    } else found = at(spec.call ?? 0);
    if (MISSING_PATH(found)) continue;
    let parsedFound = found;
    if (spec.parse === 'json') { if (typeof found !== 'string') continue; try { parsedFound = JSON.parse(found) as unknown; } catch { continue; } }
    if (spec.shape !== undefined) {
      const built: Obj = {};
      for (const [k, m] of Object.entries(spec.shape)) {
        const path = typeof m === 'string' ? m : m.path;
        const v = valueAt(parsedFound, path);
        if (MISSING_PATH(v)) continue;
        const keep = typeof m === 'string' ? undefined : m.project;
        built[k] = keep === undefined ? v : Array.isArray(v) ? v.map((el) => pick(el, keep)) : pick(v, keep);
      }
      parsedFound = built;
    }
    const projected = spec.project === undefined ? parsedFound : Array.isArray(parsedFound) ? parsedFound.map((el) => pick(el, spec.project!)) : pick(parsedFound, spec.project);
    if (spec.is !== undefined) { out[name] = JSON.stringify(parsedFound) === JSON.stringify(spec.is); continue; }
    const kept = spec.where !== undefined && Array.isArray(projected) ? projected.filter((el) => isRec(el) && Object.entries(spec.where!).every(([k, v]) => el[k] === v)) : projected;
    const skipped = spec.skip !== undefined && Array.isArray(kept) ? kept.slice(spec.skip) : kept;
    const cut = (v: unknown): unknown => (typeof v === 'string' ? v.slice(0, spec.prefix) : v);
    out[name] = spec.prefix === undefined ? skipped : Array.isArray(skipped) ? skipped.map(cut) : cut(skipped);
  }
  return out;
}

// ---------- the preload ----------

/**
 * The text of the load-time preload for a replacement arm. `mintExpression` evaluates, in the child, to the one-per-process mint of the fixture policy
 * source (the test file supplies it). The policy answers the state in `REPLAY_POLICY_STATE`, `allow` by default. Anchors that moved make the child
 * fail at load, named, never silently classic.
 */
export function preloadSource(options: { distDir: string; proven: readonly string[]; mintExpression: string }): string {
  return `import { registerHooks } from 'node:module';
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const dist = ${JSON.stringify(options.distDir)};
const np = await import(pathToFileURL(dist + '/mcp/code-mode/native-policy.js').href);
const br = await import(pathToFileURL(dist + '/mcp/code-mode/broker.js').href);
const mint = ${options.mintExpression};
// the policy answers REPLAY_POLICY_STATE, or, once the harness has written REPLAY_POLICY_FILE, the state in that file (a change mid-run)
const state = () => { try { return readFileSync(process.env.REPLAY_POLICY_FILE, 'utf8').trim() || 'allow'; } catch { return process.env.REPLAY_POLICY_STATE || 'allow'; } };
const source = mint('replay-fixture-policy', { revision: () => 'replay-rev-1', decide: state });
globalThis.__replayBroker = (catalog, launchId) => br.createBroker({
  source, catalog, launchId,
  agent: { url: process.env.PARLEY_AGENT_URL, token: process.env.PARLEY_AGENT_TOKEN },
  launch: {}, hold: { workDir: process.env.PARLEY_WORK_DIR, sessionId: process.env.PARLEY_SESSION_ID },
});
// what the server computed for a script request, kept before the protocol layer can drop it: a client that cancelled never receives the answer
// a tap that cannot be written is a lost tap, named by the harness when it waits for it; it must never reach the product's own error path
// seq is taken when a script request enters execute: the order the client sent them in, so two runs of the same code are told apart. done.call is what the agent gets (the
// agent view, contract v4); done.full is the parent's own ExecuteResult, null where the answer is a fixed text with no result behind it.
globalThis.__replayTap = (done, args, seq) => { try { if (process.env.REPLAY_TAP) appendFileSync(process.env.REPLAY_TAP, JSON.stringify({ seq, code: createHash('sha256').update(String(args && args.code)).digest('hex'), result: done.call, full: done.full }) + '\\n'); } catch { /* lost */ } };
const limits = () => (process.env.REPLAY_LIMITS ? JSON.parse(process.env.REPLAY_LIMITS) : undefined);
globalThis.__replayLimits = limits;
const swap = (text, anchor, by, what) => { if (!text.includes(anchor)) throw new Error('replay preload: the ' + what + ' anchor moved'); return text.replace(anchor, by); };
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  const text = String(result.source);
  if (url.endsWith('/code-mode/migration-registry.js')) {
    return { ...result, source: swap(text, 'proven: Object.freeze([])', 'proven: Object.freeze(' + ${JSON.stringify(JSON.stringify(options.proven))} + ')', 'proven') };
  }
  if (url.endsWith('/mcp/code-mode-tools.js')) {
    let out = swap(text, 'return Object.freeze({ catalog, launchId, broker: null });', 'return Object.freeze({ catalog, launchId, broker: globalThis.__replayBroker(catalog, launchId) });', 'live backend');
    out = swap(out, 'ran = await broker.run(request.code, request.apiRevision, signal);', 'ran = await broker.run(request.code, request.apiRevision, signal, globalThis.__replayLimits());', 'run call');
    out = swap(out, 'return (await execute(state, args, signal)).call;', 'return await (async () => { const seq = globalThis.__replaySeq = (globalThis.__replaySeq ?? 0) + 1; const done = await execute(state, args, signal); globalThis.__replayTap(done, args, seq); return done.call; })();', 'execute call');
    return { ...result, source: out };
  }
  return result;
} });
void np;
`;
}

// ---------- processes left behind ----------

export interface ProcessRow { readonly pid: number; readonly ppid: number; readonly command: string }
const processes = (): ProcessRow[] => execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  .split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter((m): m is RegExpExecArray => m !== null).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }));

/**
 * Helper pids recorded while the child is alive, and what is left of them after it exits. A helper that outlives its server is re-parented, so a
 * parent filter taken afterwards would find nothing: the pids are kept, and any process whose command line names this arm's directory counts too.
 */
export class HelperWatch {
  private readonly seen = new Map<number, string>();
  /** `list` is the process table; a test passes a fake one. */
  constructor(private readonly marker: string, private readonly list: () => ProcessRow[] = processes) {}
  /** Records every descendant of `root` as it is now. */
  snapshot(root: number): void {
    const rows = this.list();
    const live = new Set([root]);
    for (let grew = true; grew;) { grew = false; for (const r of rows) if (!live.has(r.pid) && live.has(r.ppid)) { live.add(r.pid); grew = true; } }
    for (const r of rows) if (r.pid !== root && live.has(r.pid)) this.seen.set(r.pid, r.command);
  }
  /** The processes below `root` right now, nearest first: what a `kill-helper` fault takes. */
  descendants(root: number): ProcessRow[] {
    const rows = this.list();
    const live = new Set([root]);
    const out: ProcessRow[] = [];
    for (let grew = true; grew;) { grew = false; for (const r of rows) if (!live.has(r.pid) && live.has(r.ppid)) { live.add(r.pid); out.push(r); grew = true; } }
    return out;
  }
  /** Records one process the caller knows belongs to the arm. */
  record(pid: number): void {
    const row = this.list().find((r) => r.pid === pid);
    if (row !== undefined) this.seen.set(pid, row.command);
  }
  /** Waits on the observed condition (nothing recorded is still alive), bounded; returns what remains and how long it took. A helper still dying is not a leak. */
  async settle(maxMs: number, everyMs = 100): Promise<{ readonly pids: number[]; readonly waitedMs: number }> {
    const start = Date.now();
    for (;;) {
      const pids = this.leftovers();
      const waitedMs = Date.now() - start;
      if (pids.length === 0 || waitedMs >= maxMs) return { pids, waitedMs };
      await new Promise((r) => setTimeout(r, everyMs));
    }
  }
  /** Pids still alive: a recorded one running the same command, or any process whose command line holds the marker. */
  leftovers(): number[] {
    const rows = this.list();
    const byPid = new Map(rows.map((r) => [r.pid, r.command]));
    const out = new Set<number>();
    for (const [pid, command] of this.seen) if (byPid.get(pid) === command) out.add(pid);
    for (const r of rows) if (r.pid !== process.pid && r.command.includes(this.marker)) out.add(r.pid);
    return [...out].sort((a, b) => a - b);
  }
}

/** The command line of the sandboxed helper: the sandbox wrapper, then Node on the helper entry. Anything else under the server (a `ps` the run record spawns) is not it. */
export const isHelperCommand = (command: string): boolean => /sandbox-exec|helper-entry/.test(command);

/**
 * The `kill-helper` fault: SIGKILL everything below the server (recorded first, so a survivor is found later) and say whether the HELPER was among it.
 * Only then has the fault fired; a transient child alone does not count.
 */
export function killHelper(watch: HelperWatch, root: number, kill: (pid: number) => void = (pid) => process.kill(pid, 'SIGKILL')): { readonly fired: boolean; readonly killed: readonly number[] } {
  const rows = watch.descendants(root);
  for (const r of rows) { watch.record(r.pid); try { kill(r.pid); } catch { /* already gone */ } }
  return { fired: rows.some((r) => isHelperCommand(r.command)), killed: rows.map((r) => r.pid) };
}

// ---------- the client ----------

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where the MCP client SDK came from: the harness runs the one core declares, never one that happens to sit above the repository. */
export interface SdkInfo { readonly root: string; readonly version: string; readonly clientUrl: string; readonly stdioUrl: string }

/**
 * Resolves the MCP client SDK from core's declared dependency (a `createRequire` anchored at core's package.json) and refuses a path outside the
 * repository: a stray install in a parent directory would make the harness's client an undeclared, unpinned one. The report carries `root` and `version`.
 */
export function resolveSdk(corePackageJson: string = path.join(REPO, 'packages', 'core', 'package.json'), repo: string = REPO): SdkInfo {
  let resolved: string;
  try { resolved = createRequire(corePackageJson).resolve('@modelcontextprotocol/sdk/client/index.js'); } catch { throw new ArmError('the MCP client SDK cannot be resolved from the core package'); }
  const marker = `${path.sep}@modelcontextprotocol${path.sep}sdk${path.sep}`;
  const at = resolved.lastIndexOf(marker);
  if (at < 0) throw new ArmError(`the MCP client SDK resolved to an unexpected path: ${resolved}`);
  const root = realpathSync(resolved.slice(0, at + marker.length - 1));
  if (!root.startsWith(`${realpathSync(repo)}${path.sep}`)) throw new ArmError(`the MCP client SDK resolves outside the repository: ${root}`);
  const version = String((JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string }).version);
  return { root, version, clientUrl: pathToFileURL(path.join(root, 'dist', 'esm', 'client', 'index.js')).href, stdioUrl: pathToFileURL(path.join(root, 'dist', 'esm', 'client', 'stdio.js')).href };
}

interface Sdk { readonly info: SdkInfo; readonly Client: typeof ClientClass; readonly Stdio: typeof StdioClass }
let sdkOnce: Promise<Sdk> | undefined;
const loadSdk = (): Promise<Sdk> => (sdkOnce ??= (async () => {
  const info = resolveSdk();
  const [client, stdio] = await Promise.all([import(/* @vite-ignore */ info.clientUrl) as Promise<{ Client: typeof ClientClass }>, import(/* @vite-ignore */ info.stdioUrl) as Promise<{ StdioClientTransport: typeof StdioClass }>]);
  return { info, Client: client.Client, Stdio: stdio.StdioClientTransport };
})());
/** The preflight line of the report: which client SDK the harness ran. */
export const sdkPreflight = async (): Promise<SdkInfo> => (await loadSdk()).info;

/** One message the server sent, as the model would have received it: what answered which request, and how many UTF-8 bytes it took. */
export interface WireMessage { readonly id: number | string | null; readonly kind: string; readonly bytes: number }
export type RecordingTransport = InstanceType<typeof StdioClass> & { received: string; messages: WireMessage[]; /** The ids of the script requests the client sent, in the order it sent them. */ executeIds: (number | string)[]; finish(): Promise<void> };
/**
 * A stdio client transport that keeps every byte the server sent it: what the model would have received. Its `close` ends the server's stdin and
 * nothing more: the SDK's own `close` signals a server that lingers (SIGTERM after 2 s, SIGKILL after 4 s), which would be the harness killing the
 * server before `settleChild` had read the record. `finish` is the SDK's own teardown, to be called once the server is gone.
 */
export function recordingTransport(Stdio: typeof StdioClass, options: ConstructorParameters<typeof StdioClass>[0]): RecordingTransport {
  class Recording extends Stdio {
    received = '';
    messages: WireMessage[] = [];
    executeIds: (number | string)[] = [];
    private readonly asked = new Map<number | string, string>();
    override send(message: Parameters<InstanceType<typeof StdioClass>['send']>[0]): Promise<void> {
      const m = message as unknown as Obj;
      if (m['id'] !== undefined && typeof m['method'] === 'string') {
        const params = m['params'] as Obj | undefined;
        this.asked.set(m['id'] as number | string, m['method'] === 'tools/call' ? `tools/call ${String(params?.['name'])}` : m['method']);
        if (m['method'] === 'tools/call' && params?.['name'] === 'code_execute') this.executeIds.push(m['id'] as number | string);
      }
      return super.send(message);
    }
    override async start(): Promise<void> {
      const handler = this.onmessage;
      this.onmessage = (message) => {
        const text = JSON.stringify(message);
        const m = message as unknown as Obj;
        const id = (m['id'] as number | string | undefined) ?? null;
        const asked = id === null ? undefined : this.asked.get(id);
        // a response is named by the request it answers: the handshake, the tool list, or a call of one tool; anything else the server sends on its own is a notification
        this.messages.push({ id, kind: asked === undefined ? `notification ${String(m['method'] ?? 'unknown')}` : asked === 'initialize' ? 'handshake' : asked, bytes: Buffer.byteLength(text, 'utf8') });
        this.received += text;
        handler?.(message);
      };
      await super.start();
    }
    override async close(): Promise<void> {
      const child = (this as unknown as { _process?: { stdin?: { end(): void } } })._process;
      if (child === undefined) return;
      if (child.stdin === undefined) throw new ArmError('the MCP client SDK keeps its child differently from the one this harness was written against');
      try { child.stdin.end(); } catch { /* already closed */ }
    }
    async finish(): Promise<void> { await super.close(); }
  }
  return new Recording(options);
}

const textOf = (result: unknown): string => {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('');
};
const parsed = (text: string): unknown => { try { return JSON.parse(text) as unknown; } catch { return text; } };

// ---------- one arm ----------

export interface ArmRunInput {
  readonly goal: Goal;
  readonly arm: Arm;
  readonly built: BuiltData;
  readonly script: ArmScript;
  /** `packages/core/dist`. */
  readonly distDir: string;
  /** The replacement arm's preload file, written by the test that owns the mint. */
  readonly preloadPath: string | null;
  readonly timeoutMs?: number;
  /** A seam for a test: false leaves the preload's tap off, to show the tap changes nothing the agent receives (default true). */
  readonly tap?: boolean;
  /** A seam for a test: where the preload writes its tap (default: a file in the arm directory). */
  readonly tapFile?: string;
  /** A seam for a test: replaces how the `kill-helper` fault takes the helper. */
  readonly killer?: typeof killHelper;
  /** How long to wait for the server's own answer to a cancelled script request (default 40 s: past the wall limit). */
  readonly tapWaitMs?: number;
  /** How long the server may take to go once the client has closed, before the harness kills it (default 10 s). */
  readonly exitGraceMs?: number;
  /** The goal says the server may outlive its client (a held run keeps it until the receipt): a harness kill is then recorded, not a failure. */
  readonly mayOutliveClient?: boolean;
  /** How long a recorded helper may still be dying after the server is gone (default 5 s). */
  readonly leftoverWaitMs?: number;
  /** A seam for a test: runs after the client and its server are gone and before leftovers are judged, to plant a process the way a leaking helper would. */
  /** A seam for a test: how the run record is read. */
  readonly inspect?: typeof inspectRunRecord;
  /**
   * The conservation phase: runs on the live client AFTER the goal's script, when what the goal is judged on (received bytes, host log, fired faults, peak
   * pending) has been frozen, so its reads can never enter that observation; its result comes back apart, as `phase`.
   */
  readonly phase?: (tools: PhaseTools) => Promise<unknown>;
  /** A seam for the rollback goals: runs once the arm's data is restored and before its server starts, to put the run record the goal needs where the server will find it. */
  readonly beforeLaunch?: (context: { readonly built: BuiltData; readonly workDir: string }) => Promise<void> | void;
  readonly beforeVerdict?: (watch: HelperWatch) => Promise<void> | void;
}

/** What a goal's faults ask the runner to do to a RUNNING replacement arm (the host's own faults are the host's). */
export interface ArmFaults {
  /** The client cancels its script request when the host has received this call. */
  readonly abortAfter: number | null;
  readonly guest: { readonly event: 'kill-helper' | 'no-await'; readonly afterCalls: number } | null;
  /** The policy changes to `state` after this call was received. */
  readonly policyChange: { readonly state: string; readonly afterCalls: number } | null;
  /** The policy state from the start, when it does not change mid-run. */
  readonly policyState: string | null;
  readonly limits: Obj | null;
  readonly concurrentRuns: boolean;
  /** Some criterion states `nextRun`: a further script request is sent once the run has ended. */
  readonly wantsNextRun: boolean;
}

const isRec = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

export function faultsOf(goal: Goal): ArmFaults {
  const f = goal.faults;
  const policy = isRec(f['policy']) ? f['policy'] : null;
  const guest = isRec(f['guest']) ? f['guest'] : null;
  const abort = isRec(f['abort']) ? f['abort'] : null;
  const wants = (goal.criteria as unknown[]).some((c) => isRec(c) && isRec(c['run']) && 'nextRun' in c['run']);
  return {
    abortAfter: abort !== null && typeof abort['afterCalls'] === 'number' ? abort['afterCalls'] : null,
    guest: guest === null ? null : { event: guest['event'] as 'kill-helper' | 'no-await', afterCalls: typeof guest['afterCalls'] === 'number' ? guest['afterCalls'] : 1 },
    policyChange: policy !== null && typeof policy['afterCalls'] === 'number' ? { state: String(policy['state']), afterCalls: policy['afterCalls'] } : null,
    policyState: policy !== null && typeof policy['afterCalls'] !== 'number' ? String(policy['state']) : null,
    limits: isRec(f['limits']) ? f['limits'] : null,
    concurrentRuns: isRec(f['resource']) && f['resource']['bound'] === 'concurrentRuns',
    wantsNextRun: wants,
  };
}

/** A named failure of the harness itself (not of the goal): the run stops, the goal is not judged on what is missing. */
export class ArmError extends Error {}

/** What the conservation phase may do on the live arm: direct tool calls (the classic way), the catalogue search, and a script run (the replacement way). */
export interface PhaseTools {
  readonly arm: Arm;
  /** The tool list this arm's client was given. */
  readonly tools: readonly ToolDescriptor[];
  call(name: string, args: Obj): Promise<unknown>;
  search(query: string, cursor?: string): Promise<{ readonly body: Obj; readonly text: string }>;
  run(code: string): Promise<{ readonly result: ExecuteLike; readonly body: Obj }>;
}

export const recordOf = (workDir: string, sessionId: string, inspect: typeof inspectRunRecord = inspectRunRecord, exists: (file: string) => boolean = existsSync): RecordState => {
  const view = inspect(workDir, sessionId);
  if (view.kind === 'unreadable') throw new ArmError('the run record is unreadable: its state cannot be judged');
  if (view.kind === 'held-live') return 'held-live';
  if (view.kind === 'unaccounted') return 'unaccounted';
  return exists(runRecordPath(workDir, sessionId)) ? 'free' : 'none';
};

const executeLike = (r: Obj): ExecuteLike => ({
  status: String(r['status']), error: r['error'] === null || r['error'] === undefined ? null : { kind: String((r['error'] as Obj)['kind']) },
  runId: (r['runId'] as string | null) ?? null, incomplete: r['incomplete'] === true,
  operations: ((r['operations'] as Obj[] | undefined) ?? []).map((o) => ({ ordinal: o['ordinal'] as number, method: (o['method'] as string | null) ?? null, dispatched: o['dispatched'] === true, outcome: String(o['outcome']), incomplete: o['incomplete'] === true })),
  diagnostics: ((r['diagnostics'] as Obj[] | undefined) ?? []).map((d) => ({ code: String(d['code']), params: (d['params'] as Record<string, Json> | undefined) ?? {} })),
  value: r['value'],
});

/** What the judge reads, and the tool list this arm's client was given (the conservation goals compare the two arms' lists). */
export type ArmRunResult = ArmObservation & {
  readonly tools: readonly ToolDescriptor[];
  /** The harness had to kill the server after its client closed. The record in the observation was read before that. */
  readonly serverKilledByHarness: boolean;
  /** How long the recorded helpers took to be gone after the server, in ms; the time the leftover check waited. */
  readonly helperGoneAfterMs: number;
  /** What the conservation phase returned, kept apart from everything the goal is judged on. */
  readonly phase?: unknown;
  /** The server's messages in order, what each answered and its UTF-8 bytes; their sum is the bytes of `received` (the conservation phase's reads are not in it). */
  readonly messages: readonly WireMessage[];
};

export interface ChildEnd { readonly killedByHarness: boolean; readonly waitedMs: number }

/** A harness kill fails the arm unless the goal declared that the server may outlive its client. */
export function checkEnd(ended: ChildEnd, mayOutliveClient: boolean | undefined): void {
  if (ended.killedByHarness && mayOutliveClient !== true) throw new ArmError(`the server outlived its client by ${ended.waitedMs} ms and the harness had to kill it; the goal does not say it may`);
}

/** Waits for the server to exit on its own; past `graceMs` it runs `beforeKill` (the record is read there) and then kills it. */
export async function settleChild(pid: number, graceMs: number, beforeKill: () => void): Promise<ChildEnd> {
  const start = Date.now();
  const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  while (alive()) {
    if (Date.now() - start >= graceMs) {
      beforeKill();
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      while (alive()) await new Promise((r) => setTimeout(r, 25));
      return { killedByHarness: true, waitedMs: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return { killedByHarness: false, waitedMs: Date.now() - start };
}

/** The arm started in the mode it was launched for: a replacement list has `code_execute`, a classic one never does. */
export function checkMode(arm: Arm, names: readonly string[]): void {
  if (arm === 'replacement' && !names.includes('code_execute')) throw new ArmError('the replacement arm did not start in replacement mode: no code_execute in its list');
  if (arm === 'classic' && names.includes('code_execute')) throw new ArmError('the classic arm started in replacement mode');
}

/** Runs one arm of a run goal from the restored snapshot and returns what the judge reads. */
export async function runArm(input: ArmRunInput): Promise<ArmRunResult> {
  const { goal, arm, built, distDir } = input;
  const sdk = await loadSdk();
  const canary = typeof goal.faults['localCanary'] === 'string' ? goal.faults['localCanary'] : null;
  await restoreForArm(built, canary);
  const workDir = workPaths(built.project, built.workId).dir;
  await input.beforeLaunch?.({ built, workDir });
  const host = await startReplayHost(built, goal.faults);
  const watch = new HelperWatch(built.dir);
  let childPid: number | null = null;
  let transport: RecordingTransport | null = null;
  try {
    const f = faultsOf(goal);
    const policyFile = path.join(built.dir, 'policy-state');
    const tapFile = input.tapFile ?? path.join(built.dir, 'tap.jsonl');
    rmSync(policyFile, { force: true });
    rmSync(tapFile, { force: true });
    const env: Record<string, string> = {
      PATH: process.env['PATH']!, HOME: process.env['HOME']!, PARLEY_HOME: built.home, PARLEY_WORK_DIR: workDir, PARLEY_SESSION_ID: built.selfId,
      PARLEY_AGENT_URL: host.agent.url, PARLEY_AGENT_TOKEN: host.agent.token,
    };
    if (arm === 'replacement') {
      env['REPLAY_POLICY_FILE'] = policyFile;
      if (input.tap !== false) env['REPLAY_TAP'] = tapFile;
      if (f.policyState !== null) env['REPLAY_POLICY_STATE'] = f.policyState;
      if (f.limits !== null) {
        // lowered only: the product refuses a raise, and so does the harness before it launches anything
        const checked = resolveRunLimits(f.limits);
        if (!checked.ok) throw new ArmError(`the goal's limits are not a lowering of the shipped ones: ${checked.problem}`);
        env['REPLAY_LIMITS'] = JSON.stringify(f.limits);
      }
    }
    const args: string[] = [];
    if (arm === 'replacement') {
      if (input.preloadPath === null) throw new ArmError('the replacement arm needs its preload');
      const nonce = newLaunchNonce();
      if (!writeLaunchDecision(workDir, built.selfId, { v: 1, nonce, effective: 'replacement', requested: true, reason: null, provider: 'claude', at: new Date().toISOString() })) throw new ArmError('the launch decision file could not be written');
      env['PARLEY_CODE_MODE_LAUNCH'] = nonce;
      args.push('--import', input.preloadPath);
    }
    args.push(path.join(distDir, 'mcp', 'server.js'));
    const tr = recordingTransport(sdk.Stdio, { command: process.execPath, args, env, stderr: 'pipe' });
    transport = tr;
    const client = new sdk.Client({ name: 'replay', version: '0' });
    const timeout = input.timeoutMs ?? 120_000;
    let answer: Obj = {};
    let result: ExecuteLike | null = null;
    let attempted = false;
    let second: { attempted: boolean; result: ExecuteLike | null } | null = null;
    let nextRun: { admitted: boolean; busyReason: string | null } | null = null;
    let fromTap = false;
    let apiRevision = '';
    /** Every answered script request of the goal, as the agent got it beside the parent's own result; the phase's reads are kept out. */
    const executes: ExecuteWire[] = [];
    let goalExecutes: ExecuteWire[] | null = null;
    /** The order of the script request the client cancelled, when it did. */
    let cancelledSeq: number | null = null;
    let frozen: { received: string; messages: WireMessage[]; hostLog: ReturnType<typeof host.log>; fired: Record<string, number | undefined>; pending: number | null } | null = null;
    let phaseResult: unknown;
    let tools: ToolDescriptor[] = [];
    try {
      await client.connect(tr);
      childPid = tr.pid;
      tools = (await client.listTools()).tools as ToolDescriptor[];
      checkMode(arm, tools.map((t) => t.name));
      if (childPid !== null) watch.snapshot(childPid);
      // The server numbers the script requests in the order it receives them, one connection and one stream, so the n-th sent is the n-th it numbered (the tap's seq).
      let sentScripts = 0;
      const execute = (code: string, signal?: AbortSignal): { readonly seq: number; readonly promise: Promise<unknown> } => {
        const seq = ++sentScripts;
        return { seq, promise: client.callTool({ name: 'code_execute', arguments: { code, apiRevision } }, undefined, { timeout, ...(signal === undefined ? {} : { signal }) }) };
      };
      // What the parent computed for an ANSWERED script request, from the tap. Null with the tap off or lost: then the judge has only what the agent was sent.
      let tapLost = input.tap === false;
      const parentOf = async (seq: number): Promise<Obj | null> => {
        if (tapLost) return null;
        try { return (await waitForTapEntry(tapFile, input.tapWaitMs ?? 5_000, seq)).full; } catch { tapLost = true; return null; }
      };
      /** An answered script request: what the agent got (parsed), the parent's own result, and the bytes, kept for the agent-view check. */
      const answered = async (sent: { readonly seq: number; readonly promise: Promise<unknown> }): Promise<{ wire: Obj; full: Obj | null; body: Obj }> => {
        const r = await sent.promise;
        const text = textOf(r);
        const full = await parentOf(sent.seq);
        executes.push({ seq: sent.seq, text, isError: (r as { isError?: boolean }).isError === true, full });
        const wire = parsed(text) as Obj;
        return { wire, full, body: full ?? wire };
      };
      if (arm === 'classic') {
        const script = input.script as ClassicScript;
        const results: unknown[] = [];
        const raws: unknown[] = [];
        for (const step of script.calls) {
          const res = await client.callTool({ name: step.name, arguments: resolveArgs(step.args, results) }, undefined, { timeout });
          raws.push({ content: res.content, isError: res.isError === true });
          results.push(parsed(textOf(res)));
        }
        answer = extractAnswer(script.extract, results, raws);
      } else {
        const script = input.script as ReplacementScript;
        const search = parsed(textOf(await client.callTool({ name: 'code_search', arguments: { query: script.search ?? 'parley' } }, undefined, { timeout }))) as Obj;
        const revision = String(search['apiRevision']);
        apiRevision = revision;
        if (childPid !== null) watch.snapshot(childPid);
        const firstRun = new AbortController();
        // faults that act on the running arm fire on an observed host receipt, never a time
        const release = f.concurrentRuns ? host.holdCall(1) : null;
        let cancelled = false;
        let onCancelled: () => void = () => undefined;
        const cancelSignal = new Promise<void>((resolve) => { onCancelled = resolve; });
        let secondRun: Promise<void> | null = null;
        host.onCall((n) => {
          if (f.abortAfter === n) {
            // the SDK sends notifications/cancelled for this request and settles the client's own promise; the server then never answers it
            host.markFired('abort');
            cancelled = true;
            firstRun.abort();
            onCancelled();
          }
          if (f.guest?.event === 'kill-helper' && n === f.guest.afterCalls && childPid !== null) {
            if ((input.killer ?? killHelper)(watch, childPid).fired) host.markFired('guest');
          }
          if (f.guest?.event === 'no-await' && n === 1) host.markFired('guest');
          if (f.policyChange !== null && n === f.policyChange.afterCalls) { writeFileSync(policyFile, f.policyChange.state); host.markFired('policy'); }
          if (f.concurrentRuns && n === 1) {
            host.markFired('concurrentRuns');
            second = { attempted: true, result: null };
            secondRun = answered(execute(script.second ?? 'return null;')).then((a) => { second = { attempted: true, result: executeLike(a.body) }; }).finally(() => release?.());
          }
        });
        attempted = true;
        const firstSent = execute(script.code, firstRun.signal);
        const run = firstSent.promise;
        run.catch(() => undefined);
        const poll = setInterval(() => { if (childPid !== null) { try { watch.snapshot(childPid); } catch { /* the process list is best effort while a run is live */ } } }, 100);
        let body: Obj;
        let wire: Obj = {};
        try {
          const first = await Promise.race([run.then((r) => ({ r })), cancelSignal.then(() => null)]);
          if (first === null || cancelled) {
            // The server never answers a cancelled request, so what the model would have been told is what the server computed: read from its tap.
            body = await waitForTap(tapFile, input.tapWaitMs ?? 40_000, firstSent.seq);
            fromTap = true;
            cancelledSeq = firstSent.seq;
          } else { const a = await answered({ seq: firstSent.seq, promise: Promise.resolve(first.r) }); wire = a.wire; body = a.body; }
        } finally { clearInterval(poll); }
        if (secondRun !== null) await secondRun;
        result = executeLike(body);
        // a cancelled request was never answered: the agent holds no value, whatever the server computed. An answer is read from what the agent was SENT.
        answer = fromTap ? {} : extractAnswer(script.extract, [wire['value']], [wire]);
        if (f.wantsNextRun) {
          const next = executeLike((await answered(execute(script.next ?? 'return null;'))).body);
          const busy = next.error?.kind === 'busy';
          nextRun = { admitted: !busy, busyReason: busy ? String(next.diagnostics.find((d) => d.code === 'busy')?.params?.['reason'] ?? 'other') : null };
        }
      }
      if (input.phase !== undefined) {
        // everything the goal is judged on is frozen first; the phase then reads on the same arm and its reads go nowhere but `phase`
        goalExecutes = [...executes];
        frozen = { received: tr.received, messages: [...tr.messages], hostLog: host.log(), fired: { ...host.firedAtSeq }, pending: host.maxPending() };
        // the phase reads the parent's own result (its rows, its sizes), as the goals do; the agent's text only where the parent has none
        const exec = async (code: string): Promise<{ result: ExecuteLike; body: Obj }> => {
          const { body } = await answered(execute(code));
          return { result: executeLike(body), body };
        };
        phaseResult = await input.phase({
          arm, tools,
          call: async (name, args) => parsed(textOf(await client.callTool({ name, arguments: args }, undefined, { timeout }))),
          search: async (query, cursor) => { const text = textOf(await client.callTool({ name: 'code_search', arguments: { query, ...(cursor === undefined ? {} : { cursor }) } }, undefined, { timeout })); return { body: parsed(text) as Obj, text }; },
          run: exec,
        });
      }
    } finally {
      if (childPid !== null) { try { watch.snapshot(childPid); } catch { /* gone */ } }
      await client.close().catch(() => undefined);
    }
    // The server goes when its client does. A held run may keep it longer (the goal then says so); either way the record is read BEFORE any kill, so a state
    // the harness made by killing can never be judged as the product's.
    let record: RecordState | null = null;
    const readRecord = (): void => { record = recordOf(workDir, built.selfId, input.inspect); };
    const ended = childPid === null ? { killedByHarness: false, waitedMs: 0 } : await settleChild(childPid, input.exitGraceMs ?? 10_000, readRecord);
    if (record === null) readRecord();
    checkEnd(ended, input.mayOutliveClient);
    const observation = {
      arm, answer: answer as Json, result, attemptedExecute: attempted, hostLog: frozen === null ? host.log() : frozen.hostLog, faultFiredAtSeq: frozen === null ? { ...host.firedAtSeq } : frozen.fired,
      hostMaxPending: frozen === null ? host.maxPending() : frozen.pending, second, nextRun, resultFromTap: fromTap, tools,
      executes: goalExecutes ?? [...executes], cancelledSeq, cancelledAnswered: cancelledSeq !== null && tr.messages.some((m) => m.id === tr.executeIds[cancelledSeq! - 1]),
      received: frozen === null ? tr.received : frozen.received, record: record as unknown as RecordState, canaryReadable: canary === null ? null : await canaryReadable(built, canary), skipped: 0,
    };
    if (input.beforeVerdict !== undefined) await input.beforeVerdict(watch);
    const left = await watch.settle(input.leftoverWaitMs ?? 5_000);
    return { ...observation, messages: frozen === null ? [...tr.messages] : frozen.messages, leftoverHelper: left.pids.length > 0, serverKilledByHarness: ended.killedByHarness, helperGoneAfterMs: left.waitedMs, ...(input.phase === undefined ? {} : { phase: phaseResult }) };
  } finally {
    // a failed arm must not leave its server, its host or PARLEY_HOME behind
    if (childPid !== null) await settleChild(childPid, 2_000, () => undefined).catch(() => undefined);
    await (transport as RecordingTransport | null)?.finish().catch(() => undefined);
    await host.close();
  }
}

/** One line of the server's tap: the request's order (`seq`), what the agent was sent, and the parent's own result (null where there is none). */
export interface TapEntry { readonly seq: number; readonly result: unknown; readonly full: Obj | null }

/** Waits for the tap to hold the line of the script request that was the `seq`-th the client sent (an observed condition, bounded; never matched by the code, so two runs of the same code are two lines). */
export async function waitForTapEntry(file: string, maxMs: number, seq: number): Promise<TapEntry> {
  const start = Date.now();
  for (;;) {
    const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l !== '') : [];
    for (const line of lines) {
      const entry = JSON.parse(line) as { seq?: number; result?: unknown; full?: Obj | null };
      if (entry.seq === seq) return { seq, result: entry.result, full: entry.full === undefined ? null : entry.full };
    }
    if (Date.now() - start >= maxMs) throw new ArmError('the server computed no answer for the cancelled script request');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The parent's own ExecuteResult of the `seq`-th script request; where the server had none (a fixed text), what the agent was sent. */
export async function waitForTap(file: string, maxMs: number, seq: number): Promise<Obj> {
  const entry = await waitForTapEntry(file, maxMs, seq);
  return entry.full ?? (parsed(textOf(entry.result)) as Obj);
}

/** The control of `$canary`: the canary can be read back from the arm's local store. */
export async function canaryReadable(built: BuiltData, canary: string): Promise<boolean> {
  const summary = await withHome(built.home, async () => readStoredMap(built.project, built.workId).sessions.find((s) => s.id === built.selfId)?.summary ?? null);
  return summary === canary;
}

/** Writes the preload file for a replacement arm and returns its path. */
export function writePreload(dir: string, options: Parameters<typeof preloadSource>[0]): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'replay-preload.mjs');
  writeFileSync(file, preloadSource(options));
  return file;
}

