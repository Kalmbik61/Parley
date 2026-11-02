import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { observeCooperativeWork } from './cooperative-profiler.mjs';
const build = process.argv[2];
await import(pathToFileURL(path.join(build, 'node-profiler.mjs')).href);
const core = await import(pathToFileURL(path.join(build, 'packages/core/dist/index.js')).href);
observeCooperativeWork(core.CooperativeWork);
let synchronizer;
try {
  const { WorksSyncHost } = await import(pathToFileURL(path.join(build, 'packages/host/dist/works/works-sync.js')).href);
  for (const name of ['publish', 'pull', 'pullMailState']) {
    if (process.env.P7_OBSERVE === '0' && process.env.P7_PHASES !== '1') break;
    const original = WorksSyncHost.prototype[name];
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Observe the actual fixture instance without replacing its promise.
    WorksSyncHost.prototype[name] = function (...args) { synchronizer = this; return Reflect.apply(original, this, args); };
  }
} catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const { startHost } = await import(pathToFileURL(path.join(build, 'packages/host/dist/host.js')).href);
const fixture = JSON.parse(await fs.readFile(process.env.P7_FIXTURE, 'utf8'));
const running = await startHost({ home: process.env.PARLEY_HOME, idleMs: 3600000 });
process.send?.({ kind: 'ready', paths: running.paths, pid: process.pid });
let counters = {};
let socketHidden = false;
const restoreSocket = async () => { if (socketHidden) { await fs.rename(running.paths.socket + '.p7-hidden', running.paths.socket); socketHidden = false; } };
process.once('disconnect', () => { void restoreSocket().finally(() => running.context.shutdown('p7-driver-disconnected')); });
process.on('message', async request => {
  try {
    let result;
    if (request.command === 'reset') { counters = { ...synchronizer?.stats }; globalThis.__p7Node.reset(); result = true; }
    else if (request.command === 'stats') result = { ...globalThis.__p7Node.read(), syncCounters: Object.fromEntries(Object.entries(synchronizer?.stats ?? {}).map(([key, value]) => [key, value - (counters[key] ?? 0)])) };
    else if (request.command === 'edit') {
      const workId = fixture.ids[request.work ?? 0], at = performance.timeOrigin + performance.now();
      // updateMap's transaction and notification execute synchronously before its
      // returned Promise settles. Scope the listener to that call, not the await.
      const written = [], phaseContext = { phaseName: 'host.db-map-write-transaction', requestId: request.id, workId };
      const off = core.onMapWritten(event => { if (event.projectPath === fixture.project && event.workId === workId) { written.push({ version: event.version, prevVersion: event.prevVersion, incarnation: event.incarnation, structural: event.structural, at: performance.timeOrigin + performance.now() }); phaseContext.sourceVersion = event.version; phaseContext.incarnation = event.incarnation; } });
      let pending;
      try { pending = globalThis.__p7Node.phaseSync('host.db-map-write-transaction', () => core.updateMap(fixture.project, workId, map => { map.sessions[request.session ?? 0].task = request.text; }), phaseContext); }
      finally { off(); }
      const transactionReturnedAt = performance.timeOrigin + performance.now();
      await pending;
      result = { requestId: request.id, dispatchAt: request.dispatchAt, at, transactionReturnedAt, completedAt: performance.timeOrigin + performance.now(), workId, version: written[0]?.version, incarnation: written[0]?.incarnation, written };
    } else if (request.command === 'dense' || request.command === 'nochange') {
      const workId = fixture.ids[request.work ?? 0], at = performance.timeOrigin + performance.now();
      await core.updateMap(fixture.project, workId, map => { if (request.command === 'dense') for (const session of map.sessions) session.task = request.text; });
      result = { at, workId, version: core.workVersion(fixture.project, workId), command: request.command };
    } else if (request.command === 'mail') {
      const workId = fixture.ids[request.work ?? 0], at = performance.timeOrigin + performance.now();
      const message = core.writeLetters(fixture.project, workId, letters => letters.add({ kind: 'note', from: 's-01', to: ['human'], roomId: null, text: '@human fixture mail' }));
      result = { at, workId, version: core.workVersion(fixture.project, workId), id: message.id };
    } else if (request.command === 'clients-close') { for (const client of running.context.clients()) client.close(); result = true; }
    else if (request.command === 'socket-hide') { await fs.rename(running.paths.socket, running.paths.socket + '.p7-hidden'); socketHidden = true; for (const client of running.context.clients()) client.close(); result = true; }
    else if (request.command === 'socket-restore') { await restoreSocket(); result = true; }
    else if (request.command === 'stop') { await restoreSocket(); await running.context.shutdown('p7-fixture-cleanup'); result = true; }
    else throw new Error('unknown fixture command');
    process.send?.({ id: request.id, result }, () => { if (request.command === 'stop') process.disconnect(); });
  } catch (error) { process.send?.({ id: request.id, error: String(error) }); }
});
await running.closed;
