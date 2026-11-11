# Qwen Code provider and CLI install/update: plan

Spec: `docs/specs/2026-11-11-qwen-code-provider-and-cli-install-design.md`.
Branch: `parley/w-0054/s-322`. Lead: s-322. Room: r-27.
Status: draft. **No task starts before the human accepts the spec and the decisions D1–D6.**

## Rules for every task

- **Where.** Work only in `/Users/kalmbik61/parley/worktrees/my_harnas-00f205/w-0054-s-322`. Never touch the main checkout. One executor in the worktree at a time, unless the lead gives a task its own worktree and merges it.
- **Scope.** One task per executor. Do not widen the scope. Ask the lead in r-27 when the spec does not answer something.
- **Commits.** Commit into the branch with an English conventional message. Do not push.
- **Checks.** Before submit:
  - `pnpm --filter <touched packages> test`;
  - `pnpm typecheck`;
  - `pnpm lint` on touched files.
  - Report the counts.
- **Tests.** Every behaviour change has a test. No test runs a real installer, a real `update` or a real network fetch; use stubs and local servers.
- **Review.** The lead (or another senior model that did not write the code) reviews each task against its criteria before the next dependent task starts.
- **Seniority.** "Senior-only" tasks are implemented by a senior model, for the reason given (PARLEY.md).

## Order and dependencies

```
Part B:  B1 → B2 → B3 → B4(senior) → B5 → B6
Part A:  A1 → A2 → A3 → A4 → A5(senior) → A6 → A7 → A8 → A9
         (A2 needs A1; A4 needs A2, A3; A6 needs A3, A4; A8 needs A7 and B5)
Final:   V1 after all
```

- **Executors.** Parts A and B touch different files except `ProviderCard.tsx`/`ProvidersSettings.tsx` (B5 and A8) and `providers.ts` (A1, A3). They can run with two executors in parallel if capacity allows. Default is sequential: B first (smaller, independent of the spike), then A.
- **Models.** Executors: Claude Sonnet or Codex gpt-6.1-sol. Senior-only tasks: Claude Opus or Codex gpt-6-astra.

## Part B

### B1. CLI descriptor table (core)

**Scope.**
- New `packages/core/src/cli-tools.ts` with the table of spec §4.1 for `claude`, `codex`, `qwen`: latest-version source, `installMethod(realpath, home, fileExists)`, update plan per method, install plan per platform, expected install dir, smoke argv.
- `cli-updates.ts` takes its sources and method rules from the table; `CliUpdateProvider` gains `'qwen'`.
- Qwen latest source: `https://registry.npmjs.org/-/package/@qwen-code/qwen-code/dist-tags`, key `latest`.

**Files.** `packages/core/src/cli-tools.ts` (new), `packages/core/src/cli-updates.ts`, tests next to them.

**Criteria.**
1. Unit tests:
   - every method rule for qwen: npm realpath, standalone wrapper plus lib dir, Homebrew prefix, unknown;
   - claude and codex rules unchanged (the existing `cli-updates.test.ts` passes unmodified);
   - the qwen dist-tags fetch picks `latest` and ignores other tags;
   - the update plan: qwen npm → npm argv with `@qwen-code/qwen-code@latest`; qwen standalone → `[bin, 'update']`; brew/unknown → `manual` with the command text;
   - install plans are constant data (a snapshot test).
2. No host or renderer change.

### B2. Shared runner; update through the table (host)

**Scope.**
- Extract the process runner from `host/src/providers/update-run.ts` into `host/src/providers/cli-run.ts`. It keeps: group spawn, timeout, kill, tail, env scrub, per-CLI busy guard shared by update and install, stop on shutdown.
- `providers.update` runs the plan from B1:
  - a `manual` plan returns `{ok:false, manualCommand}` without running anything;
  - the qwen npm plan resolves `<prefix>/bin/npm` from the realpath, falling back to the PATH npm.
- `UPDATE_COMMANDS` includes qwen. Smoke per table.

**Files.** `packages/host/src/providers/cli-run.ts` (new), `update-run.ts`, `updates.ts`, `packages/host/src/methods/providers.ts`, tests.

**Criteria.**
1. All existing `update-run.test.ts` cases pass unchanged in meaning.
2. New stub-binary tests:
   - qwen standalone update;
   - qwen npm update (a stub `npm` receives exactly `install -g @qwen-code/qwen-code@latest`);
   - brew → manual, nothing spawned;
   - busy shared across two calls for the same CLI.

### B3. Status for every CLI and Check now (host + protocol)

**Scope.**
- `updates.ts`:
  - checks missing CLIs too;
  - stores `lastError`;
  - `checkOne(cmd, {force})` ignores the 20 h gate;
  - `status(cmd)` returns spec §4.3 `cli`.
- `providers.list` items for the three CLIs carry `cli`; `update` is unchanged.
- New method `providers.checkUpdates {provider}`: a forced version probe plus a latest fetch, at most one per CLI per 10 s, then broadcast `providers.changed`.
- Protocol schemas and tests. `providers.checkUpdates` and `providers.update` go into `REMOTE_FORBIDDEN`; update `packages/remote/test/frame-boundary.test.ts`. Not in `ISLAND_METHODS`.

**Files.**
- `packages/host/src/providers/updates.ts`, `packages/host/src/methods/providers.ts`, `packages/host/src/methods/index.ts`
- `packages/protocol/src/methods.ts`, `packages/protocol/src/types.ts`, `packages/protocol/src/remote/allowlist.ts`
- `packages/remote/test/frame-boundary.test.ts`
- tests

**Criteria.** Tests for:
1. each `state` value (missing, up-to-date, available, skipped, unknown with `lastError` on offline);
2. force bypassing the gate;
3. the 10 s limit;
4. a missing CLI getting `latest`;
5. schema round-trip;
6. remote-forbidden classification.

### B4. Install method (host). **Senior-only**

**Why senior-only.** It runs downloaded vendor code as the user and changes the host's PATH (security and the write boundary).

**Scope.** `providers.install {provider}` per spec §4.2, points 1–8:
- download then run;
- npm route with the Node engine check;
- PATH lookup in the expected dir, host PATH and `agentEnv` update, `pathNote`;
- version probe, smoke, `providers.changed`, latest re-check;
- host log with the SHA-256;
- `REMOTE_FORBIDDEN`, not in `ISLAND_METHODS`.
- Windows returns the manual command.

**Files.**
- `packages/host/src/providers/install-run.ts` (new), `cli-run.ts`
- `packages/host/src/methods/providers.ts`, `packages/host/src/methods/index.ts`, `packages/host/src/host.ts` (PATH update)
- `packages/protocol/src/methods.ts`, `packages/protocol/src/remote/allowlist.ts`
- tests

**Criteria.** Tests with a local HTTPS stub (self-signed CA passed to the fetcher in tests only) and stub interpreters, covering:
1. the success path;
2. an HTTP redirect refused;
3. a body over 1 MB refused;
4. a timeout kills the group;
5. a non-zero exit gives the tail and the manual command;
6. a binary found only in the expected dir gives `pathNote`, and the next launch finds it;
7. npm missing or Node too old fails before spawn;
8. busy shared with update;
9. no argv element comes from the request (a test passes extra fields and checks the argv).

No test reaches the real network.

### B5. Provider card: Install, status row, Check now (renderer)

**Scope.**
- `ProviderUpdateRow` is always drawn for an installed CLI, with the states of spec §4.3 and [Check now].
- `ProviderCard` for a missing CLI: "Not installed · latest X · [Install…] · [Copy command] · Guide", with a confirmation dialog showing the exact command, the source URL and the profile note. It also shows running, error (output tail, manual command) and done (`pathNote`).
- The status bar ↑ covers qwen. Strings go in `desktop/src/shared/strings.ts`.

**Files.**
- `packages/desktop/src/renderer/components/providers/ProviderUpdateRow.tsx`, `ProviderCard.tsx`, `provider-install.ts`
- `packages/desktop/src/renderer/components/settings/ProvidersSettings.tsx`, `packages/desktop/src/renderer/shell/StatusBar.tsx`, `packages/desktop/src/shared/strings.ts`
- tests

**Criteria.**
1. Component tests for every row state and the install flow: confirm, cancel, running, error, done with `pathNote`.
2. The existing `ProviderUpdateRow.test.tsx` and `ProviderCard.test.tsx` cases are updated, not deleted.
3. An e2e on stub binaries (`desktop/e2e/providers-connect.spec.ts`) clicks Check now and Update.

### B6. README and earlier-decision notes (docs)

**Scope.** Apply spec §4.4:
- the README "How it works" bullets;
- the `provider-install.ts` header;
- a dated "superseded by 2026-11-11 qwen/cli-install design" line under the old decision in `docs/specs/2026-10-02-providers-connect-design.md` §66;
- a CHANGELOG entry under Unreleased.

**Files.** `README.md`, `CHANGELOG.md`, `docs/specs/2026-10-02-providers-connect-design.md`, `provider-install.ts`.

**Criteria.** The text matches the spec; no other edits.

## Part A

### A1. Family foundation (refactor, no behaviour change)

**Scope.** Spec §3.2:
- `ProviderFamily = 'claude' | 'codex' | 'qwen'`; `codex` gets `family: 'codex'`; add the helper `providerFamily()`.
- Convert every site listed in spec §2.2 ("not codex → Claude"), and any other the executor finds, to explicit family checks with a neutral default. Exhaustive `switch` with `never` in new code.
- Widen the protocol `family` field and its readers: `protocol/src/methods.ts:455`, `core/src/mcp/provider-rows.ts`, `host/src/agent/providers-endpoint.ts`, `desktop/src/renderer/lib/feed-view.ts`, `desktop/src/renderer/components/AgentIcon.tsx`.
- No `qwen` entry yet.

**Files.** About 20 (the list in spec §2.2 plus the readers above), and tests.

**Criteria.**
1. The full suite passes: `pnpm test` and `pnpm typecheck`.
2. A new test table checks, for claude, codex, glm, a custom provider, a Claude account and a `providers.json` CLI, the family and the branch taken in log-index, hook-server, feed-service seeding, compaction, inline-mail and feed-view.
3. The commit message lists every converted site.
4. The lead reviews this before A2. A missed site here is the main risk of Part A.

### A2. Stub qwen and mock lab

**Scope.**
- `packages/host/test/stub-qwen-agent.mjs` and `packages/desktop/e2e/stub-qwen-agent.mjs`, modelled on the codex stubs. Each one:
  - reads `QWEN_CODE_SYSTEM_SETTINGS_PATH`;
  - fires the configured command and http hooks with the payloads of spec appendix A;
  - writes a transcript at `transcript_path`;
  - honours `--session-id`, `--resume` and `-i`.
- `tools/qwen-mock-lab/`: the OpenAI-compatible mock and a README with a one-line way to run a real `qwen` against it with a throwaway `QWEN_HOME`. Base it on the spike lab in the s-322 scratchpad (`spike/lab/mock.mjs`, `mcp.mjs`, `ptyrun.py`).
- Fixtures in `packages/core/src/feed/qwen/__fixtures__/`, copied from the spike's observed transcripts (`spike/home2/.qwen/projects/*/chats/*.jsonl`). Replace absolute paths and remove memory-snapshot text.

**Files.** The stubs, `tools/qwen-mock-lab/*` (new), fixtures.

**Criteria.**
1. The stubs run under node without network.
2. The mock lab README steps are executed once by the executor against real qwen 0.27.2 in its scratchpad; the transcript of that run is attached to the report.
3. The fixtures contain no absolute user paths and no memory text.

### A3. Registry entry and launch (core)

**Scope.** Spec §3.3:
- the `qwen` entry in `PROVIDERS`; `Provider` gains `'qwen'`;
- new `packages/core/src/work/qwen-settings-file.ts`: the standard system file as base, `mcpServers.parley` with trust, hooks, `tools.toolSearch.enabled: false`, `general.enableAutoUpdate: false`, memory switches per D6;
- `launch.ts`: the qwen branch, with the env var, the approval mode per D5, `-i` for the first prompt and resume args;
- `minVersion '0.27.2'`.

**Files.** `packages/core/src/providers.ts`, `packages/core/src/session-index.ts`, `packages/core/src/work/launch.ts`, `packages/core/src/work/qwen-settings-file.ts` (new), `packages/core/src/providers.test.ts` (registry keys), tests.

**Criteria.**
1. Unit tests: argv and env for new, resumed, workspace and non-workspace sessions; the settings file content, including a base system file merged and an unreadable base skipped with a warning; `--yolo` never present.
2. On the mock lab with real qwen, a session launched by this code:
   - connects Parley MCP with no prompt;
   - lists Parley tools directly (no `tool_search`);
   - its http and command hooks reach a test receiver.
   Record the run in the report.

### A4. Hooks, state and sign-in wait (host)

**Scope.** Spec §3.4, the hook mapping table and the sign-in wait:
- the qwen event set in `host/src/hooks/hook-server.ts`;
- mapping in `host/src/activity/activity-service.ts`;
- the stuck message for StopFailure in `core/src/work/stuck.ts` (`providerLabel`);
- context fill from Stop in `host/src/context/context-service.ts`.

**Files.** The files above and tests (using `stub-qwen-agent.mjs`).

**Criteria.** Tests:
1. busy on a non-empty UserPromptSubmit; the empty one is ignored;
2. idle on Stop;
3. waiting-for-human on `permission_prompt`;
4. stuck on StopFailure;
5. "waiting for sign-in" when SessionStart arrives with no `auth_success` and no prompt within the grace;
6. context fill from `context_usage`.

### A5. Mail and compaction typing for qwen (host). **Senior-only**

**Why senior-only.** It types into a live pty while the agent may be mid-turn (concurrency with wake, delivery and compaction).

**Scope.**
- The wake pointer is typed after Stop as one `text\r` write, through `host/src/pty/send.ts` / `type-and-submit.ts`, `host/src/wake/wake-service.ts` and `host/src/compaction/compaction-service.ts` (`/compress`).
- `host/src/hooks/inline-mail.ts` excludes qwen explicitly.
- `host/src/pty/process-monitor.ts` handles the qwen family.

**Criteria.**
1. Tests with the stub: a pointer typed only after Stop and never during a turn; compaction sends `/compress`; no inline-mail path for qwen.
2. On the mock lab with real qwen: a message to the session wakes it and starts a turn.

### A6. Transcript parser, Chat view, history (core + host + renderer)

**Scope.** Spec §3.5:
- `packages/core/src/feed/qwen/` (parser and tail apply);
- `host/src/feed/feed-service.ts` (seed and tail for qwen);
- `desktop/src/renderer/lib/feed-view.ts` (gate);
- discovery and index for `$QWEN_HOME/projects/*/chats/*.jsonl`: `core/src/session-indexer.ts`, `core/src/all-sessions.ts`, `host/src/activity/log-index.ts`, `core/src/work/metrics.ts`;
- resume and wake with `--resume`.

**Criteria.**
1. Parser tests on the A2 fixtures: user, assistant text, thinking, tool call (including the inner MCP name of `tool_call`), tool result (success and error), usage; `system` skipped; unknown types counted.
2. Feed-service test: tail of an appended transcript.
3. The sessions list shows a qwen session from the fixtures.
4. On the mock lab: the Chat view renders a real qwen run; a slept session resumes into the same transcript.

### A7. Sign-in state, models, roles (core + host)

**Scope.** Spec §3.6:
- new `packages/core/src/qwen/auth-state.ts`: reads only `security.auth.selectedType` and `model.name`; checks `oauth_creds.json` and `OPENAI_API_KEY` for presence; never logs content;
- `providers.list` exposes the state and the configured model;
- roles: `core/src/roles/catalog.ts` mismatch rule (native roles do not fit qwen), `core/src/roles/builtin.ts` `modelForTier` → null for qwen, `core/src/work/agents.ts` role delivery through `--append-system-prompt`, `core/src/work/role-choice.ts`.

**Criteria.**
1. Tests for each sign-in state.
2. A test that an `apiKey` field inside a fixture `settings.json` never appears in the output or the log.
3. Role tests: a built-in role on qwen launches with the role prompt; a native Claude role on qwen is refused with the catalog message.

### A8. Qwen card and preset rename (renderer)

**Scope.**
- Qwen Code card in Settings → Providers (`CORE_IDS`) with sign-in state text, model field (Default or typed id) and the B5 rows;
- `AgentIcon` with a qwen asset;
- the status bar segment;
- the new-session dialog lists qwen;
- the preset label "Qwen models in Claude Code (Alibaba key)" in `custom-presets.ts`, with the id unchanged;
- strings.

**Files.**
- `packages/desktop/src/renderer/components/settings/ProvidersSettings.tsx`
- `packages/desktop/src/renderer/components/providers/ProviderCard.tsx`, `custom-presets.ts`
- `packages/desktop/src/renderer/components/AgentIcon.tsx`, `packages/desktop/src/renderer/assets/providers/qwen*.svg`
- `packages/desktop/src/renderer/shell/StatusBar.tsx`, `packages/desktop/src/shared/strings.ts`
- tests

**Criteria.**
1. Component tests for each sign-in state.
2. The new-session dialog test includes qwen.
3. The preset test checks the new label and the unchanged id.
4. The icon asset is an original simple mark, not Alibaba's logo, unless the existing vendor-icon policy says otherwise; check `docs/` for the vendor-icons decision first.

### A9. Guidance and docs for qwen (docs)

**Scope.**
- README: providers list.
- `docs/` user guide for providers (if one exists): Qwen Code, how to sign in (/auth in the terminal), what v1 excludes.
- CHANGELOG.

**Criteria.** The text matches the spec.

## V1. Verification (verifier on a junior model, then the lead's review)

Run spec §8 end to end on the branch head:
- all package tests and typecheck;
- the mock lab with real qwen 0.27.2: every §8 bullet, with evidence (commands, logs, screenshots of the card states and the Chat view through Parley's browser panel or the app);
- one real `providers.install` for qwen into a scratch `HOME` (only with the human's go-ahead at that moment, because it downloads and runs the vendor installer).

Result:
- pass / fail / not verified per §8 bullet;
- the "Not verified" list of spec §8 restated as facts.

The lead then writes the completion summary with the impact card.
