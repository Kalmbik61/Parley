#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-unused-expressions */
/* global Buffer, setImmediate, setTimeout */
// Window snapshot (`works.changed`) measurement. Standalone, no production changes.
//
//   pnpm -r build            # the bench imports packages/*/dist
// M2: use window-snapshot-structural-bench.mjs (standalone pipeline supplement).
//   node tools/bench/window-snapshot-bench.mjs [--out docs/research/data/window-snapshot-bench.json] [--quick]
//
// Part A  (service)   — the real `createWorksService` (host) on a real temp PARLEY_HOME with a fake HostContext:
//                       real SQLite reads, real file watcher, real core projections, real protocol `encodeLine`.
// NOTE: Part A attaches mail + compact + legacy clients at once (MIXED-CLIENT): its cold-start, change latency and
//       event-loop numbers include every compatibility path, not a single modern window.
// Part B  (pipeline)  — the same core projections (`mailWorkMap`, `compactWorkMap`) and `encodeLine`, no I/O, so
//                       projection and encode cost are visible separately. Includes the "transport experiment".
//
// EXCLUDED: IPC/socket write, client-side decode, window (renderer) rendering, a real multi-process host,
// disk cold-cache effects. Wall-clock numbers are hardware dependent and are never asserted anywhere.
// All content is synthetic and deterministic (seeded LCG word salad); no user content.

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
if (args.includes('--row-reuse')) {
  process.stderr.write('--row-reuse was retired: use node tools/bench/window-snapshot-structural-bench.mjs instead.\n');
  process.exit(2);
}
const quick = args.includes('--quick');
const outIdx = args.indexOf('--out');
const outPath =
  outIdx >= 0
    ? path.resolve(args[outIdx + 1])
    : path.join(root, 'docs/research/data/window-snapshot-bench.json');

const tmpHome = await mkdtemp(path.join(tmpdir(), 'parley-bench-home-'));
process.env.PARLEY_HOME = tmpHome; // set before importing core (home is resolved lazily, this is belt and braces)
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href);
const protocol = await import(
  pathToFileURL(path.join(root, 'packages/protocol/dist/index.js')).href
);
const { createWorksService } = await import(
  pathToFileURL(path.join(root, 'packages/host/dist/works/works-service.js')).href
);
const { createWork, updateMap, addSession, setWorkStatus, mapLetterReader, mailWorkMap } = core;
const {
  MAX_LINE_BYTES,
  LEGACY_SNAPSHOT_MAX_BYTES,
  COMPACT_WORKS_FEATURE,
  ROOMS_MAIL_FEATURE,
  encodeLine,
} = protocol;

const WINDOW_GATE = 5 * 1024 * 1024; // WINDOW_SNAPSHOT_MAX_BYTES in works-service.ts (not exported)
const FALLBACK_TEXT = 4 * 1024; // WINDOW_FALLBACK_TEXT_BYTES (not exported)
const PAGE = 128 * 1024;
const WARMUP = quick ? 2 : 5;
const SAMPLES = quick ? 5 : 30;
const CHANGE_SAMPLES = quick ? 4 : 15;

// ---------- synthetic content ----------
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

/** scenario = { works, sessions per work, archived count, textBytes (task and summary each) } */
const SCENARIOS = [
  {
    id: 'small-baseline',
    works: 2,
    perWork: 10,
    archived: 0,
    textBytes: 4096,
    note: 'small baseline, 4 KiB texts',
  },
  {
    id: '30w-1000s',
    works: 30,
    perWork: 33,
    total: 1000,
    archived: 20,
    textBytes: 4096,
    note: '30 works, 1,000 sessions, 20 archived/10 active, 4 KiB task + 4 KiB summary',
  },
  {
    id: '30w-3000s',
    works: 30,
    perWork: 100,
    total: 3000,
    archived: 20,
    textBytes: 4096,
    note: '30 works, 3,000 sessions, 20 archived/10 active, 4 KiB task + 4 KiB summary',
  },
  {
    id: '1w-3000s',
    works: 1,
    perWork: 3000,
    archived: 0,
    textBytes: 4096,
    note: 'one work, 3,000 sessions, 4 KiB task + 4 KiB summary',
  },
  {
    id: '30w-3000s-short',
    works: 30,
    perWork: 100,
    total: 3000,
    archived: 20,
    textBytes: 80,
    note: 'control: same shape as 30w-3000s with 80-byte task/summary',
  },
];

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
const bytesOf = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

function perWorkCounts(sc) {
  // distribute `total` over works so the sum is exact
  const total = sc.total ?? sc.works * sc.perWork;
  const base = Math.floor(total / sc.works);
  return Array.from({ length: sc.works }, (_, i) => base + (i < total - base * sc.works ? 1 : 0));
}

async function seed(sc, project) {
  const counts = perWorkCounts(sc);
  const ids = [];
  for (let w = 0; w < sc.works; w += 1) {
    const created = await createWork(project, { title: `bench-${w}`, goal: text(w, 200) });
    const id = created.work.id;
    ids.push(id);
    await updateMap(project, id, (map) => {
      for (let i = 0; i < counts[w]; i += 1) {
        const s = addSession(map, {
          provider: 'claude',
          label: `s${i}`,
          task: text(w * 100000 + i, sc.textBytes),
        });
        s.summary = text(w * 100000 + i + 7, sc.textBytes);
        s.summarySource = 'agent';
      }
    });
  }
  // the first `archived` works are archived, the rest are active
  for (let w = 0; w < sc.archived && w < ids.length; w += 1)
    await setWorkStatus(project, ids[w], 'archived');
  return { ids, counts };
}

// ---------- part A: real service ----------
function makeHostHarness() {
  const clients = [];
  const warnings = [];
  const frames = []; // { t, event, bytes, features }
  const host = {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info() {}, warn: (m) => warnings.push(String(m)), error() {} },
    clients: () => clients,
    liveSessions: () => 0,
    broadcast(event, data, only, encoded) {
      for (const c of clients)
        if (only === undefined || only(c)) c.send({ event, data, line: encoded });
    },
    onShutdown() {},
    shutdown: async () => {},
    busy() {},
    hold() {},
  };
  const client = (name, features) => {
    const c = {
      id: name,
      name,
      features: new Set(features),
      send(message) {
        // real host passes the pre-encoded line (works-service builds it for the size check); never re-encode here
        frames.push({
          t: performance.now(),
          client: name,
          event: message.event,
          revision: message.data?.revision,
          kind: message.data?.kind,
          bytes:
            message.event === 'works.changed'
              ? message.line !== undefined
                ? Buffer.byteLength(message.line)
                : -1
              : 0,
        });
        return true;
      },
      writableLength: () => 0,
      close() {},
    };
    clients.push(c);
    return c;
  };
  return { host, client, warnings, frames };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function partA(sc) {
  // fresh PARLEY_HOME per scenario: the service lists every work registered in the home
  const scenarioHome = await mkdtemp(path.join(tmpdir(), 'parley-bench-home-'));
  process.env.PARLEY_HOME = scenarioHome;
  const project = await mkdtemp(path.join(tmpdir(), 'parley-bench-proj-'));
  const t0 = performance.now();
  const { ids } = await seed(sc, project);
  const seedMs = performance.now() - t0;

  const h = makeHostHarness();
  h.client('window-mail', [COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
  h.client('window-compact', [COMPACT_WORKS_FEATURE]);
  h.client('window-legacy', []);
  const svc = createWorksService(h.host, { debounceMs: 5 });
  const eld = monitorEventLoopDelay({ resolution: 1 });
  eld.enable();
  const tStart = performance.now();
  await svc.start();
  const coldStartMs = performance.now() - tStart;
  eld.disable();
  const coldEld = {
    p50: round(eld.percentile(50) / 1e6),
    p95: round(eld.percentile(95) / 1e6),
    max: round(eld.max / 1e6),
  };

  const describe = (snap) => {
    if (snap === null) return { fits: false, bytes: null, perWork: null };
    const per = snap.entries.map((e) => bytesOf(e));
    return {
      fits: true,
      bytes: bytesOf(snap),
      encodedFrameBytes: Buffer.byteLength(encodeLine({ event: 'works.changed', data: snap })),
      gatePass: bytesOf(snap) <= WINDOW_GATE,
      perWorkBytes: {
        n: per.length,
        min: Math.min(...per),
        p50: pct(per, 50),
        max: Math.max(...per),
        sum: per.reduce((a, b) => a + b, 0),
      },
    };
  };
  const mailSnap = svc.mailSnapshot();
  const compactSnap = svc.windowSnapshot();
  const legacySnap = svc.legacySnapshot();
  const result = {
    scenario: sc.id,
    note: sc.note,
    works: sc.works,
    sessions: perWorkCounts(sc).reduce((a, b) => a + b, 0),
    archived: sc.archived,
    textBytesEach: sc.textBytes,
    gateBytes: WINDOW_GATE,
    maxLineBytes: MAX_LINE_BYTES,
    legacyGateBytes: LEGACY_SNAPSHOT_MAX_BYTES,
    seedMs: round(seedMs),
    coldStartMs: round(coldStartMs),
    coldStartEventLoopDelayMs: coldEld,
    variants: {
      mailSnapshot: describe(mailSnap),
      windowSnapshot: describe(compactSnap),
      legacySnapshot: describe(legacySnap),
    },
    hostWarnings: [...new Set(h.warnings)],
    framesSentAfterStart: h.frames.map((f) => ({
      client: f.client,
      event: f.event,
      kind: f.kind,
      bytes: f.bytes,
    })),
    // fallback detection: the gate falls back to textMax=4 KiB; marker `cut: ` appears in cut text
    usedFallback:
      mailSnap === null
        ? 'dropped (null)'
        : mailSnap.entries.some(
            (e) =>
              e.map.compact?.cut?.length > 0 &&
              e.map.sessions.some((s) => s.task.includes('cut: ')),
          ),
  };

  // warm snapshot call (same revision): cache hit
  const warm = [];
  for (let i = 0; i < WARMUP + SAMPLES; i += 1) {
    const t = performance.now();
    svc.mailSnapshot();
    svc.windowSnapshot();
    if (i >= WARMUP) warm.push(performance.now() - t);
  }
  result.warmSameRevisionCallMs = stat(warm);

  // single-session change in one active work: latency until the mail window gets a new works.changed frame
  await sleep(400); // FSEvents needs a moment after start
  const activeId = ids[ids.length - 1];
  const lat = [];
  const eld2 = monitorEventLoopDelay({ resolution: 1 });
  eld2.enable();
  let noFrame = 0;
  for (let i = 0; i < WARMUP + CHANGE_SAMPLES; i += 1) {
    const before = h.frames.length;
    const t = performance.now();
    await updateMap(project, activeId, (map) => {
      map.sessions[0].task = text(900000 + i, sc.textBytes);
    });
    let got;
    const deadline = performance.now() + 4000;
    while (performance.now() < deadline) {
      got = h.frames
        .slice(before)
        .find((f) => f.client === 'window-mail' && f.event === 'works.changed');
      if (got) break;
      await sleep(2);
    }
    if (got) {
      if (i >= WARMUP) lat.push(got.t - t);
    } else if (i >= WARMUP) noFrame += 1;
    await sleep(150);
  }
  eld2.disable();
  result.singleSessionChange = {
    method:
      'write->broadcast latency (NOT publish CPU alone): time from updateMap() start to the works.changed frame reaching the fake mail client, frame bytes taken from the pre-encoded line without re-encoding; includes SQLite write, watcher, 5 ms debounce, partial rebuild (one work, others cached), gate sizing, encodeLine. Excludes IPC and rendering.',
    warmup: WARMUP,
    latencyMs: lat.length ? stat(lat) : null,
    samplesWithoutFrame: noFrame,
    eventLoopDelayMs: {
      p50: round(eld2.percentile(50) / 1e6),
      p95: round(eld2.percentile(95) / 1e6),
      max: round(eld2.max / 1e6),
    },
    rendererLatency:
      'not measured (window rendering excluded; no replacement implementation exists to measure after-performance)',
    lastFrameBytes:
      [...h.frames].reverse().find((f) => f.client === 'window-mail' && f.event === 'works.changed')
        ?.bytes ?? null,
  };
  result.notices = h.frames.filter((f) => f.event === 'host.notice').map((f) => f.kind);

  // keep entry maps for part B (maps as stored: no letters)
  if (svc.snapshot().entries.length !== sc.works)
    throw new Error(`expected ${sc.works} works, service lists ${svc.snapshot().entries.length}`);
  const maps = svc
    .snapshot()
    .entries.map((e) => ({ map: e.map, archived: e.map.work.status === 'archived' }));
  await svc.stop();
  await rm(project, { recursive: true, force: true });
  await rm(scenarioHome, { recursive: true, force: true });
  return { result, maps };
}

// ---------- part B: pipeline without I/O + transport experiment ----------
const reader = (map) => mapLetterReader({ ...map, messages: [] });

function projectAll(maps, textMax) {
  return maps.map(({ map }) =>
    mailWorkMap(map, reader(map), textMax === undefined ? {} : { textMax }),
  );
}

function skeletonBytes(extra) {
  return bytesOf({ entries: [], branches: {}, revision: 1, ...extra });
}

async function partB(sc, maps) {
  const out = { scenario: sc.id };
  const opts = (fn) => {
    const samples = [];
    for (let i = 0; i < WARMUP + SAMPLES; i += 1) {
      const t = performance.now();
      fn();
      if (i >= WARMUP) samples.push(performance.now() - t);
    }
    return stat(samples);
  };
  const entryOf = (m) => ({ projectPath: 'bench', map: m, version: 1 });
  let projected = projectAll(maps);
  let entries = projected.map(entryOf);
  const snapshot = () => ({ entries, branches: {}, revision: 1 });
  const fullBytes = bytesOf(snapshot());
  const perWorkJson = entries.map((e) => JSON.stringify(e));
  const perWork = perWorkJson.map((s) => Buffer.byteLength(s));
  out.regular = {
    snapshotBytes: fullBytes,
    gatePass: fullBytes <= WINDOW_GATE,
    framePass8MiB: fullBytes < MAX_LINE_BYTES,
    perWorkBytes: {
      n: perWork.length,
      min: Math.min(...perWork),
      p50: pct(perWork, 50),
      max: Math.max(...perWork),
    },
  };
  const fbEntries = projectAll(maps, FALLBACK_TEXT).map(entryOf);
  const fbBytes = bytesOf({ entries: fbEntries, branches: {}, revision: 1 });
  out.fallback = {
    textMax: FALLBACK_TEXT,
    snapshotBytes: fbBytes,
    gatePass: fbBytes <= WINDOW_GATE,
    framePass8MiB: fbBytes < MAX_LINE_BYTES,
  };
  out.publication = out.regular.gatePass
    ? 'regular snapshot published'
    : out.fallback.gatePass
      ? 'fallback snapshot published'
      : 'DROPPED: both regular and fallback exceed the 5 MiB gate (works-service.window.test.ts "snapshot-too-large": windowSnapshot() === null, no works.changed frame, one host.notice)';

  // projection / encode costs (no I/O)
  out.cost = {
    method:
      'in-process, no SQLite/IPC/render; mapLetterReader over an empty letter list (letters are measured separately by the service run); warmup/samples as stated',
    warmup: WARMUP,
    samples: SAMPLES,
    projectAllWorksMs: opts(() => projectAll(maps)),
    projectOneWorkMs: opts(() => mailWorkMap(maps[0].map, reader(maps[0].map), {})),
    stringifyFullSnapshotMs: opts(() => JSON.stringify(snapshot())),
    encodeLineFullSnapshotMs: opts(() => encodeLine({ event: 'works.changed', data: snapshot() })),
    stringifyOneWorkMs: opts(() => JSON.stringify(entries[0])),
  };
  // what the current pipeline pays for a single-session change with a warm per-work cache:
  // project 1 work + stringify 1 work (size for the gate) + skeleton + encodeLine of the whole snapshot.
  out.cost.singleChangeWarmCacheMs = opts(() => {
    const m = mailWorkMap(maps[0].map, reader(maps[0].map), {});
    const e = entryOf(m);
    const b = bytesOf(e);
    void b;
    void skeletonBytes();
    encodeLine({
      event: 'works.changed',
      data: { entries: [e, ...entries.slice(1)], branches: {}, revision: 2 },
    });
  });
  out.cost.singleChangeColdMs = opts(() => {
    const p = projectAll(maps).map(entryOf);
    encodeLine({ event: 'works.changed', data: { entries: p, branches: {}, revision: 2 } });
  });

  // event-loop delay while rebuilding+encoding the full snapshot repeatedly (yield between iterations)
  const eld = monitorEventLoopDelay({ resolution: 1 });
  eld.enable();
  const iters = quick ? 5 : 20;
  for (let i = 0; i < iters; i += 1) {
    encodeLine({
      event: 'works.changed',
      data: { entries: projectAll(maps).map(entryOf), branches: {}, revision: 2 },
    });
    await new Promise((r) => setImmediate(r));
  }
  eld.disable();
  out.eventLoopDelayDuringFullRebuild = {
    iterations: iters,
    resolutionMs: 1,
    p50: round(eld.percentile(50) / 1e6),
    p95: round(eld.percentile(95) / 1e6),
    max: round(eld.max / 1e6),
    note: 'one synchronous rebuild+encode block per iteration; histogram resolution 1 ms',
  };

  // ---- transport experiment (NOT an implementation) ----
  const fullFrameBytes = Buffer.byteLength(
    encodeLine({ event: 'works.changed', data: snapshot() }),
  );
  const changedEntry = entryOf(mailWorkMap(maps[0].map, reader(maps[0].map), {}));
  const deltaFrame = encodeLine({
    event: 'works.delta',
    data: { revision: 2, upsert: [changedEntry], remove: [] },
  });
  const cachedStr = perWorkJson;
  const deltaWithCache = () =>
    `{"event":"works.delta","data":{"revision":2,"upsert":[${cachedStr[0]}],"remove":[]}}\n`;
  // paging by greedy packing of already-serialized per-work strings: no whole-snapshot serialization to enforce the budget
  const pageSizes = [];
  let cur = 0;
  let oversized = [];
  perWork.forEach((b, i) => {
    if (b > PAGE) {
      if (cur > 0) (pageSizes.push(cur), (cur = 0));
      pageSizes.push(b);
      oversized.push({ index: i, bytes: b });
      return;
    }
    if (cur + b + 1 > PAGE) (pageSizes.push(cur), (cur = 0));
    cur += b + 1;
  });
  if (cur > 0) pageSizes.push(cur);
  // realistic small change: ONE session changed. Hypothetical frame carries just that session (+ work id/version).
  const oneSession = maps[maps.length - 1].map.sessions[0];
  const sessionDelta = encodeLine({
    event: 'works.delta',
    data: { revision: 2, workId: 'w', version: 2, sessions: [oneSession] },
  });
  // bounded pages of the changed work: split its sessions greedily into frames of <= PAGE bytes each (envelope counted)
  const envelope = Buffer.byteLength(
    encodeLine({
      event: 'works.page',
      data: { revision: 2, workId: 'w', version: 2, seq: 99, of: 99, sessions: [] },
    }),
  );
  const pageFramesOf = (sessions) => {
    const frames = [];
    let cur = envelope;
    let n = 0;
    for (const s of sessions) {
      const b = Buffer.byteLength(JSON.stringify(s)) + 1;
      if (cur + b > PAGE && n > 0) (frames.push(cur), (cur = envelope), (n = 0));
      cur += b;
      n += 1;
    }
    if (n > 0) frames.push(cur);
    return frames;
  };
  const changedWorkFrames = pageFramesOf(changedEntry.map.sessions);
  const wholeSnapshotFrames = [];
  for (const e of entries) wholeSnapshotFrames.push(...pageFramesOf(e.map.sessions));
  // per-session row delta (EXPERIMENT): the journal knows only "work changed", so the candidate still projects the WHOLE
  // changed work, encodes every projected session row and diffs against cached projected baseline rows; CPU is
  // O(sessions in work), not O(changed rows). Baseline rows are cached from the PROJECTED work; one source session
  // is mutated per run and exactly 1 changed row is asserted; the delta frame is encoded with encodeLine (envelope included).
  const lastMap = maps[maps.length - 1].map;
  const baseRows = mailWorkMap(lastMap, reader(lastMap), {}).sessions.map((x) => JSON.stringify(x));
  let tick = 0;
  const mutated = () => {
    tick += 1;
    const sessions = lastMap.sessions.slice();
    sessions[0] = { ...sessions[0], task: text(7000000 + (tick % 2), sc.textBytes) + '#' };
    return { ...lastMap, sessions };
  };
  let lastDeltaFrameBytes = 0;
  const rowDeltaRun = () => {
    const m = mutated();
    const proj = mailWorkMap(m, reader(m), {});
    const changed = [];
    for (let i = 0; i < proj.sessions.length; i += 1) {
      const row = JSON.stringify(proj.sessions[i]);
      if (row !== baseRows[i]) changed.push(proj.sessions[i]);
    }
    if (changed.length !== 1)
      throw new Error(`row delta expected 1 changed row, got ${changed.length}`);
    const frame = encodeLine({
      event: 'works.delta',
      data: { revision: 2, workId: 'w', version: 2, sessions: changed },
    });
    lastDeltaFrameBytes = Buffer.byteLength(frame);
    return frame;
  };
  const existingRun = () => {
    const m = mutated();
    const e = entryOf(mailWorkMap(m, reader(m), {}));
    JSON.stringify(e); // entry encode for the gate size
    return encodeLine({
      event: 'works.changed',
      data: { entries: [e, ...entries.slice(0, -1)], branches: {}, revision: 2 },
    });
  };
  const eldOf = (fn) => {
    const h = monitorEventLoopDelay({ resolution: 1 });
    return (async () => {
      h.enable();
      const n = quick ? 10 : 40;
      for (let i = 0; i < n; i += 1) {
        fn();
        await new Promise((r) => setImmediate(r));
      }
      h.disable();
      return {
        iterations: n,
        resolutionMs: 1,
        p50: round(h.percentile(50) / 1e6),
        p95: round(h.percentile(95) / 1e6),
        max: round(h.max / 1e6),
      };
    })();
  };
  const rowDelta = {
    label:
      'EXPERIMENT. One changed session in the last work (' +
      lastMap.sessions.length +
      ' sessions). Host CPU is NOT O(changed rows): full changed-work projection + all-row encode + diff.',
    existingWarmCache_projectOneWork_entryEncode_globalEncodeMs: opts(existingRun),
    rowCandidate_projectOneWork_encodeAllRows_diff_deltaEncodeMs: opts(rowDeltaRun),
    deltaFrameBytes: (rowDeltaRun(), lastDeltaFrameBytes),
    existingFullFrameBytes: Buffer.byteLength(existingRun()),
    pairedEventLoopDelay: {
      method:
        'same loop (mutate -> run -> setImmediate yield), N iterations each, 1 ms histogram; synchronous CPU block per iteration only, not publish/IPC/render',
      existingWarmCache: await eldOf(existingRun),
      rowCandidate: await eldOf(rowDeltaRun),
    },
  };
  out.transportExperiment = {
    rowDelta,
    smallChange: {
      label:
        'hypothetical single-session delta frame (envelope + JSON escaping included, measured with encodeLine)',
      singleSessionDeltaFrameBytes: Buffer.byteLength(sessionDelta),
      vsFullSnapshotFrameRatio: round(Buffer.byteLength(sessionDelta) / fullFrameBytes),
      changedWorkPagesAt128KiB: {
        frames: changedWorkFrames.length,
        maxFrameBytes: Math.max(...changedWorkFrames),
        sumBytes: changedWorkFrames.reduce((a, b) => a + b, 0),
      },
      allWorksPagedAt128KiB: {
        frames: wholeSnapshotFrames.length,
        maxFrameBytes: Math.max(...wholeSnapshotFrames),
        sumBytes: wholeSnapshotFrames.reduce((a, b) => a + b, 0),
        note: 'session-level paging of every work (initial sync cost); work metadata other than sessions not counted',
      },
      frameEnvelopeBytes: envelope,
    },
    label:
      'EXPERIMENT ONLY — not a production implementation; sizes are for hypothetical frames, no new after-performance is claimed',
    fullSnapshotFrameBytes: fullFrameBytes,
    changedWorkDeltaFrameBytes: Buffer.byteLength(deltaFrame),
    deltaVsFullRatio: round(Buffer.byteLength(deltaFrame) / fullFrameBytes),
    cost: {
      encodeFullSnapshotMs: out.cost.encodeLineFullSnapshotMs,
      encodeChangedWorkWithCachedStringsMs: opts(() => deltaWithCache()),
      note: 'cached = per-work JSON strings kept from the previous build; only the changed work is re-stringified in the real variant: add projectOneWorkMs + stringifyOneWorkMs',
      reStringifyChangedWorkMs: opts(() =>
        JSON.stringify(entryOf(mailWorkMap(maps[0].map, reader(maps[0].map), {}))),
      ),
    },
    paging128KiB: {
      pageBudgetBytes: PAGE,
      pages: pageSizes.length,
      maxPageBytes: Math.max(...pageSizes),
      oversizedWorks: oversized.length,
      oversizedWorkBytes: oversized.slice(0, 5),
      partitionMs: opts(() => {
        let c = 0;
        let n = 0;
        for (const b of perWork) {
          if (c + b + 1 > PAGE && c > 0) ((n += 1), (c = 0));
          c += b + 1;
        }
        return n;
      }),
      note: 'greedy packing of the per-work byte sizes already known from the cache; a single work above the budget cannot be split by this scheme (it needs in-work paging of sessions)',
    },
  };
  return out;
}

// ---------- main ----------
const report = {
  generatedAt: new Date().toISOString(),
  baseCommit: process.env.BENCH_BASE_COMMIT ?? 'unknown',
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  cpu: (await import('node:os')).cpus()[0]?.model,
  cpuCount: (await import('node:os')).cpus().length,
  quick,
  warmup: WARMUP,
  samples: SAMPLES,
  changeSamples: CHANGE_SAMPLES,
  excludes: [
    'full publish path timing in the shared host (publish() also does releaseMail/published bookkeeping)',
    'IPC/socket write',
    'client decode',
    'window rendering',
    'multi-process host',
    'OS disk cache effects',
    'letters (scenarios have no mail; mailWorkMap is letterless by design)',
  ],
  scenarios: [],
};
for (const sc of SCENARIOS) {
  process.stderr.write(`scenario ${sc.id}...\n`);
  const a = await partA(sc);
  const b = await partB(sc, a.maps);
  report.scenarios.push({ serviceRun: a.result, pipeline: b });
}
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(report, null, 2) + '\n');
await rm(tmpHome, { recursive: true, force: true });
process.stderr.write(`wrote ${outPath}\n`);
process.exit(0);
