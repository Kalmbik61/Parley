# M4 final evidence — native bounded pages with cooperative scheduling

Base `33e3761b`, branch `fix/scalable-window-snapshot`. Final benchmark-only evidence requested by s-203/s-38 for the pending human performance decision. Same M4 native bounded-array/projected-object-cache transport, with a cooperative 4 ms scheduling target. No new transport variant, production edits or service rerun. Earlier benchmark artifacts are preserved.

## Findings for the human decision

- Dense allChanged: process CPU p50/p95 **39.155/57.719 → 50.803/65.113 ms**; completion p50/p95 **38.598/52.498 → 49.955/64.319 ms**. CPU p50 rises about 30%. Active ELD p50/p95/max improves **38.240/52.560/89.326 → 4.157/6.320/55.312 ms**.
- One task edit: process CPU p50/p95 **39.566/59.898 → 9.001/11.415 ms**; ELD **38.502/50.037/106.103 → 4.028/4.895/6.771 ms**.
- One status edit: process CPU p50/p95 **38.786/52.688 → 8.922/10.835 ms**; ELD **38.371/45.122/107.676 → 4.028/4.772/5.992 ms**.
- The 4 ms target is **not a hard bound**. Dense longest synchronous slice is **52.902 ms**, with per-operation maximum-slice p95 **7.779 ms**. Dense ELD max remains **55.312 ms**; sparse longest slices are **4.606 ms task / 5.674 ms status**.
- Every produced candidate frame is <=131,072 bytes and every warmup/measured update decodes to its exact target. Dense emits 215 pages, largest 122,786 bytes. Sparse emits one <=8,932-byte page.

This supplies a measured responsiveness/CPU tradeoff. It is not an automatic CPU waiver or production-readiness verdict; the human’s acceptable performance criterion remains pending. Earlier unconditional dense-CPU parity checks were an investigation criterion, not an established human acceptance rule. The lead takes these numbers to that decision. ELD is a host-loop proxy; actual renderer/end-to-end latency is not measured. Benchmark work stops after this report.

## Reproduce and raw evidence

```sh
~/.nvm/versions/node/v22.23.3/bin/node tools/bench/window-snapshot-native-eld-bench.mjs
```

Raw JSON: `docs/research/data/window-snapshot-native-eld-m4.json`. Optional `--out file` changes the output. Uses existing same-checkout core/protocol dist builds. Environment: Node v22.23.3, darwin-arm64, Apple M4 Pro. Five alternating paired trials per case, five warmups and 20 measured calls per variant/trial: 100 samples per variant/case. Only 1w/3k dense/task/status are measured.

## Method and scope

Fixtures retain 4,096-byte synthetic task and summary fields. Every operation uses a fresh cloned input prepared outside timing. Dense alternates between two complete task sets; sparse task toggles one task; status toggles lifecycle active/pending and startedAt. The actual candidate next-cache feeds every subsequent operation, including warmup→measurement. Each changed row is native-encoded within a bounded <=14-row array page; overflow retries only that batch and smaller halves, exactly as the prior M4 candidate. This normal fixture produced zero oversized retries.

Only scheduling is added: compare-loop budget checks every 16 rows and page-encode checks after each successful/rejected batch, yielding with setImmediate when elapsed slice reaches 4 ms. Full mailWorkMap projection, object-cache construction and an individual native batch encode remain uninterruptible. Long-tail pauses were observed; this run does not isolate GC, allocation, OS scheduling or other causes.

Process CPU is process.cpuUsage user+system over the awaited complete operation; completion is performance.now over the same call, including yield waits. Waiting is not counted as saved CPU. The reference projects the changed work, stringifies its entry and encodeLine-encodes a full snapshot: it is the same hypothetical CPU reference as M1–M4. For the oversized fixture, production’s gate would stop publication; these are not measured before/after real-service delivery costs.

Active ELD uses a fresh 1 ms monitorEventLoopDelay histogram per trial, primed 5 ms then reset; measured operation→setImmediate loops; 2 ms drain. Native HDR distributions are pooled using retained empirical-rank samples, as in M3. Per-trial raw CPU/completion/slice/yield/transport samples and ELD ranks are retained. Reference synchronous-slice estimates equal its completion time; candidate slices are measured within the scheduler.

All outputs, input clones and projected rows remain live until the trial monitor is disabled, then **every warmup/measured output** is decoded and checked before the next trial. This excludes decoder cost from measured CPU/ELD but increases memory retained across 20 calls and may influence GC. Process CPU includes background threads. There is no forced-GC control or isolated memory attribution. This caveat is relevant to the long tails; it is not a proven explanation for them. The initial collection attempt was stopped before output to add per-call byte maxima for the alternating dense payloads; final JSON contains only the completed five-pair run.

## Full distributions (p50 / p95 / max, ms)

| Case | Path | Process CPU | Completion | Active ELD | Maximum slice per operation |
|---|---|---|---|---|---|
| dense | existing | 39.155 / 57.719 / 258.883 | 38.598 / 52.498 / 86.394 | 38.240 / 52.560 / 89.326 | 38.598 / 52.498 / 86.394 |
| dense | candidate | 50.803 / 65.113 / 155.552 | 49.955 / 64.319 / 107.603 | 4.157 / 6.320 / 55.312 | 5.234 / 7.779 / 52.902 |
| task | existing | 39.566 / 59.898 / 191.427 | 39.169 / 49.943 / 102.955 | 38.502 / 50.037 / 106.103 | 39.169 / 49.943 / 102.955 |
| task | candidate | 9.001 / 11.415 / 12.198 | 8.723 / 10.782 / 11.592 | 4.028 / 4.895 / 6.771 | 4.023 / 4.480 / 4.606 |
| status | existing | 38.786 / 52.688 / 162.240 | 38.420 / 45.069 / 104.713 | 38.371 / 45.122 / 107.676 | 38.420 / 45.069 / 104.713 |
| status | candidate | 8.922 / 10.835 / 12.326 | 8.620 / 10.172 / 10.695 | 4.028 / 4.772 / 5.992 | 4.019 / 4.232 / 5.674 |

Maximum CPU can exceed elapsed because process CPU includes concurrent background threads. Percentiles are nearest-rank over samples; ELD is its timer histogram, not a percentile of operation completion. The dense case’s 55.312 ms ELD tail must be considered alongside the much lower p95.

## Encoding and actual frame bytes

Every call projects/compares 3,000 rows. Candidate retains projected objects, with zero eager per-row encoded-cache bytes; projected-object memory is not measured. Every ordinary dense call serializes 3,000 rows in 215 native page attempts; every sparse call serializes one row in one page attempt; all have zero retries. The reference serializes 6,000 row occurrences (entry plus full snapshot).

| Case | Candidate row occurrences | Frames/call | Maximum frame across all calls | Total bytes/call p50 / p95 / max | Yields/call p50 / p95 / max |
|---|---|---|---|---|---|
| dense | 3,000 | 215 | 122,786 | 26,284,891 / 26,285,382 / 26,285,382 | 11 / 11 / 12 |
| task | 1 | 1 | 8,919 | 8,914 / 8,919 / 8,919 | 2 / 2 / 2 |
| status | 1 | 1 | 8,932 | 8,911 / 8,932 / 8,932 | 2 / 2 / 2 |

Sizes include UTF-8 escaping, envelope/keys, sequence/cursor metadata, row separators and newline. Per-call bytes vary because the cache evolves between alternating payloads. Reported maximum covers **all measured frames**, not only the representative last-call counts. Every produced output validates event/work id, sequence, cursor, done flag, newline, exact actual bytes, frame bound, row count, retained object cache and decoded target semantics.

## Not verified

Production implementation/integration, recovery/atomicity, renderer or end-to-end delivery, IPC/backpressure, real service/SQLite/watchers, other work sizes/entities, insertion/deletion/order changes for this restricted candidate, isolated heap/GC attribution and a hard scheduling deadline. Earlier M4 retry/split/oversized-row fixtures remain evidence for that algorithm; this final normal-fixture run does not add overflow workloads. No provider calls, production/DB/journal/compression changes, service rerun, commit/push/PR.

## Impact card

- Goal: provide final native-page loop-delay evidence for the human’s performance decision.
- Behaviour: same bounded native-array/projected-object candidate with cooperative 4 ms scheduling and evolving cache; every output decoded after timing.
- Numbers: five paired trials/case, 100 measured calls/variant/case; dense CPU p50 39.155 → 50.803 ms, ELD p95 52.560 → 6.320 ms, ELD max 89.326 → 55.312 ms; task/status CPU about 9 ms.
- Screens: not measured; ELD is a host-loop proxy.
- For the human: disclosed dense CPU/completion cost buys lower typical loop blocking; acceptability remains a human decision.
- Risk: dense maximum slice 52.902 ms despite 4 ms target; retained-result memory and uncontrolled GC/scheduling can affect tails; no production-readiness claim.
- Cost: candidate eagerly retains zero row-JSON-cache bytes but retains projected objects and page outputs; isolated heap/model cost not measured.
- Verdict: requested evidence complete and sent to leads; stop benchmark work pending human performance criterion and reviewer approval.
