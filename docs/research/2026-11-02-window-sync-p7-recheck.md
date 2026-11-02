# P7 repaired-candidate recheck

Status: FAIL / acceptance blocked (independent CPU assessment m2823). Rerun of accepted pl-03rev7 item8 after items10/11 independently
VERIFIED. Prior FAIL package `2026-11-02-window-sync-p7.md` and its221gzip artifacts,
old builds and frozen observer snapshots are preserved unchanged. No production fixes,
cap changes,installs,live host operations,commits,push or activation belong here.

## Declaration before measurement

Apple M4 Pro12logical CPUs,24GiB RAM,arm64,Darwin27.2.0. Host/driver Node25.8.0;
copied Electron44.4.5,Electron Node24.21.0,Chromium152.0.7977.130. Actual displays
120.0006Hz/100Hz; declared reference remains60Hz/16.7ms synchronous p95 per process,
with maxima and named/enclosing-task coverage required. Candidate cap512KiB unchanged.

All23 reviewed item10/11 source hashes match the frozen s214 handoffs. Core/protocol/
host rebuilt; separate head-repaired-v1 and base-repaired-observers-v1 Electron builds.
The sole fixture behaviour patch remains copied host `sync:{enabled:true}`; main opts
in with the existing test switch. Default OFF. Schema3 head and unchanged schema2
historical base each seed/read through their own build core,identical logical data.
No new core migrates the baseline DB. Runtime/dependencies unchanged; manifests and
external observer snapshot are frozen before measurements.

First recheck: exact1work/3000sessions/4096-byte task+summary,300submissions at100ms
cadence for30s,one real main,island off. Heavy observers OFF,common bounded actual
commit timestamp probe ON. Retain request ID,driver dispatch/reply,host request start,
synchronous transaction return,Promise completion and actual onMapWritten source
version/incarnation/commit-notification timestamp. Listener covers only the synchronous
updateMap call,not the later await; no later global workVersion is attributed to a
request. Report request-start and actual-commit→first-covering renderer commit separately,
continuous intermediate progress,loss,CPU/native ELD,queued/read bytes and final state.
All successful expected/renderer canonical preimages are retained outside timing.

Second recheck: bounded small-only B/H/H/B diagnostic,5warmup writes,20sequential128B
writes,heavy and commit probes OFF,separate equal1s idle windows. Gross per-process CPU
and idle controls reported separately without subtraction. Five alternating completing
pairs per supported shape remain required for acceptance; a material unresolved failure
blocks PASS and calls for a separately scoped repair,not an open-ended matrix loop.

Third recheck: actual main+island notch-mode failed recovery with retained data,visible
Retry contained in the measured/reported shape,and CUA native OS mouse input. Use the
Parley browser first for UI; prior browser preview was explicitly disconnected and
never actual IPC/native evidence. No CDP/locator click substitutes for OS hit eligibility.
Own socket fault is restored; no host restart or write replay is used.

Detailed phase/task/IPC traces,near-cap/huge final fragments,cold/reset/dense/mail/
expiry/mixed cases remain separate required gates,with heavy-observer perturbation and
sample loss explicitly qualified. A successful first recheck cannot waive small CPU,
16.7ms,security/recovery or missing evidence.

## Repaired sustained result (single recheck,not overall P7 PASS)

Head manifest SHA256 `5ecf08cebcb42154d1cf86614ace6da5101c5950dde3fc30f1deb0c40deac660`;
separate base manifest `5d6640906eba909f442ede5178308008a64b9703fc45ba907ba9378e49fe0e6e`.
Exact external sources: `/private/tmp/parley-s215-p7-repaired-observers-v1`.

The declared sustained run produced55renderer commits,53during submissions. First
commit0.960s after first host request; last30.963s. All300requests captured exactly one
own commit event and300distinct source versions. All loss counters0. Final canonical
state matches and both successful preimages are retained in the owned home.

| Start point→first covering renderer commit | p50,s | p95,s | max,s |
|---|---:|---:|---:|
| Host request start (previous criterion) |1.040|1.358|1.717|
| Driver dispatch |1.054|1.404|1.778|
| Post-commit notification |1.021|1.334|1.688|

Host CPU37.226s; native ELD p95/max17.547/238.551ms. Host queued/read bytes516842/3139.
No16.7ms slice conclusion follows from native ELD. This run meets the previous continuous
progress/<=2s lag criterion,pending independent raw audit. It does not establish small
CPU parity,phase coverage,native recovery or full P7 acceptance.

Raw `/private/tmp/parley-s215-p7-repaired-sustained-v1.json`; owned home
`/private/tmp/parley-s215-p7-run-Ijier1`; summary `…-summary.json`.

## Small CPU diagnostic and native recovery

Repaired B/H/H/B,heavy+commit probes OFF,5warmups then20writes,4/4full-state matches.
Gross host CPU266.577/245.552/246.878/256.670ms; adjacent head−base deltas−21.025/
−9.792ms. Main235.586/227.978/196.927/215.878ms; renderer236.164/219.114/236.392/
249.029ms. Idle controls remain separate in raw files. Frozen observer hashes unchanged.
The previous positive small-host signal reverses in these four runs; this is inconclusive,
not CPU parity. Required five alternating supported pairs are measured separately.

Actual repaired main and island both retain2entries and show enabled Retry on failure.
Island Retry rect roughly441,40,34,20 is contained in the reported island hit region
roughly−6.5,0,493,101 and within its480×520native window. After own socket restoration,
both stores become current and the island restores its healthy185×32bare notch.
No host restart or CDP/locator click was used. Actual OS click remains UNVERIFIED:
CUA exact owned Electron binding/AX/screenshot succeeds,but two coordinate-input calls
fail with server−10005 `noWindowsAvailable`,including after a fresh binding. No trusted
Retry click was recorded; restoration/recovery cannot be attributed to a click. This
is an automation/input coverage blocker,not proof of product click failure or success.
Raw native stage snapshots and screenshots remain in the owned homeDI6gxh.

The bounded second native input attempt explicitly tried AX Raise of the owned window.
That operation also failed in CUA with ScreenCaptureKit SCStreamErrorDomain−3811
(audio/video capture stream failure). It did not establish a successful native click.
The second fixture preserves persistent failed recovery/Retry geometry and is closed
with its own socket restored during cleanup. No alternate OS-input mechanism bypasses
this automation limitation.

## Repaired supported pairs

Five alternating pairs per shape complete;20/20full-state matches,successful preimages
retained. Same runtime/client mix/three writes/one warmup/heavy-off/probe-on declaration.
Small host deltas are mixed:−3.757,+5.136,−2.474,+0.406,+8.114ms/3writes. Small signal
remains inconclusive. Short3k host deltas are positive5/5:+46.368,+25.312,+44.148,
+50.053,+66.117ms/3writes. Host marginal medians893.908→943.961ms (~5.6%); main
185.064→44.024ms; renderer146.966→49.642ms. Commit-lag p95478.538→450.168ms.
This host cost is an unresolved regression signal under independent assessment; other
process improvements do not waive it. Broad remaining trials are held while this
focused signal and the native input coverage blocker are assessed.


## Review position and evidence integrity

Lead m2816 independently accepts the sustained continuous-progress/<=2s criterion for
this single repaired run. onMapWritten is a post-transaction notification,not an exact
SQLite COMMIT timestamp. Driver clock resolution is milliseconds; cross-process clock
offsets were not separately calibrated. Covering source-version visibility does not
mean every intermediate edit was individually rendered. Maximum intercommit gap in the
independent audit is0.885s. Host ELDmax238.551ms still needs phase attribution.

Lead m2821 confirms no verified human native-click checkpoint is available for this
automated acceptance. Native clicking is handed off INCONCLUSIVE with both exact CUA
errors and empty click logs; no human action is presumed and the broken setup is not
retried further. This criterion alone blocks overall PASS. Independent assessment m2823 confirms an unresolved material host-CPU regression
signal in all five short3k pairs; bounded attribution/repair is required before PASS.
No CPU/noise waiver is claimed.

The separate recheck archive is `data/window-sync-p7-s215-recheck/`:229gzip files,
3678384compressed bytes,102074644original bytes. Every saved artifact was decompressed
and checked against original SHA256/size. The index preserves original absolute paths,
raw/gzip hashes and sizes. Included: both manifests/provenance/diffs,exact frozen external
sources,all supported/diagnostic/sustained raw data and successful correctness preimages,
native states/geometry/screens,explicit input-error record and reviewed-source checks.
The original221-artifact FAIL archive and report remain unchanged.

Not verified in this acceptance attempt: native OS Retry click/physical hit eligibility,
full calibrated per-process phase/task/IPC16.7ms gate,complete cold/reset/expired-cursor/
new-epoch/dense/mail/mixed-client matrix,migration/epoch-retirement cost and all pin/
memory lifetime assessments. Raw memory/native socket totals are retained; no native
IPC-byte or bounded-memory acceptance claim is made. Prior cases remain historical,
not substituted for repaired-candidate acceptance. No broad trials are run to evade
focused blockers. No production file was changed in this lane; all23 reviewed source
hashes still match.

Goal: recheck reviewed repairs against actual-window acceptance. Behaviour: sustained
progress repaired in this run; Retry DOM/shape restored; native input unavailable.
Numbers:300distinct versions,55commits,host-start p951.358s;20paired full-state matches;
short3k host CPU positive5/5;229integrity-checked recheck artifacts.
Screens: retained actual failed/current main+island images and geometry; no clicked Retry.
For the human: exact successful criterion plus remaining coverage/cost blockers.
Risk: native input,host CPU and untouched required acceptance gates block PASS.
Cost: measurement only; engineering time not measured. Heavy observers not used for
CPU conclusions. Verdict: FAIL / blocked on the independently assessed host CPU signal. Native input
remains INCONCLUSIVE; no activation or production repair.

CUA main failed-window AX text is retained separately,with its scope labelled; it is
not an island AX tree or native click proof. All owned fixture processes are closed.


## Independent CPU assessment — m2823

s211 independently recomputed all10 short3k raw CPU totals/pair assignments and every
expected/actual canonical snapshot hash. All five host deltas agree:+46.368,+25.312,
+44.148,+50.053,+66.117ms per3edits. Marginal medians893.908→943.961ms,+50.053ms/
~5.60%. Treat this as an unresolved material host-local regression signal requiring
separately scoped bounded attribution/repair before P7 PASS. Main/renderer and lag
improvements do not waive it. No formal significance proof,mechanism or root cause is
established; both modes used the bounded common commit probe. No broad matrix expansion
or production change is authorized by this evidence. The affected paired workload is
the target for a later approved diagnostic/repair recheck. Previous inconclusive report
and index are preserved losslessly as submission-v1-report/index artifacts.
