# Window snapshot M2 — compare projected objects before encoding

Base: `33e3761b`, branch `fix/scalable-window-snapshot`. Pure pipeline experiment; no production changes. M1 is complete and its final data remains unchanged. This supplement supersedes neither M1 nor its encoded-row-then-diff result (1w/3k ≈53 vs 33 ms).

## Verdict

Structural comparison resolves the measured sparse-update regression for both large scenarios. For one task edit in 1w/3k, process CPU p50/p95 is **39.272/45.868 → 8.374/10.104 ms**, and active ELD p50/p95/max is **38.502/47.514/77.529 → 8.593/10.420/11.641 ms**. Status edits improve similarly. This is a paired comparison from this run; absolute times should not be compared directly with the earlier M1 run.

**The unconditional same/lower CPU and ELD goal is not met.** In 1w/3k with every row changed, process CPU becomes **37.933/41.486 → 80.568/111.046 ms** and ELD p95 **41.353 → 88.474 ms**. Small-case CPU improves, but ELD is slightly higher around the 1 ms sampling floor (task p95 1.340 → 2.023 ms). No production readiness claim follows from the sparse-update win.

## Reproduce and method

```sh
~/.nvm/versions/node/v22.23.3/bin/node tools/bench/window-snapshot-structural-bench.mjs
```

Raw evidence: `docs/research/data/window-snapshot-structural-m2.json`. Requires the existing same-checkout core/protocol dist builds. `--quick --out /private/tmp/m2-smoke.json` is a smoke run, not final evidence. Default output is a separate M2 file, protecting M1.

Environment: v22.23.3, darwin-arm64, Apple M4 Pro (12 cores). Five alternating paired trials (existing→candidate, then candidate→existing), five warmups and 20 measured calls per variant/trial: 100 samples per variant/scenario/change kind. All fixtures are deterministic pure maps with 4,096-byte task and summary; 30-work case has 20 archived and 10 active works. No service or provider is invoked. Importing the core letter reader loads Node's SQLite module, but the experiment performs no database operations.

Both variants receive freshly structured-cloned maps for every call, mutated outside timing. The candidate caches **projected** baseline row objects and encodings once. Each call independently compares baseline→target with `isDeepStrictEqual`, then creates the next id-keyed object/encoding cache, finds deletions/order changes and encodes a row-delta envelope. All projection, structural comparison, changed-row encoding, envelope encoding, next-cache allocation and bookkeeping are timed. Equal rows reuse cached strings; changed rows are serialized once for their cached encoding and again by the actual protocol `encodeLine` envelope. The baseline projects the changed work, serializes its entry, then encodes the full snapshot including cached other-work projections.

`processCpuMs` is measured `process.cpuUsage()` user+system, including process-wide background CPU. Raw `cpuMs` is synchronous elapsed time from `performance.now()`, retained for comparison with M1. Cloning, mutation, fixture generation, initial projection/cache encoding and correctness checks are outside timing. Fresh inputs are batched before each variant; allocation/GC can still affect measured calls. This is not a sustained-update/cache-evolution workload.

Active ELD uses a **fresh** `monitorEventLoopDelay({ resolution: 1 })` for each trial, primes 5 ms, resets, runs synchronous calls with `setImmediate` yields and drains 2 ms before disabling. Pooled p50/p95/max is reconstructed from each trial histogram at evenly spaced empirical ranks at native HDR precision; rank samples, counts and per-trial p50/p95/max are retained in JSON. A smoke run showed reused ELD monitors could include disabled preparation gaps; that aggregate was discarded, and final evidence uses fresh monitors. Sub-millisecond cases have sparse ELD samples and timer-floor effects.

## Measured process CPU and active ELD (ms)

All entries are existing → candidate. CPU shows p50/p95; ELD shows p50/p95/max.

| Scenario | Change | CPU existing | CPU candidate | ELD existing | ELD candidate |
|---|---|---|---|---|---|
| small | none | 0.397 / 0.657 | 0.034 / 0.059 | 0.911 / 1.583 / 1.608 | 0.778 / 1.708 / 1.717 |
| small | task | 0.415 / 0.470 | 0.062 / 0.076 | 0.891 / 1.340 / 1.652 | 1.116 / 2.023 / 2.023 |
| small | status | 0.417 / 0.460 | 0.061 / 0.087 | 0.898 / 1.375 / 1.596 | 0.949 / 1.926 / 2.092 |
| small | allChanged | 0.395 / 0.448 | 0.317 / 0.356 | 0.848 / 1.327 / 1.646 | 0.990 / 1.496 / 1.825 |
| 30w-3000s | none | 18.243 / 27.249 | 0.217 / 0.783 | 18.383 / 19.956 / 22.102 | 0.947 / 1.882 / 2.039 |
| 30w-3000s | task | 18.307 / 28.223 | 0.245 / 0.278 | 18.612 / 20.742 / 22.954 | 1.041 / 1.345 / 1.707 |
| 30w-3000s | status | 18.317 / 27.473 | 0.238 / 0.266 | 18.547 / 20.513 / 23.282 | 0.989 / 1.434 / 1.974 |
| 30w-3000s | allChanged | 18.160 / 26.992 | 2.377 / 2.537 | 18.416 / 20.562 / 21.217 | 2.415 / 2.712 / 2.869 |
| 1w-3000s | none | 38.240 / 43.952 | 8.792 / 9.990 | 37.945 / 43.647 / 53.314 | 8.872 / 10.551 / 11.633 |
| 1w-3000s | task | 39.272 / 45.868 | 8.374 / 10.104 | 38.502 / 47.514 / 77.529 | 8.593 / 10.420 / 11.641 |
| 1w-3000s | status | 38.094 / 44.471 | 8.164 / 8.884 | 37.847 / 44.925 / 82.117 | 8.438 / 9.191 / 9.650 |
| 1w-3000s | allChanged | 37.933 / 41.486 | 80.568 / 111.046 | 37.716 / 41.353 / 49.840 | 79.692 / 88.474 / 112.525 |

Synchronous elapsed p50/p95 for the key 1w/3k case (existing → candidate):

| Change | Existing | Candidate |
|---|---|---|
| none | 37.890 / 43.577 | 8.627 / 9.869 |
| task | 38.901 / 47.447 | 8.288 / 10.245 |
| status | 37.808 / 44.854 | 8.017 / 8.740 |
| allChanged | 37.681 / 41.296 | 79.821 / 88.443 |

## Projection and encoding counts per call

Exactly one unique changed row is JSON-encoded for task and status edits. The occurrence count is two because the changed row also appears in the encoded envelope. Baseline occurrence counts include other works in the global frame. Cached-equal calls still project and compare the whole changed work.

| Scenario | Projected/compared candidate rows | Existing row serialization occurrences | Candidate none: unique / occurrences / reused | Candidate task or status | Candidate allChanged |
|---|---|---|---|---|---|
| small | 10 | 30 | 0 / 0 / 10 | 1 / 2 / 9 | 10 / 20 / 0 |
| 30w-3000s | 100 | 3100 | 0 / 0 / 100 | 1 / 2 / 99 | 100 / 200 / 0 |
| 1w-3000s | 3000 | 6000 | 0 / 0 / 3000 | 1 / 2 / 2999 | 3000 / 6000 / 0 |

Correctness passed in all 12 scenario/change combinations: fresh projected row identity, full projected-map wire equivalence after applying the decoded delta, exactly expected changed/encoded/reused counts, and exact cached JSON versus fresh JSON. Four small fixtures also passed: delete-middle, reorder, insert, edit-one. A separate post-run isolation check used actual `mailWorkMap` projections with a recursively frozen baseline: fresh cloned-input task/status edits and later mutations left both the baseline and its encodings unchanged; decoded delta reconstruction was exact, and nochange performed zero row encodes while reusing the cached string. This additional correctness check did not change the measured JSON. All timing data is descriptive; no hardware-dependent pass/fail assertions.

The 1w/3k task delta is 8,849 bytes; status delta is 8,861 bytes. The allChanged envelope is 26,247,264 bytes, so it also requires paging in a real transport. This supplement does not implement paging or change the production frame gate.

## Not verified

Production service latency, publication bookkeeping, SQLite/watchers, IPC/backpressure, renderer, sustained commits/cache evolution, cache memory overhead, real letters and actual after-implementation performance. No full real-service rerun, schema/journal expansion, commit, push or PR was performed. The abandoned M2 implementation was removed from the original harness; `--row-reuse` now exits 2 before setup/imports and points to the standalone supplement. A source comparison verified that the M1 code outside obsolete M2/help/import/rejection edits remains byte-identical. No extra full run was performed for this cleanup.

M1 JSON SHA-256 before and after: `8f97d0a0f8c3911bf2b3326e68512dbcd4c477a1988dfef664e10d9856ee0a69`.

## Impact card

- Goal: resolve M1 sparse-update CPU/ELD regression without expanding storage scope.
- Behaviour: experimental projected-row structural comparison, equal-row encoding reuse, changed-only encoding; production behaviour unchanged.
- Numbers: five paired trials, 100 measured calls per variant/case; 1w/3k task CPU p50 39.272 → 8.374 ms; allChanged 37.933 → 80.568 ms.
- Screens: not measured; no UI changes.
- For the human: sparse-update evidence supports further design review; worst-case and small-case ELD prevent an unconditional performance claim.
- Risk: allChanged CPU/ELD regression; large delta still exceeds frame limits; synthetic pipeline excludes service and renderer costs.
- Cost: runtime/cache memory overhead not measured; model/token cost not declared because unavailable to the benchmark.
- Verdict: M1 complete; M2 experiment complete, sparse-update goal met for large cases, unconditional same/lower CPU and ELD not met.
