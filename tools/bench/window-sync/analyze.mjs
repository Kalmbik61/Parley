// Summarize retained raw measurements; does not convert incomplete coverage to PASS.
import fs from 'node:fs/promises';
import path from 'node:path';
const [input, output] = process.argv.slice(2);
export function stats(values) {
  const a = values.filter(Number.isFinite).sort((a, b) => a - b);
  return a.length ? { n: a.length, p50: a[Math.ceil(a.length * .5) - 1], p95: a[Math.ceil(a.length * .95) - 1], max: a.at(-1) } : { n: 0 };
}
const cpu = value => (value.user + value.system) / 1000;
function phases(samples = []) {
  const names = [...new Set(samples.map(s => s.phase))];
  return Object.fromEntries(names.map(name => [name, stats(samples.filter(s => s.phase === name).map(s => s.ms))]));
}
export async function summarize(raw) {
  if (!raw.host) return { completed: raw.completed, error: raw.error };
  const commits = raw.surfaces.flatMap(s => s.renderer.commits ?? []).sort((a, b) => a.at - b.at);
  const lag = (raw.edits ?? []).map(edit => ({ ...edit, commitAt: commits.find(c => c.versions.some(([id, version]) => id === edit.workId && version >= edit.version))?.at })).map(edit => ({ ...edit, lagMs: edit.commitAt === undefined ? null : edit.commitAt - edit.at }));
  const before = new Map((raw.processBefore ?? []).map(p => [p.pid, p]));
  const processes = raw.main.processes.map(p => ({ pid: p.pid, type: p.type, cpuMs: before.has(p.pid) ? (p.cpu.cumulativeCPUUsage - before.get(p.pid).cpu.cumulativeCPUUsage) * 1000 : null, memory: p.memory }));
  const sends = raw.main.ipc.samples.filter(s => s.phase === 'ipc-send');
  const receives = raw.surfaces.flatMap(s => s.ipc.samples).filter(s => s.phase === 'ipc-receive-consumer');
  const acks = raw.main.ipc.samples.filter(s => s.phase === 'ipc-ack-receive');
  const legacySends = sends.filter(s => s.stream === null), legacyReceives = receives.filter(s => s.stream === null);
  const ipc = sends.map(send => {
    const receipt = send.stream === null ? legacySends.length === legacyReceives.length && raw.surfaces.length === 1 ? legacyReceives[legacySends.indexOf(send)] : undefined : receives.find(r => r.stream === send.stream && r.delivery === send.delivery);
    const ack = acks.find(r => r.contents === send.contents && r.stream === send.stream && r.delivery === send.delivery);
    return { ...send, receiptDelayMs: receipt ? receipt.at - send.at : null, ackRttMs: ack ? ack.at - send.at : null };
  });
  let traceTasks = null, phaseTasks = null;
  if (raw.trace) {
    const trace = JSON.parse(await fs.readFile(raw.trace, 'utf8')).traceEvents;
    const names = Object.fromEntries(trace.filter(e => e.ph === 'M' && e.name === 'thread_name').map(e => [`${e.pid}:${e.tid}`, e.args.name]));
    const start = trace.filter(e => e.name === 'p7-measure-start').map(e => e.ts), end = trace.filter(e => e.name === 'p7-measure-end').map(e => e.ts);
    const lo = start.length ? Math.min(...start) : -Infinity, hi = end.length ? Math.max(...end) : Infinity;
    const tasks = trace.filter(e => e.ph === 'X' && e.ts >= lo && e.ts <= hi && /RunTask$/.test(e.name) && ['CrBrowserMain', 'CrRendererMain'].includes(names[`${e.pid}:${e.tid}`]));
    const groups = [...new Set(tasks.map(e => `${e.pid}:${names[`${e.pid}:${e.tid}`]}:${e.name}`))];
    traceTasks = Object.fromEntries(groups.map(group => [group, stats(tasks.filter(e => `${e.pid}:${names[`${e.pid}:${e.tid}`]}:${e.name}` === group).map(e => e.dur / 1000))]));
    const endMarks = trace.filter(e => e.name === 'p7-measure-end');
    // Single-surface timing trials supply an epoch conversion for the shared trace clock.
    if (raw.measureEnds.length === 1 && endMarks.length === 1) {
      const offset = raw.measureEnds[0].epoch * 1000 - endMarks[0].ts;
      const measured = [
        ...raw.main.samples.filter(s => s.phase !== 'uninterrupted-task').map(s => ({ ...s, pid: raw.main.pid, process: 'main' })),
        ...raw.surfaces.flatMap(surface => [...surface.renderer.samples, ...surface.ipc.samples].filter(s => s.at !== undefined && s.ms !== undefined).map(s => ({ ...s, pid: endMarks[0].pid, process: 'renderer' }))),
      ];
      const mapped = measured.map(s => {
        const ts = s.at * 1000 - offset;
        const containing = tasks.filter(t => t.name === 'RunTask' && t.pid === s.pid && t.ts <= ts + 200 && t.ts + t.dur >= ts - 200).sort((a, b) => b.dur - a.dur)[0];
        return { ...s, fullTaskMs: containing?.dur / 1000 };
      });
      const keys = [...new Set(mapped.map(s => `${s.process}:${s.phase}`))];
      phaseTasks = { mappingToleranceUs: 200, groups: Object.fromEntries(keys.map(key => { const selected = mapped.filter(s => `${s.process}:${s.phase}` === key); return [key, { span: stats(selected.map(s => s.ms)), enclosingTask: stats(selected.map(s => s.fullTaskMs)), unmapped: selected.filter(s => !Number.isFinite(s.fullTaskMs)).length }]; })) };
    }
  }
  return { home: raw.home, mode: raw.mode, shape: raw.fixture.shape, heavy: raw.observe, commitProbe: raw.commitProbe, correctness: raw.correctness, runtimeInfo: raw.runtimeInfo, hostCpuMs: cpu(raw.host.cpu), mainCpuMs: cpu(raw.main.cpu), processCpuAndMemory: processes, hostEld: raw.host.eld, mainEld: raw.main.eld, hostWire: raw.host.wire, mainWire: raw.main.wire, hostPeakRssRaw: raw.host.resources.maxRSS, mainPeakRssRaw: raw.main.resources.maxRSS, hostMemory: raw.host.memoryAfter, mainMemory: raw.main.memoryAfter, lagMs: stats(lag.map(e => e.lagMs)), uncommittedWrites: lag.filter(e => e.commitAt === undefined).length, lag, hostPhases: phases(raw.host.samples), mainPhases: phases(raw.main.samples), surfaces: raw.surfaces.map(s => ({ title: s.title, phases: phases(s.renderer.samples), heap: s.renderer.heap, loss: s.renderer.dropped + s.ipc.dropped })), loss: { host: raw.host.dropped, hostTypes: raw.host.typeLoss, main: raw.main.dropped, mainTypes: raw.main.typeLoss, mainIpc: raw.main.ipc.dropped }, syncCounters: raw.host.syncCounters, frameMaxObservedBytes: raw.host.maxWriteBytes, ipc: { samples: ipc, receiptDelayMs: stats(ipc.map(s => s.receiptDelayMs)), ackRttMs: stats(ipc.map(s => s.ackRttMs)) }, traceTasks, phaseTasks, verdict: 'raw summary only; missing/confounded phase, UI or workload coverage prevents PASS' };
}
if (input) {
  const stat = await fs.stat(input);
  const files = stat.isDirectory() ? (await fs.readdir(input)).filter(n => /^\d.*\.json$/.test(n)).map(n => path.join(input, n)) : [input];
  const results = [];
  for (const file of files) results.push({ file, ...await summarize(JSON.parse(await fs.readFile(file, 'utf8'))) });
  await fs.writeFile(output, JSON.stringify(results, null, 2));
}
