# Approved budget diagnostic — 128 vs 512 KiB native pages

Base `33e3761b`, branch `fix/scalable-window-snapshot`. One prepared/critic-approved parameter check on the same M4 native bounded-array/projected-object-cache candidate and 4 ms scheduler. All prior artifacts, including the completed 128 KiB final ELD run, are preserved. No production contract changed.

## Result and recommendation

512 KiB reduces dense process CPU p50 **45.599 → 32.634 ms**, dense completion p50 **43.591 → 31.133 ms**, and page count **215 → 54**. Dense→single-edit total CPU p50 improves **53.973 → 40.807 ms**. Sparse output is exactly **8,919 bytes** at either cap; no padding occurs.

However, delay does **not improve uniformly**: dense ELD p95 **4.846 → 5.034 ms**, longest synchronous slice **4.935 → 5.168 ms**; sparse ELD max **4.145 → 4.485 ms**. Dense ELD max improves **5.366 → 5.190 ms**, and sparse ELD p95 improves **3.770 → 3.680 ms**. These are small, noisy diagnostic differences, not proof of a user-visible regression or of equivalence.

**Retain 128 KiB under the prepared rule “if delay worsens, keep 128.”** 512 KiB has a clear measured CPU/page-count benefit, but this eight-pair check does not demonstrate uniformly no-worse delay. Any decision to accept the small delay/slice changes and review a larger constant belongs to the leads/human. Do not compare 32.634 ms to a full-reference CPU number from another run and call dense parity passed: this diagnostic compares only the two native caps. No more variants or benchmark runs are proposed here.

## Command and evidence

```sh
~/.nvm/versions/node/v22.23.3/bin/node tools/bench/window-snapshot-budget-bench.mjs
```

Raw JSON: `docs/research/data/window-snapshot-budget-diagnostic-m4.json`. Optional `--out file` chooses another output. Same-checkout core/protocol dist required. Node v22.23.3, darwin-arm64, Apple M4 Pro. Eight alternating paired dense→single-task-edit chains, two warmup pairs. Only one work / 3,000 rows is tested. Timing p95 equals max at n=8; pooled ELD comes from its timer samples.

## Method

The only parameters changed are maximum frame bytes and bounded row batch size: **128 KiB / 14 rows** versus **512 KiB / 56 rows**. The larger batch is proportional, not a new packing algorithm. Native encodeLine serializes that small array once, measures exact UTF-8 frame bytes, and recursively splits only an overflowing batch into smaller halves. No retry encodes the whole 3,000-row collection. Scheduling remains budget checks every 16 comparisons and after each encoded/rejected batch, setImmediate at the 4 ms target. Projection, object-cache construction and one batch encode remain uninterruptible.

Both caps receive identical freshly cloned dense/sparse inputs, prepared outside timing. Every actual dense result cache feeds its sparse edit. All outputs are decoded and verified against their exact target and actual cap after timing. Initial immutable projected caches are outside timing. Ordinary fixtures have zero retries at both caps; explicit multibyte retry fixtures count all rejected work.

CPU uses process.cpuUsage user+system; completion uses performance.now over the awaited operation, including yielding. A fresh 1 ms monitorEventLoopDelay runs for each operation after 5 ms priming/reset and through setImmediate + 2 ms drain, then stops before decoding. ELD distributions pool retained empirical-rank native HDR samples over eight operations/case/cap. This per-operation window retains much less output than the prior 100-sample final run and has different timer-floor effects; **compare caps within this run only**, not absolute ELD/CPU across runs. No forced GC or isolated cause attribution. Sparse ELD has only 12/14 pooled timer samples and is especially noisy.

## Measurements (p50 / p95 / max, ms)

| Cap | Update | Process CPU | Completion | Active ELD | Maximum slice per operation |
|---|---|---|---|---|---|
| 128 KiB | dense | 45.599 / 51.389 / 51.389 | 43.591 / 49.319 / 49.319 | 4.125 / 4.846 / 5.366 | 4.253 / 4.935 / 4.935 |
| 128 KiB | sparse | 7.760 / 8.855 / 8.855 | 7.500 / 8.540 / 8.540 | 1.324 / 3.770 / 4.145 | 4.008 / 4.024 / 4.024 |
| 512 KiB | dense | 32.634 / 33.863 / 33.863 | 31.133 / 32.910 / 32.910 | 4.182 / 5.034 / 5.190 | 5.010 / 5.168 / 5.168 |
| 512 KiB | sparse | 8.732 / 9.072 / 9.072 | 7.582 / 8.501 / 8.501 | 1.321 / 3.680 / 4.485 | 4.014 / 4.032 / 4.032 |

| Cap | Dense+sparse CPU p50/p95/max ms | Dense+sparse completion p50/p95/max ms |
|---|---|---|
| 128 KiB | 53.973 / 59.428 / 59.428 | 51.738 / 57.096 / 57.096 |
| 512 KiB | 40.807 / 42.935 / 42.935 | 38.496 / 40.545 / 40.545 |

Sparse code handles the same one-row array at both caps; its observed CPU change is not attributed to a known algorithmic cause. Process background CPU/GC and scheduling are uncontrolled. The experiment does not declare a significance/equivalence threshold.

## Exact bytes and encoding work

Every normal dense update projects/compares 3,000 rows and serializes 3,000 row occurrences; the following sparse edit projects/compares 3,000 and serializes exactly one row. Neither path eagerly retains per-row encoded strings; projected objects still cost memory.

| Cap | Update | Frame count | Largest frame bytes | Total frame bytes | Page encode attempts | Oversized attempts | Row serialization occurrences |
|---|---|---|---|---|---|---|---|
| 128 KiB | dense | 215 | 122,786 | 26,284,891 | 215 | 0 | 3,000 |
| 128 KiB | sparse | 1 | 8,919 | 8,919 | 1 | 0 | 1 |
| 512 KiB | dense | 54 | 490,328 | 26,256,601 | 54 | 0 | 3,000 |
| 512 KiB | sparse | 1 | 8,919 | 8,919 | 1 | 0 | 1 |

All frames include JSON/UTF-8 escaping, complete envelope, sequence/cursor metadata, separators and newline. Identical normal payloads have identical bytes/counts across each cap’s samples. Both decoded sequences reproduce the dense and sparse targets exactly, with no missing rows.

| Retry fixture cap | Unique changed rows | Encoded occurrences including retries | Page attempts | Oversized attempts | Final frames | Largest bytes | Total bytes |
|---|---|---|---|---|---|---|---|
| 128 KiB | 14 | 42 | 7 | 3 | 4 | 90,541 | 316,920 |
| 512 KiB | 56 | 168 | 7 | 3 | 4 | 316,437 | 1,265,531 |

Retry input uses the cap’s bounded batch count with multibyte/escaped text. Both cases have three rejected oversized attempts and four valid decoded pages. All retry work is reported; no oversized placeholder is returned.

## Preservation and limits

The completed final 128 KiB ELD JSON remains SHA-256 `69f7b7f6babde68aada60dbf3d9930e033c4a7c467f52ff86754c588b20d64f0`; its script remains `d244797a6ca9f39fa962677a47f33c113a744a8840b72c41af0de1aec14f9731`. M1–M4 earlier raw data remains unchanged. Syntax and raw-data audits verify all eight pairs, evolving-cache row counts, actual cap bounds, retry counts, sparse equality and exact total timing accounting.

## Not verified

Final performance acceptance, statistical delay equivalence, hard 4 ms scheduling deadline, consumer decode/IPC/backpressure/cold-bootstrap latency, production integration/recovery, other sizes/entities, and isolated heap/GC effects. Fewer pages do not prove lower consumer or startup latency. No production/contract/storage/UI/compression changes, full-matrix/service/provider run, commit/push/PR. Benchmark work stops after reporting to s-203/s-38/s-211 for the human criterion decision.

## Impact card

- Goal: test the single approved page-budget parameter hypothesis.
- Behaviour: same native/object-cache/4 ms scheduling path, 14-row/128 KiB versus 56-row/512 KiB bounds, actual-byte retry/split checks.
- Numbers: eight paired chains; dense CPU p50 45.599 → 32.634 ms, 215 → 54 pages; dense ELD p95 4.846 → 5.034 ms; sparse frame unchanged at 8,919 bytes.
- Screens: not measured; host-loop proxy only.
- For the human: larger pages reduce measured CPU but do not show uniformly improved delay; review is needed before changing the proposed constant.
- Risk: small noisy sample; some delay/slice metrics rise; no consumer/production latency claim.
- Cost: retained projected-object heap/model cost unmeasured; normal encoding and all overflow retry counts recorded.
- Verdict: diagnostic complete; retain 128 KiB under the prepared conservative rule, preserve production contract, stop benchmarking.
