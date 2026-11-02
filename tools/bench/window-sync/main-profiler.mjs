import './node-profiler.mjs';
import path from 'node:path';
import { app, contentTracing, ipcMain } from 'electron';
import { performance } from 'node:perf_hooks';
import * as protocol from './packages/protocol/dist/index.js';
const now = () => performance.timeOrigin + performance.now();
const observe = process.env.P7_OBSERVE !== '0';
let samples = [], dropped = 0;
const record = value => { if (samples.length < 100_000) samples.push(value); else dropped += 1; };
for (const name of ['WorksSyncReducer', 'WorksMailStateAssembler']) {
  if (!observe) break;
  const Class = protocol[name], original = Class?.prototype?.applyPage;
  if (!original) continue;
  Class.prototype.applyPage = function (...args) {
    const page = args[0];
    return globalThis.__p7Node.span(name, () => Reflect.apply(original, this, args), { commit: page?.commit === true, finalFragment: page?.records?.some(r => r.kind.includes('fragment') && r.final === true) ?? false });
  };
}
app.on('web-contents-created', (_event, contents) => {
  if (!observe) return;
  const send = contents.send;
  let legacy = 0;
  contents.send = function (channel, ...args) {
    const relevant = channel === 'works-sync:batch' || channel === 'host:event' && args[0]?.event === 'works.changed';
    if (!relevant) return Reflect.apply(send, this, [channel, ...args]);
    const at = now();
    return globalThis.__p7Node.span('ipc-send', () => {
      try { return Reflect.apply(send, this, [channel, ...args]); }
      finally { record({ phase: 'ipc-send', at, ms: now() - at, contents: contents.id, pid: contents.getOSProcessId(), channel, stream: channel === 'works-sync:batch' ? args[0] : null, delivery: channel === 'works-sync:batch' ? args[1] : ++legacy }); }
    });
  };
});
if (observe) ipcMain.on('works-sync:ack', (event, stream, delivery) => record({ phase: 'ipc-ack-receive', at: now(), contents: event.sender.id, stream, delivery }));
let traceStarted;
app.on('ready', () => {
  if (!observe) return;
  traceStarted = contentTracing.startRecording({ included_categories: ['toplevel', 'devtools.timeline', 'v8.execute', 'blink.user_timing', 'renderer.scheduler', 'disabled-by-default-devtools.timeline'] });
});
globalThis.__p7Main = {
  reset() { samples = []; dropped = 0; globalThis.__p7Node.reset(); },
  read() { return { ...globalThis.__p7Node.read(), ipc: { samples, dropped }, processes: app.getAppMetrics() }; },
  async stopTrace() { if (!observe) return null; await traceStarted; return await contentTracing.stopRecording(path.join(process.env.PARLEY_HOME, 'electron-trace.json')); },
};
