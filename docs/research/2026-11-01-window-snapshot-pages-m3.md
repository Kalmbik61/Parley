# Window snapshot M3 — bounded pages from cached row JSON

Base `33e3761b`, branch `fix/scalable-window-snapshot`. Standalone pipeline experiment; M1/M2 evidence preserved. No production edits or service rerun.

## Verdict

**Bounded transport and exact reconstruction pass; unconditional same/lower CPU and ELD do not.** Every changed row is JSON-encoded exactly once and packed verbatim into actual newline-terminated <=128 KiB frames. Equal rows are not encoded. The 1w/3k allChanged case emits **215 pages**, maximum **122,786 bytes**, total **26,284,891 bytes**. Removing M2’s second changed-row serialization does not remove the large allChanged CPU regression: paired synchronous process CPU p50/p95 is **41.887/49.669 → 75.276/86.085 ms**; ELD p95 **49.578 → 79.167 ms**. We did not isolate the residual cost among individual row stringification, comparison, allocation, and page assembly; attributing it to one stage would require another measurement.

The separate 4 ms cooperative mode improves responsiveness, not total CPU: its paired 1w/3k allChanged process CPU p50/p95 is **39.769/47.048 → 75.008/85.471 ms**, completion **39.573/50.178 → 72.704/82.767 ms**, ELD **38.928/47.448/77.791 → 4.215/7.311/14.352 ms**. A 4 ms yield target is not a hard bound: worst observed candidate synchronous slice is **9.230 ms**. Sparse task/status updates improve CPU and ELD in both large cases. Small-case ELD is noisy near the 1 ms timer floor and does not support a universal non-regression claim.

## Commands and artifacts

```sh
~/.nvm/versions/node/v22.23.3/bin/node tools/bench/window-snapshot-pages-bench.mjs
~/.nvm/versions/node/v22.23.3/bin/node tools/bench/window-snapshot-pages-bench.mjs --yield-ms 4 --out docs/research/data/window-snapshot-pages-m3-yield4.json
```

Synchronous raw JSON: `docs/research/data/window-snapshot-pages-m3.json`. Separate yielding evidence: `docs/research/data/window-snapshot-pages-m3-yield4.json`. `--quick --out /private/tmp/m3-smoke.json` is smoke only. Existing same-checkout core/protocol dist builds are required. Original `--row-reuse` remains rejected with a standalone M2 pointer.

Environment: v22.23.3, darwin-arm64, Apple M4 Pro (12 cores). Each run: three sizes × four change kinds × five alternating paired trials, five warmups and 20 measured calls per variant/trial (100 samples per variant/case). Runs did not overlap. Inputs match M2's deterministic fixture shape: 4 KiB task+summary, 20 archived/10 active works in the 30-work case. Fresh structuredClone inputs per call; each call is an independent baseline→target update.

## What the measurement includes

Candidate timing includes actual `mailWorkMap` projection of the whole changed work, `isDeepStrictEqual` comparisons against projected baseline objects, exactly one `JSON.stringify` per changed row, encoded UTF-8 row lengths, id-keyed next-cache construction, changed/order/removal token bookkeeping, page packing, small envelope/key encoding, concatenation of the cached JSON text, final actual-frame byte measurement and retained output strings. There is no stringify of a full candidate map or an array of changed objects. Other-work projected rows and encodings are prepared outside timing. Equal rows reuse cached text and cached lengths. The reference is unchanged M2-style work projection + entry stringify + actual protocol `encodeLine` full snapshot; for over-limit fixtures it remains a hypothetical reference encode, not a claim that production publishes that frame.

`processCpuMs` is `process.cpuUsage()` user+system around the awaited operation, including process-wide background CPU. `completionMs` is elapsed `performance.now()` over the same awaited operation. Yield waits remain in completion time and are not presented as a CPU reduction. For `--yield-ms 4`, projection is still one uninterruptible call; comparison/row encoding and packing check the time budget every 16 tokens and use `setImmediate`. Per-trial maximum slices are retained; summary slice statistics use the five trial maxima. The last sample’s yield count is diagnostic, not an aggregate.

Cloning/mutation, fixtures, baseline projection/cache construction and correctness decoding are outside timed CPU calls. Timed ELD uses a fresh 1 ms `monitorEventLoopDelay` each trial, 5 ms priming then reset, operation→setImmediate loops, 2 ms drain. Pooled ELD is reconstructed at native HDR precision from empirical-rank samples; raw rank samples, per-trial percentiles and sample counts are retained. Tiny candidates can finish before a monitor tick, so their sample count is much lower and drain/timer noise dominates. Batched fresh clones can produce allocation/GC effects in measured calls.

## Synchronous process CPU / ELD (ms)

CPU is p50/p95; ELD is p50/p95/max. Columns compare each candidate to its paired reference from the same run.

| Scenario | Change | Reference CPU | Candidate CPU | Reference ELD | Candidate ELD |
|---|---|---|---|---|---|
| small | none | 0.408 / 0.514 | 0.039 / 0.105 | 0.864 / 1.320 / 1.791 | 1.029 / 2.023 / 2.071 |
| small | task | 0.424 / 0.482 | 0.050 / 0.107 | 0.901 / 1.323 / 1.493 | 0.940 / 2.130 / 2.130 |
| small | status | 0.438 / 0.476 | 0.050 / 0.077 | 0.927 / 1.664 / 1.764 | 0.902 / 1.834 / 2.048 |
| small | allChanged | 0.428 / 0.465 | 0.206 / 0.256 | 0.906 / 1.345 / 1.814 | 0.985 / 1.942 / 1.971 |
| 30w-3000s | none | 18.921 / 28.420 | 0.212 / 0.492 | 19.153 / 23.691 / 25.510 | 0.998 / 2.068 / 2.150 |
| 30w-3000s | task | 18.769 / 28.084 | 0.218 / 0.260 | 18.940 / 21.266 / 23.364 | 0.936 / 1.888 / 2.054 |
| 30w-3000s | status | 18.799 / 28.383 | 0.237 / 0.311 | 18.989 / 22.086 / 25.412 | 0.949 / 1.604 / 1.784 |
| 30w-3000s | allChanged | 18.764 / 27.871 | 1.753 / 2.617 | 18.907 / 21.135 / 22.266 | 1.781 / 2.061 / 2.157 |
| 1w-3000s | none | 40.064 / 56.257 | 8.348 / 9.299 | 39.453 / 48.562 / 81.002 | 8.454 / 9.462 / 9.765 |
| 1w-3000s | task | 39.795 / 44.354 | 8.567 / 9.653 | 39.387 / 45.318 / 80.413 | 8.626 / 10.084 / 10.863 |
| 1w-3000s | status | 39.352 / 51.029 | 8.608 / 9.539 | 38.928 / 46.596 / 53.248 | 8.782 / 10.346 / 11.272 |
| 1w-3000s | allChanged | 41.887 / 49.669 | 75.276 / 86.085 | 41.320 / 49.578 / 97.976 | 72.876 / 79.167 / 88.080 |

## Separate cooperative mode (4 ms target)

Full small/30-work results are retained in JSON. None of their last measured candidate calls needed to yield. The one-work case demonstrates the responsiveness/cost tradeoff:

| Change | Reference CPU | Yielding CPU | Reference completion | Yielding completion | Reference ELD | Yielding ELD | Worst candidate slice |
|---|---|---|---|---|---|---|---|
| none | 39.305 / 67.890 | 8.735 / 10.246 | 39.177 / 47.174 | 8.484 / 9.924 | 39.092 / 47.251 / 58.491 | 4.045 / 4.829 / 5.808 | 4.304 |
| task | 37.811 / 52.354 | 9.345 / 11.825 | 37.551 / 46.256 | 9.082 / 11.603 | 37.618 / 48.333 / 59.408 | 4.039 / 5.046 / 5.956 | 5.183 |
| status | 38.456 / 42.942 | 9.065 / 11.337 | 38.275 / 42.683 | 8.753 / 10.570 | 38.273 / 42.762 / 63.668 | 4.041 / 4.919 / 5.272 | 5.002 |
| allChanged | 39.769 / 47.048 | 75.008 / 85.471 | 39.573 / 50.178 | 72.704 / 82.767 | 38.928 / 47.448 / 77.791 | 4.215 / 7.311 / 14.352 | 9.230 |

Synchronous versus yielding absolute times are separate runs; performance conclusions use the paired reference within each run. Yielding does not satisfy the total-CPU goal for allChanged.

## Actual transport and encoding counts per candidate call

Counts and frame sizes are identical in synchronous/yield modes. Retained cache bytes cover all works and mean **UTF-8 bytes of encoded session-row JSON strings**. They exclude V8 strings/objects/Maps, keys, ids, source/projected objects, other entities and transient old+new caches/frames. They are not a heap-size measurement or a bounded-cache claim.

| Scenario | Change | Projected / compared | Encoded once / reused | Frames | Max frame bytes | Total frame bytes | Encoded cache bytes |
|---|---|---|---|---|---|---|---|
| small | none | 10 / 10 | 0 / 10 | 1 | 166 | 166 | 175,009 |
| small | task | 10 / 10 | 1 / 9 | 1 | 8,923 | 8,923 | 175,016 |
| small | status | 10 / 10 | 1 / 9 | 1 | 8,937 | 8,937 | 175,030 |
| small | allChanged | 10 / 10 | 10 / 0 | 1 | 87,649 | 87,649 | 174,966 |
| 30w-3000s | none | 100 / 100 | 0 / 100 | 1 | 167 | 167 | 26,234,826 |
| 30w-3000s | task | 100 / 100 | 1 / 99 | 1 | 8,915 | 8,915 | 26,234,832 |
| 30w-3000s | status | 100 / 100 | 1 / 99 | 1 | 8,930 | 8,930 | 26,234,847 |
| 30w-3000s | allChanged | 100 / 100 | 100 / 0 | 8 | 122,650 | 875,790 | 26,234,873 |
| 1w-3000s | none | 3000 / 3000 | 0 / 3000 | 1 | 166 | 166 | 26,244,403 |
| 1w-3000s | task | 3000 / 3000 | 1 / 2999 | 1 | 8,920 | 8,920 | 26,244,412 |
| 1w-3000s | status | 3000 / 3000 | 1 / 2999 | 1 | 8,932 | 8,932 | 26,244,424 |
| 1w-3000s | allChanged | 3000 / 3000 | 3000 / 0 | 215 | 122,786 | 26,284,891 | 26,244,170 |

Cache memory is O(map size), not bounded by the page size. The 128 KiB limit applies to each frame only. Observed memory changes around creating all-work row caches (synchronous run, unforced GC; whole-process observations, not attributable retained-memory measurements):

| Scenario | Initial row JSON bytes | heapUsed change | RSS change |
|---|---|---|---|
| small | 175,009 | 431,312 | 458,752 |
| 30w-3000s | 26,234,826 | 19,071,792 | 15,826,944 |
| 1w-3000s | 26,244,403 | 21,976,200 | 22,052,864 |

## Correctness and byte accounting

For each of 12 cases in each mode, correctness setup decodes **every frame in that case’s produced page sequence** outside timing, applies all upserts/removals/order chunks, and asserts exact full projected-map JSON equality, no missing/duplicate rows, exact next-cache encodings and lengths, expected changed-row counts, fresh projected object identity and the actual <=131,072-byte bound. Timed calls repeat those deterministic cases; they check every emitted frame’s actual byte bound without including decoder cost in CPU/ELD. AllChanged is asserted to produce multiple pages for the 100- and 3,000-row changed works.

Each page includes event/work/revision/version, sequence, cursor, completion/order-reset metadata, JSON separators and a trailing newline. Packing reserves the longer non-final header, adds measured token UTF-8 lengths and comma counts, then measures each finished frame exactly. Rows are concatenated verbatim from their cached encoding. Removal/order id tokens can span pages. No repeated complete-map stringify enforces the budget.

Seven additional fixture checks pass in both modes: delete-middle, reorder, insertion, empty target, Unicode/quotes/newline/backslash escaping, multipage order/removal, explicit oversized-row rejection. The multipage order/removal control reaches 131,062 bytes in its largest frame. A single row larger than one page is rejected rather than dropped; arbitrary row fragmentation is not implemented. A separate frozen actual-projection test verified input mutation isolation, exact decoded pages, zero nochange encodes and cached-string reuse in both modes.

Preserved evidence SHA-256:

- M1: `8f97d0a0f8c3911bf2b3326e68512dbcd4c477a1988dfef664e10d9856ee0a69`.
- M2: `6aff6deeda40983f68086e04f5166982ae1509cb5f6cc0af277b0c4589cfed18`.

## Not verified

Production protocol integration, publication atomicity/recovery, service/SQLite/watchers, IPC/backpressure, renderer, sustained commits/cache evolution, GC-controlled isolated retained heap, entity types beyond session rows and fragmented oversized rows. Core imports load Node SQLite but perform no database operations here. No production edits, provider calls, service reruns, commit, push or PR.

## Impact card

- Goal: test cached-JSON page transport without M2’s second changed-row serialization.
- Behaviour: experimental exact UTF-8 <=128 KiB frames with verbatim cached rows, sequence/cursor metadata, removals/order chunks, and optional cooperative yielding.
- Numbers: each mode has five paired trials, totaling 100 measured calls per variant/case; 1w/3k allChanged emits 215 frames (max 122,786 bytes), with 3,000 single row encodes. Synchronous CPU p50 41.887 → 75.276 ms. Yield-mode ELD p95 47.448 → 7.311 ms while CPU p50 39.769 → 75.008 ms.
- Screens: not measured; no UI changes.
- For the human: bounded paging is validated as an experiment; sparse updates improve, but paging plus yielding does not establish an unconditional CPU improvement.
- Risk: allChanged CPU regression, O(map-size) cache memory, timer-floor noise and yield slices beyond the 4 ms target; no production-readiness claim.
- Cost: encoded-cache payload ≈26.24 MB in large scenarios; whole-process heap/RSS snapshots recorded with attribution/GC caveats. Model cost not declared because unavailable to the benchmark.
- Verdict: M3 evidence complete; bounded/exact transport passes, sparse-update goal met for large cases, unconditional same/lower CPU+ELD goal fails.
