# Window snapshot M4 — dense-update diagnosis and one hypothesis

Base `33e3761b`, branch `fix/scalable-window-snapshot`. Benchmark-only diagnosis of **1 work / 3,000 sessions, allChanged**, followed by one sparse change. M1–M3 evidence is preserved. No full matrix or service rerun.

## Recommendation to s-203 / s-211

**Do not treat eager per-row encoded-JSON caching as a required transport primitive.** Individual row stringification dominates this dense workload. The one tested alternative—native bounded array-page encoding with a projected-object cache—improves M3 and the dense→sparse chain, and its later sparse update does not pay a hidden rebuild of 3,000 encodings. It is a reasonable candidate for architecture review, with cache strings materialized only for a consumer that actually requires them.

**Keep the numeric gate open.** Dense-only process CPU still exceeds the full-encode reference: **47.081/53.125 vs 38.347/63.087 ms p50/p95** (p50 about 23% higher; n=8 p95 is the maximum). A dense→one-sparse chain has CPU **56.309/62.367 vs 73.773/100.109 ms**, but that workload-specific improvement cannot satisfy an unconditional per-update CPU requirement. Recommend an explicit lead/human decision on the supported update mix and acceptable dense-update CPU budget before production implementation. Do not continue blind variant iteration. This diagnosis measures no ELD and does not reopen the small-case timer-floor claims or establish a final performance pass.

## Reproduce

```sh
~/.nvm/versions/node/v22.23.3/bin/node tools/bench/window-snapshot-diagnose-bench.mjs
~/.nvm/versions/node/v22.23.3/bin/node tools/bench/window-snapshot-diagnose-bench.mjs --test-hypothesis
```

Outputs: `docs/research/data/window-snapshot-diagnose-m4.json` and `docs/research/data/window-snapshot-hypothesis-m4.json`. Optional `--out file` chooses a separate output. Uses existing same-checkout core/protocol dist builds, Node v22.23.3 on Apple M4 Pro. Both diagnostics use 8 measured samples and 2 warmups; these are stage diagnostics, not the five-pair full-matrix acceptance run.

## Stage attribution

The first diagnostic alternates original M3 and instrumented dense builds, with freshly cloned input outside timing. Instrumented stages split the original interleaved row loop into batched passes so there are seven process-CPU/timer probes rather than thousands of per-row probes. This introduces temporary arrays, changes allocation/GC/layout and moves final frame validation after packing. The observed original-versus-staged difference is therefore **not a pure timer-overhead estimate**. All required work remains included and decoded outputs match the target. Process CPU uses `process.cpuUsage` user+system; elapsed uses `performance.now`.

| Path | Elapsed p50/p95 ms | Process CPU p50/p95 ms |
|---|---|---|
| original | 64.311 / 75.750 | 69.962 / 85.342 |
| staged | 64.868 / 73.970 | 71.214 / 82.270 |

| Stage | Elapsed p50/p95 ms | Process CPU p50/p95 ms |
|---|---|---|
| projection | 3.677 / 4.671 | 5.683 / 7.739 |
| comparison | 1.354 / 1.763 | 1.383 / 2.275 |
| rowStringify | 50.965 / 52.548 | 52.088 / 53.052 |
| rowByteCounts | 0.621 / 1.316 | 0.624 / 1.262 |
| nextCacheAndTokens | 0.865 / 0.985 | 1.513 / 2.317 |
| packingAndConcatenation | 5.250 / 7.334 | 6.276 / 9.472 |
| finalFrameByteValidation | 2.092 / 5.916 | 3.037 / 9.566 |

Row stringify is dominant: elapsed p50 **50.965 ms** and process CPU p50 **52.088 ms**, versus staged totals **64.868 ms elapsed / 71.214 ms CPU**. Structural comparison is only **1.383 ms CPU**, row-byte counts **0.624 ms**, next-cache/token work **1.513 ms**, packing **6.276 ms**, final-byte validation **3.037 ms**. Stage percentile sums need not equal total percentiles. GC/background process CPU is not controlled, and this diagnosis does not attribute V8-internal causes.

## The one tested hypothesis

Native `JSON.stringify` via actual `encodeLine` over small arrays may avoid the cost of stringifying 3,000 individual rows. The experiment retains projected objects and does **not** eagerly retain row JSON strings. A changed batch is at most 14 rows, matching the observed capacity of this deterministic 4 KiB task + 4 KiB summary fixture. Fourteen is only a batch-size bound, never a trusted byte estimate: every encoded frame is measured in UTF-8, including envelope/sequence/cursor/newline. An oversized batch is split recursively and re-encoded; every rejected attempt and every row reserialization is counted. An oversized single projected row is explicitly rejected.

This is intentionally restricted to same ids/order and these dense/sparse updates; it does not implement generic removal/reorder support. The original M3 path and the full-encode reference are controls, not additional candidate variants. Initial projected/encoded caches are prepared outside timing. Each chain uses fresh cloned dense and sparse inputs prepared before either timed operation. The exact **dense result cache** feeds the next sparse operation. The full reference still produces an unbounded 26 MB hypothetical frame, as in M1–M3; it is a CPU reference, not valid production transport.

Per-row encodings remain unmaterialized in both alternative updates: the sparse delta needs only its one changed object and can native-encode that one-row array. This tests the explicit object-cache/no-eager-encoding hypothesis rather than silently deferring a full encoding rebuild. A later consumer requiring individual cached strings, full resync or cold initial paging could incur different costs and is not measured.

## Dense → sparse chain (8 samples each)

CPU and elapsed are measured separately for each operation; chain totals sum the two measured operations and exclude correctness checks, fixture cloning and pauses. Sample order alternates forward/reverse across the three controls/candidate. Correctness decodes every produced frame in every warmup/measured candidate operation outside timing.

| Path | Update | Elapsed p50/p95 ms | Process CPU p50/p95 ms |
|---|---|---|---|
| m3 | dense | 61.128 / 75.912 | 65.995 / 115.551 |
| m3 | sparse | 8.687 / 9.514 | 9.495 / 9.847 |
| m3 | total | 69.701 / 84.302 | 75.220 / 125.159 |
| nativeArray | dense | 44.811 / 49.578 | 47.081 / 53.125 |
| nativeArray | sparse | 8.290 / 8.877 | 8.971 / 10.577 |
| nativeArray | total | 52.975 / 58.222 | 56.309 / 62.367 |
| fullReference | dense | 36.271 / 46.031 | 38.347 / 63.087 |
| fullReference | sparse | 34.902 / 38.303 | 35.669 / 38.602 |
| fullReference | total | 71.518 / 81.440 | 73.773 / 100.109 |

The alternative subsequent sparse CPU p50 **8.971 ms** is comparable to M3’s **9.495 ms**, with exactly one row serialization and no per-row cache rebuild. The chain CPU p50 **56.309 ms** improves M3’s **75.220 ms** and reference **73.773 ms** in this eight-sample diagnostic. Dense-only CPU p50 **47.081 ms** improves M3’s **65.995 ms** but remains above reference **38.347 ms**. These results support an architecture discussion, not a final numerical acceptance claim.

## Encoding, retries and bytes

| Path / update | Unique changed rows | Row serialization occurrences | Native page attempts | Oversized attempts | Frames | Largest bytes | Total bytes | Retained row-encoding bytes |
|---|---|---|---|---|---|---|---|---|
| m3 / dense | 3000 | 3000 | n/a | n/a | 215 | 122,786 | 26,284,891 | 26,244,170 |
| m3 / sparse | 1 | 1 | n/a | n/a | 1 | 8,919 | 8,919 | 26,244,170 |
| nativeArray / dense | 3000 | 3000 | 215 | 0 | 215 | 122,786 | 26,284,891 | 0 |
| nativeArray / sparse | 1 | 1 | 1 | 0 | 1 | 8,919 | 8,919 | 0 |
| Native Unicode retry fixture | 14 | 42 | 7 | 3 | 4 | 90,510 | 316,869 | 0 |

The dense ordinary fixture has no retries and 215 bounded frames, largest **122,786 bytes**, total **26,284,891 bytes**, identical to M3 transport. Sparse has one frame **8,919 bytes**. The retry fixture serializes 14 unique rows **42 times across 7 page attempts**, including 3 rejected oversized attempts, and emits four valid pages (max 90,510 bytes). Rejected work is not hidden by the unique-row count. Each retry fixture row has multibyte/escaped text. The oversized-row fixture uses many short context ids because real projection caps long text fields; its cache preserves ids/order so it tests the byte limit rather than the restricted-scope guard. The first attempt’s auxiliary fixture had an id-count mismatch; it was corrected without changing the candidate algorithm, and final raw results are from the successful eight-chain run.

All projected objects remain retained; zero encoded-row-cache bytes does **not** mean zero cache memory. Projected/source objects, id maps and frames still cost memory. M4 does not repeat M3’s heap/RSS observations or claim an isolated memory improvement.

## Validation and preservation

Original/staged builds and both chain candidates assert exact decoded target rows, full-map JSON equivalence and frame byte bounds. Alternative validates sequence/cursor/newline and one-row sparse counts, while its sparse baseline is the actual dense next-cache. Retry/split and oversized-single-row checks pass. Source syntax checks pass. No hardware timing assertions.

M1–M3 JSON SHA-256 values remain:

- M1: `8f97d0a0f8c3911bf2b3326e68512dbcd4c477a1988dfef664e10d9856ee0a69`.
- M2: `6aff6deeda40983f68086e04f5166982ae1509cb5f6cc0af277b0c4589cfed18`.
- M3 sync: `2c5d5fa746689b39d81edbc36b83ca7a6d7fde88669689bc51bc4f60a8625a1e`.
- M3 yield4: `3268be52945caa4a59810874cac30436b671b8782cf67d12169a5a2346923ac7`.

## Not verified

Final five-pair performance gate, ELD, small/30-work fixtures, cold pages/resync, generic insertion/deletion/reorder for the alternative, other entities, V8-internal causes, GC-isolated memory costs, future consumers requiring cached row JSON, production protocol integration, recovery/atomicity, IPC/renderer and real service costs. No additional variants, production edits, DB/journal work, compression, provider calls, service rerun, commit/push/PR.

## Impact card

- Goal: diagnose repeated dense-cost failures and test one evidence-supported hypothesis.
- Behaviour: stage-only diagnostic plus one bounded native-array-page/projected-object-cache candidate; dense cache feeds subsequent sparse update.
- Numbers: 8 original/staged pairs, 8 chains per path; row stringify CPU p50 52.088 ms; native dense CPU 47.081 vs reference 38.347 ms; dense+sparse 56.309 vs reference 73.773 ms.
- Screens: not measured; no UI changes.
- For the human: eager row-JSON cache should not be assumed mandatory; review object caching and the acceptable dense-update budget rather than iterating blindly.
- Risk: dense CPU regression remains; small sample and changed instrumentation layout; alternate path has restricted semantics and no ELD evidence.
- Cost: 3,000 dense +1 subsequent sparse row serializations, zero retained per-row encodings for this path; projected-object heap overhead and model cost not measured.
- Verdict: M4 diagnosis complete; dominant cost identified, one hypothesis improves M3 and chain total but does not pass unconditional dense CPU gate.

## Addendum — sparse control and dense → nochange → single-edit

This bounded follow-up addresses the lead/reviewer refinement without adding an architecture variant or overwriting the first M4 JSON files. It uses the same native-array candidate and the same 1w/3k fixture. Both supplemental runs retain 8 samples and 2 warmups; no matrix/service rerun.

```sh
~/.nvm/versions/node/v22.23.3/bin/node tools/bench/window-snapshot-diagnose-bench.mjs --sparse-control --out docs/research/data/window-snapshot-diagnose-m4-sparse.json
~/.nvm/versions/node/v22.23.3/bin/node tools/bench/window-snapshot-diagnose-bench.mjs --test-hypothesis --evolving-control --out docs/research/data/window-snapshot-hypothesis-m4-evolving.json
```

### Sparse instrumentation control

Both paths perform the complete single-edit operation from a projected/encoded dense baseline. There is exactly one changed/encoded row. Inputs are freshly cloned and row/page output is checked. CPU and elapsed totals remain paired; they are not replaced by sums of stage medians.

| Sparse path | Complete elapsed p50/p95 ms | Complete process CPU p50/p95 ms |
|---|---|---|
| original | 10.073 / 11.529 | 12.493 / 20.539 |
| staged | 9.710 / 13.092 | 13.598 / 22.292 |

| Sparse stage | Elapsed p50/p95 ms | Process CPU p50/p95 ms |
|---|---|---|
| projection | 3.317 / 4.938 | 5.585 / 8.749 |
| comparison | 5.078 / 7.234 | 5.794 / 11.964 |
| rowStringify | 0.340 / 0.559 | 0.340 / 0.752 |
| rowByteCounts | 0.112 / 0.294 | 0.112 / 0.597 |
| nextCacheAndTokens | 0.430 / 0.711 | 0.442 / 1.816 |
| packingAndConcatenation | 0.028 / 0.086 | 0.030 / 0.533 |
| finalFrameByteValidation | 0.002 / 0.003 | 0.002 / 0.003 |

Sparse staged CPU p50 is **13.598 vs 12.493 ms** original, whereas elapsed is **9.710 vs 10.073 ms**. This exposes instrumentation/layout/GC/noise effects and is not a fixed overhead correction. Comparison dominates the sparse case (**5.794 ms CPU p50**) rather than row stringify (**0.340 ms**): unchanged cloned rows require structural equality work, while dense changed-task rows can differ earlier. Do not infer the exact internal cause beyond this measured phase attribution.

### Evolving cache sequence

All three input maps are cloned before timing. Each candidate’s actual dense next-cache becomes the nochange baseline; its actual nochange next-cache becomes the single-edit baseline. Every measured/warmup output is decoded and checked against its target after each operation. The candidate algorithm and bounded 14-row retry/split policy are unchanged.

**Nochange here means a forced changed-work rebuild whose projected row values are equal**, matching M2/M3 equal-row controls. It is not an idle read at an unchanged revision or a production cache hit. The full-reference control still projects/encodes on this forced rebuild; the chain totals must not be read as savings against an idle service.

| Path | Operation | Elapsed p50/p95 ms | Process CPU p50/p95 ms |
|---|---|---|---|
| m3 | dense | 64.260 / 76.327 | 69.328 / 108.028 |
| m3 | none | 8.789 / 9.690 | 9.738 / 10.903 |
| m3 | sparse | 8.406 / 9.457 | 8.634 / 10.332 |
| m3 | total | 81.662 / 93.266 | 88.359 / 127.435 |
| nativeArray | dense | 44.838 / 51.635 | 47.488 / 54.460 |
| nativeArray | none | 8.410 / 10.326 | 8.997 / 12.533 |
| nativeArray | sparse | 8.484 / 9.204 | 8.726 / 9.401 |
| nativeArray | total | 61.975 / 71.165 | 65.364 / 75.744 |
| fullReference | dense | 36.896 / 40.088 | 37.632 / 40.631 |
| fullReference | none | 35.813 / 40.016 | 36.146 / 40.336 |
| fullReference | sparse | 35.192 / 39.824 | 36.170 / 40.108 |
| fullReference | total | 108.905 / 114.306 | 111.524 / 117.033 |

The native-array path has **3,000 → 0 → 1 row serialization occurrences**, no retries on this fixture, and zero eagerly retained row-JSON bytes after every state. Its pages are **215 → 1 → 1**, largest **122,786 → 166 → 8,919 bytes**. This demonstrates no full-row encoding debt at either the equal-row rebuild or the following sparse edit. It retains projected objects and still pays O(changed-work rows) projection/comparison.

Native chain CPU p50 **65.364 ms** improves M3 **88.359 ms** and the forced-rebuild reference **111.524 ms**. Dense-only CPU still regresses **47.488 vs 37.632 ms** reference. The architecture recommendation and open numeric gate therefore remain unchanged; this is not a new final acceptance run and contains no ELD measurement.

Overflow handling remains bounded to one <=14-row batch and its smaller recursive halves. The supplemental retry fixture again counts all 42 row serializations, including 3 oversized attempts, for 14 unique rows; it never serializes the complete 3,000-row collection as a retry strategy.

Addendum impact card: Goal — close missing nochange/sparse-control evidence; Behaviour — same candidate, evolving three-state cache chain and complete original/staged sparse totals; Numbers — 8 samples/control, 3,000/0/1 encodes, native total CPU p50 65.364 ms; Screens — not measured; For the human — no hidden encoding rebuild observed in the tested sequence; Risk — dense CPU gate remains open and small diagnostic sample; Cost — projected-object heap not measured; Verdict — requested diagnostic coverage complete, no production-readiness claim.
