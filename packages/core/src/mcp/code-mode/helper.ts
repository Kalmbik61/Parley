// Code Mode helper lifecycle, parent side (plan T4a). Fixture-only: the host callback is a stub bridge; no ToolRunner,
// broker, native-policy or registration is wired here. Every refusal is `unavailable` with nothing dispatched, and there
// is no weaker fallback: no unsandboxed helper, no skipped check.
//
// Order of one run:
//   1. platform (darwin/arm64), stack rlimit ≥ 8000 KiB, wrapper present, helper/guest/QuickJS paths resolved;
//   2. render the pinned r4 profile for those real paths;
//   3. once per launch (cached by profile/probe/binary identity): the shipped native process-info probe must get EPERM;
//   4. every run: spawn the helper under sandbox-exec with env {} and Node --permission, and judge its whole-profile
//      self-test (sockets, DNS, file, spawn) with parent-owned listeners that must see zero hits;
//   5. only then send the script; relay calls to the fixture host with the T2b protocol checks.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import dgram from 'node:dgram';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { types as utilTypes } from 'node:util';
import type { CallValidators, OperationEvidence } from './contracts.js';
import type { GuestOutcome, GuestRefusals } from './guest.js';
import type { RunRecordStore } from './run-record.js';
import { type RunLimits, guestLimitsFor, resolveRunLimits } from './limits.js';
import { type EdgeVerdict, type FixtureHost, GUEST_MESSAGES, type GuestDelivery, type HostBudget, type LedgerEntry, type LedgerSnapshot, RunLedger, SESSION_SCHEDULER, type SessionScheduler, type Violation } from './scheduler.js';
import type { PolicyRefusal } from './native-policy.js';
import { type JsonValue, RESULT_LIMITS, parseStrictJson } from './validation.js';
import { type ProfilePaths, ancestorsOf, profilePath, renderHelperProfile, renderProbeProfile, sha256 } from './helper-profile.js';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const MIN_STACK_RLIMIT_KB = 8000;
/** --stack-size=4000 relies on the ≥ 8000 KiB stack rlimit checked before every spawn (T2b r4). */
export const HELPER_NODE_FLAGS = Object.freeze(['--stack-size=4000', '--max-old-space-size=64']);
/** sha256 of packages/core/native/procinfo-probe.c; the shipped manifest must name exactly this source. */
export const PROCINFO_SOURCE_SHA256 = '3292cd3ad65c56f6adcf5018d41affa2be1181fc0dd195dfa143cf6adda62830';
const PROBE_STARTED = 'PARLEY_PROCINFO_PROBE_STARTED 1';
/** A probe whose owned group could not be killed: definitive, and never reported as a cancellation. */
export const PROBE_CLEANUP_FAILED = 'probe cleanup failed';
const PROBE_TIMEOUT_MS = 10_000;
const MAX_LINE = 1024 * 1024;

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where a run's files come from. Product code uses PRODUCT_LOCATIONS only; nothing selects another set at runtime. */
export interface HelperLocations {
  readonly wrapper: string;
  readonly entry: string;
  readonly guest: string;
  readonly nativeDir: string;
  /** The process-status tool the RSS watchdog samples with. */
  readonly ps: string;
}

/** Package-relative: dist/mcp/code-mode → ../../../native/darwin-arm64 is packages/core/native/darwin-arm64. */
export const PRODUCT_LOCATIONS: HelperLocations = Object.freeze({
  wrapper: SANDBOX_EXEC,
  entry: path.join(here, 'helper-entry.js'),
  guest: path.join(here, 'guest.js'),
  nativeDir: path.resolve(here, '../../../native/darwin-arm64'),
  ps: '/bin/ps',
});

export interface HelperRequest {
  readonly code: string;
  /** The genuine T3b handle of this run's catalogue snapshot; calls are admitted against it. */
  readonly validators: CallValidators;
  /** The exact revision the script was written against (it must equal the handle's). */
  readonly apiRevision: string;
  /** Methods this run may call; defaults to every method of the handle and must be a subset of it. */
  readonly methods?: readonly string[];
  /** The session's durable run record: with it, the lease is held across processes too (plan T7a-sleep). The broker always passes one. */
  readonly record?: RunRecordStore;
  /** The synthetic, trusted fixture host (typed settlement contract, scheduler.ts). No live authority. */
  readonly host: FixtureHost;
  /**
   * Optional synchronous check at the dispatch edge (plan T5b2; the T5b3 broker supplies native policy and transport
   * preparation here). It runs after every ledger check and after a deadline/abort check; the deadline and abort are
   * checked again after it returns, immediately before the call is marked dispatched and the host is called.
   */
  readonly authorize?: (call: AuthorizeCall) => EdgeVerdict;
  /**
   * Optional preflight run under the lease, inside the run wall, before any launch probe or spawn. Its bytes are
   * reported in `HelperResult.preflight`, never charged to a call. A preflight still pending at the deadline-triggered
   * stop or a caller abort keeps the lease until it settles.
   */
  readonly preflight?: (signal: AbortSignal) => Promise<PreflightReport>;
  readonly signal?: AbortSignal;
  /** Lower-only overrides of the run limits (limits.ts). */
  readonly limits?: Partial<RunLimits>;
}

/** What `authorize` is asked about: the run, the ledger ordinal and the call admitted through the T3b handle. */
export interface AuthorizeCall { readonly runId: string; readonly ordinal: number; readonly method: string; readonly argsText: string; readonly args: JsonValue }
/** A preflight's answer: whether the run may go on, and the response bytes it read (reported separately). */
export interface PreflightReport { readonly ok: boolean; readonly bytes: number }

export interface LaunchProof {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly helperProfileSha256: string;
  readonly probeProfileSha256: string;
  readonly binarySha256: string;
  readonly costMs: number;
}

/** The run's outcome in T3b terms; null when no script ran (refused, busy, cancelled or unavailable before the run). */
export type RunStatus = 'completed' | 'error' | 'partial-or-unknown';

export interface HelperResult {
  readonly status: 'busy' | 'unavailable' | 'cancelled' | 'wall-time' | 'quota' | 'violation' | 'finished' | 'crashed' | 'policy';
  /**
   * The helper's lifecycle when the result was assembled: `none` (nothing spawned), `confirmed` (its close was observed),
   * `pending` (killed, close not yet observed by the deadline; the lease is held and a later close is still observed),
   * `unknown` (the kill itself failed; the lease is held for good).
   */
  readonly cleanup: 'none' | 'confirmed' | 'pending' | 'unknown';
  /** completed only when the guest finished and every started call has a terminal receipt. */
  readonly runStatus: RunStatus | null;
  readonly runId: string | null;
  readonly reason: string | null;
  readonly spawned: boolean;
  /** Calls the parent dispatched to the host (from the ledger, never from the helper). */
  readonly hostCalls: number;
  /** The parent ledger when the result was assembled; later receipts update the live ledger, see `drained`. */
  readonly ledger: LedgerSnapshot | null;
  readonly evidence: readonly OperationEvidence[];
  /** Resolves when the lease is released; never resolves while a call is draining with no receipt or is unknown. */
  readonly drained: Promise<LedgerSnapshot> | null;
  readonly outcome: GuestOutcome | null;
  readonly probes: Readonly<Record<string, string>> | null;
  readonly listenerHits: Readonly<{ tcp: number; udp: number; unix: number }> | null;
  readonly launch: LaunchProof | null;
  readonly helperProfileSha256: string | null;
  readonly timings: Readonly<{ preflightMs: number; selfTestMs: number | null; totalMs: number }>;
  readonly peakRssKb: number;
  readonly killedBy: string | null;
  /** Largest number of helper-output bytes the parent ever held without a newline (bounded by MAX_LINE + one chunk). */
  readonly maxPendingBytes: number;
  /** The preflight's settled answer; null when there was none or it had not settled when the result was assembled. */
  readonly preflight: PreflightReport | null;
}

// ----- preflights -----

export function stackPreflight(): string | null {
  let v: string;
  try { v = execFileSync('/bin/sh', ['-c', 'ulimit -s'], { encoding: 'utf8', env: {} }).trim(); } catch { return 'stack rlimit unknown'; }
  if (v === 'unlimited') return null;
  const kb = Number(v);
  if (!Number.isFinite(kb)) return 'stack rlimit unknown';
  return kb < MIN_STACK_RLIMIT_KB ? `stack rlimit ${kb} KiB < ${MIN_STACK_RLIMIT_KB} KiB` : null;
}

export function platformPreflight(): string | null {
  // An x64 Node (including one translated by Rosetta) reports x64 and is refused even when the arm64 probe ships.
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return `unsupported platform ${process.platform}/${process.arch}`;
  return null;
}

/** The directory of an installed package, found from its resolved entry (its exports map may hide package.json). */
function packageDir(fromFile: string, name: string): string {
  const entry = realpathSync(createRequire(fromFile).resolve(name));
  for (let d = path.dirname(entry); d !== path.dirname(d); d = path.dirname(d)) {
    const pj = path.join(d, 'package.json');
    if (existsSync(pj)) {
      try { if ((JSON.parse(readFileSync(pj, 'utf8')) as { name?: unknown }).name === name) return d; } catch { /* not this one */ }
    }
  }
  throw new Error(`package ${name} not resolvable`);
}

/** The `node_modules/<name>` entries Node visits from `fromDir` until it finds the package (dirs and symlinks). */
function lookupEntries(fromDir: string, name: string): string[] {
  const out: string[] = [];
  for (let d = fromDir; d !== path.dirname(d); d = path.dirname(d)) {
    const nm = path.join(d, 'node_modules');
    const candidate = path.join(nm, name);
    out.push(nm);
    if (name.includes('/')) out.push(path.dirname(candidate));
    let found = false;
    try { lstatSync(candidate); found = true; } catch { /* keep walking */ }
    if (found) { out.push(candidate); break; }
  }
  return out;
}

/** Profile paths plus the pnpm symlink paths Node's resolver opens before following them (Node permission grants). */
export interface ResolvedPaths extends ProfilePaths {
  readonly links: readonly string[];
}

/** Real paths and metadata grants for one helper; any unresolved dependency throws (the run is unavailable). */
export function resolveProfilePaths(loc: HelperLocations): ResolvedPaths {
  const entry = realpathSync(loc.entry);
  const guest = realpathSync(loc.guest);
  const node = realpathSync(process.execPath);
  const qjsCore = packageDir(guest, 'quickjs-emscripten-core');
  const qjsSync = packageDir(guest, '@jitl/quickjs-wasmfile-release-sync');
  const qjsFfi = packageDir(path.join(qjsCore, 'package.json'), '@jitl/quickjs-ffi-types');
  const syncReal = qjsSync;
  const metadata = new Set<string>();
  const links = new Set<string>();
  for (const p of [node, entry, guest, qjsCore, qjsSync, qjsFfi]) for (const a of ancestorsOf(p)) metadata.add(a);
  const lookups = [
    lookupEntries(path.dirname(guest), 'quickjs-emscripten-core'),
    lookupEntries(path.dirname(guest), '@jitl/quickjs-wasmfile-release-sync'),
    lookupEntries(qjsCore, '@jitl/quickjs-ffi-types'),
    lookupEntries(syncReal, '@jitl/quickjs-ffi-types'),
  ];
  for (const chain of lookups) {
    const found = chain[chain.length - 1]!;
    if (realpathSync(found) !== found) links.add(found);
    for (const e of chain) {
      metadata.add(e);
      for (const a of ancestorsOf(e)) metadata.add(a);
    }
  }
  for (const p of [node, entry, guest, qjsCore, qjsSync, qjsFfi, ...metadata, ...links]) profilePath(p);
  return { node, helper: entry, probes: guest, qjsCore, qjsSync, qjsFfi, metadata: [...metadata].sort(), links: [...links].sort() };
}

// ----- native launch probe -----

interface ProbeManifest { v: 1; arch: 'arm64'; identifier: string; signature: string; sourceSha256: string; binarySha256: string; compiler: string }

/** The shipped probe and its manifest; null with a reason unless both exist and every hash matches. */
export function shippedProbe(nativeDir: string): { binary: string; binarySha256: string } | { reason: string } {
  const binary = path.join(nativeDir, 'procinfo-probe');
  const manifestFile = path.join(nativeDir, 'manifest.json');
  if (!existsSync(binary) || !existsSync(manifestFile)) return { reason: 'native probe not built' };
  let m: ProbeManifest;
  try { m = JSON.parse(readFileSync(manifestFile, 'utf8')) as ProbeManifest; } catch { return { reason: 'native probe manifest unreadable' }; }
  const keys = ['v', 'arch', 'identifier', 'signature', 'sourceSha256', 'binarySha256', 'compiler'];
  if (typeof m !== 'object' || m === null || Object.keys(m).sort().join() !== [...keys].sort().join() || m.v !== 1 || m.arch !== 'arm64') return { reason: 'native probe manifest malformed' };
  if (m.sourceSha256 !== PROCINFO_SOURCE_SHA256) return { reason: 'native probe built from another source' };
  const real = realpathSync(binary);
  const binarySha256 = sha256(readFileSync(real));
  if (binarySha256 !== m.binarySha256) return { reason: 'native probe hash mismatch' };
  return { binary: real, binarySha256 };
}

const launchCache = new Map<string, LaunchProof>();

export interface ProbeReport {
  readonly v: 1;
  readonly target: number;
  readonly ppid: number;
  readonly kinfo: { readonly errno: number; readonly read: boolean };
  readonly procargs2: { readonly errno: number; readonly read: boolean; readonly marker: boolean };
}

/** How a launch-probe attempt ended: `transient` failures (timeout, no report, start error) are not cached. */
export interface LaunchProbeResult {
  readonly reason: string | null;
  readonly report: ProbeReport | null;
  readonly transient: boolean;
  /** Ended by the caller's abort: never a verdict about the profile, never cached. */
  readonly cancelled: boolean;
  /** The owned process group (= the synthetic parent's pid), for cleanup checks; null if nothing was spawned. */
  readonly pgid: number | null;
}

const MAX_PROBE_OUTPUT = 16 * 1024;

/** SIGKILL to a process group this module created; a group that is already gone (ESRCH) is fine. */
/**
 * Signal a process group this module created. `gone` (ESRCH) means nothing was left; any other error is `failed` and
 * must not be read as a clean group. `signal` other than SIGKILL is used only by tests (signal 0 checks permission).
 */
export function killOwnedGroup(pgid: number | undefined, signal: NodeJS.Signals | 0 = 'SIGKILL'): 'killed' | 'gone' | `failed:${string}` {
  if (pgid === undefined || !Number.isSafeInteger(pgid) || pgid <= 1) return 'gone';
  try {
    process.kill(-pgid, signal);
    return 'killed';
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return code === 'ESRCH' ? 'gone' : `failed:${typeof code === 'string' ? code : 'error'}`;
  }
}

/**
 * Runs the probe as the direct child of a synthetic parent (env {}, marker in its argv) under the probe profile. Pass
 * only on: started line, exact JSON, ppid = the synthetic parent, kinfo errno 1 and procargs2 errno 1, nothing read.
 * The synthetic parent is spawned detached, so it leads its own process group and its sandbox-exec/probe child joins
 * it; every outcome other than a clean successful report kills that owned group (never anything found by name).
 * Closing the parent's stdin is its normal start signal, not a stop signal.
 */
export async function runLaunchProbe(probeBinary: string, probeProfile: string, signal?: AbortSignal): Promise<LaunchProbeResult> {
  const marker = `PARLEY_SYNTH_PARENT_${sha256(String(performance.now() + Math.random())).slice(0, 24)}`;
  const parentScript = `const { spawn } = require('node:child_process');
let input = ''; process.stdin.on('data', (d) => { input += d; }); process.stdin.on('end', () => {
  const { wrapper, profile, probe } = JSON.parse(input);
  const c = spawn(wrapper, ['-p', profile, probe, String(process.pid), process.argv[1]], { env: {}, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = ''; c.stdout.on('data', (d) => { out += d; if (out.length > 4096) c.kill('SIGKILL'); });
  c.on('error', () => { process.exit(3); });
  c.on('close', (code, sig) => { process.stdout.write(JSON.stringify({ out, code, sig })); });
});`;
  return new Promise((done) => {
    let report: ProbeReport | null = null;
    let settled = false;
    let parent: ReturnType<typeof spawn> | null = null;
    const onAbort = (): void => finish('cancelled', true, true);
    const finish = (reasonIn: string | null, transientIn = false, cancelledIn = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      let reason = reasonIn;
      let transient = transientIn;
      let cancelled = cancelledIn;
      if (reason !== null && parent?.pid !== undefined) {
        // Only "nothing left" (ESRCH) counts as clean; any other kill error is a definitive cleanup failure.
        if (killOwnedGroup(parent.pid).startsWith('failed')) { reason = PROBE_CLEANUP_FAILED; transient = false; cancelled = false; }
      }
      done({ reason, report, transient, cancelled, pgid: parent?.pid ?? null });
    };
    const timer = setTimeout(() => finish('native probe timed out', true), PROBE_TIMEOUT_MS);
    if (signal?.aborted) { finish('cancelled', true, true); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      parent = spawn(realpathSync(process.execPath), ['-e', parentScript, marker], { env: {}, stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    } catch {
      finish('native probe parent failed to start', true);
      return;
    }
    let raw = '';
    parent.stdout!.on('data', (d: Buffer) => { raw += d.toString(); if (raw.length > MAX_PROBE_OUTPUT) finish('native probe output too large'); });
    parent.on('error', () => finish('native probe parent failed to start', true));
    parent.stdin!.on('error', () => { /* the parent died; its close decides */ });
    parent.on('close', () => {
      let r: { out: string; code: number | null; sig: string | null };
      try { r = JSON.parse(raw) as typeof r; } catch { finish('native probe produced no report', true); return; }
      const lines = r.out.split('\n');
      if (lines[0] !== PROBE_STARTED) { finish('native probe did not start'); return; }
      if (r.code !== 0 || lines.length !== 3 || lines[2] !== '') { finish(`native probe failed (exit ${String(r.code ?? r.sig)})`); return; }
      let j: ProbeReport;
      try { j = JSON.parse(lines[1]!) as ProbeReport; } catch { finish('native probe report malformed'); return; }
      const exact = (o: unknown, keys: string[]): boolean => typeof o === 'object' && o !== null && Object.keys(o).sort().join() === [...keys].sort().join();
      if (!exact(j, ['v', 'target', 'ppid', 'kinfo', 'procargs2']) || j.v !== 1 || !exact(j.kinfo, ['errno', 'read']) || !exact(j.procargs2, ['errno', 'read', 'marker'])
        || ![j.target, j.ppid, j.kinfo.errno, j.procargs2.errno].every(Number.isSafeInteger) || ![j.kinfo.read, j.procargs2.read, j.procargs2.marker].every((b) => typeof b === 'boolean')) { finish('native probe report malformed'); return; }
      report = j;
      if (j.target !== parent!.pid || j.ppid !== parent!.pid) { finish('native probe did not run under the synthetic parent'); return; }
      if (j.kinfo.errno !== 1 || j.kinfo.read) { finish(`foreign kinfo_proc not denied (errno ${j.kinfo.errno})`); return; }
      if (j.procargs2.errno !== 1 || j.procargs2.read || j.procargs2.marker) { finish(`foreign KERN_PROCARGS2 not denied (errno ${j.procargs2.errno})`); return; }
      finish(null);
    });
    parent.stdin!.end(JSON.stringify({ wrapper: SANDBOX_EXEC, profile: probeProfile, probe: probeBinary }));
  });
}

/** Once per launch for a given helper profile, probe profile and probe binary; any change re-runs it. */
async function launchProof(paths: ProfilePaths, helperProfile: string, nativeDir: string, signal?: AbortSignal): Promise<LaunchProof> {
  const helperProfileSha256 = sha256(helperProfile);
  const shipped = shippedProbe(nativeDir);
  if ('reason' in shipped) return { ok: false, reason: shipped.reason, helperProfileSha256, probeProfileSha256: '', binarySha256: '', costMs: 0 };
  const probeProfile = renderProbeProfile(paths, shipped.binary);
  const probeProfileSha256 = sha256(probeProfile);
  const key = `${helperProfileSha256}:${probeProfileSha256}:${shipped.binarySha256}:${shipped.binary}`;
  const cached = launchCache.get(key);
  if (cached) return cached;
  const t0 = performance.now();
  const { reason, transient } = await runLaunchProbe(shipped.binary, probeProfile, signal);
  const proof: LaunchProof = Object.freeze({ ok: reason === null, reason, helperProfileSha256, probeProfileSha256, binarySha256: shipped.binarySha256, costMs: Math.round(performance.now() - t0) });
  // A definitive answer (pass, or a well-formed refusal) is cached for this identity. A transient failure (timeout, no
  // report, start error) is not: this run is unavailable, and the next run tries the probe again.
  if (!transient) launchCache.set(key, proof);
  return proof;
}

/** The launch proof for the product locations (for release verification and diagnostics). */
export async function checkLaunchProof(): Promise<LaunchProof | { ok: false; reason: string }> {
  const pre = platformPreflight();
  if (pre !== null) return { ok: false, reason: pre };
  let paths: ProfilePaths;
  try { paths = resolveProfilePaths(PRODUCT_LOCATIONS); } catch (e) { return { ok: false, reason: `unresolved helper dependency: ${(e as Error).message}` }; }
  return launchProof(paths, renderHelperProfile(paths), PRODUCT_LOCATIONS.nativeDir);
}

// ----- self-test listeners and judgement -----

interface Listeners {
  counts: { tcp: number; udp: number; unix: number };
  ports: { tcpPort: number; udpPort: number; tcp6Port: number; udp6Port: number; unixPath: string; secretFile: string };
  close(): void;
}

async function openListeners(): Promise<Listeners> {
  const counts = { tcp: 0, udp: 0, unix: 0 };
  const opened: (Server | dgram.Socket)[] = [];
  const dir = mkdtempSync(path.join(tmpdir(), 'parley-cm-'));
  const close = (): void => { for (const c of opened) { try { c.close(); } catch { /* closed */ } } rmSync(dir, { recursive: true, force: true }); };
  const tcp = (host: string): Promise<Server> => new Promise((res, rej) => { const s = createServer((c) => { counts.tcp++; c.destroy(); }); s.once('error', rej); s.listen(0, host, () => { opened.push(s); res(s); }); });
  const udp = (type: 'udp4' | 'udp6', host: string): Promise<dgram.Socket> => new Promise((res, rej) => { const s = dgram.createSocket(type); s.on('message', () => { counts.udp++; }); s.once('error', rej); s.bind(0, host, () => { opened.push(s); res(s); }); });
  try {
    const t4 = await tcp('127.0.0.1');
    const u4 = await udp('udp4', '127.0.0.1');
    const t6 = await tcp('::1');
    const u6 = await udp('udp6', '::1');
    const unixPath = path.join(dir, 's');
    await new Promise<void>((res, rej) => { const s = createServer((c) => { counts.unix++; c.destroy(); }); s.once('error', rej); s.listen(unixPath, () => { opened.push(s); res(); }); });
    const secretFile = path.join(dir, 'synthetic-secret');
    writeFileSync(secretFile, 'PARLEY_SYNTHETIC_SELF_TEST_FILE');
    const port = (s: Server | dgram.Socket): number => (s.address() as { port: number }).port;
    return { counts, ports: { tcpPort: port(t4), udpPort: port(u4), tcp6Port: port(t6), udp6Port: port(u6), unixPath, secretFile: realpathSync(secretFile) }, close };
  } catch (e) {
    close();
    throw e;
  }
}

const SELF_TEST_KEYS = ['loopbackTcp', 'outboundTcp', 'loopbackUdp', 'outboundUdp', 'loopbackTcp6', 'loopbackUdp6', 'outboundTcp6', 'outboundUdp6', 'unixSocket', 'dnsQuery', 'systemDns', 'fileRead', 'spawn', 'spawnNode'] as const;
const MUST_BE_DENIED = ['loopbackTcp', 'outboundTcp', 'loopbackUdp', 'outboundUdp', 'loopbackTcp6', 'loopbackUdp6', 'outboundTcp6', 'outboundUdp6', 'unixSocket', 'fileRead', 'spawn', 'spawnNode'] as const;

/** The parent's verdict on the helper's self-test report; null when every check passed. */
export function judgeSelfTest(probes: unknown): string | null {
  if (typeof probes !== 'object' || probes === null || Array.isArray(probes)) return 'malformed self-test report';
  const p = probes as Record<string, unknown>;
  if (Object.keys(p).sort().join() !== [...SELF_TEST_KEYS].sort().join() || !SELF_TEST_KEYS.every((k) => typeof p[k] === 'string' && (p[k] as string).length <= 64)) return 'malformed self-test report';
  const open = MUST_BE_DENIED.filter((k) => p[k] !== 'EPERM' && p[k] !== 'EACCES');
  if (open.length > 0) return `not denied: ${open.map((k) => `${k}=${String(p[k])}`).join(', ')}`;
  // Exact codes observed under the r3/r4 profile: c-ares reports its denied send as ECONNREFUSED (the parent also requires
  // zero packets at its UDP listener) and the system resolver fails with ENOTFOUND. Any other code is a changed OS
  // behaviour that needs review, so it is unavailable rather than passed.
  if (p.dnsQuery !== 'ECONNREFUSED') return `c-ares DNS not as expected: ${String(p.dnsQuery)}`;
  if (p.systemDns !== 'ENOTFOUND') return `system resolver not as expected: ${String(p.systemDns)}`;
  return null;
}

// ----- one run -----

const isPlain = (o: unknown): o is Record<string, unknown> => typeof o === 'object' && o !== null && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;
const keysWithin = (o: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every((k) => Object.hasOwn(o, k)) && Object.keys(o).every((k) => required.includes(k) || optional.includes(k));
const REFUSAL_KEYS: readonly (keyof GuestRefusals)[] = ['operations', 'argumentBytes', 'responseBytes', 'notSerializable', 'notParsed'];
/** Required on `done`: a line that omits it could not say a read was refused, so it is not a clean run. */
const refusalsOk = (v: unknown): boolean => isPlain(v) && keysWithin(v, REFUSAL_KEYS) && REFUSAL_KEYS.every((k) => Number.isSafeInteger(v[k]) && (v[k] as number) >= 0);

/** One RSS sample in KiB, or null when the tool failed or printed anything but a positive integer. */
function rssKb(ps: string, pid: number | undefined): number | null {
  if (pid === undefined) return null;
  try {
    const out = execFileSync(ps, ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', env: {}, timeout: 2000 }).trim();
    return /^[1-9]\d{0,9}$/.test(out) ? Number(out) : null;
  } catch {
    return null;
  }
}

/** How long a helper may stay alive after its `done` line. */
const POST_DONE_GRACE_MS = 1000;
/** Consecutive failed RSS samples after which the watchdog counts as gone and the run is stopped. */
const RSS_MAX_MISSED = 3;
/** Helper output is framed by newline; this many bytes without one is a violation. */
const MAX_PENDING = MAX_LINE;

export function runHelper(request: HelperRequest): Promise<HelperResult> {
  return runWith(PRODUCT_LOCATIONS, request);
}

interface RunContext {
  /** Monotonic clock (performance.now in product; tests may inject one through the runWith seam). */
  readonly clock: () => number;
  readonly t0: number;
  readonly deadline: number;
  readonly limits: RunLimits;
  readonly ledger: RunLedger;
  readonly runCtl: AbortController;
  readonly request: Readonly<{ code: string; methods: readonly string[]; host: FixtureHost; authorize: ((call: AuthorizeCall) => EdgeVerdict) | undefined }>;
}

const FAILED_PREFLIGHT: PreflightReport = Object.freeze({ ok: false, bytes: 0 });
/**
 * Exactly `{ ok: boolean, bytes: safe non-negative integer }` as own data properties of a plain object, copied once;
 * anything else is a failed preflight. Never throws: a proxy is refused before any reflection, and a throw while reading
 * (a hostile trap or accessor) is a failed preflight too.
 */
function readPreflight(v: unknown): PreflightReport {
  try {
    if (typeof v !== 'object' || v === null || utilTypes.isProxy(v)) return FAILED_PREFLIGHT;
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return FAILED_PREFLIGHT;
    const keys = Reflect.ownKeys(v);
    if (keys.length !== 2 || !keys.includes('ok') || !keys.includes('bytes')) return FAILED_PREFLIGHT;
    const ok = Object.getOwnPropertyDescriptor(v, 'ok');
    const bytes = Object.getOwnPropertyDescriptor(v, 'bytes');
    if (ok === undefined || bytes === undefined || !Object.hasOwn(ok, 'value') || !Object.hasOwn(bytes, 'value')) return FAILED_PREFLIGHT;
    if (typeof ok.value !== 'boolean' || !Number.isSafeInteger(bytes.value) || (bytes.value as number) < 0) return FAILED_PREFLIGHT;
    return Object.freeze({ ok: ok.value, bytes: bytes.value as number });
  } catch {
    return FAILED_PREFLIGHT;
  }
}

/** Why the run's own controller was aborted: the caller's signal or the total wall. */
const abortStatus = (ctl: AbortController): 'cancelled' | 'wall-time' => (ctl.signal.reason === 'wall-time' ? 'wall-time' : 'cancelled');

/**
 * The run with explicit file locations and scheduler. Product code calls `runHelper` (PRODUCT_LOCATIONS and the
 * process scheduler); fixtures pass other files or a fresh scheduler. Nothing here can skip a check, change the
 * template, its pin, the preflights, the empty environment, the Node flags or raise a limit.
 */
export async function runWith(loc: HelperLocations, request: HelperRequest, scheduler: SessionScheduler = SESSION_SCHEDULER, clock: () => number = () => performance.now()): Promise<HelperResult> {
  const t0 = clock();
  const base = { cleanup: 'none' as const, runStatus: null, runId: null, spawned: false, hostCalls: 0, ledger: null, evidence: [], drained: null, outcome: null, probes: null, listenerHits: null, launch: null, helperProfileSha256: null, peakRssKb: 0, killedBy: null, maxPendingBytes: 0, preflight: null };
  const early = (status: HelperResult['status'], reason: string): HelperResult =>
    ({ ...base, status, reason, timings: { preflightMs: Math.round(clock() - t0), selfTestMs: null, totalMs: Math.round(clock() - t0) } });
  if (request.signal?.aborted) return early('cancelled', 'aborted before start');
  // Owned, frozen snapshots of everything the caller passed, taken before the first await.
  const validators = request.validators;
  const apiRevision = request.apiRevision;
  if (typeof request.code !== 'string' || typeof apiRevision !== 'string' || typeof validators !== 'object' || validators === null || !Array.isArray(validators.methods)) return early('unavailable', 'invalid request');
  if (apiRevision !== validators.apiRevision) return early('unavailable', 'stale apiRevision');
  const methods = Object.freeze(request.methods === undefined ? [...validators.methods] : Array.isArray(request.methods) ? [...request.methods] : []);
  if (!methods.every((m) => typeof m === 'string' && validators.methods.includes(m))) return early('unavailable', 'methods outside the catalogue handle');
  const resolved = resolveRunLimits(request.limits);
  if (!resolved.ok) return early('unavailable', `invalid limits: ${resolved.problem}`);
  const limits = resolved.limits;
  const code = request.code;
  if (Buffer.byteLength(code, 'utf8') > limits.codeBytes) return early('unavailable', 'code too large');
  const host = request.host;
  const authorize = request.authorize;
  const preflightFn = request.preflight;
  if (typeof host !== 'function' || (authorize !== undefined && typeof authorize !== 'function') || (preflightFn !== undefined && typeof preflightFn !== 'function')) return early('unavailable', 'invalid request');
  // One run per session: a held lease refuses at once, with the holder and why.
  const leased = scheduler.acquire((runId) => new RunLedger(runId, validators, apiRevision, methods, limits), request.record);
  if (!leased.ok) return { ...early('busy', `${leased.reason} (${leased.holder})`) };
  const ledger = leased.lease.ledger;
  const runId = leased.lease.runId;
  // The run's own controller: the caller's abort or the total wall (from admission, no extra allowance) stops everything.
  const runCtl = new AbortController();
  const deadline = t0 + limits.wallMs;
  const onUserAbort = (): void => runCtl.abort('cancelled');
  request.signal?.addEventListener('abort', onUserAbort, { once: true });
  if (request.signal?.aborted) onUserAbort();
  // setTimeout truncates fractions and may fire just before the monotonic deadline; round up so the timer never runs early.
  const wallTimer = setTimeout(() => runCtl.abort('wall-time'), Math.max(0, Math.ceil(deadline - clock())));
  const ctx: RunContext = { clock, t0, deadline, limits, ledger, runCtl, request: Object.freeze({ code, methods, host, authorize }) };
  const withLedger = { runId, drained: ledger.whenQuiescent() };
  let spawnStarted = false;
  /** A preflight still pending when the run returned owns the lifecycle until it settles. */
  let preflightOwnsLifecycle = false;
  let preflight: PreflightReport | null = null;
  const stop = (status: HelperResult['status'], reason: string, extra: Partial<HelperResult> = {}): HelperResult => {
    ledger.end();
    return { ...base, ...withLedger, preflight, ...extra, status, reason, ledger: ledger.snapshot(), evidence: ledger.evidence(), timings: { preflightMs: Math.round(clock() - t0), selfTestMs: null, totalMs: Math.round(clock() - t0) } };
  };
  try {
    if (runCtl.signal.aborted) return stop(abortStatus(runCtl), 'aborted before start');
    if (preflightFn !== undefined) {
      // Under the lease and inside the wall. The run's own signal (caller abort or the wall timer) is passed in; a
      // throw, a rejection or a malformed answer is a failed preflight.
      let settled: Promise<PreflightReport>;
      // A total promise: it always fulfils with a report, so the late lifecycle observer below can never be stranded.
      try { settled = Promise.resolve(preflightFn(runCtl.signal)).then(readPreflight, () => FAILED_PREFLIGHT).catch(() => FAILED_PREFLIGHT); } catch { settled = Promise.resolve(FAILED_PREFLIGHT); }
      const STOPPED = Symbol('stopped');
      let offAbort = (): void => {};
      const stopped = new Promise<typeof STOPPED>((resolve) => {
        if (runCtl.signal.aborted) { resolve(STOPPED); return; }
        const h = (): void => resolve(STOPPED);
        runCtl.signal.addEventListener('abort', h, { once: true });
        offAbort = () => runCtl.signal.removeEventListener('abort', h);
      });
      const first = await Promise.race([settled, stopped]);
      offAbort();
      if (first === STOPPED) {
        // Deadline-triggered (subject to timer latency) or a caller abort: return now with cleanup pending. The lease is
        // held, reading "preflight pending", until the preflight itself settles; a preflight that never settles keeps it.
        preflightOwnsLifecycle = true;
        ledger.markPreflightPending();
        ledger.stopAdmission();
        void settled.then(() => ledger.lifecycleClosed());
        return {
          ...base, ...withLedger, status: abortStatus(runCtl), cleanup: 'pending', reason: `${runCtl.signal.reason === 'wall-time' ? 'run wall deadline' : 'cancelled'} while the preflight was pending`,
          ledger: ledger.snapshot(), evidence: ledger.evidence(), timings: { preflightMs: Math.round(clock() - t0), selfTestMs: null, totalMs: Math.round(clock() - t0) },
        };
      }
      preflight = first;
      // Time first: a report (refusing, malformed or ok) that settles at or after the deadline, or after an abort, is
      // wall-time/cancelled; only a refusal before both is `unavailable`. The settled report is kept either way.
      if (runCtl.signal.aborted || clock() >= deadline) return stop(runCtl.signal.aborted ? abortStatus(runCtl) : 'wall-time', 'stopped after the preflight');
      if (!first.ok) return stop('unavailable', 'preflight refused the run');
    }
    const platform = platformPreflight();
    if (platform !== null) return stop('unavailable', platform);
    const stack = stackPreflight();
    if (stack !== null) return stop('unavailable', stack);
    if (!existsSync(loc.wrapper)) return stop('unavailable', `wrapper missing: ${loc.wrapper}`);
    let paths: ResolvedPaths;
    let profile: string;
    try {
      paths = resolveProfilePaths(loc);
      profile = renderHelperProfile(paths);
    } catch (e) {
      return stop('unavailable', `helper not resolvable: ${(e as Error).message}`);
    }
    const helperProfileSha256 = sha256(profile);
    const launch = await launchProof(paths, profile, loc.nativeDir, runCtl.signal);
    // A probe group that could not be cleaned up never lets the lease go.
    if (launch.reason === PROBE_CLEANUP_FAILED) ledger.markCleanupUnknown();
    // A failed proof decides the outcome before the abort flag does: `cancelled`/`wall-time` only when the probe itself
    // reported a cancellation (after a clean kill of its group); every other failure is unavailable with its reason.
    if (!launch.ok) {
      if (launch.reason === 'cancelled') return stop(abortStatus(runCtl), 'stopped during the launch probe', { launch, helperProfileSha256 });
      return stop('unavailable', `launch probe: ${launch.reason ?? 'failed'}`, { launch, helperProfileSha256 });
    }
    if (runCtl.signal.aborted) return stop(abortStatus(runCtl), 'aborted before start', { launch, helperProfileSha256 });
    let listeners: Listeners;
    try { listeners = await openListeners(); } catch (e) { return stop('unavailable', `self-test listeners failed: ${(e as { code?: string }).code ?? 'error'}`, { launch, helperProfileSha256 }); }
    if (runCtl.signal.aborted) { listeners.close(); return stop(abortStatus(runCtl), 'aborted before start', { launch, helperProfileSha256 }); }
    const preflightMs = Math.round(clock() - t0);
    spawnStarted = true;
    try {
      // spawnRun owns the helper's lifecycle: it marks it closed only when it observes the close, possibly after this
      // result has returned with `cleanup: 'pending'`. Here admission simply stops; calls without a receipt drain.
      const r = await spawnRun(loc, paths, profile, listeners, ctx, { preflightMs, launch, helperProfileSha256 });
      ledger.stopAdmission();
      return { ...r, ...withLedger, preflight, ledger: ledger.snapshot(), evidence: ledger.evidence() };
    } finally {
      listeners.close();
    }
  } finally {
    clearTimeout(wallTimer);
    request.signal?.removeEventListener('abort', onUserAbort);
    // Nothing spawned and no preflight pending: the lifecycle is over. Otherwise only admission stops; the close observer
    // (or the pending preflight's settlement) decides the rest.
    if (spawnStarted || preflightOwnsLifecycle) ledger.stopAdmission();
    else ledger.end();
  }
}

function spawnRun(loc: HelperLocations, paths: ResolvedPaths, profile: string, listeners: Listeners, ctx: RunContext, info: { preflightMs: number; launch: LaunchProof; helperProfileSha256: string }): Promise<Omit<HelperResult, 'runId' | 'drained' | 'ledger' | 'evidence' | 'preflight'>> {
  // spawnRun is the owned close observer: ledger.lifecycleClosed() is called only from the child's observed close.
  const { limits, ledger, runCtl, request } = ctx;
  // Node permission sees the paths its resolver opens: the real files and dirs, plus the pnpm symlinks on the way to them.
  // The OS profile grants only the real paths (and metadata of the links); the kernel checks the resolved target.
  const grants = [paths.helper, paths.probes, paths.qjsCore, paths.qjsSync, paths.qjsFfi, ...paths.links, listeners.ports.secretFile].map((p) => `--allow-fs-read=${p}`);
  // --allow-child-process lets the self-test's spawn reach the OS layer, where the profile must deny it.
  const argv = ['-p', profile, paths.node, '--permission', ...grants, '--allow-child-process', ...HELPER_NODE_FLAGS, paths.helper];
  const cancels = new Map<LedgerEntry, AbortController>();
  return new Promise((resolve) => {
    const child = spawn(loc.wrapper, argv, { stdio: ['pipe', 'pipe', 'ignore'], env: {}, cwd: '/' });
    let phase: 'self-test' | 'checking' | 'running' | 'done' = 'self-test';
    let status: HelperResult['status'] = 'crashed';
    let reason: string | null = null;
    let outcome: GuestOutcome | null = null;
    let probes: Record<string, string> | null = null;
    let listenerHits: HelperResult['listenerHits'] = null;
    let selfTestMs: number | null = null;
    let killedBy: string | null = null;
    let peakRssKb = 0;
    let finished = false;
    let missedSamples = 0;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let maxPendingBytes = 0;
    /** Ask the host to cancel every call still in flight; only a typed `cancelled` receipt will record it. */
    const cancelInFlight = (): void => {
      for (const [entry, ctl] of cancels) {
        const now = ledger.snapshot().entries[entry.ordinal - 1];
        if (now !== undefined && (now.state === 'dispatched' || now.state === 'draining')) { ledger.requestCancel(entry); ctl.abort(); }
      }
    };
    const onRunAbort = (): void => {
      if (status === 'crashed') { status = abortStatus(runCtl); reason = runCtl.signal.reason === 'wall-time' ? 'run wall deadline' : 'aborted'; }
      finish(runCtl.signal.reason === 'wall-time' ? 'wall-time' : 'cancel');
    };
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    const armPending = (): void => {
      if (!closed && !responded && pendingTimer === null) pendingTimer = setTimeout(() => respond(cleanup === 'unknown' ? 'unknown' : 'pending'), Math.max(0, Math.ceil(ctx.deadline - ctx.clock())));
    };
    let closed = false;
    let responded = false;
    /** The post-done wait for in-flight calls ran into the deadline. */
    let waitTimedOut = false;
    let cleanup: HelperResult['cleanup'] = 'confirmed';
    const finish = (why: string, cancel = true): void => {
      if (finished) return;
      finished = true;
      // Any ending other than the guest's own `done`: stop admission and ask the host to cancel unresolved calls now.
      // A policy stop (`cancel` false) only stops admission: started calls drain to their receipts.
      if (phase !== 'done') { ledger.stopAdmission(); if (cancel) cancelInFlight(); }
      clearInterval(sampler);
      runCtl.signal.removeEventListener('abort', onRunAbort);
      if (!cancel) {
        // A caller abort or the wall during the drain still cancels the started calls (existing rules, U2).
        if (runCtl.signal.aborted) cancelInFlight();
        else runCtl.signal.addEventListener('abort', () => cancelInFlight(), { once: true });
      }
      pending = [];
      if (child.exitCode === null && child.signalCode === null) {
        killedBy ??= why;
        // A kill that cannot even be sent leaves cleanup unknown for good (U2).
        if (!child.kill('SIGKILL')) { cleanup = 'unknown'; ledger.markCleanupUnknown(); }
      }
      // The result never waits past the run deadline for the close, whether the helper was killed or exited by itself
      // with its close still withheld (s-292 X2): without it, the result says `pending`, the lease stays held, and the
      // close observer below still records the close when it comes.
      armPending();
    };
    const quota = (): void => {
      if (status !== 'unavailable' && status !== 'violation') status = 'quota';
      reason ??= 'response budget exhausted';
      finish('quota');
    };
    const refuse = (why: string): void => { status = 'unavailable'; reason = why; finish('self-test'); };
    /**
     * A terminal native-policy refusal (stale or revoked): no further call is admitted and the helper is stopped, but the
     * calls already started are NOT cancelled; the result waits (inside the wall) for their receipts.
     */
    const policyStop = (state: PolicyRefusal): void => {
      if (finished) return;
      status = 'policy';
      reason ??= `native policy ${state}`;
      finish('policy', false);
    };
    const budget: HostBudget = Object.freeze({ remainingRaw: () => ledger.rawRemaining });
    const violate = (why: string): void => { if (status !== 'unavailable') { status = 'violation'; reason ??= why; } finish('violation'); };
    // The soft RSS watchdog fails closed: a sample that cannot be taken counts; RSS_MAX_MISSED in a row stop the run, and a
    // valid sample within the soft limit is required before the script is sent (see the self-test handler).
    const sample = (): number | null => {
      const kb = rssKb(loc.ps, child.pid);
      if (kb === null) missedSamples++;
      else { missedSamples = 0; peakRssKb = Math.max(peakRssKb, kb); }
      return kb;
    };
    const sampler = setInterval(() => {
      if (finished || child.exitCode !== null || child.signalCode !== null) return;
      const kb = sample();
      if (kb !== null && kb > limits.rssSoftKb) { reason ??= 'soft RSS watchdog'; finish('rss-watchdog'); return; }
      if (missedSamples >= RSS_MAX_MISSED) {
        if (phase === 'running') { status = 'violation'; reason ??= 'RSS watchdog unavailable'; finish('rss-sampler'); } else refuse('RSS watchdog unavailable');
      }
    }, 50);
    runCtl.signal.addEventListener('abort', onRunAbort, { once: true });
    // An abort that fired before the listener was registered is not replayed by the signal: check it now.
    if (runCtl.signal.aborted) onRunAbort();
    child.stdin.on('error', () => { /* helper gone */ });
    if (!finished) child.stdin.write(`${JSON.stringify({ t: 'probe', ...listeners.ports })}\n`);
    const pastDeadline = (): boolean => ctx.clock() >= ctx.deadline;
    /** Send one rpc-result line, charging its serialized bytes to the response budget first; false if it does not fit. */
    const sendLine = (rid: number, entry: LedgerEntry | null, ok: boolean, value: string): boolean => {
      const line = `${JSON.stringify({ t: 'rpc-result', rid, ok, value })}\n`;
      if (!ledger.tryCharge(entry, Buffer.byteLength(line, 'utf8'))) return false;
      child.stdin.write(line);
      return true;
    };
    /**
     * Every message the guest gets is charged by its serialized IPC bytes: data, fixed failures, refusals, unknown and
     * cancelled alike. Data that does not fit becomes the fixed "not delivered" message (the call stays succeeded); if
     * even a fixed message does not fit, admission stops and the guest is stopped with a bounded quota outcome.
     */
    const deliver = (rid: number, entry: LedgerEntry | null, d: GuestDelivery | null): void => {
      if (d === null || finished || phase !== 'running' || !child.stdin.writable || pastDeadline()) return;
      if (d.ok) {
        // Pre-check the raw size against what is left, so oversized text is never re-serialized just to be rejected.
        if (Buffer.byteLength(d.text, 'utf8') <= ledger.deliveryRemaining && sendLine(rid, entry, true, d.text)) return;
        if (entry !== null) ledger.markUndeliverable(entry);
        if (!sendLine(rid, entry, false, GUEST_MESSAGES.undeliverable)) quota();
        return;
      }
      if (!sendLine(rid, entry, false, d.message)) quota();
    };
    // Newline framing with a byte cap: the parent never holds more than MAX_PENDING bytes of an unterminated line plus the
    // chunk that crossed it, and a line is measured before it is parsed.
    child.stdout.on('data', (chunk: Buffer) => {
      if (finished) return;
      let start = 0;
      for (let nl = chunk.indexOf(0x0a); nl !== -1 && !finished; nl = chunk.indexOf(0x0a, start)) {
        const piece = chunk.subarray(start, nl);
        const lineBytes = pendingBytes + piece.length;
        const line = lineBytes > MAX_LINE ? null : Buffer.concat([...pending, piece]).toString('utf8');
        pending = [];
        pendingBytes = 0;
        start = nl + 1;
        if (line === null) { if (phase === 'self-test') refuse('helper output line too long'); else violate('helper output line too long'); return; }
        onLine(line);
      }
      if (finished || start >= chunk.length) return;
      pending.push(chunk.subarray(start));
      pendingBytes += chunk.length - start;
      maxPendingBytes = Math.max(maxPendingBytes, pendingBytes);
      if (pendingBytes > MAX_PENDING) { if (phase === 'self-test') refuse('helper output line too long'); else violate('helper output line too long'); }
    });
    const onLine = (line: string): void => {
      if (finished) return;
      let m: unknown;
      try { m = JSON.parse(line); } catch { m = null; }
      if (!isPlain(m) || typeof m.t !== 'string') { if (phase === 'self-test') refuse('malformed helper output before the self-test'); else violate('malformed helper line'); return; }
      if (m.t === 'probed') {
        if (phase !== 'self-test' || !keysWithin(m, ['t', 'probes'])) { violate('bad self-test message'); return; }
        phase = 'checking';
        const verdict = judgeSelfTest(m.probes);
        if (verdict !== null) { probes = isPlain(m.probes) ? (m.probes as Record<string, string>) : null; listenerHits = { ...listeners.counts }; refuse(`self-test failed: ${verdict}`); return; }
        probes = m.probes as Record<string, string>;
        // Let stray packets or connections arrive, then require that none reached a parent listener.
        setTimeout(() => {
          if (finished) return;
          listenerHits = { ...listeners.counts };
          const hits = listeners.counts.tcp + listeners.counts.udp + listeners.counts.unix;
          if (hits > 0) { refuse(`self-test failed: ${hits} listener hits`); return; }
          const gate = sample();
          if (gate === null) { refuse('RSS watchdog unavailable'); return; }
          if (gate > limits.rssSoftKb) { refuse('soft RSS limit exceeded before run'); return; }
          selfTestMs = Math.round(ctx.clock() - ctx.t0) - info.preflightMs;
          phase = 'running';
          // The guest gets the wall that is left; the parent's own deadline stays the run wall.
          child.stdin.write(`${JSON.stringify({ t: 'run', code: request.code, methods: [...request.methods], limits: guestLimitsFor(limits, ctx.deadline - ctx.clock()) })}\n`);
        }, 100);
        return;
      }
      if (m.t === 'fatal') {
        if (!keysWithin(m, ['t', 'reason']) || typeof m.reason !== 'string') { violate('bad fatal'); return; }
        if (phase !== 'running') refuse(`helper refused before run: ${m.reason.slice(0, 64)}`);
        else { reason = `helper fatal: ${m.reason.slice(0, 64)}`; finish('fatal'); }
        return;
      }
      if (m.t === 'done') {
        if (phase !== 'running') { violate(`done in phase ${phase}`); return; }
        // A done that arrives after the deadline is not a finished run: the wall decided first.
        if (pastDeadline()) { if (!runCtl.signal.aborted) runCtl.abort('wall-time'); return; }
        const o = m as Record<string, unknown>;
        const ok = keysWithin(o, ['t', 'ok', 'rpcs', 'unsettled', 'refused', 'activeMs', 'disposed'], ['value', 'error'])
          && typeof o.ok === 'boolean' && (o.ok ? typeof o.value === 'string' && o.error === undefined : o.value === undefined && isPlain(o.error) && keysWithin(o.error, ['kind', 'message']) && typeof o.error.kind === 'string' && typeof o.error.message === 'string' && o.error.message.length <= 512)
          && Number.isSafeInteger(o.rpcs) && Array.isArray(o.unsettled) && o.unsettled.every(Number.isSafeInteger) && refusalsOk(o.refused) && Number.isFinite(o.activeMs) && typeof o.disposed === 'boolean';
        if (!ok) { violate('bad done'); return; }
        const rest: Record<string, unknown> = { ...o };
        delete rest.t;
        outcome = rest as unknown as GuestOutcome;
        phase = 'done';
        status = 'finished';
        // The real helper exits right after `done`; one that lingers is killed after a short grace (lifecycle cleanup,
        // not a host settlement: its calls keep their ledger state).
        setTimeout(() => finish('post-done'), POST_DONE_GRACE_MS).unref();
        return;
      }
      if (m.t !== 'rpc') { violate('unknown message type'); return; }
      if (phase !== 'running') { violate(`rpc in phase ${phase}`); return; }
      if (!keysWithin(m, ['t', 'rid', 'method', 'args']) || !Number.isSafeInteger(m.rid) || (m.rid as number) <= 0 || typeof m.method !== 'string' || typeof m.args !== 'string') { violate('bad rpc shape'); return; }
      const rid = m.rid as number;
      // The deadline is checked by monotonic time at the dispatch edge too, not only by the wall timer.
      if (pastDeadline()) ledger.stopAdmission();
      // The edge, synchronously: deadline/abort → authorize (policy, transport preparation) → deadline/abort again →
      // dispatched → the host call below, with no await in between.
      const a = ledger.admit(rid, m.method, m.args, (call, ordinal): EdgeVerdict => {
        if (pastDeadline() || runCtl.signal.aborted) return { ok: false, reason: 'run-ended' };
        if (request.authorize === undefined) return { ok: true };
        const v = request.authorize(Object.freeze({ runId: ledger.runId, ordinal, method: call.method, argsText: call.argsText, args: call.args }));
        // Time first, for every verdict (P3): a deadline or abort crossed during the callback refuses as run-ended, so the
        // run ends wall-time/cancelled rather than by the verdict; only a timely verdict is classified by the ledger.
        if (pastDeadline() || runCtl.signal.aborted) return { ok: false, reason: 'run-ended' };
        return v;
      });
      if (a.kind === 'violation') { violate(VIOLATION_TEXT[a.reason]); return; }
      if (a.kind === 'refuse') {
        // A terminal policy refusal stops first and sends no line (the helper is killed): a refusal line that did not fit
        // the delivered budget must never turn the drain into a quota stop that cancels started calls.
        if (a.entry.policy === 'stale' || a.entry.policy === 'revoked') { policyStop(a.entry.policy); return; }
        if (a.reason === 'run-ended' && pastDeadline() && !runCtl.signal.aborted) runCtl.abort('wall-time');
        deliver(rid, a.entry, { ok: false, message: a.reason === 'unsettled-capacity' ? GUEST_MESSAGES.capacity : a.reason === 'policy' ? GUEST_MESSAGES.policy : GUEST_MESSAGES.refused });
        return;
      }
      const cancel = new AbortController();
      cancels.set(a.entry, cancel);
      let settlement: Promise<unknown>;
      try {
        settlement = Promise.resolve(request.host({ runId: ledger.runId, ordinal: a.entry.ordinal, method: a.call.method, argsText: a.call.argsText }, cancel.signal, budget));
      } catch {
        deliver(rid, a.entry, ledger.settleUncertain(a.entry, 'host-threw'));
        return;
      }
      settlement
        .then((v) => deliver(rid, a.entry, ledger.settle(a.entry, v)), () => deliver(rid, a.entry, ledger.settleUncertain(a.entry, 'host-rejected')))
        .catch(() => { deliver(rid, a.entry, ledger.settleUncertain(a.entry, 'settle-threw')); });
    };
    child.on('error', () => { reason ??= 'wrapper failed to start'; });
    /** Assemble and return the result once. `cleanup` says what is known about the helper's lifecycle at this moment. */
    const respond = (cleanupNow: HelperResult['cleanup']): void => {
      if (responded) return;
      responded = true;
      if (pendingTimer !== null) clearTimeout(pendingTimer);
      // The final value is validated once; THEN completion is judged by monotonic time (s-292 X1): at or past the
      // deadline the run is wall-time and never completed, even if `done` arrived in time and the timer has not fired.
      const valueOk = outcome !== null && outcome.ok && finalValueOk(outcome.value, limits);
      const late = ctx.clock() >= ctx.deadline || runCtl.signal.reason === 'wall-time' || waitTimedOut;
      if (late && (status === 'finished' || status === 'crashed')) { status = 'wall-time'; reason ??= 'run wall deadline'; }
      // Whatever has no receipt at this point is asked to cancel, draining calls included: the wall timer can fire just after this
      // response, and a result must not say that nothing asked a draining call to stop.
      if (ledger.awaitingReceipt > 0) cancelInFlight();
      if (cleanupNow !== 'confirmed') reason = reason === null ? `helper exit ${cleanupNow === 'pending' ? 'not yet confirmed' : 'unconfirmable'}` : `${reason}; helper exit ${cleanupNow === 'pending' ? 'not yet confirmed' : 'unconfirmable'}`;
      let runStatus: RunStatus;
      if (!ledger.allSettled || cleanupNow !== 'confirmed') runStatus = 'partial-or-unknown';
      else if (!late && status === 'finished' && valueOk) runStatus = 'completed';
      else runStatus = 'error';
      if (outcome !== null && outcome.ok && !valueOk) reason ??= 'final value is not bounded strict JSON';
      resolve({
        status, cleanup: cleanupNow, runStatus, reason, spawned: true, hostCalls: ledger.snapshot().dispatched, outcome, probes, listenerHits, launch: info.launch, helperProfileSha256: info.helperProfileSha256,
        timings: { preflightMs: info.preflightMs, selfTestMs, totalMs: Math.round(ctx.clock() - ctx.t0) }, peakRssKb, killedBy, maxPendingBytes,
      });
    };
    /** The owned close observer: the only place the lifecycle is marked closed, even after a `pending` result. */
    const onClose = (exitCode: number | null, sig: NodeJS.Signals | null): void => {
      closed = true;
      ledger.lifecycleClosed();
      if (responded) return;
      if ((phase === 'self-test' || phase === 'checking') && status === 'crashed') { status = 'unavailable'; reason ??= `helper exited before the self-test passed (${String(exitCode ?? sig)})`; }
      else if (status === 'crashed') reason ??= `helper exited without a result (${String(exitCode ?? sig)})`;
      finish('exit');
      void (async () => {
        // A guest that returned while calls were still in flight (fire-and-forget): wait for their receipts inside the
        // run wall. Whatever is still in flight after the wall, or after any other ending, is asked to cancel and drains.
        // A policy stop drains the same way: started calls (now draining) get their receipts inside the wall.
        const draining = status === 'policy' && ledger.awaitingReceipt > 0;
        if (((status === 'finished' && ledger.inFlight > 0) || draining) && !runCtl.signal.aborted) {
          const settled = await Promise.race([
            draining ? ledger.waitForReceipts(Math.ceil(ctx.deadline - ctx.clock())) : ledger.waitForInFlight(Math.ceil(ctx.deadline - ctx.clock())),
            new Promise<boolean>((r) => runCtl.signal.addEventListener('abort', () => r(false), { once: true })),
          ]);
          if (!settled && runCtl.signal.reason !== 'cancelled') waitTimedOut = true;
        }
        respond(cleanup === 'unknown' ? 'unknown' : 'confirmed');
      })();
    };
    // An observed exit may come before its last output lines are read, so it does not end the run's work by itself; it
    // only arms the deadline response, so a close withheld by an inherited pipe can never hang the caller (s-292 X2).
    child.on('exit', () => armPending());
    child.on('close', onClose);
  });
}

const VIOLATION_TEXT: Readonly<Record<Violation, string>> = Object.freeze({
  'duplicate-rid': 'duplicate rid',
  'method-not-in-run': 'method not allowed',
  'call-budget': 'call budget exceeded',
  'in-flight': 'too many calls in flight',
  'arguments-too-large': 'arguments too large',
});

/** The final value the guest returned: strict JSON within the result budget. */
function finalValueOk(value: string | undefined, limits: RunLimits): boolean {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > limits.resultBytes) return false;
  try { parseStrictJson(value, { ...RESULT_LIMITS, maxBytes: limits.resultBytes }); return true; } catch { return false; }
}
