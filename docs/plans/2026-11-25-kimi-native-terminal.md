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
