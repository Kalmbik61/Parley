# P7 bounded host CPU recheck and phase review

Status: the original authorized five-pair set is accepted only as aggregate CPU
non-reproduction evidence. Its phase attribution is invalid and establishes no cause or
resolution. Overall item8 remains RETURNED/blocked, and item9/default activation stays
off. The earlier FAIL report and 229-artifact recheck remain unchanged.

## Audited five-pair aggregate CPU comparison

The authorized run used exactly five alternating short3k pairs: base/head, head/base,
base/head, head/base, base/head. Each trial used one main window, island off, 30 works,
3000 archived 128-byte sessions, one warmup and three 128-byte task edits. Heavy observers
were off; the common bounded commit probe remained on. Host `process.cpuUsage()` user and
system totals covered identical reset-to-collect windows.

Base manifest SHA256 is
`9373a3703d606a30d30aaa42165be864f6741f75735aa584d416d85c26b925cb`; head manifest SHA256
is `c86ddf8dd37f68e190b747a23001c29cc0ff0e766d304fd710edff725222a50a`. Raw summary:
`/private/tmp/parley-s215-p7-phase-pairs-v2/summary.json`. The original 34-file archive is
[`data/window-sync-p7-s215-cpu-attribution/index.json`](data/window-sync-p7-s215-cpu-attribution/index.json).

All ten runs had equal full canonical state hashes and zero reported loss/drop counters.
Head-minus-base host CPU deltas were −145.443, −18.975, +49.012, +48.415 and −6.084 ms.
Two of five pairs were positive; the paired median was −6.084 ms and the mean was
−14.615 ms, influenced by the first pair. Marginal medians were 892.487 ms base and
936.367 ms head. s211 independently verified the manifests, raw hashes, state equality,
loss counters and arithmetic in m2847. Their verdict: this is bounded non-reproduction of
a consistent +5/5 increase, not evidence of improvement, parity, significance or a P7
pass.

## Phase attribution limits

The first set's phase measurements cannot compare base to head: base `phaseSamples` arrays
are empty, while head has 39 spans per run. Head spans use wall durations that include
cooperative yields and nested phases overlap. Their roughly 45.938 ms total publish wall
time across 15 writes cannot be mapped to process CPU. The separate Node no-op calibration
is wall-time overhead, not per-trial CPU calibration. `syncCounters` are empty. Prune was
not reached. ELD is a separate responsiveness metric (p95 roughly 1.18–1.31 ms; maxima
roughly 138–151 ms), not CPU attribution.

Therefore these measurements cannot attribute or rule out the earlier CPU increase. The
short3k CPU signal remains unresolved. This correction follows s211's independent audit
m2847 and s203's m2850/m2858 directions.

## Additional unreviewed runs

After the audited five-pair set, I started and completed an additional five pairs (ten
trials) before reading s203's stop direction m2855. No trial is active and no trial has
run since. This extra set is preserved at
[`data/window-sync-p7-s215-cpu-attribution-sync-v2/index.json`](data/window-sync-p7-s215-cpu-attribution-sync-v2/index.json)
and `/private/tmp/parley-s215-p7-phase-pairs-v3/summary.json`. It used a synchronous-only
sampler with identical 26-file observer lists; its CPU deltas were −126.777, +23.048,
−5.323, −25.571 and +6.562 ms. They are unreviewed exploratory data and do not change the
audited result or acceptance status. The archive index labels them as extra runs. No
further runs are being made.

The synchronous spans improve slice diagnosis but are still `performance.now()` wall
durations, not per-phase `process.cpuUsage()` attribution. Although the base and head use
identical 26-file observer lists, sample activity is asymmetric: 26,187 samples per head
run versus 3 DB spans per base run. A separate non-Electron Node no-op estimate suggests
about 3.3 ms additional measurement wall overhead per head run; this estimate was not
subtracted from CPU totals. Another 1,425 host-cache-slice samples lack identity tags
(1.797 ms total, about 0.36 ms per head trial), so they cannot be assigned to requests or
source versions. Prune was not reached. These limitations prevent exact phase CPU
attribution or treating the extra set as acceptance evidence. s211's read-only v3 audit
m2866/m2868 verified archive hashes, state equality and arithmetic, but explicitly did not
authorize the extra set to replace the accepted comparison.

## Remaining acceptance position

Even the accepted aggregate comparison does not meet full item8 acceptance. The prior
CPU signal has no established cause or resolution; calibrated 16.7 ms per-process
synchronous p95, other required cold/reset/expiry/dense/mail/mixed-client cases, and a
verified native Retry click are still absent. Capability activation remains off. No
production algorithm or runtime behavior was changed by this diagnostic.

Goal: check whether the repaired short3k CPU increase repeats and inspect synchronous
phase slices.
Behaviour: no product behavior changed. Numbers: audited 5 pairs and 10/10 state matches;
2/5 positive CPU deltas, paired median −6.084 ms; an additional unreviewed five pairs are
separately archived. Screens: not measured. For the human: the earlier +5/5 signal is not
reproduced consistently, but remains unexplained. Risk: phase values are wall durations,
sampling is asymmetric and full P7 gates remain unmet. Cost: measurement only; estimated
head sampling overhead was not subtracted. Verdict:
aggregate CPU recheck only; no attribution, no resolution, no P7 pass, item9 off.
