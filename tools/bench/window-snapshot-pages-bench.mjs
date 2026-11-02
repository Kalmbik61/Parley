#!/usr/bin/env node
/* global Buffer, setImmediate, setTimeout, structuredClone */
// M3 bounded-page supplement only. No service, database, provider calls, or production changes.
// node tools/bench/window-snapshot-pages-bench.mjs [--quick] [--out file]
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cpus } from 'node:os';
import { performance, monitorEventLoopDelay, createHistogram } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { addSession } from '../../packages/core/dist/work/map.js';
import { mailWorkMap } from '../../packages/core/dist/work/context-pages.js';
import { mapLetterReader } from '../../packages/core/dist/work/letter-store.js';
import { encodeLine } from '../../packages/protocol/dist/index.js';
const args = process.argv.slice(2);
const quick = args.includes('--quick');
const outIdx = args.indexOf('--out');
const outPath = path.resolve(outIdx < 0 ? 'docs/research/data/window-snapshot-pages-m3.json' : args[outIdx + 1]);
const PAGE = 128 * 1024;
const yieldIdx = args.indexOf('--yield-ms');
const YIELD_MS = yieldIdx < 0 ? 0 : Number(args[yieldIdx + 1]);
if (YIELD_MS !== 0 && YIELD_MS !== 4) throw new Error('--yield-ms must be 0 or 4');
const AT = '2026-11-01T00:00:00.000Z';
function lcg(seed) {
  let s = seed >>> 0 || 1;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
const WORDS =
  'alpha beta gamma delta epsilon zeta theta iota kappa lambda sigma omega plan build check merge review cache frame window snapshot session task result'.split(
    ' ',
  );
function text(seed, bytes) {
  const rnd = lcg(seed);
  let out = '';
  while (out.length < bytes)
    out += WORDS[Math.floor(rnd() * WORDS.length)] + (rnd() < 0.1 ? '.\n' : ' ');
  return out.slice(0, bytes);
}

const pct = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  return a.length === 0 ? null : a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)];
};
const stat = (arr) => ({
  n: arr.length,
  p50: round(pct(arr, 50)),
  p95: round(pct(arr, 95)),
  max: round(Math.max(...arr)),
});
const round = (v) => (v === null ? null : Math.round(v * 1000) / 1000);

// Retained byte counts describe UTF-8 encoded row payloads, not V8 object/Map overhead.
function makeCache(rows, workId = 'w') {
  const ids = [], objs = new Map(), enc = new Map(), bytes = new Map();
  let encodedBytes = 0;
  for (const row of rows) {
    const json = JSON.stringify(row), n = Buffer.byteLength(json);
    ids.push(row.id); objs.set(row.id, row); enc.set(row.id, json); bytes.set(row.id, n);
    encodedBytes += n;
  }
  return { workId, ids, objs, enc, bytes, encodedBytes };
}

async function pagedDeltaOf(cache, rows, yieldMs = 0, startedAt = performance.now()) {
  const counts = { projectedRows: rows.length, compared: 0, encodedRows: 0, reusedRows: 0, yields: 0 };
  const next = { workId: cache.workId, ids: [], objs: new Map(), enc: new Map(), bytes: new Map(), encodedBytes: 0 };
  const tokens = [];
  let sliceStart = startedAt, maxSliceMs = 0;
  const pause = async () => {
    maxSliceMs = Math.max(maxSliceMs, performance.now() - sliceStart);
    counts.yields += 1;
    await new Promise(r => setImmediate(r));
    sliceStart = performance.now();
  };
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i], prev = cache.objs.get(row.id);
    let json, n;
    if (prev !== undefined) {
      counts.compared += 1;
      if (isDeepStrictEqual(prev, row)) {
        json = cache.enc.get(row.id); n = cache.bytes.get(row.id); counts.reusedRows += 1;
      }
    }
    if (json === undefined) {
      json = JSON.stringify(row); n = Buffer.byteLength(json); counts.encodedRows += 1;
      tokens.push({ kind: 'upsert', json, bytes: n });
    }
    next.ids.push(row.id); next.objs.set(row.id, row); next.enc.set(row.id, json);
    next.bytes.set(row.id, n); next.encodedBytes += n;
    if (yieldMs > 0 && i % 16 === 15 && performance.now() - sliceStart >= yieldMs) await pause();
  }
  const sameOrder = next.ids.length === cache.ids.length && next.ids.every((id, i) => id === cache.ids[i]);
  for (const id of cache.ids) if (!next.objs.has(id)) {
    const json = JSON.stringify(id); tokens.push({ kind: 'remove', json, bytes: Buffer.byteLength(json) });
  }
  if (!sameOrder) for (const id of next.ids) {
    const json = JSON.stringify(id); tokens.push({ kind: 'order', json, bytes: Buffer.byteLength(json) });
  }
  const frames = [], frameBytes = [];
  let seq = 0, groups = { upsert: [], remove: [], order: [] };
  const prefix = done => JSON.stringify({ event: 'works.delta.page', data: {
    revision: 2, workId: cache.workId, version: 2, seq,
    cursor: done ? null : String(seq + 1).padStart(10, '0'), done,
    resetOrder: !sameOrder && seq === 0,
  } }).slice(0, -2);
  const suffix = () => ',"upsert":[' + groups.upsert.join(',') + '],"remove":[' +
    groups.remove.join(',') + '],"order":[' + groups.order.join(',') + ']}}\n';
  const emptySuffixBytes = Buffer.byteLength(',"upsert":[],"remove":[],"order":[]}}\n');
  let size = Buffer.byteLength(prefix(false)) + emptySuffixBytes;
  const flush = done => {
    const frame = prefix(done) + suffix();
    const n = Buffer.byteLength(frame); // Actual final frame, including all escaping and trailing newline.
    if (n > PAGE) throw new Error(`frame ${seq} over budget: ${n}`);
    frames.push(frame); frameBytes.push(n); seq += 1;
    groups = { upsert: [], remove: [], order: [] };
    size = Buffer.byteLength(prefix(false)) + emptySuffixBytes;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    let extra = token.bytes + (groups[token.kind].length ? 1 : 0);
    if (size + extra > PAGE) {
      if (Object.values(groups).every(a => a.length === 0)) throw new Error('single token exceeds page budget');
      flush(false); extra = token.bytes;
      if (size + extra > PAGE) throw new Error('single token exceeds page budget');
    }
    groups[token.kind].push(token.json); size += extra;
    if (yieldMs > 0 && i % 16 === 15 && performance.now() - sliceStart >= yieldMs) await pause();
  }
  flush(true);
  maxSliceMs = Math.max(maxSliceMs, performance.now() - sliceStart);
  return { frames, frameBytes, next, counts, maxSliceMs };
}

function verifyPages(cache, result, targetRows) {
  const byId = new Map(cache.objs), ordered = [];
  let resetOrder = false, decodedRows = 0;
  result.frames.forEach((frame, seq) => {
    const message = JSON.parse(frame), d = message.data;
    if (message.event !== 'works.delta.page' || d.workId !== cache.workId || d.seq !== seq ||
        d.done !== (seq === result.frames.length - 1) ||
        d.cursor !== (d.done ? null : String(seq + 1).padStart(10, '0')) ||
        Buffer.byteLength(frame) !== result.frameBytes[seq] || !frame.endsWith('\n') ||
        result.frameBytes[seq] > PAGE) throw new Error('page framing/byte/sequence/cursor invariant failed');
    if (d.resetOrder) { if (seq !== 0) throw new Error('late order reset'); resetOrder = true; }
    for (const row of d.upsert) { byId.set(row.id, row); decodedRows += 1; }
    for (const id of d.remove) byId.delete(id);
    ordered.push(...d.order);
  });
  const ids = resetOrder ? ordered : cache.ids.filter(id => byId.has(id));
  const rebuilt = ids.map(id => byId.get(id));
  if (!isDeepStrictEqual(rebuilt, JSON.parse(JSON.stringify(targetRows)))) throw new Error('decoded pages do not reproduce target');
  if (decodedRows !== result.counts.encodedRows) throw new Error('dropped/duplicated rows');
  if (result.next.ids.some(id => result.next.enc.get(id) !== JSON.stringify(result.next.objs.get(id)))) throw new Error('next cache encoding mismatch');
  if (result.next.encodedBytes !== [...result.next.enc.values()].reduce((n, json) => n + Buffer.byteLength(json), 0)) throw new Error('cache byte count mismatch');
  return rebuilt;
}

async function runPages() {
  const M2 = [
    { id: 'small', works: 2, perWork: 10, textBytes: 4096 },
    { id: '30w-3000s', works: 30, perWork: 100, textBytes: 4096 },
    { id: '1w-3000s', works: 1, perWork: 3000, textBytes: 4096 },
  ];
  const TRIALS = 5;
  const ITERS = quick ? 3 : 20;
  const WARM = quick ? 1 : 5;
  const report = {
    kind: 'M3 cached-JSON bounded pages, pipeline only, EXPERIMENT (no production implementation); M1 data untouched',
    pageBudgetBytes: PAGE,
    yieldTargetMs: YIELD_MS,
    generatedAt: new Date().toISOString(),
    node: process.version,
    cpu: cpus()[0]?.model,
    cpuCount: cpus().length,
    baselineCommit: '33e3761b',
    platform: `${process.platform}-${process.arch}`,
    trials: TRIALS,
    warmupPerTrial: WARM,
    iterationsPerTrial: ITERS,
    method: 'Five alternating paired trials, 5 warmups and 20 measured calls per variant/trial. Freshly cloned inputs, mutation and initial projected/cache setup outside timing. Existing = project changed work + stringify entry + encodeLine full snapshot. Candidate = project changed work + compare projected objects + stringify changed rows once + byte-accounting/packing cached JSON verbatim into <=128KiB newline-terminated frames + next-cache bookkeeping. Completion uses performance.now, CPU uses process.cpuUsage user+system across the same awaited operation, including any cooperative yields; wait time is not subtracted from completion or misreported as reduced CPU. Active ELD: fresh 1ms histogram/trial, prime5ms/reset, synchronous or cooperative operation then setImmediate; drain2ms; pooled rank samples retained as in M2. SQLite/service/IPC/renderer excluded. Cache byte counts are UTF8 row-JSON payload only, not JS heap overhead. Memory snapshots around cache creation are unforced-GC observations of the whole process, not isolated retained-heap measurements.',
    scenarios: [],
  };
  for (const sc of M2) {
    const maps = Array.from({ length: sc.works }, (_, w) => {
      const map = {
        schemaVersion: 2,
        work: { id: `w-${w}`, title: `m2-${w}`, goal: text(w, 200),
          status: sc.works === 30 && w < 20 ? 'archived' : 'active',
          createdAt: AT, updatedAt: AT },
        sessions: [], messages: [], rooms: [],
      };
      for (let i = 0; i < sc.perWork; i += 1) {
        const row = addSession(map, { provider: 'codex', label: `s${i}`,
          task: text(w * 100000 + i, sc.textBytes) }, AT);
        row.summary = text(w * 100000 + i + 7, sc.textBytes);
        row.summarySource = 'agent';
      }
      return map;
    });
    const base = maps[maps.length - 1];
    const otherEntries = maps.slice(0, -1).map((m) => ({
      projectPath: 'bench',
      map: mailWorkMap(m, mapLetterReader({ ...m, messages: [] }), {}),
      version: 1,
    }));
    const project1 = (m) => mailWorkMap(m, mapLetterReader({ ...m, messages: [] }), {});
    const baseProj = project1(base);
    const baseRows = baseProj.sessions;
    const memoryBeforeCaches = process.memoryUsage();
    const allCaches = maps.map(m => makeCache(project1(m).sessions, m.work.id));
    const memoryAfterCaches = process.memoryUsage();
    const baselineCache = allCaches[allCaches.length - 1];
    const allCacheBytes = allCaches.reduce((n, c) => n + c.encodedBytes, 0);
    const baselineJson = JSON.stringify(baseProj); // correctness/setup only, never in candidate timing
    const taskEdit = text(8800001, sc.textBytes);
    const allTaskEdits = base.sessions.map((_, i) => text(8900000 + i, sc.textBytes));
    const mutate = {
      none: (m) => m,
      task: (m) => ((m.sessions[0].task = taskEdit), m),
      status: (m) => (
        (m.sessions[0].lifecycle = 'active'),
        (m.sessions[0].startedAt = '2026-11-01T00:00:00.000Z'),
        m
      ),
      allChanged: (m) => (
        m.sessions.forEach((x, i) => (x.task = allTaskEdits[i])),
        m
      ),
    };
    const expectChanged = { none: 0, task: 1, status: 1, allChanged: base.sessions.length };
    const sc_out = { scenario: sc.id, sessionsInChangedWork: base.sessions.length, encodedCacheUtf8Bytes: allCacheBytes, memoryBeforeCaches, memoryAfterCaches, kinds: {} };
    for (const kind of Object.keys(mutate)) {
      const target = project1(mutate[kind](structuredClone(base)));
      if (target.sessions.some((r, i) => r === baseRows[i])) throw new Error('cached projected row aliases fresh input');
      const checked = await pagedDeltaOf(baselineCache, target.sessions, YIELD_MS);
      const rebuilt = verifyPages(baselineCache, checked, target.sessions);
      if (!isDeepStrictEqual({ ...JSON.parse(baselineJson), sessions: rebuilt }, JSON.parse(JSON.stringify(target)))) throw new Error('full target map mismatch');
      if (checked.counts.encodedRows !== expectChanged[kind] || checked.counts.reusedRows !== baseRows.length - expectChanged[kind]) throw new Error('encoding/reuse count mismatch');
      if (kind === 'allChanged' && sc.perWork >= 100 && checked.frames.length < 2) throw new Error('allChanged must use multiple bounded pages');
      const variants = {
        existing: () => {
          const m = clones.pop();
          const e = { projectPath: 'bench', map: project1(m), version: 1 };
          JSON.stringify(e);
          const frame = encodeLine({
            event: 'works.changed',
            data: { entries: [e, ...otherEntries], branches: {}, revision: 2 },
          });
          return {
            frames: 1, maxFrameBytes: Buffer.byteLength(frame), totalFrameBytes: Buffer.byteLength(frame),
            projectedRows: e.map.sessions.length,
            encodedRows: e.map.sessions.length + maps.reduce((n, m) => n + m.sessions.length, 0),
          };
        },
        candidate: async () => {
          const m = clones.pop();
          const startedAt = performance.now();
          const rows = project1(m).sessions;
          const d = await pagedDeltaOf(baselineCache, rows, YIELD_MS, startedAt);
          // Frames remain live until return; decoding/equivalence checks are outside timed region.
          return {
            frames: d.frames.length, maxFrameBytes: Math.max(...d.frameBytes),
            totalFrameBytes: d.frameBytes.reduce((n, bytes) => n + bytes, 0),
            ...d.counts, retainedEncodedCacheUtf8Bytes: allCacheBytes - baselineCache.encodedBytes + d.next.encodedBytes,
            changedWorkEncodedCacheUtf8Bytes: d.next.encodedBytes, maxSyncSliceMs: round(d.maxSliceMs),
          };
        },
      };
      let clones = [];
      const prep = (n) => {
        clones = Array.from({ length: n }, () => mutate[kind](structuredClone(base)));
      };
      const acc = {
        existing: { cpu: [], eld: createHistogram(), perTrial: [] },
        candidate: { cpu: [], eld: createHistogram(), perTrial: [] },
      };
      let counters = {};
      for (let t = 0; t < TRIALS; t += 1) {
        for (const name of t % 2 === 0 ? ['existing', 'candidate'] : ['candidate', 'existing']) {
          prep(WARM + ITERS);
          for (let i = 0; i < WARM; i += 1) await variants[name]();
          const cpu = [];
          const syncSlices = [];
          const trialEld = monitorEventLoopDelay({ resolution: 1 });
          trialEld.enable();
          await new Promise((r) => setTimeout(r, 5));
          trialEld.reset();
          const processCpu = [];
          for (let i = 0; i < ITERS; i += 1) {
            const c0 = process.cpuUsage();
            const t0 = performance.now();
            counters[name] = await variants[name]();
            cpu.push(performance.now() - t0);
            if (counters[name].maxSyncSliceMs !== undefined) syncSlices.push(counters[name].maxSyncSliceMs);
            const used = process.cpuUsage(c0);
            processCpu.push((used.user + used.system) / 1000);
            await new Promise((r) => setImmediate(r));
          }
          await new Promise((r) => setTimeout(r, 2));
          trialEld.disable();
          // A reused ELD monitor can include disabled preparation gaps after re-enable.
          // Pool rank samples from fresh trial histograms at native HDR precision instead.
          const eldRankSamplesNs = Array.from({ length: trialEld.count }, (_, i) =>
            trialEld.percentile(100 * (i + 1) / trialEld.count));
          for (const ns of eldRankSamplesNs) acc[name].eld.record(Math.max(1, ns));
          acc[name].cpu.push(...cpu);
          acc[name].perTrial.push({
            trial: t + 1,
            samplesMs: cpu.map(round),
            maxSyncSliceMs: syncSlices.length ? stat(syncSlices) : null,
            processCpuMs: stat(processCpu),
            processCpuSamplesMs: processCpu.map(round),
            eldSamples: trialEld.count,
            eldRankSamplesNs,
            eldP95: round(trialEld.percentile(95) / 1e6),
            cpuP50: round(pct(cpu, 50)),
            eldP50: round(trialEld.percentile(50) / 1e6),
            eldMax: round(trialEld.max / 1e6),
          });
        }
      }
      const summary = (name) => ({
        completionMs: stat(acc[name].cpu),
        maxSyncSliceMs: name === 'candidate' ? stat(acc[name].perTrial.map(t => t.maxSyncSliceMs.max)) : null,
        processCpuMs: stat(acc[name].perTrial.flatMap((t) => t.processCpuSamplesMs)),
        activeLoopDelayMs: {
          samples: acc[name].eld.count,
          p50: round(acc[name].eld.percentile(50) / 1e6),
          p95: round(acc[name].eld.percentile(95) / 1e6),
          max: round(acc[name].eld.max / 1e6),
        },
        counts: counters[name],
        perTrial: acc[name].perTrial,
      });
      const ex = summary('existing');
      const cd = summary('candidate');
      sc_out.kinds[kind] = {
        assertions: { freshRowObjects: true, decodedPagesExact: true, fullProjectedMapWireEquivalent: true, cachedEncodingsExact: true, changedAndEncodingCountsExact: true, exactBytesWithin128KiB: true },
        expectedChangedRows: expectChanged[kind],
        existing: ex,
        candidate: cd,
        candidateCpuNotAboveExistingP50: cd.processCpuMs.p50 <= ex.processCpuMs.p50,
        candidateCpuNotAboveExistingP95: cd.processCpuMs.p95 <= ex.processCpuMs.p95,
        candidateLoopDelayNotAboveExistingP95: cd.activeLoopDelayMs.p95 <= ex.activeLoopDelayMs.p95,
        candidateLoopDelayNotAboveExistingMax: cd.activeLoopDelayMs.max <= ex.activeLoopDelayMs.max,
      };
    }
    if (JSON.stringify(baseProj) !== baselineJson) throw new Error('baseline cache mutated');
    report.scenarios.push(sc_out);
  }
  const checks = {};
  const fx = ids => ids.map(id => ({ id, task: `t-${id}`, lifecycle: 'pending' }));
  const check = async (name, from, to) => {
    const cache = makeCache(from), before = JSON.stringify(from);
    const target = structuredClone(to), d = await pagedDeltaOf(cache, target, YIELD_MS);
    verifyPages(cache, d, target);
    if (JSON.stringify(from) !== before) throw new Error('baseline mutated');
    checks[name] = { ok: true, encodedRows: d.counts.encodedRows, frames: d.frames.length, maxFrameBytes: Math.max(...d.frameBytes) };
  };
  await check('delete-middle', fx(['a','b','c','d']), fx(['a','c','d']));
  await check('reorder', fx(['a','b','c','d']), fx(['d','a','c','b']));
  await check('insert', fx(['a','b']), fx(['a','x','b']));
  await check('empty', fx(['a']), []);
  await check('unicode-escaping', fx(['a']), [{ id:'🌟"\n\\', task:'🌟"\n\\'.repeat(1000), lifecycle:'active' }]);
  await check('paged-order-removal', fx(Array.from({length:12000},(_,i)=>`🌟-${i}`)), fx(Array.from({length:11000},(_,i)=>`🌟-${10999-i}`)));
  let oversizedRejected = false;
  try { await pagedDeltaOf(makeCache([]), [{id:'x',task:'x'.repeat(PAGE)}]); }
  catch (e) { if (!String(e).includes('single token exceeds page budget')) throw e; oversizedRejected = true; }
  if (!oversizedRejected) throw new Error('oversized row silently accepted');
  checks.oversizedRowRejected = { ok:true };
  report.fixtureChecks = checks;
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2) + '\n');
  process.stderr.write(`wrote ${outPath}\n`);
}

await runPages();
