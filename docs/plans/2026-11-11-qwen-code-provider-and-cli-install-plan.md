# Qwen Code provider and CLI install/update: plan

Spec: `docs/specs/2026-11-11-qwen-code-provider-and-cli-install-design.md` (revision 2).
Branch: `parley/w-0054/s-322`. Lead: s-322. Room: r-27.
Status: draft. **No task starts before the human accepts the spec and decisions D2–D10.**

## Rules for every task

**Where.**
- Work only in `/Users/kalmbik61/parley/worktrees/my_harnas-00f205/w-0054-s-322`. Never touch the main checkout.
- One executor in the worktree at a time.

**Scope.**
- One task per executor. Do not widen it.
- Ask the lead in r-27 when the spec does not answer something.

**Commits.**
- English conventional messages. No push.

**Checks before submit.** Report the counts for each:
- `pnpm --filter <touched packages> test`;
- `pnpm typecheck`;
- `pnpm lint`.

**Tests.**
- Every behaviour change has a test.
- No test runs a real installer, a real `update` or a real network fetch.

**Review.** A senior model that did not write the code reviews each task against its criteria before dependents start. That is the lead, or a critic for senior-only tasks the lead wrote.

**Seniority.**
- "Senior-only" tasks are implemented by a senior model, for the reason given (PARLEY.md).
- Junior tasks: Claude Sonnet or Codex gpt-6.1-sol.
- Senior: Claude Opus or Codex gpt-6-astra.

## Order and shared files

```
Part B: B1 → B2 → B3 → B4(senior) → B5 → B6
Part A: A0 → A1a → A1b → A1c → A2 → A3 → A4 → A5(senior) → A6(senior) → A7a → A7b → A7c → A8 → A9(senior) → A10 → A11
Final:  V1
```

- **Run order.** Sequential by default: Part B first, then Part A.
- **Shared files** that force this order when two executors run:
  - `protocol/src/methods.ts` and `host/src/methods/providers.ts` (B3, B4, A1c, A10);
  - `core/src/providers.ts` (A1a, A5);
  - `ProviderCard.tsx` and `ProvidersSettings.tsx` (B5, A10);
  - `host/src/sessions/sessions-service.ts` (A5, A6, A9).
- **Parallel option.** Part A may start in parallel with Part B only up to A4, which touches none of these files. The lead checks `get_capacity` first.

## Part B

### B1. CLI descriptor table (core)

**Scope.**
- New `packages/core/src/cli-tools.ts` with the table of spec §4.1:
  - latest source;
  - `installMethod(realpath, home, exists)`;
  - update plan per method (`run`, `npm-bound`, `manual`);
  - install plan per platform;
  - exact expected binary;
  - smoke argv.
- `cli-updates.ts` reads its sources and method rules from the table. `CliUpdateProvider` gains `'qwen'`.
- The qwen source is `https://registry.npmjs.org/-/package/@qwen-code/qwen-code/dist-tags`, key `latest`.

**Files.** `packages/core/src/cli-tools.ts` (new), `packages/core/src/cli-updates.ts`, tests.

**Criteria.**
1. Existing `cli-updates.test.ts` passes unmodified.
2. New tests cover:
   - the qwen method rules: npm realpath, standalone wrapper plus lib dir, Homebrew prefix, unknown;
   - the dist-tags fetch picking `latest` and ignoring experimental tags;
   - the update plan per method;
   - the install plans and expected binaries as a constant snapshot.

### B2. Shared runner; update through the table (host)

**Scope.** Extract the runner from `update-run.ts` into `cli-run.ts`, moving the existing semantics without changing them:
- group spawn, timeout and kill, tail, scrub;
- stop on shutdown;
- one per-CLI busy guard that install will share.

`providers.update` then runs per plan:
- **`run`:** as today; qwen standalone is `[bin, 'update']`.
- **`npm-bound`:** spec §4.3. Any unbound part returns the manual command; there is no PATH fallback.
- **`manual`:** returns `{ok:false, manualCommand}` and spawns nothing.

`UPDATE_COMMANDS` gains qwen.

Junior, with mandatory senior review of the busy/kill boundary. Reason it is not senior-only: the existing tested code moves with unchanged semantics, and the only new concurrency fact is that one guard is shared.

**Files.** `packages/host/src/providers/cli-run.ts` (new), `update-run.ts`, `updates.ts`, `packages/host/src/methods/providers.ts`, tests.

**Criteria.**
1. All `update-run.test.ts` cases pass with the same meaning.
2. Stub tests for:
   - qwen standalone update;
   - npm-bound: the stub node receives exactly the §4.3 argv with `--prefix` of the active install;
   - two prefixes, where the update targets the active one;
   - an unbindable install returns manual and spawns nothing;
   - unchanged or downgraded version → failure;
   - brew → manual;
   - busy across concurrent calls.

### B3. Status for every CLI and Check now (host, protocol)

**Scope.**
- `updates.ts`:
  - checks missing CLIs;
  - records `lastError`;
  - `checkOne(cmd, {force})`;
  - `status(cmd)` returns spec §4.4 `cli`.
- `providers.list` adds `cli`; `update` is unchanged.
- New `providers.checkUpdates {provider}`: a forced probe and fetch, at most one per CLI per 10 s, then `providers.changed`.
- `providers.checkUpdates` and `providers.update` go into `REMOTE_FORBIDDEN`. Update `packages/remote/test/frame-boundary.test.ts`. Neither goes into `ISLAND_METHODS`.

**Files.**
- `packages/host/src/providers/updates.ts`, `packages/host/src/methods/providers.ts`, `packages/host/src/methods/index.ts`;
- `packages/protocol/src/methods.ts`, `packages/protocol/src/types.ts`, `packages/protocol/src/remote/allowlist.ts`;
- `packages/remote/test/frame-boundary.test.ts`;
- tests.

**Criteria.** Tests for:
1. each `state` value, including `unknown` with `lastError` when offline;
2. force;
3. the 10 s limit;
4. `latest` for a missing CLI;
5. schemas;
6. remote-forbidden.

### B4. Install method (host). **Senior-only**

**Reason:** it runs downloaded vendor code as the user and defines the installer env (security, write boundary).

**Scope.** `providers.install {provider}` per spec §4.2:
- download, then run;
- the env policy;
- the npm route with the engine check, the forced registry and an empty userconfig;
- the exact-binary resolver fallback with `pathNote`, with no PATH change, honouring `PARLEY_<CMD>_BIN`;
- probe and smoke, then `providers.changed` and the latest re-check;
- the logged SHA-256;
- the allowlists;
- a Windows manual command.

**Files.**
- `packages/host/src/providers/install-run.ts` (new), `cli-run.ts`;
- `packages/core/src/work/find-binary.ts` (exact fallback);
- `packages/host/src/providers/versions.ts`;
- `packages/host/src/methods/providers.ts`, `packages/host/src/methods/index.ts`;
- `packages/protocol/src/methods.ts`, `packages/protocol/src/remote/allowlist.ts`;
- tests.

**Criteria.** Tests with a local HTTPS stub (a test-only CA) and stub interpreters:
1. success;
2. an HTTP redirect is refused;
3. a body over 1 MB is refused;
4. a timeout kills the group;
5. a non-zero exit returns the tail and the manual command;
6. inherited `BASH_ENV`, `NODE_OPTIONS` and `npm_config_registry` do not reach the child, and proxy and CA variables do;
7. a scoped `@qwen-code` registry in the npmrc is refused;
8. a binary only at the expected path gives `pathNote`, an unrelated `git`/`node` in that dir does not change resolution, and the fallback works after a host restart;
9. npm missing or Node too old fails before spawn;
10. busy is shared with update;
11. no argv element comes from the request.

### B5. Provider card: Install, status row, Check now (renderer)

**Scope.**
- The row is always drawn, with the spec §4.4 states and [Check now].
- A missing CLI gets [Install…], with a confirmation carrying the command, the source URL, the trust-boundary text and the D3 profile note.
- Running, error and done states (done shows `pathNote`).
- The status bar "↑" covers qwen.
- New text goes in `strings.ts`.

**Files.**
- `packages/desktop/src/renderer/components/providers/ProviderUpdateRow.tsx`, `ProviderCard.tsx`, `provider-install.ts`;
- `packages/desktop/src/renderer/components/settings/ProvidersSettings.tsx`;
- `packages/desktop/src/renderer/shell/StatusBar.tsx`;
- `packages/desktop/src/shared/strings.ts`;
- tests.

**Criteria.**
1. Component tests for every state and the install flow.
2. Existing tests are updated, not deleted.
3. An e2e test on stub binaries (`desktop/e2e/providers-connect.spec.ts`) clicks Check now, Update and Install.

### B6. README and superseded decision (docs)

**Scope.**
- Spec §4.5: the README bullets.
- A dated "superseded" line under `docs/specs/2026-10-02-providers-connect-design.md:66`.
- The `provider-install.ts` header.
- A CHANGELOG entry.

**Criteria.** The text matches the spec.

## Part A

### A0. Mock lab and fixtures (versioned)

**Scope.**
- `tools/qwen-mock-lab/`: the OpenAI-compatible mock (text, tool call, thinking, an auth-error and a quota-error mode), a stdio MCP mock, a pty driver, and a README for running the real `qwen` 0.27.2 against it with a throwaway `QWEN_HOME`. The source is the spike lab in the s-322 scratchpad (`spike/lab/`).
- Sanitized fixtures in `packages/core/src/feed/qwen/__fixtures__/` from `spike/home2` and `spike/home3`:
  - no absolute user paths;
  - no memory-snapshot text.
- Stubs `packages/host/test/stub-qwen-agent.mjs` and `packages/desktop/e2e/stub-qwen-agent.mjs`, modelled on the codex stubs. They:
  - read `QWEN_CODE_SYSTEM_SETTINGS_PATH`;
  - fire the command and http hooks with the appendix A payloads, including the empty UserPromptSubmit;
  - write the transcript;
  - honour `--session-id`, `--resume` and `-i`.

**Criteria.**
1. The stubs run offline.
2. The executor runs the lab README once against real qwen and attaches the run log.
3. The fixtures pass a check for absolute paths and memory text.

### A1a. Family type, registry helper, synthetic tests (core)

**Scope.**
- `ProviderFamily = 'claude'|'codex'|'qwen'`.
- `codex.family = 'codex'`.
- `providerFamily()`.
- A test-only synthetic `qwen` entry plus an unknown-family entry, used as fixtures by A1b and A1c.

**Files.** `packages/core/src/providers.ts`, `packages/core/src/session-index.ts` (type only, no registry entry), tests.

**Criteria.** Unit tests for the family of every built-in, custom, account and `providers.json` entry. The suite stays green.

### A1b. Host and core dispatch sites

**Scope.** Convert the host and core sites of plan appendix 1 to explicit family checks with a neutral default. New switches are exhaustive.

**Criteria.**
1. For each site, a test with the synthetic qwen and unknown entries shows the neutral branch.
2. Claude, Codex, GLM, custom and account entries keep their branch.
3. The commit message lists every site.
4. Lead review before A1c.

### A1c. Wire and UI family

**Scope.** Widen the `family` wire field and its readers:
- `protocol/src/methods.ts:455`;
- `core/src/mcp/provider-rows.ts`;
- `host/src/agent/providers-endpoint.ts`;
- `desktop/src/renderer/lib/feed-view.ts`;
- `desktop/src/renderer/components/AgentIcon.tsx`.

**Criteria.**
1. Tests: Codex shows `family: "codex"`; an unknown family is shown as neutral.
2. The whole suite and typecheck pass.

### A2. qwen home resolver and sign-in hints (core)

**Scope.**
- `packages/core/src/qwen/home.ts` (`qwenHome(env)`).
- `packages/core/src/qwen/auth-state.ts`, spec §3.6: reads only `model.name` and `security.auth.selectedType`; presence checks for the credential file and the env key.

**Criteria.**
1. Tests for each hint and for `QWEN_HOME`.
2. A fixture `settings.json` containing an `apiKey` field never leaks it into the output or the log.

### A3. Durable normalization (core)

**Scope.** Spec §3.4 normalization in `core/src/work/events.ts` and `core/src/work/activity.ts`:
- `promptEmpty`, `notificationType`, `contextUsage` and `contextLimit` on qwen journal records;
- activity ignores `promptEmpty: true`.

**Criteria.**
1. A replay test of a journal with the empty follow-up shows one turn and no lost wait.
2. Claude and Codex replays are unchanged.

### A4. Transcript parser (core)

**Scope.** `packages/core/src/feed/qwen/` parser per spec §3.5.

**Criteria.** Tests on the A0 fixtures cover:
- every record kind, including the inner MCP name and tool errors;
- `system` skipped;
- unknown types counted;
- a partial last line kept for the next read.

### A5. Registry entry and settings file (core). **Senior-only**

**Reason:** the settings writer handles the administrator's system policy and the write boundary.

**Scope.**
- The `qwen` entry with route kind `qwen-system-settings`.
- New `packages/core/src/work/qwen-settings-file.ts`, spec §3.3: base resolution, refusals, Parley additions, set-if-absent defaults. It uses the protected writer of `settings-file.ts`.
- `launch.ts`: the qwen argv and env, the route-kind MCP detection, D6 approval mode.

**Mock lab checks, recorded in the report:**
- the `http` hook type works;
- the D7 options: whether a tool-level allow list exists;
- the D8 measurement with the full Parley tool list plus a representative user server (tool count, payload bytes).

**Files.**
- `packages/core/src/providers.ts`, `packages/core/src/session-index.ts`;
- `packages/core/src/work/launch.ts`, `packages/core/src/work/qwen-settings-file.ts` (new), `packages/core/src/work/settings-file.ts` (writer reuse);
- `packages/core/src/providers.test.ts`;
- tests.

**Criteria.** Unit tests:
1. argv and env for new, resumed, workspace and non-workspace sessions;
2. `--yolo` never appears;
3. base absent;
4. base inherited from the env;
5. base invalid JSON, EACCES, symlink or hardlink → refused;
6. administrator conflict on each required key → refused;
7. administrator value of a default → kept;
8. unrelated nested keys preserved.

### A6. Host launch wiring, hooks, readiness, state (host). **Senior-only**

**Reason:** the readiness state machine and hook-token lifetime are concurrency- and recovery-sensitive.

**Scope.**
- `sessions-service.ts`: hook URL, version gate, token registration and cleanup for qwen, on start and resume.
- `hook-server.ts`: the qwen event set.
- `activity-service.ts`: the mapping and the spec §3.4 readiness state machine.
- `core/src/work/stuck.ts`: StopFailure.
- `context-service.ts`: `contextUsage`.

**Criteria.**
1. Tests with the stub for every row of the mapping table, every readiness transition and the startup-attention text.
2. On the mock lab through `sessions-service`: the token is accepted, state goes busy → idle, and the no-auth run shows startup attention.

### A7a. Watcher, discovery, binding (core, host)

**Scope.**
- A qwen `WatchSource` in `core/src/watch.ts`.
- `host/src/activity/log-index.ts` registration and reindex dispatch.
- `core/src/session-indexer.ts`, `core/src/all-sessions.ts`, `core/src/work/metrics.ts`.
- The binding stored from SessionStart, validated by `sessionId` and `cwd`.

**Criteria.** Spec §3.5 test list:
- creation after host start;
- append;
- partial line;
- truncation;
- missed events with rescan;
- host restart without a hook;
- the same id under two families.

### A7b. Feed integration and Chat gate (host, renderer)

**Scope.**
- `host/src/feed/feed-service.ts` seed and tail for qwen.
- The `onHook` qwen branch (state only, no items, no permission cards).
- `desktop/src/renderer/lib/feed-view.ts`: the gate and the "waiting for approval in the terminal" text.

**Criteria.**
1. Tests: tail of an appended transcript; no duplicate items from hooks.
2. On the mock lab: the Chat view renders a real run.

### A7c. Sleep, wake and resume (core, host)

**Scope.** Resume argv on wake, and the binding reused after resume.

**Criteria.**
1. Test: wake resumes with `--resume <id>`.
2. Mock lab: a slept session resumes into the same transcript.

### A8. Mail, compaction, pty typing for qwen (host). **Senior-only**

**Reason:** typing into a live pty while the agent or the human may act (concurrency).

**Scope.** Spec §3.4 mail and typing:
- `host/src/pty/send.ts`, `type-and-submit.ts`: the qwen strategy keeping every guarantee;
- `host/src/wake/wake-service.ts`: delivery after Stop, and when `ready` before the first turn;
- `compaction-service.ts`: `/compress`;
- `inline-mail.ts`: qwen excluded;
- `process-monitor.ts`.

**Criteria.**
1. Negative tests:
   - a pointer during a turn waits;
   - the human typing at the same time;
   - a startup dialog blocks typing;
   - a stale hook from an old process is ignored;
   - Stop followed by a new turn;
   - a host restart during delivery;
   - no duplicate delivery.
2. Mock lab: a message wakes an idle session, including one before its first turn.

### A9. Roles on qwen (core). **Senior-only**

**Reason:** permission enforcement.

**Scope.** Spec §3.6 roles:
- the qwen grammar in `core/src/work/agents.ts` (`nativeRolePairs`, `assertRoleDelivery`), with read-only kept refused;
- the `core/src/roles/catalog.ts` mismatch rule;
- `core/src/roles/builtin.ts` `modelForTier` → null;
- `core/src/work/role-choice.ts`.

**Criteria.** Tests on start and resume:
1. executor, debugger and verifier launch with the role prompt;
2. every read-only role → `role-permissions-unavailable`;
3. a native Claude or Codex role → mismatch;
4. a template with an unknown flag → refused.

### A10. Qwen card and preset rename (renderer)

**Scope.**
- The Qwen Code card (`CORE_IDS`) with the A2 hints, the model field and the B5 rows.
- `AgentIcon` with a qwen asset. First check the vendor-icons decision in `docs/`; otherwise use an original simple mark.
- The status bar segment.
- The new-session dialog lists qwen. Read-only roles are disabled there, with the reason.
- The preset label "Qwen models in Claude Code (Alibaba key)", with the id unchanged.
- New text goes in `strings.ts`.

**Files.**
- `ProvidersSettings.tsx`, `ProviderCard.tsx`, `custom-presets.ts`;
- `AgentIcon.tsx`, `assets/providers/qwen*.svg`;
- `StatusBar.tsx`;
- the new-session dialog;
- `strings.ts`;
- tests.

**Criteria.** Component tests for:
- each hint;
- the dialog with qwen and its disabled read-only roles;
- the preset label with an unchanged id.

### A11. Docs for qwen

**Scope.**
- The README providers list.
- The providers user guide, if one exists in `docs/`: Qwen Code, sign-in through `/auth`, and what v1 excludes.
- A CHANGELOG entry.

**Criteria.** The text matches the spec.

## V1. Verification

A verifier on a junior model runs spec §8 end to end on the branch head:
- package tests and typecheck;
- the mock lab through the real host for every §8 item, with evidence (commands, logs, screenshots of card states and the Chat view);
- one real qwen Install through Parley into a scratch `HOME`, as authorized with the spec.

**Result.**
- pass / fail / not verified for each §8 item;
- the "needs a live login" list restated as facts.

**Afterwards.** The lead reviews the result and writes the completion summary with the impact card.

## Appendix 1. Family touch-point inventory (bounded scope of A1b)

From the code survey of 2026-11-11. The A1b executor converts exactly these sites; anything else it finds is reported to the lead, not changed.

**Core:**
- `core/src/work/room-usage.ts:83`
- `core/src/work/role-choice.ts:23`
- `core/src/watch.ts:55-85`
- `core/src/work/usage-timeline.ts:20,52,77`
- `core/src/work/usage-ledger.ts:553`
- `core/src/agent-plan-log.ts:35,61`
- `core/src/cli-updates.ts:25-36` (done by B1)

**Host:**
- `host/src/activity/log-index.ts:118, 301, 409-414, 507-511`
- `host/src/activity/activity-service.ts:656, 714, 1130, 1153`
- `host/src/hooks/hook-server.ts:319-328`
- `host/src/hooks/inline-mail.ts:60`
- `host/src/feed/feed-service.ts:794-805, 851`
- `host/src/compaction/compaction-service.ts:40`
- `host/src/pty/process-monitor.ts:44`
- `host/src/context/context-service.ts:64`
- `host/src/stuck/stuck-service.ts:157-160`
- `host/src/stuck/limit-alternatives.ts:43-48`
- `host/src/sessions/sessions-service.ts:734-745, 2294-2315`

**Desktop (A1c):**
- `desktop/src/renderer/lib/feed-view.ts:31, 47-53`
- `desktop/src/renderer/components/AgentIcon.tsx:65-90`

**Sites that stay id-based on purpose**, because they are Codex-specific behaviour rather than family dispatch:
- `core/src/work/launch.ts` codex flags;
- `core/src/work/codex-policy.ts`;
- `host/src/pty/codex-terminal.ts`, `codex-input.ts`;
- `host/src/activity/codex-log-poll.ts`;
- the capabilities and skills modules (`claude`/`codex` only, qwen excluded in v1);
- the autonomous, assistant and swarm allowlists (`claude`/`codex` only, qwen excluded in v1).
