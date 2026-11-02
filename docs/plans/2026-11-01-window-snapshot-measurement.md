# Window snapshot investigation — measurement task

Base: origin/master at 33e3761b. Working branch: fix/scalable-window-snapshot.
This task prepares evidence for a reviewed design; no production changes are authorized yet.

## M1 — reproducible baseline (Sonnet executor)

Scope: add only a standalone benchmark under `tools/bench/` and a concise results file under
`docs/research/`. Use this worktree, not the shared project checkout. Do not commit or push.

Measure the actual `mailWorkMap`/window snapshot publication pipeline on deterministic synthetic
maps: 30 works with 1,000 and 3,000 total sessions (20 archived, 10 active); one-work 3,000-session
case; a small baseline. Include representative tasks/summaries (at least 4 KiB each) and a
short-text control. No real user content. Use actual core projections and protocol encoding.

Record regular/fallback snapshot bytes, per-work bytes, whether the 5 MiB gate passes,
single-session-change full snapshot bytes and projection/encode cost, warm cache versus cold
build, and event-loop delay with methodology, Node version, sample count, warmup and p50/p95.
Do not claim a replacement-size estimate as implemented after-performance.

Acceptance: a repeatable command and raw JSON evidence; baseline over-limit reproducer;
identify how existing test `works-service.window.test.ts` expects dropped publication. Reuse
existing fixtures when useful. A microbenchmark must clearly identify what it excludes
(SQLite/watchers/IPC/window rendering). No hardware-dependent wall-clock assertions in unit tests.

For a candidate comparison, measure cached changed-work encoding versus full snapshot encoding,
and 128 KiB page partitioning; label it a transport experiment, not production implementation.
Avoid repeatedly serializing the complete snapshot to enforce a page budget.

Not in scope: production protocol changes, host restart, deleting data, raising limits, UI edits.

## M2 — resolve the measured single-work regression (same executor)

Final corrected M1 exposes 1w/3k row candidate CPU/ELD regression (53 ms vs 33 ms).
Before any production implementation, add a supplementary pipeline-only experiment:
cache projected row objects and their encodings; structurally compare each new projected
row against its previous object BEFORE encoding (Node `isDeepStrictEqual` is an available
reference), reuse the encoding when equal, encode only changed rows. This keeps O(size
changed work) comparison without O(size changed work) JSON encoding. Include comparison,
projection, changed-row envelope encoding and bookkeeping in measured cost.

Scope: existing benchmark file and separate supplementary JSON/note under docs/research;
do not overwrite final M1 data. No more full real-service reruns. Reuse deterministic
pure fixtures or extract fixture generation without production imports changing.

Acceptance: assert the updated snapshot/delta reproduces the target exactly; exactly one
changed row for a task edit and for a lifecycle/status edit; deletion/reorder correctness
may be small fixture checks. Cache baseline is projected, not raw. Use freshly cloned maps
per change so comparison cannot get an artificial reference-identity free pass. Report
small, 30w/3k and 1w/3k, five alternating paired trials with warmups, CPU p50/p95 and active
loop-delay p50/p95/max; count projected rows and actual JSON-encoded rows. Include cached
equal-row and all-rows-changed cases to show worst-case behaviour. Explicitly identify
whether the experiment satisfies same/lower CPU and ELD; do not claim production head.

If equality still regresses, return the finding rather than widening into database schema
changes. Report M1 done and M2 outcome together to s-203, no commit/push/PR.

## M3 — bounded pages reuse encoded rows (Codex s-210)

M2 proves sparse improvement but still encodes changed rows twice: once for the row cache,
again through encodeLine over objects. This is not the design's cached-frame path and
allChanged regresses (1w/3k about 80 vs 38 ms). Complete this bounded transport experiment
before production work. Preserve M1 and M2 evidence; use a new M3 script/mode/output.

Reuse cached row JSON verbatim when building actual <=128 KiB frames. Encode only small
envelopes/keys separately. Count exact UTF-8 frame bytes including newline, row separators,
sequence/cursor metadata; pack all changed rows without dropping. No stringify over the
full map or over an array containing already-encoded changed row objects. Each changed
row is JSON-encoded exactly once; equal rows zero times. Include all comparison, encoding,
page packing, byte accounting, next-cache bookkeeping and resulting frames in timing.

Decode every produced frame and apply its rows/order/removals; assert exact target equality
and maximum frame bound in all cases. Run same three fixture sizes, none/task/status/all
changes, five alternating paired trials. Report CPU, active ELD, largest frame, total
frame bytes, encoding counts and retained-cache bytes. Allchanged must really produce
multiple bounded pages, not an oversized single-frame placeholder. Retain cold setup
outside timing equally for baseline/candidate, with freshly cloned inputs as in M2.

Add cooperative yielding at the documented 4 ms target if needed, and measure total CPU
separately from elapsed completion and active ELD; do not count a wait as reduced CPU.
Report small-case timer-floor noise honestly. Do not rerun real service or change production.
Remove/reject the abandoned broken --row-reuse option in original benchmark, keeping M1
default behaviour and raw evidence unchanged. No commit/push/PR; report to s-203.

## M4 — diagnose dense-update cost before another design change

Codex executor, benchmark-only. M3 removes double row encoding but dense 1w/3k still
costs about 75 vs 40 ms. Do NOT run another full matrix first. Add a separate diagnostic
entry point or mode for this one case. Attribute total time/CPU to projection, structural
comparison, row stringify/byte counts, cache bookkeeping, packing/concatenation and
final frame byte validation. Instrumentation overhead must be named; 5–10 samples are
enough to locate the dominant stage, not to claim final performance.

Then test only the dominant hypothesis. One candidate, if encoding/packing dominates,
is batching changed objects into small bounded array pages encoded once by native
JSON.stringify, retaining projected objects and lazily materializing per-row encodings
when later sparse updates need them. Compare its **dense update plus a subsequent sparse
update** so deferred work is not hidden. Maintain actual <=128 KiB frames and exact
decoded target semantics; use bounded batch sizes and explicit retry/split for an oversized
batch, and account all retries. Do not trade away sparse speed or byte bounds silently.

Report diagnostic evidence and a recommended architecture decision to s-203/s-211.
No full-service run, no production edits, no database/journal redesign, no compression,
no further iterative variants without lead review. Keep M1–M3 immutable.

## M4 final evidence — native-page event-loop delay

Codex s-210, requested by workspace lead s-38/m-2304. No new transport variant.
Measure the same native bounded-array/projected-object candidate with cooperative 4 ms
scheduling against the existing path: 1w/3k dense allChanged and one task/status edit.
Five alternating paired trials with actual evolving cache where relevant; report process
CPU, completion, active ELD p50/p95/max, longest synchronous slice, frame bytes and row
counts. Keep initial cloning/cache setup outside timing equally; exact decoded target
after each operation and all frames bounded. Preserve all previous artifacts. No
service rerun or production edits. This supplies user-visible-delay evidence for the
human's decision on the disclosed dense CPU tradeoff, not an automatic CPU waiver.

Report numbers to s-203 and s-38. After that stop benchmark work; further implementation
requires the human's performance criterion and reviewer approval.

## One approved budget diagnostic — 128 vs 512 KiB

Codex critic s-211/m-2315 approves one parameter check on the SAME native-array-page
candidate. 128 KiB was a proposed constant, not a human requirement. Keep existing 128
evidence and reviewed production contract unchanged. Compare 128 and 512 KiB in paired
alternating order with identical 1w/3k dense and sparse inputs. Adjust bounded row batch
size accordingly so this actually tests native batch-size overhead; every final frame
still uses actual byte checking and counted overflow retries. Eight paired diagnostic
samples are sufficient; this is not another full matrix or a final implementation gate.

Report CPU/completion, active ELD, max synchronous slice, max/total frame bytes, count
and retry work; exact target equivalence each time. A larger cap must not pad sparse
frames. If delay worsens, keep 128. If both improve, propose revised constant for review,
without claiming consumer decode/IPC/cold-bootstrap latency from page count. No other
budget variants, data trimming, storage changes or production edits. Send results to
s-203/s-38/s-211 and stop benchmark work for the human criterion decision.
