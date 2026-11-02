# Window snapshot measurement (M1) — baseline at origin/master 33e3761b

Raw evidence: `docs/research/data/window-snapshot-bench.json` (one run). Command (build `core`, `protocol`, `host` first; the bench imports `packages/*/dist` of the same checkout):

```
node tools/bench/window-snapshot-bench.mjs [--quick] [--out <file>]
```

Environment: Node v22.23.3, darwin-arm64, Apple M4 Pro (12 cores). Warmup 5, 30 samples for pure-pipeline timings, 15 samples (+5 warmup) for the write→frame latency; p50/p95 are nearest-rank over those samples. Event-loop delay: `perf_hooks.monitorEventLoopDelay`, 1 ms resolution. Wall-clock numbers are hardware dependent and asserted nowhere.

## What is measured, what is not

- **Service run (part A)** — the real `createWorksService` with a fake `HostContext`, a real temporary `PARLEY_HOME` (SQLite, file watcher), real core projections and real `encodeLine`. It attaches **mail + compact + legacy windows at once (mixed-client)**, so cold start, change latency and event-loop delay include every compatibility path; they are not a single modern window. The fake client takes bytes from the pre-encoded line and does not re-encode.
- **Pipeline run (part B)** — `mailWorkMap` + `encodeLine` in-process, letters = none, no I/O.
- **Excluded:** IPC/socket write, client decode, window rendering (renderer latency **not measured**), a multi-process host, OS cache effects, the host `publish()` bookkeeping as a timed step, letters (scenarios carry no mail). Sustained single-large-work commit latency is not measured: no replacement implementation exists, so no "after" numbers are claimed.
- **Content:** synthetic, deterministic seeded word salad; per session `task` and `summary` of 4,096 bytes each (control: 80 bytes). Archived works are the first 20 of 30 (10 active).

## Baseline: snapshot sizes and the 5 MiB gate

Gate = `WINDOW_SNAPSHOT_MAX_BYTES` 5 MiB (5,242,880); frame limit `MAX_LINE_BYTES` 8 MiB. "Fallback" = `textMax` 4 KiB, no letters.

| scenario | sessions | regular bytes | fallback bytes | per-work p50 / max | gate | publication |
|---|---|---|---|---|---|---|
| small-baseline (2 works) | 20 | 176,413 | 176,413 | 88,177 / 88,194 | pass | regular published |
| 30w-1000s (20 arch / 10 act) | 1,000 | 8,766,319 | 8,766,319 | 289,337 / 298,265 | **fail** | **dropped** |
| 30w-3000s | 3,000 | 26,260,933 | 26,260,933 | 875,369 / 876,022 | **fail** | **dropped** |
| 1w-3000s (one work) | 3,000 | 26,251,105 | 26,251,105 | 26,251,064 (one work) | **fail** | **dropped** |
| 30w-3000s-short (80 B texts) | 3,000 | 1,785,104 | 1,785,104 | 59,502 / 59,518 | pass | regular published |

- The fallback does not help: the 4 KiB cap equals the synthetic text size, so it removes nothing here. With longer texts it would; the fallback is not a general fix because everything else per session (≈8.8 KB with the 4 KiB texts) still scales with the session count.
- Service run agrees with the pipeline: `mailSnapshot()`, `windowSnapshot()`, `legacySnapshot()` are all `null` for the three over-limit cases; no `works.changed` frame is sent; one `snapshot-too-large` host notice is sent per modern client class (2 notices in the mixed run) and the legacy window gets a host warning only. Mixed-run frames for passing cases: ≈1.79 MB (short) / 176 KB (small).
- **Existing test that expects the drop:** `packages/host/src/works/works-service.window.test.ts`, case "снимок выше потолка — запасной вариант…" (2,200 more sessions with 10,000-char tasks): `await vi.waitFor(() => expect(s.windowSnapshot()).toBeNull())`, exactly one `host.notice` of kind `snapshot-too-large`, zero `works.changed` frames to the compact client, nothing to the legacy client, and no frame ≥ `MAX_LINE_BYTES`. The bench reproduces the same behaviour with realistic 4 KiB task+summary rows (1,000 sessions are already enough).
- Code read (not measured): in `publish()`, when `fits` is false the global branch still runs `published.set(...)` and `releaseMail()` (only gated by `only === undefined`), so versions are marked published and rooms.mail is released although no snapshot frame was sent.

## Baseline: costs (no I/O, p50 / p95 ms)

| scenario | project all works | project one work | stringify full | encodeLine full | one-work change, warm per-work cache | all-cold rebuild + encode | ELD during full rebuild (p50/p95/max) |
|---|---|---|---|---|---|---|---|
| small | 0.09 / 0.21 | 0.01 / 0.01 | 0.24 / 0.60 | 0.24 / 1.19 | 0.53 / 1.27 | 0.26 / 0.32 | 0.98 / 1.47 / 1.98 |
| 30w-1000s | 2.6 / 30.2 | 0.03 / 0.03 | 9.5 / 116.8 | 11.8 / 82.2 | 12.9 / 118.2 | 18.8 / 152.3 | 27.0 / 81.3 / 140.1 |
| 30w-3000s | 3.6 / 5.0 | 0.08 / 0.22 | 15.2 / 15.6 | 15.5 / 17.1 | 16.9 / 18.4 | 25.0 / 38.3 | 24.5 / 40.1 / 43.3 |
| 1w-3000s | 2.8 / 3.2 | 2.85 / 3.48 | 14.7 / 15.1 | 15.1 / 16.4 | 33.3 / 35.9 | 18.3 / 18.7 | 18.4 / 19.0 / 19.3 |
| 30w-3000s-short | 3.1 / 3.6 | 0.08 / 0.10 | 1.5 / 2.4 | 1.5 / 2.3 | 1.6 / 2.4 | 4.3 / 4.6 | 4.7 / 5.0 / 5.1 |

Caveats: in the three over-limit scenarios the production gate stops at the per-work size sum and never does the global `encodeLine`; those rows price the encode that a snapshot that fits would pay (reference only). "Warm" means all but the changed work come from the per-work cache; in the pure-pipeline rows the other works' JSON is re-stringified inside the global encode (as in `broadcastWorks`). Cold-versus-warm on the service itself (mixed-client): cold `start()` 9.6 / 457 / 611 / 120 / 36 ms for the five scenarios above; a repeat call at the same revision is a cache hit, 0 ms.

Service run, single-session change in one active work (mixed-client; write→frame includes SQLite write, watcher, 5 ms debounce, rebuild, gate sizing, encodeLine; excludes IPC/render): small 84.9 / 92.4 ms; 30w-3000s-short 87.8 / 90.5 ms (1.79 MB frame); the three over-limit cases produced **no frame in 15/15 samples**. Event-loop delay during those service changes: p50 ≈1.2 ms, p95 1.2–2.5 ms, max 14–204 ms (max includes seeding-adjacent and watcher work; not attributable to the projection alone).

## Transport experiment (NOT implemented in production; sizes of hypothetical frames)

Wire bytes include the envelope (`encodeLine`) and JSON escaping.

| scenario | full frame | changed-work replacement frame | one-session row delta frame | changed work paged at 128 KiB | every work paged at 128 KiB (session rows) |
|---|---|---|---|---|---|
| small | 176,447 | 88,247 | 8,828 | 1 frame (87,613) | 2 frames |
| 30w-1000s | 8,766,353 | 298,335 | 8,819 | 3 frames (max 122,689) | 90 frames |
| 30w-3000s | 26,260,967 | 875,630 | 8,819 | 8 frames (max 122,689) | 240 frames |
| 1w-3000s | 26,251,139 | **26,251,134** | 8,825 | **215 frames** (max 122,747) | 215 frames |
| 30w-3000s-short | 1,785,138 | 59,565 | 671 | 1 frame | 30 frames |

- Per-work paging by whole works cannot bound a frame when a single work exceeds 128 KiB (30 oversized works in 30w-1000s, 1 work of 26 MB in 1w-3000s): the unit must be rows. Replacing the whole changed work in the one-work case saves nothing (26.25 MB vs 26.25 MB); a row delta is 8.8 KB. Paging uses the already-known per-row sizes (greedy packing, ≈1 µs); no full-snapshot re-serialization to enforce a page budget.
- **Row delta vs existing path, host CPU for ONE changed session** (journal marks the work, not the entity; candidate still projects the whole changed work, encodes all projected rows and diffs against cached projected baseline rows; exactly one changed row asserted; delta encoded with `encodeLine`). This is **not O(changed rows)**:

| scenario | existing (project one work + entry encode + global encode) p50 / p95 ms | row candidate p50 / p95 ms | paired ELD existing p50/p95/max | paired ELD candidate p50/p95/max |
|---|---|---|---|---|
| small | 0.44 / 4.4 | 0.23 / 24.1 | 1.51 / 6.28 / 28.5 | 0.98 / 1.28 / 1.41 |
| 30w-1000s | 9.4 / 94.3 | 1.0 / 23.3 | 10.9 / 46.6 / 118.3 | 1.11 / 1.38 / 1.84 |
| 30w-3000s | 24.2 / 53.1 | 1.8 / 3.1 | 18.7 / 30.5 / 37.7 | 1.84 / 2.12 / 2.32 |
| 1w-3000s | 33.3 / 34.7 | **53.2 / 54.5** | 33.4 / 34.1 / 34.5 | **53.6 / 55.3 / 58.9** |
| 30w-3000s-short | 1.6 / 2.5 | 0.14 / 0.15 | 1.67 / 1.77 / 2.61 | 1.01 / 1.78 / 1.78 |

  In the one-work 3,000-session case the row candidate costs **more** host CPU and event-loop block than the existing path (≈53 vs 33 ms), because it encodes every row of the 26 MB work and the diff adds a second pass; the wire win does not come with a CPU win there unless row-level change tracking avoids re-encoding unchanged rows. The paired ELD loops are synchronous CPU blocks (mutate → run → `setImmediate`), not a publish with IPC.
- "Cached" changed-work encoding with ready strings is a string concatenation (<0.001 ms) and is not a meaningful cost; the honest cost is re-projecting and re-stringifying the changed work (`reStringifyChangedWorkMs` in the JSON: 0.13–18.6 ms).

## Not verified

Renderer latency; IPC/socket write and backpressure; a single modern-window run separately from the mixed-client service run; sustained commit latency of a single large work; behaviour with real mail letters; any after-implementation performance.
