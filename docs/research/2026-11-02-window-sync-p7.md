# P7 actual-window evidence — FAIL

P7/item8 fails continuous progress and the proposed2s p95 lag criterion. Default
activation/item9 remains blocked. Lead m2712 and independent verifier m2714 confirm the
failure. No production repair,cap change or activation was made in this evidence lane.

## Decisive sustained result

The isolated real host/Electron/main/preload/renderer path used one work with3000
sessions,4096-byte task and summary fields,and300 driver submissions at100ms cadence.
Detailed observers were OFF; the common bounded actual commit timestamp probe was ON.
There was exactly **one renderer commit**,31.636s after the first host request started.
Request-start→first covering committed watermark lag p50/p95/max was
**16.413/30.194/31.636s**. Final canonical state matches; all loss counters are zero.
Canonical equality is driver-generated: successful digest preimages were not retained as
separate renderer snapshots; the independent audit reviewed canonicalization and raw
reported digests. The one-commit failure is directly recomputable from raw timestamps.
Host CPU was39.532s; native ELD p95/max282.853/325.845ms.

Cadence means driver submission cadence,not uniform execution. The actual host starts
are bursty;300 acknowledgements report150 distinct post-await source watermarks because
concurrent updates can return the same later version. These are covering-watermark lags,
not300 individually identified transaction commits. A single commit after the30.414s
request-start span still decisively fails continuous progress. No fixture gate delayed
consumer application: the renderer subscribed continuously; the driver waited for the
last covering version only after submitting all writes.

Raw: `data/window-sync-p7-s215/sustained-minimal-v1/raw.json.gz`.
The earlier heavy-observer run also stalled but overflowed its buffers; it is preserved
and excluded from acceptance claims. Root cause and production repair belong to a
separate bounded assignment; trailing debounce/version revalidation are hypotheses.

## Declared machine,build and workloads

- Apple M4 Pro,12logical CPUs,24GiB RAM,arm64,Darwin27.2.0.
- Reference60Hz:16.7ms synchronous p95 per process,with max reported. Actual display
  frequencies120.0006Hz/100Hz were observed and unchanged.
- Host/driver Node25.8.0; copied Electron44.4.5; actual Electron Node24.21.0,
  Chromium152.0.7977.130. Runtime copied read-only from the original checkout.
- Candidate512KiB,unchanged. No automatic128KiB fallback.
- Head production-mode electron-vite build from the shared worktree. The sole compiled
  host behaviour patch supplies reviewed `sync:{enabled:true}` in the copied fixture;
  main opts in using `PARLEY_WORKS_SYNC=1`. Production sources/default stay unchanged.
- Base is actual33e3761b archived into its own source tree,with unchanged5MiB limit.
  Same runtime,instrumentation,debounce and one modern main; island/mixed cases separate.
- All homes/project data are synthetic isolated temporary directories; all sessions
  closed/done. No provider processes,live workspace calls,installs,commits or pushes.

| Shape | Works | Total sessions | Task/summary bytes each | Use |
|---|---:|---:|---:|---|
| small |2|20|128|Completing supported pairs|
| short3k |30|3000|128|Completing supported pairs;20 archived|
| cold30 |30|3000|4096|Cold oversized;20 archived|
| cold1 |1|3000|4096|Sustained case|
| nearcap |1|64|15000|Actual near-cap frames|
| huge |1|20|128 plus large metadata/artifacts|Huge projected row/final fragments|

The first huge-v1 long goal was truncated by existing32KiB projection,so it did NOT
exercise fragmentation. It is preserved as failed coverage. Corrected huge-v2 uses80
synthetic valid artifact paths plus retained root metadata containing Unicode/escaping.
It produced14fragments,96encoding retries and maximum observed write524132bytes,below
524288. Full state matches. Nearcap max489447bytes and cold30 max280780bytes; both
complete-state comparisons match. These are individual heavy-observed cases,not full
five-sample phase acceptance or a completing oversized baseline.

## Supported paired results

Five alternating pairs per shape:B/H,H/B,B/H,H/B,B/H. One warmup then three sequential
128-byte task edits per trial. Heavy observers OFF,common commit timestamps ON. Fresh
process/home each trial. All20 complete canonical comparisons of entries/order/versions/
maps/branches match. Native socket counters are queued/read totals,not per-method or
IPC bytes. Timing includes the real app; correctness comparison runs after measurement.

| Metric | small base→head | short3k base→head |
|---|---:|---:|
| Host CPU marginal median,ms/3writes |36.056→46.582|904.889→913.691|
| Main CPU marginal median,ms/3writes |38.315→38.486|145.954→39.945|
| Renderer CPU marginal median,ms/3writes |34.507→40.002|144.018→47.292|
| Covering commit lag p95,ms/15writes |184.600→190.387|475.689→432.843|
| Host queued bytes median/3writes |44824→4396|6247821→4374|

Marginal medians are descriptive,not paired attribution. Small host cost is higher5/5:
+17.258,+1.152,+12.418,+11.132,+10.526ms/3writes. Median paired delta+11.132ms;
median paired relative+29.19%. Small main is higher4/5 and renderer5/5. This remains an
unresolved regression signal. Short3k host is mixed3lower/2higher; median paired delta
−13.867ms,illustrating why marginal medians alone do not prove regression or parity.
The authorized B/H/H/B small diagnostic with5warmups,20writes,both probes OFF and
separate equal1s idle windows also matches4/4 full states. Its frozen source hashes
remain unchanged across the four runs. Gross host CPU in B/H/H/B order is
230.843/300.811/242.674/192.950ms for20writes:11.542/15.041/12.134/9.648ms/write.
Both adjacent head−base deltas persist:+69.968/+49.724ms per20writes. Main gross CPU
196.106/211.646/179.389/183.776ms; renderer217.940/260.166/211.916/183.661ms.
Idle-before host CPU17.637/16.402/13.734/17.524ms; idle-after16.151/17.004/11.630/
11.287ms. All idle raw process costs are retained separately; none is subtracted.
The signal persists without either probe; production-path attribution remains required.

## Observer validity and provenance

Twenty residual-control trials v3 all match complete state,with no recorded loss.
Heavy short3k host CPU1311.695ms(base)/1270.681ms(head) versus minimal around896–958ms
shows material observer overhead. Heavy timings cannot establish CPU parity. Residual
probe controls are noisy; no negligible-overhead claim is made.

Async-hooks task estimates can span idle time across Electron native-event boundaries:
a main estimate91ms had actual Chrome RunTask max1.019ms. Main gates exclude that
estimate. Chrome CrBrowserMain/CrRendererMain RunTask is correlated with named spans,
reporting enclosing-task p95/max and unmapped counts,without dilution by unrelated tiny
callbacks. Phase mapping uses a declared200μs timestamp tolerance. Cold/huge traces lack
the complete repeated phase coverage needed for a16.7ms PASS. Large host maxima and
observer perturbation remain unresolved. Raw task estimates are retained,not renamed CPU.

Legacy single-window IPC send/receipt uses ordinal alignment only when counts match,
because its observer delivery counters reset asymmetrically. Sync uses stream/delivery
identity. IPC queue/ACK wall times remain separate from synchronous spans. No total
native IPC-byte claim is made.

Frozen paired manifest file SHA256:

- head-v9: `8055a163416a4ef32d14c4849af0ec6cff61dd5d2e59033491515c158d4dae80`;
- base-v6: `c427e7da5df7d1ddd5792299211906e7d6587e67c8a0b5afce68b717ad2acdba`.

The manifests hash actual copied outputs,source including untracked files,dirty diff,
lockfile,resolved runtime dependencies/optional-package availability,observers and runtime.
Exact19/19 external observer sources used by paired-v1 are retained in
`paired-v1-observers/` in the evidence archive and `/private/tmp/parley-s215-p7-paired-v1-observers`;
their hashes match the frozen manifest. Later seed changes corrected huge coverage;
later fixture changes only added owned socket fault/cleanup commands. They were after
all paired trials. Corrected-huge observer source is separately retained. The later small-diagnostic
observer snapshot preserves the same sustained-minimal runtime edit/timestamp/probe and
cold1 seed paths; s211 independently reviewed the before/after diff in m2719. A copy is
also retained at `/private/tmp/parley-s215-p7-sustained-minimal-v1-observers`.

## Recovery and mail scope

Own fixture socket was renamed and its clients closed without restarting the host.
Both actual main and island stores retained2entries and reached retryable connection
error. Main DOM/native accessibility shows Retry. Island native window remained visible,
but its screenshot looked empty and no Retry button was present. A lead-requested
bounded supplementary reproduction establishes a notch-mode UI failure: islandEnabled
is true,works-sync negotiated,current→retryable connection error,2entries retained,
document visible,root opacity1; DOM before/after contains only a185×32 bare notch.
There is no Retry button to click. IslandView's dropped predicate omits sync failure,
and its bare-notch branch bypasses the subtree containing syncNotice even after
IslandApp unretracts. This is a concrete absent-control finding,not merely occlusion.
No captured console/render errors; listeners attach after launch and may miss bootstrap.
No hit-rect/mouse-ignore changes were captured; registered native hit geometry remains
unverified. Supplement raw/DOM/config/bounds/screenshots are in recovery-diagnosis-v1/. CUA selected only the owned copied Electron app; no native click was attempted
without a visible target. The supplementary absent-control finding still does not establish a native hit-region PASS. Screenshots and raw states are retained.

Mail-only10letters produced10rooms.mail events,zero structural encode attempts and no
projection/cache phase samples. The full comparator differs in entry source-version
watermark (a separate structural/mail domain) and direct-letter mention candidates:
fresh snapshot has10,event-maintained state0. Existing withMail candidate filtering
excludes direct letters. This is recorded as a comparator/behaviour discrepancy,not
silently labelled full-state PASS or attributed as a new sync regression.

## Validation,artifacts and not verified

Observer tests3/3 and focused harness/E2E lint pass. Actual Electron smoke1/1 passes
on the current frozen head build,with main2works/20sessions/current and both windows.
Verified P3 host source/test and all four protocol source/test SHA256 values remain
unchanged from the accepted evidence. M1–M4 artifacts are preserved.

Raw JSON,traces,declarations,logs,screenshots,manifests and observer snapshots are gzip
copies in `data/window-sync-p7-s215/` (221indexed files,21821505compressed bytes); `index.json` records original paths,raw/gzip sizes
and SHA256. Originals remain under `/private/tmp/parley-s215-p7-*`. No failed/truncated
trial was overwritten or promoted to PASS.

Not verified: full repeated all-process16.7ms phase acceptance,uninterrupted host
attribution,all native IPC bytes,old oversized no-completion trial in this fixture,
dense→nochange→edit evolution,new epoch/expired cursor,mixed legacy client,native island
Retry click and possibly-completed-write recovery. These remain unmet; the sustained
failure prevents acceptance independently. No broad matrix rerun follows this failure.

Goal: evaluate actual-window candidate acceptance. Behaviour: real isolated full path,
with default still off. Numbers: measured values above; missing metrics not measured.
Screens: retained main/island recovery images; native island Retry not verified.
For the human: reviewable failing criterion and exact raw evidence. Risk: sustained
updates stall and notch-mode Retry is absent; small CPU attribution and required coverage remain unresolved.
Cost: measurement-only observer overhead disclosed; total engineering time not measured.
Verdict: **FAIL**,independent review required for evidence submission; activation blocked.
