# Kimi shared native PTY

Accepted production spec from room r-45, messages m-10429 and m-10430. Source base includes `1e31045d` and the stock native/direct MCP probe through `069f6fae`. This task owns core and host. The sibling desktop task owns the shared capability constant `KIMI_SHARED_TERMINAL_FEATURE = 'kimi-shared-terminal'` and renderer changes. No live config, installation, app restart, account prompt, or provider outside Codex/Qwen/Kimi is in scope.

## Product and registration

- Run one stock native Kimi PTY throughout its live lifetime. Chat and Terminal are two views of the same process. They do not take over, return, or restart the provider. Keep manual/yolo/auto launch choice, same-ID resume, authenticated same-process `/new` rebind, history, drafts, and queued mail.
- Add an ordinary user-level Kimi `mcp.json` entry named `parley`, matching the prior ACP tool names. Use the existing launch-scoped Parley MCP route and credentials. Support the original Kimi home and cwd, including sessions without a worktree. Keep all other entries, surface a foreign-name collision, and store no per-session secret in the global registration. Ordinary unbound Kimi receives no tools or authority. Implement and verify setup and cleanup only in disposable homes for this task. Agreement m-10442 chooses documented additive user-level `[[hooks]]` in `config.toml`, preserving existing lines, order, and comments. No plugin registration or installer. The hook process makes no request or rules injection without the current launch credentials. Keep trust and native manual permissions authoritative.

## Core and host implementation

- **Lifecycle** — `packages/core/src/work/launch.ts`, host session service, host wiring and the PTY manager use the native process directly. ACP may remain for catalog/auth, never as a parallel conversation runner. Keep generation fencing for raw keys and resize. Advertise shared terminal capability only for the native host path. Do not expose dead ACP config controls. First native launch reads/migrates the legacy terminal/archive/checkpoint safely, keeping the bound conversation and prior feed evidence without a user ownership step. A same-launch `/new` authenticates and rebinds the provider ID under the same Parley ref and settles old request cards.
- **Input** — Reuse `pty.send`/`type-and-submit`, draft revisions, single pending Enter, generation and wake locks. Require a current native composer, idle state, no blocking dialog, and MCP readiness. `SessionStart` may only arrive after the first prompt. A first send must proceed when independently ready but never answer trust or login. Recheck before Return, preserve drafts on refusal/race, and send wake/mail through the same gate. Keep raw Terminal input on the same PTY.
- **Feed** — Read complete JSONL records incrementally and bound the reader to the exact home/cwd/active ID. Do not guess using latest files. Project user-origin `append_message` and closed `content.part` once, tool calls/results, request/resolved, turn status and compact markers. Hooks supply activity and mail, not duplicate messages. Handle replay/resume, partial UTF-8 and lines, truncation/replacement, `/new`, undo/clear/compaction. Preserve prior human history with a visible bounded limitation on an unsupported projection. Do not synthesize tokens while a block remains open.
- **Decisions** — Match the actual wire request ID and current launch generation to a fresh native screen fingerprint. Offer only exact CLI labels, order and options. Revalidate before driving keys and never send a blind fixed approval key. Drive the question select/review steps only if the shape is recognized. Unsupported or stale shapes open Terminal without invented Allow/Deny. Chat, island and raw Terminal settle the same request once.

## Acceptance

Add failing regressions before implementation. Check one PID across views, both input paths on that ID and exact-once history, native `/help` and resize, old-ID resume with migration, `/new` rebind to the same Parley ref, bounded feed, every observed permission option with stale/double refusal, input/draft/wake races, and manual/auto launch preservation. A stock Kimi 2.7.3 loopback fixture must exercise the production host components, including a genuine native `get_map` on the correct disposable Parley ref and no authority for an unbound launch. Run scoped checks/build. Commit locally only. Root integrates the desktop sibling and reviews the combined branch.

## Integrated verification

From the repository root after building core, protocol, and host:

```sh
PARLEY_KIMI_SHARED_HOST_BIN=/Users/kalmbik61/.kimi-code/bin/kimi pnpm --filter @parley/host exec vitest run src/kimi/shared-native-host.probe.test.ts
```

The test uses the production host RPC, PTY manager, authenticated hook and tool routes, and feed. It binds only the disposable model and host loopback ports, denies stock Kimi access to the real home, and accepts only the disposable folder's trust prompt. It does not opt into experimental flags or send a dummy turn. The production test replaces the preceding host-level exclusive ownership probe. The stand-alone provider probe and low-level ACP tests remain independently runnable.

- A cold Chat send and a raw Terminal send reached the same provider ID and PID. Compatibility view calls did not change the process or generation. A genuine native `/help` painted ANSI output and resize preserved the generation. A raw input stamped with the previous process's generation was ignored after exact resume.
- Explicit *Always Ask* was selected and confirmed on the native menu before the first prompt, despite the disposable account defaulting to `auto`. The same default remained in the configuration after selection. The exact resume preserved the native session permission mode. The launch tests separately check `--yolo` and `--auto`.
- A raw draft blocked Chat. Queued mail waited, then was delivered by the existing guarded sender after the composer repainted empty. The model received the inline letter and the host projected the turn once.
- The legacy terminal marker was interpreted as a binding and archive, not as a request to switch processes. Native resume kept the old provider ID and archive evidence while replacing the process. A later user `/new` changed the provider ID on the same live PID and Parley ref. The archive remains tied to the original provider ID.
- A real resumed native `get_map` reached the authenticated host route and returned the exact disposable work and session. The island and Chat decision route offered the stock choices in native order. One-use approval, reject, and session approval drove the visible menu. A repeat click did not send a second command. Reject with feedback opened the native feedback editor, and the text was entered in Terminal. A single-choice native question was selected and submitted only after the exact review pane matched. Unrecognized menus or question shapes use Terminal.
- A fresh unbound Kimi process with the same `mcp.json` and hook configuration did not expose Parley tools. Neither managed global file contains launch credentials. The guarded bridge itself does not send a request without a bound launch.

### Provider limitation

The production catalog is not the tiny direct-MCP fixture. On cold stock 2.7.3, the real registration discovered **50 Parley tools** and `tool_select.initialized` contained **76 tools including get_map**, but the model request carried **24 built-ins** and omitted the Parley catalog. This reproduced both with explicit session Manual selection over an automatic default and with an already-manual default. Non-deferred registration and standard tool-use capability were set. Exact native resume after genuine turns advertised all **74** applicable tools and the fixture called the real advertised `mcp__parley__get_map`. No hidden `/new`, forced restart, reduced catalog, or provider-compaction patch is used. A listed MCP transport is one part of native input readiness, not a guarantee of what the provider will advertise in its cold model request.

### Impact card

- **Goal** — Give Kimi one live native process for Chat and Terminal.
- **Behaviour** — Native launch/resume, two views, scoped registration, main-wire Chat, native decisions, queued mail and same-process ID evolution. Unsupported wire/screen shapes retain earlier human evidence and use the native Terminal.
- **Numbers** — Stock production host probe exercised 15 loopback model requests. Cold catalog and exact-resume counts above. Zero paid or external model requests. Passed 510 core, 565 protocol, 302 scoped host, and 415 merged desktop checks. A final run of the stock host, screen and wire suites passed all 9 checks after the last shape refinements.
- **Screens** — Native trust, Always Ask, help, resize, permission choices, feedback editor and question review were observed in disposable PTYs. Desktop view behavior is from the independently accepted UI merge.
- **For the human** — No live configuration, app install, restart, account prompt, REA change, or provider-compaction patch was applied.
- **Risk** — Kimi can omit the full catalog on a cold turn even after successful discovery. Screen controls are intentionally limited to recognized stock English layouts. The native wire exposes completed blocks, not token-by-token output. User config collisions stop setup without replacing foreign entries.
- **Cost** — No paid model requests. Production overhead not measured.
- **Verdict** — Stock native input, history, authentication and tested decisions work through the production host. Cold full-catalog advertisement remains a provider limitation.

**Not verified** — Live-account deployment, non-English layouts, model profiles other than the synthetic OpenAI route, and the provider's full catalog on a cold first turn. The room excluded REA and changes to the provider's compaction behavior.
