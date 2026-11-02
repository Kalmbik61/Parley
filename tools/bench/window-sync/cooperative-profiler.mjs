// Observe existing run/next/pause boundaries; no additional awaits or promises.
import { performance } from 'node:perf_hooks';
export function observeCooperativeWork(Class) {
  if (!Class || (process.env.P7_OBSERVE === '0' && process.env.P7_PHASES !== '1')) return;
  const run = Class.prototype.run;
  Class.prototype.run = function (steps) {
    const heavy = process.env.P7_OBSERVE !== '0';
    const phaseContext = globalThis.__p7Node.readPhaseContext();
    const stack = heavy ? new Error().stack ?? '' : '';
    const phase = phaseContext.phaseName ?? (stack.includes('projectWindowMail') ? 'host-projection-slice' : stack.includes('cloneWindowValue') ? 'owned-copy-slice' : /\bencode\b/.test(stack) ? 'host-encode-slice' : 'host-cache-slice');
    const pause = this.pause;
    let start;
    const finish = () => { if (start !== undefined) { if (process.env.P7_OBSERVE !== '0') globalThis.__p7Node.sample(phase, start); start = undefined; } };
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Restore only in the heavy observer mode, at its existing completion boundary.
    const owner = this;
    if (heavy) this.pause = function (...args) { finish(); return Reflect.apply(pause, this, args); };
    const wrapped = {
      next(...args) {
        if (heavy) start ??= performance.now();
        const sliceStart = performance.now();
        try {
          const result = Reflect.apply(steps.next, steps, args);
          if (process.env.P7_PHASES === '1') globalThis.__p7Node.phaseSample(phaseContext.phaseName ?? phase, sliceStart, phaseContext);
          if (result.done && heavy) { finish(); owner.pause = pause; }
          return result;
        }
        catch (error) { if (heavy) { finish(); owner.pause = pause; } throw error; }
      },
    };
    return Reflect.apply(run, this, [wrapped]);
  };
}
