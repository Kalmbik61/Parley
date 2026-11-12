# OpenCode 2.x provider: plan

Spec: `docs/specs/2026-11-12-opencode-provider-design.md` (revision 2).
Spike: `docs/research/2026-11-12-opencode-2x-spike.md`.
Branch: `parley/w-0054/s-345`. Lead: s-345. Owner: s-320. Room: r-28.

Status: revision 2.
- **No task starts before the human accepts the spec and DO1–DO8**, and before Parts M, A and Q are done (the order s-320 set).
- Changes after the critique of s-348 (spec appendix A):
  - O5: host-first death, exposure tests, the last poll;
  - O7: delivery without duplicates;
  - O10: the list of allowed tools.

## Rules for every task

These are the rules of `docs/plans/2026-11-12-mail-in-chat-and-qwen-models-plan.md`:
- work only in the s-345 worktree;
- one executor at a time;
- English commits, no push;
- tests, typecheck and lint counts, with failing tests named against the known baseline;
- fixtures copy shapes with invented content.

Two additions:
- **No real CLI in tests.**
  - Unit tests use fakes: a fake `opencode serve` HTTP/SSE server and a fake TUI, under `host/test/`.
  - The real CLI runs only in the mock lab and in V-O.
- **Secrets.**
  - Never log, store or print the server password, `auth list` output or keys.
  - Never read OpenCode's SQLite or auth files.

**Seniority.**
- **Senior-only (Claude Opus or Codex gpt-6-astra):**
  - O5, the server supervision: a process lifecycle across launch, resume, sleep, close, crash and host restart;
  - O6, the event bridge: a reconnecting stream that drives activity state.
- **Junior (Claude Sonnet):** all other tasks. Codex executors cannot write this worktree.

## Order

```
O0 → O1a → O1b → O2 → O3 → O4 → O5(senior) → O6(senior) → O7 → O8 → O9 → O10 → O11 → O12 → V-O → R-O
```

Strictly sequential, after Parts M, A and Q.

## Tasks

### O0. Mock lab and fixtures

**Scope.**
- `tools/opencode-mock-lab/`, after `tools/qwen-mock-lab/`:
  - an OpenAI-compatible mock with tool calls, `reasoning_content` and usage;
  - a stdio MCP mock with `check_inbox` / `wait_for` shapes;
  - a runner script that starts `opencode serve` with a throwaway HOME and XDG dirs, plus the TUI with `--server`;
  - a README.
- **Record, from a run of 2.2.7 with the mock, invented content only:**
  - `/api/session/{id}/message` for a turn with reasoning, text, a `shell` tool and an `execute` that calls `tools.parley.check_inbox`;
  - the SSE events of that turn, including `permission.asked` / `.replied` and `mcp.status.changed`;
  - `/api/info`;
  - the session `/inbox` list with one queued prompt;
  - the bodies of `/health` and `/doc`;
  - `auth list --format json` signed out;
  - `models` output.
- **Answer the [N] items of the spec with observations:**
  - `serve --port 0`;
  - `session export` without a server;
  - `debug config` without a server;
  - `auth list --format json` with one configured provider (fake key), and whether it prints secrets;
  - `models --verbose` variants;
  - the `execute` tool part shape;
  - the failed-execution event name;
  - whether `serve` survives the death of the process that started it.

**Files.** `tools/opencode-mock-lab/*`, `packages/core/src/feed/opencode/__fixtures__/*`, `host/test/stub-opencode-*.mjs`.

**Criteria.**
1. The lab README run reproduces the fixtures.
2. Each [N] item has an answer with the command and an output excerpt.
3. No real keys, user paths or human data are in the fixtures.

### O1a. The `opencode` family in the unions (core)

**Scope.**
- `ProviderFamily` gains `'opencode'`, and `providerFamily()` handles it.
- Synthetic family fixtures go in `core/test/family-fixtures.ts`.
- Grow every union listed in the integration map:
  - `session-index.ts:23`, `cli-tools.ts:6`, `mcp/provider-rows.ts:12,33`;
  - `protocol/methods.ts:478,575`;
  - desktop `feed-view.ts:31`;
  - `agents.ts:132`, `wake-service.ts:139`, `log-index.ts:123`;
  - `ProvidersSettings.tsx:25`, `StatusBar.tsx:165`;
  - mobile `brand.ts:10`.

**Criteria.**
1. Typecheck passes.
2. Each union has a test, or an exhaustive `never` check, that sees `opencode`.

### O1b. `byFamily` branches (core + host)

**Scope.**
- Add an `opencode` branch to every `byFamily` caller (integration map §1 list), neutral unless the spec says otherwise.
- Convert the direct `providerFamily(...) === 'qwen'` checks so that `opencode` is handled explicitly:
  - core `providers.ts:945,947`, `agents.ts:140`;
  - host `wake-service.ts:142,812`, `compaction-service.ts:43,175`, `pty/send.ts:120`.

**Criteria.**
1. A table test asserts the chosen branch per call site.
2. The existing family tests pass unmodified.

### O2. Install, update, version gate (core + host + desktop)

**Scope.**
- A `cli-tools.ts` descriptor (spec §4.9):
  - npm `@opencode/cli` dist-tags `latest`;
  - npm and curl install plans, with redirect hosts measured once with `curl -sI`;
  - expected binaries;
  - update plans.
- `UPDATE_COMMANDS` and `WINDOWS_COMMANDS`; provider-install strings; `cli-run` busy guard.
- Version: `opencode vX.Y.Z` is parsed. A bare 1.x version gives readiness "OpenCode 1.x found (…); Parley supports 2.x" (DO1).

**Criteria.**
1. Descriptor snapshot test.
2. Version and 1.x tests.
3. No test runs a real installer.

### O3. Per-session config builder (core)

**Scope.** `core/src/work/opencode-config.ts` builds the JSON of spec §4.3:
- `mcp.parley` with absolute `command` paths and the Parley MCP env;
- `permissions` per role, with read-only deny rules (DO4) and `parley_*` allow last;
- `model`;
- `autoupdate: false`.

It also builds `OPENCODE_CLI_CONFIG_CONTENT` `{"highlights": false}`.

**Criteria.**
1. Snapshot tests for a writable role, a read-only role, with and without a model.
2. The output has no relative command path.
3. A test with the O0 fixture of `debug config` shows the merge (if O0 found it works without a server).

### O4. Transcript and event parsers (core)

**Scope.** `core/src/feed/opencode/`:
- **Messages.** API messages → feed items (spec §4.11):
  - prompt, text, tool items;
  - reasoning hidden;
  - `idle` closes the turn;
  - `execute` parts that call `tools.parley.check_inbox` / `wait_for(inbox)` → `mail` items through `mailFromTool`, or a small adapter to it.
- **Events.** SSE event → Parley journal event mapping (spec §4.4) as a pure function.
- Idempotent by part and message ids.

**Criteria.**
1. Every O0 fixture gives the expected items and events.
2. Applying twice changes nothing.
3. The mail item for the Code Mode call equals the one the Part M tests expect.

### O5. Server supervision and launch (core + host). **Senior-only** (process lifecycle)

**Scope.**
- **Registry entry** (spec §4.1) with `mcpConfig: 'opencode-server'` and the placeholders `{serverUrl}`, `{sessionId}`, `{autoFlag}` (`PLACEHOLDER` regex, `RunnerSubstitutions`).
- **Session id.** `launch.ts` generates `ses_<uuid>`.
- **Host supervisor** `host/src/opencode/server.ts`, per spec §4.2:
  - port with retry;
  - password;
  - spawn of `opencode serve` in its own group with the config env;
  - `/api/info` wait;
  - TUI env;
  - the run file `<parley-home>/run/opencode-servers.json` (pid, pgid, startedAt; no password, no port);
  - on stop: last poll, then SIGTERM, SIGKILL after 2 s, await, record removed;
  - crash → session failed;
  - at host start, before any resume: sweep the run file. For each recorded pgid, kill the live group members whose command line is `opencode`, even when the leader is gone; leave a reused pgid alone.
- Resume reuses the id with a new server.

**Criteria.** Unit tests with the fake server:
1. start;
2. port collision retry;
3. a server that never answers (timeout, cleanup);
4. a server crash (session failed, TUI stopped);
5. TUI exit (server group gone, checked by pid);
6. resume (same id, new password);
7. **host-first restart:**
   - a fake server left running is killed by the sweep;
   - a leader that died first, with its child still alive, gets the child killed;
   - a pgid reused by another program is not touched;
   - the resumed session has exactly one server;
8. **exposure:**
   - the fake and the mock-lab server listen on 127.0.0.1 only;
   - the recorded `/health` and `/doc` bodies contain no session id, password, working directory or user name;
9. a grep test that the map, journal, run file and logs never contain the password.

### O6. Event bridge, readiness, activity (host). **Senior-only** (reconnecting stream, activity state)

**Scope.**
- `host/src/opencode/events.ts` subscribes to `/api/event` with Basic auth and reconnects with backoff while the server lives.
- It filters by session id, applies the O4 mapping, and writes journal events through the same path the hook server uses.
- **Readiness.** The server answers, `parley` MCP is connected and the TUI is alive.
- busy, idle and blocked as spec §4.4.

**Criteria.** Fake-server tests:
1. A turn gives the same activity sequence as a Qwen turn fixture.
2. A permission ask makes the session blocked.
3. A dropped stream reconnects without duplicate events.
4. Readiness waits for the MCP connection.

### O7. Delivery through the API, without duplicates (host)

**Scope** (spec §4.5).
- The deferred brief, the mail pointer and the limit-return text go through `POST /api/session/{id}/prompt`.
- **Pty fallback** only on a definite rejection: the connection was refused before sending, or an explicit 4xx.
- **Ambiguous outcome** (timeout, reset after sending, 5xx):
  - check `/inbox` and the latest messages for the text;
  - if absent, retry the API once;
  - type only if the server is gone.
- A pointer is marked delivered once.
- The inline-mail exclusion is kept.

**Criteria.** Fake-server tests:
1. The brief is sent once after readiness.
2. A pointer sent while busy is queued.
3. A 202 with a lost response (the server queued it) gives no second delivery.
4. A refused connection falls back to typing.
5. A 500 with the text in `/inbox` gives no typing.
6. No typing on success (spy).

### O8. Chat feed source (host + protocol + desktop)

**Scope.**
- Host polls messages every 2 s while subscribed, early on SSE, with the cache `<work>/opencode/<session>.json` (8 MiB cap). There is a last poll before a planned stop (called by O5). It seeds from the cache when no server runs.
- `FEED_OPENCODE_FEATURE`, `OPENCODE_FEED_MIN_VERSION`; desktop Chat gating, `feed-view.ts`, waiting banner and composer strings.

**Criteria.**
1. Live poll gives the O4 items.
2. A reseed from the cache after a fake restart gives the same items.
3. The last poll runs before stop.
4. The cap is enforced.
5. Chat is gated off for an old host or a version below the minimum.

### O9. Tool guidance (core)

**Scope.** The OpenCode bridge text (spec §4.6) in `guidance.ts` / `launch.ts`, and the short tool profile.

**Criteria.**
1. Snapshot of the system guidance for an OpenCode session.
2. The Codex and Qwen texts are unchanged.

### O10. Roles (core + desktop)

**Scope.**
- The role grammar for `opencode` (`agents.ts`).
- Read-only roles allowed through the O3 deny rules (DO4).
- `modelForTier` null.
- The role-picker note: Parley tools stay allowed, and `execute` can read the network.

**Criteria.**
1. A read-only role launch produces the deny rules.
2. A writable one produces `--auto`.
3. With the mock lab, the model request of a read-only session lists no `edit`, `write` or `shell`, lists `execute`, and a Parley tool call succeeds.
4. The picker shows the note.

### O11. Model catalog (core + host)

**Scope.**
- `opencode-catalog.ts` runs `opencode models` with a timeout of 10 s and an output cap of 1 MiB. The process group is cleaned up as in Q2. One probe runs at a time, and nothing waits on it.
- It writes `opencode-models.json`, which `loadProviders` reads.
- The model goes into the session config (O3).
- Variants become efforts only if O0 found them listed.

**Criteria.** As Q2 criteria 1–6, adapted. A session started with a chosen model has it in its config.

### O12. Provider card, icon, sign-in hint, docs (desktop + core)

**Scope.**
- Provider card and status bar.
- Icon `assets/providers/opencode.svg`: the official mark, if its license allows; otherwise a neutral `Oc` mark.
- Sign-in hint: the count from `auth list --format json`, never stored (DO2).
- New-session dialog, strings, README and CHANGELOG. The docs list the local exposure of `/health` and `/doc`.

**Criteria.**
1. Card tests for not installed, 1.x, signed out and signed in.
2. The icon license is noted in NOTICE if needed.

### V-O. Verification on the real app (builtin:verifier, junior, with the lead)

- Spec §6 items 1–10, with the mock lab model.
- One real account, only if the human gives one, with sign-in done by the human inside OpenCode.
- Screenshots: install, start, Chat with mail, read-only role, model choice, cleanup `ps` after close and after Restart Host.

### R-O. Independent review

A senior model that wrote none of O's code reviews the whole Part O diff. The critic s-348 does it, or Claude Opus if the Codex limit is hit. Then fixes and a delta review.

## Cost

- 14 tasks: 12 junior and 2 senior, plus a verification and a review. That is about the size of the Qwen provider work (38 commits).
- At the weekly limits of 2026-11-12 (Claude 97 %, Codex 93 %), Part O will likely need a limit reset during the work. The lead tells s-320 when a limit stops a session.
