#!/usr/bin/env node
/* global Buffer, setImmediate, setTimeout, structuredClone */
// M2 supplement only. No service, database, provider calls, or production changes.
// node tools/bench/window-snapshot-structural-bench.mjs [--quick] [--out file]
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
const outPath = path.resolve(outIdx < 0 ? 'docs/research/data/window-snapshot-structural-m2.json' : args[outIdx + 1]);
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

function rowDeltaOf(cache, rows) {
  // cache = { ids: string[], objs: Map<id,row>, enc: Map<id,string> }; returns delta + next cache + counters
  const counters = { projectedRows: rows.length, compared: 0, encoded: 0, reused: 0 };
  const upsert = [];
  const nextObjs = new Map();
  const nextEnc = new Map();
  for (const row of rows) {
    const prev = cache.objs.get(row.id);
    let enc;
    if (prev !== undefined) {
      counters.compared += 1;
      if (isDeepStrictEqual(prev, row)) {
        enc = cache.enc.get(row.id);
        counters.reused += 1;
      }
    }
    if (enc === undefined) {
      enc = JSON.stringify(row);
      counters.encoded += 1;
      upsert.push(row);
    }
    nextObjs.set(row.id, row);
    nextEnc.set(row.id, enc);
  }
  const ids = rows.map((r) => r.id);
  const remove = cache.ids.filter((id) => !nextObjs.has(id));
  const sameOrder = ids.length === cache.ids.length && ids.every((id, i) => id === cache.ids[i]);
  const frame = encodeLine({
    event: 'works.delta',
    data: {
      revision: 2,
      workId: 'w',
      version: 2,
      upsert,
      remove,
      ...(sameOrder ? {} : { order: ids }),
    },
  });
  counters.encoded += upsert.length; // the delta frame stringifies the changed rows once more (envelope encode)
  return {
    frame,
    upsert,
    remove,
    order: sameOrder ? null : ids,
    next: { ids, objs: nextObjs, enc: nextEnc },
    counters,
  };
}
function applyDelta(rowsById, orderIds, delta) {
  const byId = new Map(rowsById);
  for (const id of delta.remove) byId.delete(id);
  for (const r of delta.upsert) byId.set(r.id, JSON.parse(JSON.stringify(r)));
  const order = delta.order ?? orderIds.filter((id) => byId.has(id));
  return order.map((id) => byId.get(id));
}

async function runRowReuse() {
  const M2 = [
    { id: 'small', works: 2, perWork: 10, textBytes: 4096 },
    { id: '30w-3000s', works: 30, perWork: 100, textBytes: 4096 },
    { id: '1w-3000s', works: 1, perWork: 3000, textBytes: 4096 },
  ];
  const TRIALS = 5;
  const ITERS = quick ? 3 : 20;
  const WARM = quick ? 1 : 5;
  const report = {
    kind: 'M2 projected-row reuse, pipeline only, EXPERIMENT (no production implementation); M1 data untouched',
    generatedAt: new Date().toISOString(),
    node: process.version,
    cpu: cpus()[0]?.model,
    cpuCount: cpus().length,
    baselineCommit: '33e3761b',
    platform: `${process.platform}-${process.arch}`,
    trials: TRIALS,
    warmupPerTrial: WARM,
    iterationsPerTrial: ITERS,
    method:
      'per scenario and change kind, 5 alternating paired trials (existing, candidate, existing, ...) each with warmup; fresh structuredClone of deterministic pure in-memory maps per iteration outside the timed region; cpuMs = synchronous elapsed time around project+compare/encode+delta encode+bookkeeping; processCpuMs = process.cpuUsage user+system over the same call; active ELD = monitorEventLoopDelay(1 ms), primed 5 ms and reset after warmup, synchronous run + setImmediate yield; 2 ms drain captures final block; fresh monitor per trial excludes preparation/cloning/warmup and priming; pooled ELD reconstructed from each native HDR histogram at evenly spaced empirical ranks (rank samples retained), avoiding disabled-gap contamination from monitor re-enable. Small-case ELD is near the 1 ms monitor floor. Counters count row serialization occurrences: changed candidate rows appear once in cache encoding and once in delta envelope; existing rows appear in changed-entry encoding and full-snapshot encoding. Cache construction and input cloning/mutation excluded; next-cache construction included. Each call is an independent baseline-to-target change. Excluded: SQLite, IPC, publish bookkeeping, renderer. Existing path = project work + entry JSON.stringify + global encodeLine([changed entry, ...other entries]).',
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
    const mkCache = () => ({
      ids: baseRows.map((r) => r.id),
      objs: new Map(baseRows.map((r) => [r.id, r])),
      enc: new Map(baseRows.map((r) => [r.id, JSON.stringify(r)])),
    });
    const baselineCache = mkCache(); // Prepared once; equal-row encodings survive every independent baseline-to-target trial.
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
    const sc_out = { scenario: sc.id, sessionsInChangedWork: base.sessions.length, kinds: {} };
    for (const kind of Object.keys(mutate)) {
      // equivalence assertion (once, outside timing): applying the delta to the baseline reproduces the target exactly
      {
        const target = project1(mutate[kind](structuredClone(base)));
        const cache = mkCache();
        if (target.sessions[0] === cache.objs.get(target.sessions[0].id))
          throw new Error('fresh projection unexpectedly shares a cached row');
        const d = rowDeltaOf(cache, target.sessions);
        if (d.counters.encoded - d.upsert.length !== expectChanged[kind])
          throw new Error(
            `${sc.id}/${kind}: expected ${expectChanged[kind]} changed rows, got ${d.counters.encoded - d.upsert.length}`,
          );
        const rebuilt = applyDelta(cache.objs, cache.ids, JSON.parse(d.frame).data);
        if (!isDeepStrictEqual(JSON.parse(JSON.stringify(target.sessions)), rebuilt))
          throw new Error(`${sc.id}/${kind}: delta does not reproduce the target`);
        const reconstructed = { ...baseProj, sessions: rebuilt };
        if (!isDeepStrictEqual(JSON.parse(JSON.stringify(target)), JSON.parse(JSON.stringify(reconstructed))))
          throw new Error(`${sc.id}/${kind}: full projected map mismatch`);
        if (d.counters.encoded !== 2 * expectChanged[kind] || d.counters.reused !== baseRows.length - expectChanged[kind])
          throw new Error(`${sc.id}/${kind}: incorrect encoding/reuse counts`);
        if (
          d.next.ids.map((id) => d.next.enc.get(id)).join(',') !==
          target.sessions.map((r) => JSON.stringify(r)).join(',')
        )
          throw new Error(`${sc.id}/${kind}: cached encodings differ from fresh encodings`);
      }
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
            frameBytes: Buffer.byteLength(frame),
            projectedRows: e.map.sessions.length,
            encodedRows: e.map.sessions.length + maps.reduce((n, m) => n + m.sessions.length, 0),
          };
        },
        candidate: () => {
          const m = clones.pop();
          const d = rowDeltaOf(baselineCache, project1(m).sessions);
          return {
            frameBytes: Buffer.byteLength(d.frame),
            projectedRows: d.counters.projectedRows,
            compared: d.counters.compared,
            changedRows: d.upsert.length,
            uniqueJsonEncodedRows: d.upsert.length,
            encodedRows: d.counters.encoded,
            reusedRows: d.counters.reused,
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
          for (let i = 0; i < WARM; i += 1) variants[name]();
          const cpu = [];
          const trialEld = monitorEventLoopDelay({ resolution: 1 });
          trialEld.enable();
          await new Promise((r) => setTimeout(r, 5));
          trialEld.reset();
          const processCpu = [];
          for (let i = 0; i < ITERS; i += 1) {
            const c0 = process.cpuUsage();
            const t0 = performance.now();
            counters[name] = variants[name]();
            cpu.push(performance.now() - t0);
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
        cpuMs: stat(acc[name].cpu),
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
        assertions: { freshRowObjects: true, fullProjectedMapWireEquivalent: true, cachedEncodingsExact: true, changedAndEncodingCountsExact: true },
        expectedChangedRows: expectChanged[kind],
        existing: ex,
        candidate: cd,
        candidateCpuNotAboveExistingP50: cd.cpuMs.p50 <= ex.cpuMs.p50,
        candidateCpuNotAboveExistingP95: cd.cpuMs.p95 <= ex.cpuMs.p95,
        candidateLoopDelayNotAboveExistingP95: cd.activeLoopDelayMs.p95 <= ex.activeLoopDelayMs.p95,
        candidateLoopDelayNotAboveExistingMax: cd.activeLoopDelayMs.max <= ex.activeLoopDelayMs.max,
      };
    }
    report.scenarios.push(sc_out);
  }
  // small fixture checks: deletion, reorder, insertion, id-keyed correctness
  const fx = (ids) => ids.map((id) => ({ id, task: `t-${id}`, lifecycle: 'pending' }));
  const mk = (rows) => ({
    ids: rows.map((r) => r.id),
    objs: new Map(rows.map((r) => [r.id, r])),
    enc: new Map(rows.map((r) => [r.id, JSON.stringify(r)])),
  });
  const checks = {};
  const check = (name, from, to) => {
    const cache = mk(from);
    const d = rowDeltaOf(cache, structuredClone(to));
    const rebuilt = applyDelta(cache.objs, cache.ids, JSON.parse(d.frame).data);
    checks[name] = {
      ok: isDeepStrictEqual(rebuilt, to),
      upsert: d.upsert.length,
      remove: d.remove.length,
      orderSent: d.order !== null,
    };
    if (!checks[name].ok) throw new Error(`fixture ${name} failed`);
  };
  check('delete-middle', fx(['a', 'b', 'c', 'd']), fx(['a', 'c', 'd']));
  check('reorder', fx(['a', 'b', 'c', 'd']), fx(['d', 'a', 'c', 'b']));
  check('insert', fx(['a', 'b']), fx(['a', 'x', 'b']));
  check(
    'edit-one',
    fx(['a', 'b', 'c']),
    fx(['a', 'b', 'c']).map((r) => (r.id === 'b' ? { ...r, lifecycle: 'running' } : r)),
  );
  report.fixtureChecks = checks;
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2) + '\n');
  process.stderr.write(`wrote ${outPath}\n`);
}

await runRowReuse();
