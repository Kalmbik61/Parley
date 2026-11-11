// Code Mode guest runtime (plan T4a): ONE script in QuickJS-WASM (sync variant, accepted T2b pins) with a promise/job
// bridge. The guest sees exactly one capability, `parley.<method>(args) -> Promise<JSON>`, whose calls leave as strings
// through the injected bridge. No host object or function crosses into the guest; no module loader is installed.
// This module is loaded by the sandboxed helper process (helper-entry.ts) and, in tests, in-process. It must not import
// node:os (it needs sysctl, which the helper profile denies) or anything outside the QuickJS packages.

import { performance } from 'node:perf_hooks';
import variantImport from '@jitl/quickjs-wasmfile-release-sync';
import { DefaultIntrinsics, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSSyncVariant, newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';

// The package ships CJS-style typings for an ESM default export; at runtime the ESM default is the variant itself.
const variantModule = variantImport as unknown as QuickJSSyncVariant | { default: QuickJSSyncVariant };
const variant: QuickJSSyncVariant = 'default' in variantModule ? variantModule.default : variantModule;
// The core lib has no DOM/WebAssembly typings; the Node global exists at runtime.
const WasmMemory = (globalThis as unknown as { WebAssembly: { Memory: new (d: { initial: number; maximum: number }) => object } }).WebAssembly.Memory;

export interface GuestLimits {
  readonly codeBytes: number;
  /** Cumulative interpreter time (eval and pending jobs), not time spent awaiting the host. */
  readonly activeMs: number;
  readonly wallMs: number;
  /** Hard bound: the maximum of the caller-supplied WebAssembly.Memory. */
  readonly memoryBytes: number;
  readonly stackBytes: number;
  readonly maxRpcs: number;
  readonly maxInFlight: number;
  readonly argBytes: number;
  readonly responseBytes: number;
  readonly resultBytes: number;
}

/** Design §6 starting limits; T2b r4 accepted the 48 MiB WASM maximum and the 128 KiB guest stack. */
const PAGE = 65536;

export const GUEST_LIMITS: GuestLimits = Object.freeze({
  codeBytes: 32 * 1024,
  activeMs: 1000,
  wallMs: 30_000,
  memoryBytes: 48 * 1024 * 1024,
  stackBytes: 128 * 1024,
  maxRpcs: 32,
  maxInFlight: 2,
  argBytes: 64 * 1024,
  responseBytes: 1024 * 1024,
  resultBytes: 16 * 1024,
});

/**
 * Physical maxima that no caller may raise (T2b r4): the 48 MiB WASM linear-memory maximum and the 128 KiB guest stack
 * (512 KiB crashed the host under --stack-size=4000). Lower values are allowed; the WASM floor is its 16 MiB initial size.
 */
export const PHYSICAL_MAXIMA = Object.freeze({ memoryBytes: 48 * 1024 * 1024, stackBytes: 128 * 1024 });
const LIMIT_KEYS = ['codeBytes', 'activeMs', 'wallMs', 'memoryBytes', 'stackBytes', 'maxRpcs', 'maxInFlight', 'argBytes', 'responseBytes', 'resultBytes'] as const;

/** null when `limits` has exactly the limit keys, each a positive safe integer, within the physical maxima. */
export function guestLimitsProblem(limits: unknown): string | null {
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) return 'limits must be an object';
  const l = limits as Record<string, unknown>;
  if (Object.keys(l).length !== LIMIT_KEYS.length || !LIMIT_KEYS.every((k) => Object.hasOwn(l, k))) return 'limits must have exactly the known keys';
  for (const k of LIMIT_KEYS) if (!Number.isSafeInteger(l[k]) || (l[k] as number) <= 0) return `${k} must be a positive safe integer`;
  const memory = l.memoryBytes as number;
  if (memory > PHYSICAL_MAXIMA.memoryBytes) return 'memoryBytes above the 48 MiB maximum';
  if (memory % PAGE !== 0 || memory < 256 * PAGE) return 'memoryBytes must be whole WASM pages and at least 16 MiB';
  if ((l.stackBytes as number) > PHYSICAL_MAXIMA.stackBytes) return 'stackBytes above the 128 KiB maximum';
  return null;
}

export interface GuestCall { readonly rid: number; readonly method: string; readonly args: string }
export interface GuestReply { readonly rid: number; readonly ok: boolean; readonly value: string }

/** The only route out of the guest. `next` resolves with a reply, or null when `timeoutMs` passes first. */
export interface GuestBridge {
  send(call: GuestCall): void;
  next(timeoutMs: number): Promise<GuestReply | null>;
}

export type GuestErrorKind = 'syntax' | 'runtime' | 'interrupted' | 'wall-time' | 'deadlock' | 'result' | 'result-size' | 'memory' | 'protocol';

/**
 * Calls the script asked for and this runtime refused on its own: the parent never sees them, so it cannot count them. Kept on the
 * host side of QuickJS, out of the script's reach. (T7a-guest-floor; a throw in the guest's own `JSON.stringify` forms no call and
 * is the script's own error, not counted here.)
 */
export interface GuestRefusals {
  readonly operations: number;
  readonly argumentBytes: number;
  readonly responseBytes: number;
  /** Arguments that did not stringify to a string: a function, a symbol, a `toJSON` returning undefined. */
  readonly notSerializable: number;
  /** Replies delivered whose parse was never acknowledged: the parent's strict JSON fails here only for lack of memory or stack. */
  readonly notParsed: number;
}
const NO_REFUSALS: GuestRefusals = Object.freeze({ operations: 0, argumentBytes: 0, responseBytes: 0, notSerializable: 0, notParsed: 0 });

export interface GuestOutcome {
  readonly ok: boolean;
  /** The guest's final value as JSON text (only when ok). */
  readonly value?: string;
  /** Raw guest error text is bounded and belongs to the separate guest channel, never to safe diagnostics. */
  readonly error?: { readonly kind: GuestErrorKind; readonly message: string };
  readonly rpcs: number;
  /** Calls started but not settled when the run ended, queued ones that never left the guest included: reported, never dropped. */
  readonly unsettled: readonly number[];
  readonly refused: GuestRefusals;
  readonly activeMs: number;
  /** All guest handles, the context and the runtime were disposed without error. */
  readonly disposed: boolean;
}

const MESSAGE_CHARS = 512;
const bounded = (s: string): string => (s.length > MESSAGE_CHARS ? `${s.slice(0, MESSAGE_CHARS - 1)}…` : s);
const METHOD = /^[a-z][a-z0-9_]{0,63}$/;

function errorText(ctx: QuickJSContext, handle: QuickJSHandle): string {
  try {
    const dumped: unknown = ctx.dump(handle);
    if (dumped !== null && typeof dumped === 'object') {
      const e = dumped as { name?: unknown; message?: unknown };
      return bounded(`${typeof e.name === 'string' ? e.name : 'Error'}: ${typeof e.message === 'string' ? e.message : ''}`);
    }
    return bounded(String(dumped));
  } catch {
    return 'unreadable guest error';
  }
}

/**
 * Prelude, evaluated before the script: freezes `parley` over the private `__rpc`, removes the global name, `eval` and
 * every Function constructor reachable from function prototypes. Hardening, not the boundary: they could only
 * evaluate more guest code inside the same sandbox.
 *
 * `__parsed` acknowledges one parsed reply (T7a-guest-floor). Positive, so that running out of memory at the parse fails closed. It
 * and the parse run in a callback the script cannot obtain or call with another string: `JSON.parse`, `Promise.prototype.then` and
 * `Reflect.apply` are taken here, before the script, and a replaced one is never asked.
 */
const prelude = (methods: readonly string[]): string => `(() => { const rpc = globalThis.__rpc; delete globalThis.__rpc;
  const parsed = globalThis.__parsed; delete globalThis.__parsed;
  const parse = JSON.parse, then = Promise.prototype.then, apply = Reflect.apply;
  delete globalThis.eval;
  for (const f of [function () {}, async function () {}, function* () {}, async function* () {}]) {
    Object.defineProperty(Object.getPrototypeOf(f), 'constructor', { value: undefined, writable: false, configurable: false });
  }
  delete globalThis.Function;
  const api = Object.create(null);
  for (const m of ${JSON.stringify(methods)}) api[m] = (args) => apply(then, rpc(m, JSON.stringify(args === undefined ? {} : args)), [(s) => { const v = parse(s); parsed(); return v; }]);
  Object.defineProperty(globalThis, 'parley', { value: Object.freeze(api), writable: false, configurable: false });
})();`;

/** Runs one script. Never throws for guest behaviour; a broken WASM instance is reported as `memory`. */
export async function runGuest(code: string, methodsIn: readonly string[], limitsIn: GuestLimits, bridge: GuestBridge): Promise<GuestOutcome> {
  // Owned, frozen snapshots taken before the first await: a caller that changes its arrays or limits object afterwards
  // changes nothing here. The copy is validated, not the caller's object, so a getter cannot pass one value and use another.
  const methods: readonly string[] = Object.freeze(Array.isArray(methodsIn) ? [...methodsIn] : []);
  const limits: GuestLimits = Object.freeze(typeof limitsIn === 'object' && limitsIn !== null ? { ...limitsIn } : ({} as GuestLimits));
  if (typeof code !== 'string') return { ok: false, error: { kind: 'protocol', message: 'code must be a string' }, rpcs: 0, unsettled: [], refused: NO_REFUSALS, activeMs: 0, disposed: true };
  if (!methods.every((m) => typeof m === 'string' && METHOD.test(m))) return { ok: false, error: { kind: 'protocol', message: 'bad method name' }, rpcs: 0, unsettled: [], refused: NO_REFUSALS, activeMs: 0, disposed: true };
  if (Buffer.byteLength(code, 'utf8') > limits.codeBytes) return { ok: false, error: { kind: 'protocol', message: 'code too large' }, rpcs: 0, unsettled: [], refused: NO_REFUSALS, activeMs: 0, disposed: true };
  const limitProblem = guestLimitsProblem(limits);
  if (limitProblem !== null) return { ok: false, error: { kind: 'protocol', message: `bad limits: ${limitProblem}` }, rpcs: 0, unsettled: [], refused: NO_REFUSALS, activeMs: 0, disposed: true };
  // Hard guest memory bound: the WASM linear memory itself. setMemoryLimit below is advisory only (T2b: not a hard cap).
  const QuickJS = await newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmMemory: new WasmMemory({ initial: 256, maximum: limits.memoryBytes / PAGE }) as never }));
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  let activeMs = 0;
  let sliceStart: number | null = null;
  runtime.setInterruptHandler(() => sliceStart !== null && activeMs + (performance.now() - sliceStart) > limits.activeMs);
  const inGuest = <T>(fn: () => T): T => {
    sliceStart = performance.now();
    try { return fn(); } finally { activeMs += performance.now() - sliceStart; sliceStart = null; }
  };
  // In 0.32 `Eval: false` also disables the host's own evalCode, so Eval stays on and the prelude removes it instead.
  const ctx = runtime.newContext({ intrinsics: { ...DefaultIntrinsics } });

  interface Job { rid: number; method: string; args: string; deferred: QuickJSDeferredPromise }
  const pending = new Map<number, Job>();
  const queue: Job[] = [];
  let rid = 0;
  let rpcs = 0;
  let inFlight = 0;
  let responseBytes = 0;
  const refused = { ...NO_REFUSALS };
  let delivered = 0;
  let acknowledged = 0;
  const pump = (): void => {
    while (inFlight < limits.maxInFlight && queue.length > 0) {
      const job = queue.shift()!;
      inFlight++;
      pending.set(job.rid, job);
      bridge.send({ rid: job.rid, method: job.method, args: job.args });
    }
  };

  const finish = (outcome: Omit<GuestOutcome, 'rpcs' | 'unsettled' | 'refused' | 'activeMs' | 'disposed'>): GuestOutcome => {
    const unsettled = [...pending.keys(), ...queue.map((j) => j.rid)];
    let disposed = true;
    try {
      for (const j of [...pending.values(), ...queue]) j.deferred.dispose();
      ctx.dispose();
      runtime.dispose();
    } catch {
      disposed = false;
    }
    return { ...outcome, rpcs, unsettled, refused: { ...refused, notParsed: Math.max(0, delivered - acknowledged) }, activeMs: Math.round(activeMs), disposed };
  };

  try {
    // The only host function: strings in, a promise handle out.
    const rpcFn = ctx.newFunction('__rpc', (methodH, argsH) => {
      const method = ctx.typeof(methodH) === 'string' ? ctx.getString(methodH) : null;
      const args = ctx.typeof(argsH) === 'string' ? ctx.getString(argsH) : null;
      if (method === null || args === null || !methods.includes(method)) { refused.notSerializable++; return { error: ctx.newError('parley: unknown method') }; }
      if (Buffer.byteLength(args, 'utf8') > limits.argBytes) { refused.argumentBytes++; return { error: ctx.newError('parley: arguments too large') }; }
      if (rpcs >= limits.maxRpcs) { refused.operations++; return { error: ctx.newError('parley: call budget exhausted') }; }
      rpcs++;
      const deferred = ctx.newPromise();
      queue.push({ rid: ++rid, method, args, deferred });
      pump();
      return deferred.handle;
    });
    ctx.setProp(ctx.global, '__rpc', rpcFn);
    rpcFn.dispose();
    const parsedFn = ctx.newFunction('__parsed', () => { acknowledged++; });
    ctx.setProp(ctx.global, '__parsed', parsedFn);
    parsedFn.dispose();
    const pre = inGuest(() => ctx.evalCode(prelude(methods), 'prelude.js'));
    if (pre.error) { pre.error.dispose(); return finish({ ok: false, error: { kind: 'protocol', message: 'prelude failed' } }); }
    pre.value.dispose();

    // Syntax (including any static import) is checked before anything can be dispatched: compile only.
    const wrapped = `(async () => {\n${code}\n})().then((v) => JSON.stringify(v === undefined ? null : v))`;
    const compiled = ctx.evalCode(wrapped, 'guest.js', { compileOnly: true });
    if (compiled.error) {
      const message = errorText(ctx, compiled.error);
      compiled.error.dispose();
      return finish({ ok: false, error: { kind: 'syntax', message } });
    }
    compiled.value.dispose();

    const wallDeadline = performance.now() + limits.wallMs;
    const result = inGuest(() => ctx.evalCode(wrapped, 'guest.js'));
    if (result.error) {
      const message = errorText(ctx, result.error);
      result.error.dispose();
      return finish({ ok: false, error: { kind: activeMs > limits.activeMs ? 'interrupted' : 'runtime', message } });
    }
    const promise = result.value;
    type Partial = Omit<GuestOutcome, 'rpcs' | 'unsettled' | 'refused' | 'activeMs' | 'disposed'>;
    let outcome: Partial | null = null;
    while (outcome === null) {
      const jobs = inGuest(() => runtime.executePendingJobs());
      if (jobs.error) {
        const message = errorText(ctx, jobs.error);
        jobs.error.dispose();
        outcome = { ok: false, error: { kind: activeMs > limits.activeMs ? 'interrupted' : 'runtime', message } };
        break;
      }
      const state = ctx.getPromiseState(promise);
      if (state.type === 'fulfilled') {
        const s = ctx.typeof(state.value) === 'string' ? ctx.getString(state.value) : null;
        state.value.dispose();
        if (s === null) outcome = { ok: false, error: { kind: 'result', message: 'non-string result' } };
        else if (Buffer.byteLength(s, 'utf8') > limits.resultBytes) outcome = { ok: false, error: { kind: 'result-size', message: 'result too large' } };
        else outcome = { ok: true, value: s };
        break;
      }
      if (state.type === 'rejected') {
        const message = errorText(ctx, state.error);
        state.error.dispose();
        outcome = { ok: false, error: { kind: activeMs > limits.activeMs ? 'interrupted' : 'runtime', message } };
        break;
      }
      if (inFlight === 0 && queue.length === 0) { outcome = { ok: false, error: { kind: 'deadlock', message: 'the guest awaits nothing the host can settle' } }; break; }
      const left = wallDeadline - performance.now();
      if (left <= 0) { outcome = { ok: false, error: { kind: 'wall-time', message: 'wall deadline' } }; break; }
      const reply = await bridge.next(left);
      if (reply === null) continue;
      const job = pending.get(reply.rid);
      if (job === undefined) { outcome = { ok: false, error: { kind: 'protocol', message: 'reply for an unknown call' } }; break; }
      pending.delete(reply.rid);
      inFlight--;
      responseBytes += Buffer.byteLength(reply.value, 'utf8');
      if (responseBytes > limits.responseBytes) refused.responseBytes++;
      const h = responseBytes > limits.responseBytes ? ctx.newError('parley: response budget exhausted') : reply.ok ? ctx.newString(reply.value) : ctx.newError(reply.value);
      if (reply.ok && responseBytes <= limits.responseBytes) { delivered++; job.deferred.resolve(h); }
      else job.deferred.reject(h);
      h.dispose();
      job.deferred.dispose();
      pump();
    }
    promise.dispose();
    return finish(outcome!);
  } catch (e) {
    // A WASM abort (linear memory exhausted) leaves the instance unusable; dispose may fail and is reported.
    return finish({ ok: false, error: { kind: 'memory', message: bounded(e instanceof Error ? `${e.name}: ${e.message}` : String(e)) } });
  }
}
