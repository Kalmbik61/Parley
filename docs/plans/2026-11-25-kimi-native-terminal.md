# T4 — ordinary native Kimi Terminal

Accepted for the combined T1/T2/probe candidate d8cbe978. Chat is read-only while Terminal owns the conversation. The island opens native prompts in Terminal. Returning ownership restores managed Chat. Native Kimi is ordinary installed Kimi without Parley room/plan MCP tools, plugin or managed rule injection. Managed tools and rules return with ACP. The [stock probe](2026-11-25-kimi-native-handoff-probe.md) proved exact-ID round-trip, actual process exits, native keys and resize. The experimental managed-plugin authority is not part of T4.

## Ownership and lifecycle

- Bootstrap new conversations in ACP, preserving T2 launch choice and one initial brief. Viewing a tab or reloading never claims ownership.
- Explicit takeover holds the existing session lifecycle lock and resource accounting. Require known idle ACP, with no turn, approval, elicitation, delivery, scheduled wake, or unsent Chat/Terminal draft. Preserve content on refusal. Reject another ref bound to the same provider ID and Kimi home.
- Block Chat sends, config, choices and wake/delivery during transitions and native ownership. Preserve queued mail without sending it to the PTY. Raw terminal keys and resize use existing PTY transport. Fence callbacks and requests by process generation.
- Await outgoing process exit before starting a successor. Start installed Kimi with only the exact original `--session` ID, original cwd/home and sanitized ordinary environment. Honor provider locks and durable mode, with no resume override, ID discovery, config copy, global plugin or Parley grant.
- Require human `/exit` before returning from a running native process. Reopen managed ACP with the originally bound ID, even after native `/new` or another ID in the same terminal. Explain this at the controls. A crash or interrupted handoff leaves a durable recoverable state and never wakes ACP automatically.
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

The stock run resumed an unseeded ACP ID in native Kimi. A second session retained **Ask When Needed** without resume flags, as verified by Kimi's native `/status`. At ACP load, Kimi still reported `default` in its initial config snapshot, as described in T2. An inert ephemeral MCP server launched in ACP, did not launch in native mode, and launched on ACP handback. The original ACP and native turns replayed once each. No turn from native `/new` entered the original replay. The test sent three model requests, all to loopback. See [Kimi's native command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/slash-commands.html) for the status and session commands.

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

Open `http://127.0.0.1:4658/e2e/fixtures/kimi-native-terminal.html`. The Terminal tab has an explicit takeover button. While native owns the fixture, the island row opens Terminal and Chat shows its retained transcript and no composer. The fixture responds to native `/help` and `/exit` input. Return to Chat restores the composer and settings. Presets for screenshots are `?view=terminal` before takeover, `?owner=terminal` for read-only Chat, `?owner=terminal&view=terminal` for the native PTY, and `?owner=exited&view=terminal` after exit.

## Impact card

- **Goal** — Make ordinary Kimi Terminal available without letting it share the conversation with managed Chat.
- **Behaviour** — Takeover and return are explicit. Native gets the original ID and cwd with no Parley-managed authority. A live native process must exit before handback. Parley mail waits. Recovery retains the original binding, and handback refreshes Chat from a complete, bounded ACP replay.
- **Numbers** — 1,161 focused checks passed (89 host, 455 desktop, 101 protocol, 516 core). The installed 2.7.3 probe passed with 3 loopback model requests, 0 external or paid requests, and no plugin installation.
- **Screens** — Parley browser, 1120 × 530. [Takeover](../../packages/desktop/e2e/fixtures/kimi-native-takeover.png), [read-only Chat and island](../../packages/desktop/e2e/fixtures/kimi-native-read-only.png), [native Terminal](../../packages/desktop/e2e/fixtures/kimi-native-terminal.png), [return control](../../packages/desktop/e2e/fixtures/kimi-native-return.png), [restored Chat](../../packages/desktop/e2e/fixtures/kimi-native-restored.png).
- **For the human** — Open Terminal and select **Take control in Terminal**. Use Kimi normally, then type `/exit` and select **Return to Chat**. A native `/new` does not rebind Parley.
- **Risk** — Handback requires ACP `session/load`. Failure or replay beyond the explicit limits leaves Chat unchanged and a recoverable stopped state. The preserved pre-handoff feed is under the work's `kimi-history/<session-id>/<archive-id>.json`. Repeated handoffs keep separate archived views.
- **Cost** — Zero paid calls. Production latency and archive growth were not measured.
- **Verdict** — The fixture and stock CLI establish exact-ID ownership transfer, provider-owned mode, no native MCP attachment, and restored Chat. The live app and user configuration were not changed.

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
