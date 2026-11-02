import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers';
import './node-profiler.mjs';
import { observeCoreSource } from './phase-transform.mjs';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

test('task observer groups a synchronous promise drain instead of diluting it into callbacks', async () => {
  globalThis.__p7Node.reset();
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    const until = performance.now() + 7;
    while (performance.now() < until) { /* Deliberate synthetic uninterrupted work, not a product speed assertion. */ }
  }
  await new Promise(resolve => setImmediate(resolve));
  const raw = globalThis.__p7Node.read();
  const turns = raw.samples.filter(row => row.phase === 'uninterrupted-task' && row.resources.includes('PROMISE'));
  assert.ok(turns.some(row => row.ms >= 28), 'the whole deliberate28ms promise drain must be visible as one task');
  assert.equal(raw.dropped, 0); assert.equal(raw.typeLoss, 0);
});

test('preload observer preserves duplicate and cross-channel listener removal', () => {
  const ipc = new EventEmitter(); ipc.send = () => {};
  const exposed = {};
  runInNewContext(readFileSync(new URL('./preload-profiler.cjs', import.meta.url), 'utf8'), {
    performance, process: { env: {} },
    require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld(name, value) { exposed[name] = value; } } }),
  });
  let calls = 0; const callback = () => { calls += 1; };
  ipc.on('works-sync:batch', callback); ipc.on('works-sync:batch', callback); ipc.on('host:event', callback);
  ipc.removeListener('works-sync:batch', callback);
  ipc.emit('works-sync:batch', {}, 1, 1, {}); assert.equal(calls, 1);
  ipc.removeListener('host:event', callback);
  ipc.emit('host:event', {}, { event: 'works.changed' }); assert.equal(calls, 1);
  ipc.removeListener('works-sync:batch', callback);
  ipc.emit('works-sync:batch', {}, 1, 2, {}); assert.equal(calls, 1);
  assert.equal(exposed.__p7IPC.read().dropped, 0);
});

test('synchronous phase spans preserve return identity and thrown errors', () => {
  const original = 'function mailWorkMap(value) { if (value.error) throw value.error; return value; }';
  const { source, phases } = observeCoreSource(original);
  const seen = [];
  const instrumented = new Function('performance', 'globalThis', source + ';return mailWorkMap;')(performance, { __p7Node: { observed: true, sample: phase => seen.push(phase) } });
  const value = {};
  assert.equal(instrumented(value), value);
  const error = new Error('same error'); assert.throws(() => instrumented({ error }), candidate => candidate === error);
  assert.deepEqual(phases, ['host-legacy-mail-projection']);
  assert.deepEqual(seen, ['host-legacy-mail-projection', 'host-legacy-mail-projection']);
});
