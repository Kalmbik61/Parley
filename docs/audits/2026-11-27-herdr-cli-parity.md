# Real CLI OSC 7501 and input parity

**Baseline:** Parley v0.39.8, `670df38736cc517302b451b724b7f22bf9da4a3e` (`origin/master`). Measured on macOS arm64 with installed CLIs. This is a verification record for tasks 4 and 6 of the adoption plan, not verification of the pending generic OSC reader.

Every CLI ran on a fresh PTY with a throwaway HOME and provider state. HTTP responders listened on loopback and returned synthetic output. The OS profile denied non-loopback network access, writes to the user's home, and access to the real Parley checkout and profiles. Herdr was not run or installed. OpenCode and Qwen reused the committed mock-provider labs. No raw transcripts, provider configuration, credentials, or screen dumps are included.

## Task 4 — real status matrix

A root frame has no `id` field. States below come from bytes emitted by the CLI, not from the prompt text or the mock. `7501;?` is a capability query and does not carry a state. ST is ESC-backslash and BEL is byte 0x07.

| Installed CLI and native mode | Readiness, work, waiting and completion | Adoption verdict |
| --- | --- | --- |
| OpenCode **2.3.0**. `opencode serve --hostname 127.0.0.1 --port 0` and `opencode --server <url> -s <session-id>`. No `HERDR_ENV` and no OSC capability response. | **PASS.** ST, `app=opencode`. Terminal prompt: root `idle → working → idle`. Server API prompt: root `working → blocked:permission → working → idle`. Escape dismissed the live permission from the TUI and interrupted that turn. Root `clear` without app on quit. No root `done` or `error` observed. | Evidence supports this mode. An initial `?` and the session-scoped frames are not root reports. |
| Qwen Code **0.27.2**. Parley host launch, `qwen --session-id <uuid> --approval-mode default --append-system-prompt <session-instructions>` (model via mock environment). Independent raw PTY comparison selects `-m mock-model` explicitly. | **PASS** for root ST frames `app=qwen-code`: `idle → working → done` on each of the three verified turns, plus an app-less `clear` in a separate raw shutdown. A separate clean unauthenticated profile opened “Connect a Provider” and emitted root `blocked:auth` (ST). Permission, question and error frames were not verified on the controlled turns. | Retain the independently verified Qwen path and its existing readiness checks. |
| Kimi Code **2.8.1**, native `kimi`, manual permissions; a second process invoked with the same fresh test profile. | **PASS** for the negative control: `7501;?` (ST) only in the normal PTY, despite a real folder trust menu and a local reply after choosing “Trust and continue.” **PASS** for separate synthetic negotiation: root ST `app=kimi-code`; `blocked:permission` at trust, then `idle`, app-less `clear`, `idle → working → done`, and a fresh `idle` from the replacement. | **NOT VERIFIED** for ordinary root status or managed-host handoff. No nested status appeared in these runs. The handshake result does not justify enabling Kimi for an unnegotiated terminal. |
| Codex **0.166.0**, `codex --no-daemon -c …` and `codex resume <thread-id> -c …` with the usual Parley terminal-title, OSC 9, and no-update options. | **PASS** for root ST `app=codex` on a real local Responses turn and a resumed turn on the same rollout. `idle → working → done` and app-less root `clear` observed, no capability response supplied. A local Responses tool call caused root `blocked:permission`; Escape left the approval menu and returned through `working` to `idle`. | Separately version-tested only. Existing Codex notification and approval paths were not replaced. |
| Claude Code **2.1.332**, TUI `claude --session-id <uuid> --settings <test-json> --append-system-prompt <test-instructions> --model claude-sonnet-4-6`; explicit default permission mode in negotiation run. | **PASS** for the negative control: only `7501;?` (BEL) with ordinary PTY and real local Messages traffic. **PASS** for separate synthetic negotiation: root BEL `app=claude-code`; `idle → working → done`, then `working → blocked:permission → idle` after Escape. | **NOT VERIFIED** for ordinary root status or variants such as GLM and user aliases. Do not infer support from the query. |

For the negotiated runs only, the interpreter answered the CLI's query with
`ESC ] 7501 ; ?supported=true ST` before answering the DA1 probe. This was a synthetic terminal capability response, not an application status and not evidence that existing Parley sends the response.

### OpenCode correlation

The suspect status was checked against the exact session created by `POST /api/session` before attaching the TUI. The first mock reply appeared in that TUI, and `GET /api/session/<id>/message` returned one matching user and one matching assistant record for the first turn. The second prompt went through `POST /api/session/<id>/prompt`; `GET /api/permission/request` returned a pending request with that same session ID, and the SSE stream included `permission.asked` and `permission.replied`. Escape in the TUI reduced the pending request list from one to zero without approving the command. The underlying session API was not asked to make the decision.

Sanitized capture, omitting messages and unrelated terminal bytes:

```text
7501;? ST
7501;state=idle:app=opencode ST
7501;state=working:app=opencode ST
7501;state=working:app=opencode:id=<id> ST
7501;state=clear:id=<id> ST
7501;state=idle:app=opencode ST
…
7501;state=blocked:kind=permission:app=opencode ST
7501;state=blocked:kind=permission:app=opencode:id=<id> ST
…
7501;state=clear ST
```

The session-scoped `id` in these frames was the attached session, not evidence that a child agent had been launched. Its presence is still enough to keep the record out of the root state.

## Task 6 — Qwen under the real host

The temporary host launched two real Qwen sessions in the same cwd under a single fresh profile. The host was driven through its existing NDJSON protocol. A delayed local responder held the third turn open without submitting a different prompt to the other session.

| Scenario | Evidence and verdict |
| --- | --- |
| Terminal plus Chat send path with a clean editor | **PASS at the host boundary.** `pty.input` submitted `parity-terminal-one` in A. After the draft check and a human-style Ctrl+U, `pty.send` with `submit:true` sent `blue-widget` in A and returned `submitted:true`. A's actual Qwen JSONL had both user texts in order, two assistant replies, and no extras. Both pairs were present exactly once at `feed.snapshot` on A. **NOT VERIFIED** in the desktop GUI with real Qwen. |
| Known `z` draft during Chat send of `blue-widget` | **PASS.** `{inserted:true, submitted:false, reason:"draft"}`. The draft was left in the terminal, and the host inserted text but withheld Enter. Mock request count stayed 1→1, JSONL still contained just the first prompt, and no merged prompt was submitted. There was no clear-and-submit fallback. |
| Banner, placeholder, redraw, view switch | **PASS at the host boundary** for no extra prompt in A's feed and in the two provider logs after startup, redraws and the held draft. **NOT VERIFIED** for a real Qwen Chat ↔ Terminal GUI switch. |
| Two Qwen processes in the same cwd | **PASS** for the input target and log isolation: A had two user records and replies, B had one. A's last root status was `done` while B's mock request was held and its last root status was `working`. **PASS for eventual feed completeness, FAIL for live discovery on a cold history root.** The original 12-second wait left B empty. A longer repeat gave each feed its own rows exactly once, but B took 26.565 s after the JSONL was observed. With the empty Qwen history directory already present at host startup, B took 1.868 s in the matching control. **NOT VERIFIED** for desktop sidebar/permission targeting. |
| Changed permission menu or process | **PASS** for OpenCode's current TUI cancellation on the attached session. **NOT VERIFIED** for stale decisions during replacement on real clients. The existing Qwen dialog tests used fixtures. |
| Silent, idle-only or disconnected status source | **PASS** for the existing Qwen readiness tests on v0.39.8, including idle without MCP, no OSC, and old-generation evidence. **NOT VERIFIED** for the proposed generic reader and per-provider renderer wiring, which were not in this baseline. |

The three recorded requests carried `[parity-terminal-one]`, then `[parity-terminal-one, blue-widget]` as A's history, then `[parity-b-three]` for B. This is three requests, not four user messages. Both real provider JSONL files were checked.

The final run also saw hook-driven host activity `unseen` for completed A and `working` for B while its response was held. B's hook journal included `SessionStart`, `UserPromptSubmit`, and `Stop` for its own UUID. The corresponding native file existed, and `indexQwenSession`, `qwenBindingCandidate`, and `qwenBindingHolds` agreed on its UUID, cwd, and file after the run. The initial blank B snapshot also occurred before applying canonical-path and subscription controls. The distinction matters: a displayed activity status, valid binding inputs, and a complete provider transcript did not guarantee timely discovery by Chat.

### Follow-up — cold Qwen history root

The original 12-second check caught a delay, not data loss. A two-run control on the same build kept two Qwen processes, cwd shape, the three mock turns, subscription sequence, and draft probe unchanged. The only changed setup was creating the empty `$QWEN_HOME/projects` before starting the host.

| Qwen history root at host start | Host start to B's full snapshot | B's native JSONL observed to full snapshot | Final outcome |
| --- | ---: | ---: | --- |
| Absent | 30.369 s | 26.565 s | A's two pairs and B's one pair, no duplicates or cross-feed rows. |
| Pre-created and empty | 5.578 s | 1.868 s | A's two pairs and B's one pair, no duplicates or cross-feed rows. |

These are single-run timings measured by the RPC driver, not performance percentiles or an asserted latency contract. Both cases reattached the requested refs and observed the same draft guard and the same three mock calls.

The source-level mechanism is in `packages/core/src/watch.ts`. `watchSessions` attaches to the history root once. Its initial `fs.watch` failure with `ENOENT` does not schedule reattachment, unlike an error from an existing watcher. The host can recover without the watcher because `rescanLive` supplies bound Qwen transcript paths to the index every 30 seconds (`packages/host/src/activity/activity-service.ts`). The cold timing matches this timer. A separate direct watcher probe placed the same two synthetic UUID logs into a directory created after watcher startup. The absent-root case recorded one `ENOENT`, zero live callbacks, and two discoveries after explicit rescan. The pre-created root had no errors and two distinct live discoveries before rescan. A narrow regression should start with the Qwen history directory absent, then create it and write two transcript UUIDs in one cwd. Both must reach the correct feeds without a manual rescan or the 30-second fallback. The regularly present-root control checks the same UUID isolation without claiming the cold-path defect is fixed.

### Independent verification of the cold-root fix

**PASS** at the real host boundary. A separate v0.39.8 copy used only `packages/core/src/watch.ts` and `packages/host/src/activity/log-index.ts` from candidate `b5adebe1a4998732dfbe6fde9e98355d9ea7d621`. The `git diff --no-ext-diff --binary --full-index` for those two paths against the baseline had SHA-256 `41562050b6616afce7a5028174a659c1a9805559a225cb3ec8be90a069554461`. The same two paths from the submitter's working copy and the test copy matched that patch byte for byte. Their file object IDs also matched the named commit.

Two runs used fresh Qwen **0.27.2** profiles, two processes in one canonical cwd per run, one temporary host, and the same loopback fixture. The harness asserted that `$QWEN_HOME/projects` did not exist before host startup. Each run explicitly required the B prompt in its snapshot within 12 seconds of observing the B JSONL reply.

| Cold run | Host start to B snapshot | B JSONL observed to B snapshot | A and B feed contents |
| --- | ---: | ---: | --- |
| 1 | 5.643 s | 1.889 s | A had two pairs, B had one. |
| 2 | 3.669 s | 0.362 s | A had two pairs, B had one. |

Both runs compared each snapshot to the actual provider JSONL and local mock requests. A had `parity-terminal-one` and `blue-widget`; B had `parity-b-three`. Each prompt and reply appeared exactly once in its own feed, with no cross-feed prompt. Both runs returned `{inserted:true, submitted:false, reason:"draft"}` for `blue-widget` over the typed `z`. The mock request count remained 1→1 during that check and the combined text did not become a transcript entry. After Ctrl+U the same host send submitted `blue-widget` normally. The mock hold on B again showed separate hook-driven activity for A and B.

The host and its dependencies built successfully with `pnpm --filter '@parley/host...' build`. From `packages/host`, the following existing tests passed on the two-file snapshot (76 total):

```sh
node ../../node_modules/vitest/vitest.mjs run src/activity/log-index-qwen.test.ts src/activity/log-index.rescan.test.ts src/activity/qwen-binding.test.ts src/pty/send.test.ts
```

This is verification of the two production files and the live host scenario, not of the rest of the candidate branch, its newly edited tests, or the Electron E2E suite. The verifier made no changes to the submitted implementation or tests.

## Reproduction and checks

1. Start with a clean checkout of v0.39.8. Use an empty process environment plus a temporary HOME, XDG directories, `PARLEY_HOME`, and provider profile paths. Restrict network to loopback plus the test root's Unix sockets. Use local synthetic keys only. Resolve the real CLI paths before clearing the environment.
2. For OpenCode follow `tools/opencode-mock-lab/README.md` and `record.mjs`, using the installed 2.3.0. Start the fixture with permissions set to ask, attach to a known session, and capture the raw PTY before any terminal escape stripping. Type `SLOW parity-terminal`; record the first API messages. Submit `BASHCALL parity-permission` via that session's API to open the permission, inspect the request and SSE, and dismiss in the TUI with Escape. Inspect both root and `id` OSC 7501 records.
3. For Qwen, build the host from this checkout and run `tools/qwen-mock-lab/mock.mjs` on loopback. Use an empty `QWEN_CODE_SYSTEM_SETTINGS_PATH` document before launch so the test host supplies its standard runtime settings and MCP hooks. Give it the synthetic `OPENAI_API_KEY`, `OPENAI_MODEL=mock-model` and local `OPENAI_BASE_URL`. Create two `qwen` sessions of one work, use `pty.attach` for their generations, and use `feed.subscribe` followed by `feed.snapshot` for the Chat path. Wait for both actual composers, not merely the first `idle`. Run the prompts in the table, compare mock input, `pty.output` and `feed.snapshot` against the distinct provider `projects/*/chats/*.jsonl` files; hold the third mock request to capture overlap.
4. For Kimi, the synthetic `KIMI_MODEL_*` settings and manual mode in `packages/host/src/kimi/shared-native-host.probe.test.ts` describe the mock setup. That opt-in integration fixture version-gates 2.7.3 and 2.8.0, so its result is not asserted for 2.8.1. The measured command here was the real native CLI with a fresh `KIMI_CODE_HOME` and the local OpenAI-compatible responder. For Codex and Claude, use isolated local Responses and Messages SSE respectively with one synthetic text response and, where recorded, a permission request the tester does not approve. Capture the normal PTY separately from the capability-response control.

Exact baseline checks:

```sh
pnpm --filter '@parley/host...' build
pnpm --filter '@parley/desktop...' build
pnpm --filter @parley/core exec vitest run src/feed/qwen/apply-qwen.test.ts
# From packages/host, under the loopback/private Unix-socket profile
node ../../node_modules/vitest/vitest.mjs run src/activity/log-index-qwen.test.ts src/activity/log-index.rescan.test.ts src/activity/qwen-binding.test.ts
node ../../node_modules/vitest/vitest.mjs run src/pty/qwen-terminal.test.ts src/pty/codex-terminal.test.ts src/pty/pty-manager.test.ts src/activity/activity-qwen.test.ts src/pty/send.test.ts src/feed/qwen-prompt.test.ts src/feed/feed-service-opencode.test.ts src/kimi/native-session-steer.test.ts
pnpm --filter @parley/desktop exec vitest run src/renderer/store/activity.test.ts src/renderer/sidebar/SessionRow.test.tsx src/renderer/chat/ChatToolbar.test.tsx
# From packages/desktop, with an isolated HOME and local cached Electron
node node_modules/@playwright/test/cli.js test e2e/chat-view.spec.ts
```

Both builds **PASS**; 203 host, 17 core and 119 renderer tests **PASS**. The follow-up direct watcher probe and 12 focused host tests also **PASS**; the focused suite did not cover a missing root at startup. The Playwright invocation exited 1 before its first assertion because the sandboxed Electron could not initialize its own macOS sandbox/SingletonSocket. Desktop E2E is **NOT VERIFIED**, not a renderer failure. The baseline does not contain `src/pty/program-status.test.ts`; no verdict on that implementation is implied.

## Impact card

- **Goal** — Distinguish real provider state from a capability probe and verify where input and history remain authoritative.
- **Behaviour** — OpenCode's attached TUI reports actionable display signals without capability negotiation. Qwen's real host preserves the known-draft Enter guard and the two native session identities. This audit changes no runtime behaviour.
- **Numbers** — Five exact installed versions, three controlled Qwen turns, two Qwen JSONLs, and a measured baseline cold-root delay of 26.565 s after the B JSONL was observed. Two candidate cold runs took 1.889 s and 0.362 s. OpenCode and Codex each had a real permission wait dismissed from the TUI. No latency, CPU or memory impact measured.
- **Screens** — Not measured for desktop UI because Electron failed before the E2E assertions. The evidence is raw terminal frames and provider/host records.
- **For the human** — The OpenCode status is display evidence. It is not proof of input delivery or approval authority. The Qwen guard inserts into a known draft without submitting it.
- **Risk** — Mistaking a capability query or a scoped report for a root state can mislabel a session. A negotiated Kimi/Claude result cannot be extrapolated to ordinary PTYs.
- **Cost** — No paid requests or dependency downloads. Runtime overhead of the proposed change was not measured because it was not part of this baseline.
- **Verdict** — OpenCode passes the real attached-mode check. Qwen's three native turns and draft guard pass at the input/log boundary. The baseline cold path waited for a fallback rescan. The two-file fix passed the under-12-second check in both cold runs and both same-cwd feeds matched the native turns. Full desktop task 6 and generic reader integration are not verified.
