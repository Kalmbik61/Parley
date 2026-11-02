// P7 fixture-only observation. No extra awaits, retries, caps or scheduling changes.
import { createHook } from 'node:async_hooks';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Socket } from 'node:net';
import { Buffer } from 'node:buffer';
import { wireMeter } from './wire-meter.mjs';

const maximum = 1_000_000;
const observe = process.env.P7_OBSERVE !== '0';
const phaseObserve = process.env.P7_PHASES === '1';
let samples = [], phaseSamples = [], dropped = 0, phaseDropped = 0, starts = new Map(), enabled = false, phaseContext = {};
const types = new Map();
let typeLoss = 0, depth = 0, turn = null;
const microtasks = new Set(['PROMISE', 'TickObject', 'Microtask']);
const eld = monitorEventLoopDelay({ resolution: 1 });
eld.enable();
function sample(phase, start, detail = {}) {
  if (!enabled) return;
  if (turn !== null && phase !== 'uninterrupted-task') turn.phases.add(phase);
  if (samples.length < maximum) samples.push({ phase, at: performance.timeOrigin + start, ms: performance.now() - start, ...detail });
  else dropped += 1;
}
function phaseSample(phase, start, detail = {}) {
  if (!phaseObserve || !enabled) return;
  if (phaseSamples.length < 200_000) phaseSamples.push({ phase, at: performance.timeOrigin + start, ms: performance.now() - start, ...phaseContext, ...detail });
  else phaseDropped += 1;
}
function endTurn() {
  if (turn === null) return;
  const value = turn; turn = null;
  if (samples.length < maximum) samples.push({ phase: 'uninterrupted-task', at: performance.timeOrigin + value.start, ms: value.end - value.start, phases: [...value.phases], resources: [...value.resources] });
  else dropped += 1;
}
const hooks = createHook({
  init(id, type) { if (types.size < 200_000) types.set(id, type); else typeLoss += 1; },
  before(id) {
    if (!enabled) return;
    const at = performance.now(), type = types.get(id) ?? 'unknown';
    // A macro callback and its entire following microtask drain form one uninterrupted turn.
    // End uses the last callback's end, so idle I/O/timer waiting is never counted as CPU.
    if (depth === 0 && !microtasks.has(type)) endTurn();
    if (turn === null) turn = { start: at, end: at, phases: new Set(), resources: new Set() };
    turn.resources.add(type); starts.set(id, at); depth += 1;
  },
  after(id) { if (starts.delete(id)) { if (turn !== null) turn.end = performance.now(); depth = Math.max(0, depth - 1); } },
  destroy(id) { starts.delete(id); types.delete(id); },
});
if (observe) hooks.enable();
const parse = JSON.parse;
if (observe) JSON.parse = function (...args) { const start = performance.now(); try { return Reflect.apply(parse, this, args); } finally { sample('json-parse', start, { chars: typeof args[0] === 'string' ? args[0].length : 0 }); } };
const stringify = JSON.stringify;
if (observe) JSON.stringify = function (...args) {
  const start = performance.now(); let result;
  try { result = Reflect.apply(stringify, this, args); return result; }
  finally { sample('json-stringify', start, { chars: result?.length ?? 0 }); }
};
const write = Socket.prototype.write;
let socketBytes = 0, writes = 0, maxWriteBytes = 0, socketKinds = {};
if (observe) Socket.prototype.write = function (...args) {
  const start = performance.now();
  if (enabled && this !== process.stdout && this !== process.stderr) {
    const data = args[0];
    const bytes = typeof data === 'string' ? Buffer.byteLength(data, typeof args[1] === 'string' ? args[1] : 'utf8') : data?.byteLength ?? 0;
    socketBytes += bytes; maxWriteBytes = Math.max(maxWriteBytes, bytes);
    const prefix = typeof data === 'string' ? data.slice(0, 180) : '';
    const kind = /"(?:event|method)":"([^"]+)"/.exec(prefix)?.[1] ?? 'response/other';
    socketKinds[kind] = (socketKinds[kind] ?? 0) + 1;
    writes += 1;
  }
  try { return Reflect.apply(write, this, args); } finally { sample('socket-write', start); }
};
let cpu = process.cpuUsage(), memory = process.memoryUsage(), since = performance.now();
globalThis.__p7Node = {
  observed: observe,
  reset() { enabled = false; samples = []; phaseSamples = []; dropped = 0; phaseDropped = 0; typeLoss = 0; turn = null; depth = 0; starts.clear(); socketBytes = 0; writes = 0; maxWriteBytes = 0; socketKinds = {}; phaseContext = {}; wireMeter.reset(); eld.reset(); cpu = process.cpuUsage(); memory = process.memoryUsage(); since = performance.now(); enabled = observe || phaseObserve; },
  span(phase, callback, detail = {}) { if (!observe) return callback(); const start = performance.now(); try { return callback(); } finally { sample(phase, start, detail); } },
  phaseSpan(phase, callback) { if (!phaseObserve) return callback(); const start = performance.now(); try { return callback(); } finally { phaseSample(phase, start); } },
  phaseSync(phase, callback, detail = {}) { if (!phaseObserve) return callback(); const start = performance.now(); try { return callback(); } finally { phaseSample(phase, start, detail); } },
  withPhaseContext(context, callback) { const previous = phaseContext; phaseContext = context ?? {}; try { return callback(); } finally { phaseContext = previous; } },
  readPhaseContext() { return { ...phaseContext }; },
  phaseSample,
  sample,
  read() {
    if (turn !== null) turn.end = performance.now(); endTurn(); enabled = false;
    return { role: process.versions.electron ? 'main' : 'host', pid: process.pid, node: process.version, electron: process.versions.electron ?? null, wallMs: performance.now() - since, cpu: process.cpuUsage(cpu), memoryBefore: memory, memoryAfter: process.memoryUsage(), resources: process.resourceUsage(), wire: wireMeter.read(), observedWriteBytes: socketBytes, writes, maxWriteBytes, socketKinds, samples, dropped, typeLoss, phaseSamples, phaseDropped, eld: { p50Ms: eld.percentile(50) / 1e6, p95Ms: eld.percentile(95) / 1e6, maxMs: eld.max / 1e6 } };
  },
};
globalThis.__p7Node.reset();
