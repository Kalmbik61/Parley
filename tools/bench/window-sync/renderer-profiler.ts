import * as protocol from '@parley/protocol';
import { useWorksStore } from '../../../packages/desktop/src/renderer/store/works.js';

// Fixture entry only; imported before the unchanged production renderer entry executes.
type Sample = { phase: string; ms: number; at?: number; chars?: number; commit?: boolean; finalFragment?: boolean };
const samples: Sample[] = [];
const observe = (globalThis as { __p7Observe?: boolean }).__p7Observe !== false;
const commitProbe = (globalThis as { __p7CommitProbe?: boolean }).__p7CommitProbe !== false;
let enabled = observe, dropped = 0, commitEnabled = commitProbe, commitDropped = 0;
function record(sample: Sample): void {
  if (!enabled) return;
  if (samples.length < 100_000) samples.push(sample); else dropped += 1;
}
const parse = JSON.parse;
if (observe) JSON.parse = function (...args: Parameters<typeof JSON.parse>) {
  const start = performance.now();
  try { return Reflect.apply(parse, this, args); }
  finally { record({ phase: 'json-parse', ms: performance.now() - start, chars: typeof args[0] === 'string' ? args[0].length : 0 }); }
};
for (const name of ['WorksSyncReducer', 'WorksMailStateAssembler']) {
  if (!observe) break;
  const Class = (protocol as Record<string, unknown>)[name] as { prototype?: { applyPage?: (...args: unknown[]) => unknown } } | undefined;
  const original = Class?.prototype?.applyPage;
  if (original === undefined) continue;
  Class!.prototype!.applyPage = function (...args: unknown[]) {
    const start = performance.now();
    try { return Reflect.apply(original, this, args); }
    finally {
      const page = args[0] as { commit?: boolean; records?: Array<{ kind: string; final?: boolean }> };
      record({ phase: name, at: performance.timeOrigin + start, ms: performance.now() - start, commit: page?.commit === true, finalFragment: page?.records?.some(r => r.kind.includes('fragment') && r.final === true) ?? false });
    }
  };
}
const commits: Array<{ at: number; versions: Array<[string, number | undefined]> }> = [];
useWorksStore.subscribe((state, previous) => {
  if (commitEnabled && state.entries !== previous.entries) {
    if (commits.length < 10_000) commits.push({ at: performance.timeOrigin + performance.now(), versions: state.entries.map(entry => [entry.map.work.id, entry.version]) });
    else commitDropped += 1;
  }
});
Object.defineProperty(globalThis, '__p7Renderer', { value: {
  reset() { enabled = false; commitEnabled = false; samples.length = 0; commits.length = 0; dropped = 0; commitDropped = 0; enabled = observe; commitEnabled = commitProbe; },
  read() {
    enabled = false; commitEnabled = false;
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    return { samples, commits, dropped: dropped + commitDropped, sampleDropped: dropped, commitDropped, probe: 'bounded version/time-only commit probe remains enabled with heavy observers off', heap: memory ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize, jsHeapSizeLimit: memory.jsHeapSizeLimit } : null };
  },
  state() { return useWorksStore.getState(); },
} });
