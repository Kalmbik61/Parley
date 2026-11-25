# T4 — ordinary native Kimi Terminal

Accepted for the combined T1/T2/probe candidate d8cbe978. Chat is read-only while Terminal owns the conversation. The island opens native prompts in Terminal. Returning ownership restores managed Chat. Native Kimi is ordinary installed Kimi. Parley room and plan tools are unavailable in Terminal, and Parley supplies no managed attachment, plugin, or rule injection. Managed tools and rules return with ACP. The [stock probe](2026-11-25-kimi-native-handoff-probe.md) proved exact-ID round-trip, actual process exits, native keys and resize. The experimental managed-plugin authority is not part of T4.

## Ownership and lifecycle

- Bootstrap new conversations in ACP, preserving T2 launch choice and one initial brief. Viewing a tab or reloading never claims ownership.
- Explicit takeover holds the existing session lifecycle lock and resource accounting. Require known idle ACP, with no turn, approval, elicitation, delivery, scheduled wake, or unsent Chat/Terminal draft. Preserve content on refusal. Reject another ref bound to the same provider ID and Kimi home.
- Block Chat sends, config, choices and wake/delivery during transitions and native ownership. Preserve queued mail without sending it to the PTY. Raw terminal keys and resize use existing PTY transport. Fence callbacks and requests by process generation.
- Await outgoing process exit before starting a successor. Start installed Kimi with only the exact original `--session` ID, original cwd/home and sanitized ordinary environment. Honor provider locks and durable mode, with no resume override, ID discovery, config copy, global plugin or Parley grant.
- Require human `/exit` before returning from a running native process. Reopen managed ACP with the originally bound ID, even after native `/new` or another ID in the same terminal. Explain this at the controls. A crash before the handback commits leaves Terminal ownership recoverable and excludes ACP wake. A committed handback instead leaves a durable Chat checkpoint.
- Reconcile a bounded provider replay at handback or handback recovery against a stable snapshot boundary. Do not blindly append a replay or remove the original persisted feed. Divergence must produce a deterministic refreshed snapshot or a recoverable state.

## Acceptance

Write failing regressions before implementation. Verify ANSI, raw keys and resize, exact ID/cwd, resume mode, no dual owner or stale callbacks, busy/draft/permission/wake refusal, no leaked native authority, held mail, no duplicate brief/history across retries, exit/crash and old host behavior, and no rebinding after `/new`. Verify desktop read-only Chat, island Open Terminal, and restoration through the actual components. Run targeted checks and an opt-in installed-CLI loopback fixture with disposable homes, no paid or real account use. Supply a reproducible fixture and Parley browser screenshots, commit locally, and report the checked impact. Do not touch the live app or user configuration.

## Reproduce

After installing workspace dependencies, run the focused checks from the repository root.

```sh
pnpm run typecheck
pnpm --filter @parley/desktop build
pnpm --filter @parley/host exec vitest run \
  src/kimi/kimi-host.test.ts src/kimi/acp.test.ts src/kimi/sessions.test.ts \
  src/pty/pty-manager.test.ts src/wake/host-draft.test.ts
pnpm --filter @parley/desktop exec vitest run \
  src/renderer/chat/ChatView.test.tsx src/renderer/terminal/TerminalSurface.test.tsx \
  src/renderer/terminal/use-terminal.test.ts src/renderer/island/model.test.ts \
  src/renderer/island/IslandView.test.tsx src/renderer/island/requests.test.ts
pnpm --filter @parley/protocol exec vitest run src/methods.test.ts
pnpm --filter @parley/core exec vitest run \
  src/work/map.test.ts src/work/agent-switch.test.ts src/work/launch.test.ts
```

On macOS, the installed-CLI probe needs PTY and loopback permissions. It pins stock 2.7.3, uses fresh homes and a synthetic OpenAI response server, and blocks access to real home data and non-fixture network destinations. The older plugin cases remain separately opt-in and are not run by this command.

```sh
PARLEY_KIMI_NATIVE_BIN=/Users/kalmbik61/.kimi-code/bin/kimi \
  pnpm --filter @parley/host exec vitest run src/kimi/native-handoff.probe.test.ts \
  -t 'without any plugin installation'
```

The stock run resumed an unseeded ACP ID in native Kimi. A second session retained **Ask When Needed** without resume flags, as verified by Kimi's native `/status`. At ACP load, Kimi still reported `default` in its initial config snapshot, as described in T2. In the stand-alone probe, an inert ephemeral MCP server launched in ACP, did not launch in native mode, and launched on ACP handback. The original ACP and native turns replayed once each. No turn from native `/new` entered the original replay. The test sent three model requests, all to loopback. See [Kimi's native command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/slash-commands.html) for the status and session commands.

The [desktop fixture](../../packages/desktop/e2e/fixtures/kimi-native-terminal.html) uses production Chat, Terminal and Island components, xterm and the layout store with an inert bridge. From `packages/desktop`, start its isolated server.

```sh
pnpm exec node --input-type=module -e '
  import { createServer } from "vite";
  import react from "@vitejs/plugin-react";
  import tailwindcss from "@tailwindcss/vite";
  const server = await createServer({
    configFile: false,
    plugins: [react(), tailwindcss()],
    server: { host: "127.0.0.1", port: 4658, strictPort: true },
  });
  await server.listen();
  server.printUrls();
'
```

Open `http://127.0.0.1:4658/e2e/fixtures/kimi-native-terminal.html`. The Terminal tab has an explicit takeover button. While native owns the fixture, the island row opens Terminal and Chat shows its retained transcript and no composer. The fixture responds to native `/help` and `/exit` input. Return to Chat restores the composer and settings. After exit or failed handback, Reopen Terminal resumes the original native owner without releasing Chat. Presets for screenshots are `?view=terminal` before takeover, `?owner=terminal` for read-only Chat, `?owner=terminal&view=terminal` for the native PTY, and `?owner=exited&view=terminal` after exit.

## Impact card

- **Goal** — Make ordinary Kimi Terminal available without letting it share the conversation with managed Chat.
- **Behaviour** — Takeover and return are explicit. Native gets the original ID and cwd with no Parley-managed authority. A live native process must exit before handback. Parley mail waits. Recovery retains the original binding, and handback refreshes Chat from a complete, bounded ACP replay.
- **Numbers** — 1,161 focused checks passed (89 host, 455 desktop, 101 protocol, 516 core). The installed 2.7.3 probe passed with 3 loopback model requests, 0 external or paid requests, and no plugin installation.
- **Screens** — Parley browser, 1120 × 530. [Takeover](../../packages/desktop/e2e/fixtures/kimi-native-takeover.png), [read-only Chat and island](../../packages/desktop/e2e/fixtures/kimi-native-read-only.png), [native Terminal](../../packages/desktop/e2e/fixtures/kimi-native-terminal.png), [return control](../../packages/desktop/e2e/fixtures/kimi-native-return.png), [restored Chat](../../packages/desktop/e2e/fixtures/kimi-native-restored.png).
- **For the human** — Open Terminal and select **Take control in Terminal**. Use Kimi normally, then type `/exit` and select **Return to Chat**. A native `/new` does not rebind Parley.
- **Risk** — Kimi 2.7.3 can still expose descriptions of earlier managed tools to the model even though Terminal cannot call them. Handback requires ACP `session/load`. Failure or replay beyond the explicit limits leaves Chat unchanged and a recoverable stopped state. The work's `kimi-history/<session-id>/` keeps the latest committed Chat checkpoint and its original evidence, plus any active Terminal archive. Superseded files are pruned after a durable selection.
- **Cost** — Zero paid calls. Production latency and archive growth were not measured.
- **Verdict** — The fixture and stock CLI establish exact-ID ownership transfer, provider-owned mode, unavailable managed tools in native Terminal, and restored Chat. The live app and user configuration were not changed.

**Not verified** — Real accounts, non-macOS stock CLI, production throughput, or live app migration. Parley browser captured the production-component fixture presets. Automated desktop tests covered button interactions independently.

## R1 — replay integrity after source review

Source review m-10274 and m-10275 reaffirm the accepted native handoff and split changes into R1 replay integrity, R2 lifecycle recovery, and R3 ownership fencing. This turn owns R1 only in `packages/host/src/kimi/{sessions,acp}.ts`, `packages/host/src/feed/feed-service.ts`, and focused regression fixtures/tests. Runtime authority discrimination remains with the integrated verifier.

- A historical replay exceeding a Cold Chat display bound can limit that replay, but must never discard a subsequent live assistant reply.
- A handback replay must preserve distinct historical prompts even when an old turn has no assistant text. Use explicit provider boundaries when supported or reconcile against the known Chat history. If a replay does not uniquely identify the turns, report a recoverable failure and preserve the prior projection.
- Match unchanged provider turns against Chat before applying the replay. Preserve exact row IDs, timestamps, durations, resolved request cards, and order for matched rows. Reconcile native additions or divergence without blindly appending the whole replay.
- Reproduce the three findings before changing implementation. Verify targeted host and fixture checks, then commit and hand in R1 separately before touching R2 or R3.

R1 preserves the archive-matched prefix without emitting fresh rows for it. An ACP message ID confirms a user-message boundary when one is available. With legacy chunks, a run of consecutive prompts must match the archived sequence, including any turns with no assistant text. If it cannot, handback leaves the prior Chat alone. New replayed durations are unknown because ACP does not carry them. [ACP v1 session loading](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/session-setup.mdx)

R1 verification reproduced five failing cases before the fix. The final focused run passed 56 tests and the host build. The fixture held the original row IDs, timestamps, cancellation marker and resolved permission card across a no-op handoff and a native append followed by isolated host restart. It also verified that the first later live prompt receives fresh row IDs. This does not close R2, R3, or the separately investigated native authority finding.

```sh
pnpm --filter @parley/host build
pnpm --filter @parley/host exec vitest run \
  src/kimi/acp.test.ts src/kimi/sessions.test.ts src/kimi/kimi-host.test.ts
```

## R2 — lifecycle recovery and bounded archives

Rework m-10277 and m-10285 covers review findings #2, #3 and #8 only. R1 stays in place. R3 ownership fencing and the integrated runtime-authority investigation are separate. Scope is the Kimi ACP capability and lifecycle, sessions service, Kimi feed archives, core session-file cleanup, the existing Terminal control, and focused fixtures/tests.

- Refuse takeover before stopping the original ACP if it did not advertise history loading. Preserve the running Chat and draft. When native has exited or a handback failed, let the human explicitly reopen ordinary Kimi with the originally bound ID, cwd and Kimi home. Never kill a live native process to do this, silently reacquire ACP, rebind to another ID, or repeat the brief.
- Keep the persisted exclusion marker until managed ACP has successfully installed the replacement Chat projection. A failure before activation or release leaves a retryable marker and does not let wake take ownership.
- Keep the active handoff archive or most recent completed handoff archive for each session. A failed publication removes only its unpublished candidate. Prune superseded archives only after a new marker is durable. Explicit session deletion removes its own archives.
- Reproduce the lifecycle and archive failures first. Verify the exact-ID reopen, capability refusal, activation order, archive rollback and deletion, and the desktop reopen action. Commit R2 separately before R3. No live app actions or changes to user auth/config.


R2 verification reproduced the four host lifecycle failures and the core deletion and desktop reopen failures before implementation. The final focused suites passed 112 checks (60 host, five core session cleanup, 47 desktop TerminalSurface). Core and host builds and desktop typecheck passed. The reopen test verifies the exact ID, cwd and persisted Kimi home after restart even when the host's synthetic Kimi home changes. The marker test covers both a thrown feed installation and a rejected release write. A successful takeover prunes prior copies. Known unpublished candidates are removed on a failed write, and session deletion removes the session archive directory without touching a sibling.

```sh
pnpm run typecheck
pnpm --filter @parley/host exec vitest run \
  src/kimi/acp.test.ts src/kimi/sessions.test.ts src/kimi/kimi-host.test.ts
pnpm --filter @parley/core exec vitest run src/work/store.test.ts -t deleteSessionFiles
pnpm --filter @parley/desktop exec vitest run src/renderer/terminal/TerminalSurface.test.tsx
```

The earlier browser captures predate the Reopen Terminal button. The R2 browser panel was not loaded, so the new button was verified by component interaction tests. Stock CLI and native authority verification were not rerun or included in R2.

## R1 follow-up — match the archived reply display

Review m-10287 and lead correction m-10290 leave only R1 finding #5 open. In the pinned reducer, a reply exactly at the display bound retains its archive metadata, but an unchanged reply one character above the bound does not. Match the same bounded display text and truncation state rather than comparing the archive text to an unbounded provider reply. Verify exact prior rows, times, duration, settled approval and following turns at both lengths before the no-op handoff. No R2 or R3 production changes.

Authority wording follows m-10291 and m-10294. Ordinary Terminal must not attach or call managed Parley tools. Stock Kimi 2.7.3 may still expose their descriptions to the model from earlier managed activity. The synthetic sentinel check distinguishes descriptions from actual invocation. No production filter, plugin, or global setting change is in scope.


The integrated nonempty sentinel result (verifier commit `2bca9720`, reviewed in m-10291) observed an earlier managed tool description in the stock 2.7.3 native model request. A controlled native invocation returned `Tool not found`, with no native managed-server startup or handler call. Returning to Chat restored ACP server startup, discovery and advertisement for the original ID. A future stock CLI that drops the stale description also satisfies the contract. This result does not imply a storage location for the description or cover user-installed integrations.

R1 follow-up matches the displayed text and truncation flag. It is not a comparison of provider content beyond the Chat display limit. The unchanged 262,145-character case lost archived metadata before the fix. After the fix, both unchanged lengths retain exact rows and a changed truncation flag refreshes the reply. The host build, all 63 focused tests in the R1 command above, and `git diff --check` passed.

## R3 — Kimi attachment generations and dormant aliases

Lead assignment m-10301 covers findings #6 and #7 only, on `df8eea0b`. Give both managed ACP and ordinary Kimi processes distinct attachment generations. A terminal client that negotiates generation support must echo the current generation with raw input and resize. Delayed requests for old managed or native processes must never reach the successor. Preserve existing raw terminal compatibility for other providers and clients using a host without this capability.

Before stopping Chat for takeover, reject a nonclosed second Parley session already bound to the same provider ID and Kimi store, even if that alias is asleep and has no process claim. A refusal leaves the existing owner, draft and Chat history unchanged. Reproduce stale managed-to-managed input and resize plus a pre-existing dormant alias before implementation. Verify the same tests, dedicated compatibility checks, focused builds and desktop typecheck. The separate R2 follow-up is not part of this change.

The optional `pty.attach` reply field is the attachment negotiation. A Kimi attachment now always supplies its process generation on this host. A client must echo it for raw Kimi input and resize. Clients paired with an older host that omits it, and other providers, keep their existing tokenless path. The desktop drops a debounced resize if its attachment generation changed before the timer fired. Dormant bindings are checked from persisted Parley metadata before publishing a marker. Legacy managed bindings without a recorded home are matched by the store their ACP resume would open with current user settings and their own cwd. No unrelated Kimi history is read.

Before the fix, the delayed resize changed the successor from 120×40 to 71×19, a dormant duplicate did not block takeover, and a queued desktop resize was stamped with the successor generation. Verification passed 129 focused host tests and 74 desktop tests, plus dependency builds and desktop typecheck. The host fixture also checks that stale or unversioned text cannot enter the successor prompt, a closed alias does not block takeover, and an equal ID in a distinct relative store is allowed. No UI appearance change or stock CLI retest in this slice.

```sh
pnpm run typecheck
pnpm --filter @parley/host exec vitest run \
  src/kimi/acp.test.ts src/kimi/sessions.test.ts src/kimi/kimi-host.test.ts \
  src/methods/pty.test.ts src/pty/pty-manager.test.ts
pnpm --filter @parley/desktop exec vitest run \
  src/renderer/terminal/use-terminal.test.ts src/renderer/terminal/TerminalSurface.test.tsx
git diff --check
```

## R2 follow-up — archive containment and feed rollback

Lead assignment m-10303 covers the two deferred R2 findings from m-10299 only. Refuse linked archive ancestors and verify that archive operations stay within the canonical work state directory before writing, pruning or deleting. Regression fixtures use disposable outside sentinels and exercise both a linked archive parent and linked per-session directory. Preserve the existing archive policy for ordinary directories.

An explicit Return to Chat may prepare a divergent provider snapshot, but must not publish that projection to Chat subscribers before durable release. An injected release write failure must keep the old snapshot and old subscribed rows in the current host and after restart. A later successful retry may publish the authoritative provider projection. Keep the native marker and automatic-wake fence through preparation and durable release. Verify the original failures first, then run focused builds/checks and commit separately from R3.

R2 handback now validates the archive and prepares the projection while ownership is still fenced. It updates the visible feed only after durable release. A refused transaction publishes no replacement deltas, so subscribers need no corrective resync. The regression clears the provider conversation in the native fixture, adds a replacement turn, injects the release failure, compares the current and restarted snapshots to the original rows, then verifies the successful retry publishes the replacement.

Archive operations validate each directory component below the canonical project, including the state directory and the work directory. Unsafe writes fail before takeover. Cleanup skips unsafe paths and leaves unrelated files and links alone. The archive reader also rejects linked leaf files. As with portable settings-file operations, the path checks are not an atomic defence against a directory being swapped in the final filesystem check/use interval.

Seven cases reproduced the review findings before the fix. Afterward, all 70 focused Kimi host tests and seven session-cleanup tests passed. The dependency builds, desktop typecheck and `git diff --check` also passed. No new screenshots or stock CLI run in this slice.

```sh
pnpm run typecheck
pnpm --filter @parley/core exec vitest run src/work/store.test.ts -t deleteSessionFiles
pnpm --filter @parley/host exec vitest run \
  src/kimi/acp.test.ts src/kimi/sessions.test.ts src/kimi/kimi-host.test.ts
git diff --check
```

## R3 follow-up — managed Chat waits for the ACP request

Lead assignment m-10311 covers the remaining R3 finding #6 from m-10309. On a host that requires Kimi attachment generations, managed Kimi Chat must keep a visible waiting state while activity is blocked and the ACP card has not arrived. Do not offer a raw fallback panel whose tokenless input would be rejected and whose submit action would clear an answer. The structured card takes over when it arrives. Preserve Chat drafts, older-host fallback, other providers, the existing xterm token path and the host fence. Reproduce blocked activity with a delayed card before the UI fix. Run focused checks and commit separately from the R2 follow-up.

The host advertises `kimi-pty-generation` in `hello.features`. The desktop uses it to show a status-only banner for managed Kimi without reading or writing the raw terminal. The delayed `feed.changed` card replaces the status. The regression verifies the approval travels through `feed.decide` and the unsent composer text remains intact. A Kimi host that advertises native Terminal but not the generation capability still uses the original raw fallback, as do other providers.

The blocked Kimi case rendered the dead terminal-answer form before the fix. Afterward, all 258 focused desktop tests passed. The targeted host fixture confirmed the advertised capability and the existing managed–native–managed writer fence. Dependency builds, desktop typecheck and `git diff --check` passed. The delayed-card state was checked through the production desktop components with a fake bridge, without a new browser capture or stock CLI run.

```sh
pnpm run typecheck
pnpm --filter @parley/desktop exec vitest run \
  src/renderer/chat/ChatView.test.tsx src/renderer/chat/TerminalPromptPanel.test.tsx \
  src/renderer/terminal/TerminalSurface.test.tsx src/renderer/terminal/use-terminal.test.ts
pnpm --filter @parley/host exec vitest run src/kimi/kimi-host.test.ts -t 'old managed input'
git diff --check
```

## R2 final follow-up — durable Chat checkpoint

Lead decision m-10317 covers the final durability finding #3 from m-10315. The previous R2 correction still protects subscribers when the release transaction fails. It does not protect a restarted host if that transaction succeeds and the process dies before publishing the new feed.

- Before release, stage a bounded immutable checkpoint of the reconciled Chat. Preserve matched archived rows verbatim and add each native turn once. Atomically remove the Terminal ownership marker and select the completed checkpoint in the same map transaction. Failure leaves the old marker and archive selected, and never publishes replacement deltas. No added brief or prompt runs during recovery.
- A restarted Chat seeds the selected checkpoint before handing the feed to the window or executing a managed wake. On later ordinary ACP resume, reconcile provider turns after the checkpoint, even if Chat already has rows. Retain the checkpoint evidence on failure. Do not silently replace it with raw replay or append an entire provider snapshot.
- Keep the active checkpoint and any in-flight/active Terminal archive through takeover and cleanup. A failed unpublished checkpoint must not replace the selected history. Once a new selection is durable, prune superseded files without dropping active pointers. Session deletion and provider replacement must not leave dangling checkpoint references. Do not change other providers or native authority.
- Reproduce committed release without feed publication under a disposable host, then restart and check exact archived approval IDs, times and one native suffix before ordinary wake. Cover release rejection, successful retry, and a later managed turn surviving another resume. Run focused builds and checks and commit separately from the prior R2 and R3 changes.

The projection file is written and flushed before the map points to it. The map transaction selects it and its original evidence while clearing the Terminal marker. If release is rejected, the old map and UI remain in place. A retry removes any unselected file left by a crash before commit. Cold Chat reads the committed rows before a snapshot or managed launch. Later resumes still request bounded ACP history, using the checkpoint and any matching in-memory rows to retain Chat evidence while reconciling the suffix. This is a handback checkpoint, not a separate journal of every later managed turn. Provider-only rows recovered after a restart still lack original Parley metadata that was never checkpointed.

The `crash-on-handback.mjs` fixture starts a separate disposable host and sends SIGKILL to itself from the synchronous map-written callback, after SQLite commit and before publish. Before the fix the restarted Chat was empty. After the fix it retains the exact old rows, including the settled approval, times and IDs, and one copy of the native turn. A later wake with an already seeded checkpoint resumes a newer managed turn without repeating the brief or losing the queued note. A failed release leaves the old marker, files and subscribed rows intact. A successful retry replaces the checkpoint, prunes superseded files and leaves one original evidence file. Session deletion removes both and provider replacement clears the pointer.

Verification passed 71 host tests, eight focused core tests, dependency and host builds, desktop typecheck and `git diff --check`. No new browser capture, stock CLI retest or power-loss simulation in this slice.

```sh
pnpm run typecheck
pnpm --filter @parley/host build
pnpm --filter @parley/host exec vitest run \
  src/kimi/acp.test.ts src/kimi/sessions.test.ts src/kimi/kimi-host.test.ts
pnpm --filter @parley/core exec vitest run src/work/agent-switch.test.ts src/work/store.test.ts \
  -t 'checkpoint|deleteSessionFiles'
git diff --check
```

## Final delta — keep ordinary checkpoint resume available

Lead assignment m-10328 covers the availability finding from m-10326. An explicit Terminal-to-Chat handback stays strict and recoverable on oversize or ambiguous history. Ordinary managed resume from a committed checkpoint must not close the exact-ID ACP owner merely because later history is oversized or ambiguous. Keep the committed rows and import only newer complete turns with safely identified boundaries and a matching replay prefix. Do not widen replay limits, invent missing rows, or repeat the brief. Make any partial display visible without disabling Chat or queued wake.

Reproduce history growth above the existing 2 Mi-character cap after a handback, then cover explicit stop/resume, a queued wake, exact checkpoint retention, no duplicate brief, and successful new live prompts. Exercise ambiguous ordinary replay separately. Verify focused fixtures and build/typecheck. Do not rerun independent stock probes or touch the live app.

Ordinary cold resume retains the checkpoint if the provider replay cannot confirm its whole prefix. When the prefix matches, it imports complete, unambiguous newer turns up to the first unsafe boundary or existing size limit. It does not claim to display turns beyond that boundary. The desktop status says when history was only partially restored. The exact provider conversation stays open for new prompts and queued mail. Explicit handback still refuses an unsafe replay and keeps the native recovery controls.

Both ordinary failure cases reproduced before the fix. The oversized fixture supplies nine 240 Ki-character replies. It verifies that eight complete newer turns can be shown without replacing the committed rows, ordinary Chat can answer after both an explicit restart and a queued wake, the queued pointer arrives, and the first brief is sent only once. The ambiguous fixture retains a complete newer turn before the unknown boundary. The strict handback fixture verifies that Terminal can still reopen after an oversized replay. Afterward, 343 focused host tests, 249 desktop tests, dependency builds, desktop typecheck and `git diff --check` passed. Five stock CLI cases were deliberately skipped.

```sh
pnpm run typecheck
env -u PARLEY_KIMI_PROBE_BIN -u PARLEY_KIMI_NATIVE_BIN -u PARLEY_KIMI_INTEGRATED_BIN -u PARLEY_KIMI_SENTINEL_BIN \
  pnpm --filter @parley/host exec vitest run src/kimi src/feed/feed-service.test.ts \
  src/feed/feed-service-takeover.test.ts src/wake/wake-service.mail.test.ts
pnpm --filter @parley/desktop exec vitest run src/shared/strings.test.ts src/renderer/shell/StatusBar.test.tsx
git diff --check
```
