# T3 — stock Kimi native handoff probe

The accepted product direction is exclusive ownership of one provider conversation. Chat is read-only while native Terminal owns it, the island opens native prompts in Terminal, and returning ownership restores Chat controls. This task tests the provider boundary only. It does not change Chat, the island, launch modes, or production authority.

## Scope and acceptance

1. Use only stock Kimi at `/Users/kalmbik61/.kimi-code/bin/kimi`, version 2.7.3. Start with empty temporary HOME, Kimi home, Parley home and cwd. Use an allowlisted environment, synthetic model credentials, a loopback OpenAI streaming fixture, and disabled updates and telemetry. Do not read real configuration or auth, use external model services, or change live provider/Parley state. Any install or trust interaction must be confined to the inert fixture.
2. Use Kimi's supported local plugin installation. Its one inert stdio MCP tool and UserPromptSubmit hook carry no static session grant. Record the actual prefixed tool name and confirm a per-launch expected provider ID and generation. ACP ephemeral MCP is not a native attachment mechanism. `--agent-file` conflicts with `--session` and there is no supported `--attach` shortcut.
3. Start ACP, allocate and seed a provider session, close it and await process exit. Resume that exact ID and cwd in stock Kimi through node-pty and headless xterm. Capture bounded screens around a real slash command, Escape and a resize. Submit a native prompt, verify ACP history and bound rules/tool at the model fixture, close and await native exit, then load that exact ID in fresh ACP and assert both turns replay once. Record mutually exclusive owners.
4. Test a second ID in the same cwd, an unbound native launch, a native `/new` or session switch, and a revoked launch generation. Use actual UserPromptSubmit/PreToolUse session IDs. Parent environment and cwd are not provider identity, and tools/call has no session ID. Report presentation/history separately from isolation. Fixture success never enables production authority.
5. Hand in the opt-in command, version, owner timeline, bounded screens, rules/tool and replay evidence, request counts, and isolation results. A mock terminal or direct hook invocation is not a substitute. The task ends with evidence or a reproducible blocker. Commit only this plan and the probe/fixtures after checks.

```sh
PARLEY_KIMI_PROBE_BIN=/Users/kalmbik61/.kimi-code/bin/kimi pnpm --filter @parley/host exec vitest run src/kimi/native-handoff.probe.test.ts
```

Run from the repository root on macOS with the workspace dependencies installed. Both cases skip without the exact opt-in path. The runner needs permission to bind a loopback port and allocate a PTY. Each case starts with fresh temporary directories and a separate Seatbelt profile that permits outbound connections only to that case's `localhost` port and blocks data reads and writes under the real home except reads of the Kimi and Node executables. The probe accepts only the empty fixture directory's trust prompt, the exact copied local plugin's installation prompt, and the fixture tool's **Approve once** prompt. It neither starts Parley nor approves anything in a live session.

## Observed on Kimi 2.7.3

- **Handoff works.** In both cases, ACP created A and seeded a prompt and reply. It closed and exited before a native PTY resumed the exact ID. The native model request contained the original ACP prompt and reply plus `RULES_A` from `UserPromptSubmit`. A fresh ACP loaded the same ID after native exit and replayed both user prompts and both replies exactly once.
- **Default OpenAI settings do not expose a callable fixture schema for the ACP-origin session.** The native screen showed a connected stdio server with one tool. Kimi's model input announced the qualified name in history as a runtime addition, but `tools[]` had no fixture schema and `select_tools` was unavailable.
- **Experimental tool selection made the fixture callable.** With `KIMI_CODE_EXPERIMENTAL_TOOL_SELECT=1` and the synthetic model declaring `tool_use,dynamically_loaded_tools`, the stub received the announcement for `mcp__plugin-parley-handoff-probe_fixture__handoff_probe`. It called `select_tools`, received `Loaded`, and called only that exact tool through Kimi's native approval prompt. OpenAI `tools[]` still lacked the fixture schema on the resumed ACP-origin A and B conversations. The controlled stub knew to send `{}` and received `RESULT_A` and `RESULT_B`. A and B used the same cwd, but each request received only its own rules and result. The `PreToolUse` hook recorded the corresponding provider IDs.
- **Execution stopped after revocation, but full isolation failed.** B's `/new` produced distinct C in the same process, and its `SessionStart` revoked B's generation. C received neither B's prompt history, rules, nor tool result, yet C's `tools[]` still contained B's stale tool description `TOOL_B`. Real `PreToolUse` blocked the stale call before stdio. Explicitly revoking the fresh A2 generation also blocked the real call before stdio and injected no A2 rules. Previously delivered `RULES_A` remained in the original A conversation's history. A separate unbound launch received no fixture announcement, schema, rules, or result and did not contact the fixture rendezvous.

The harness treats the stale description as a pinned 2.7.3 observation. A passing probe does not imply that authority is safe to enable. A version or behavior change that removes this observation fails that assertion so the finding can be revisited.

### Bounded evidence

The runner prints the redacted PTY viewports and owner timeline. The focused run made 3 streaming requests with default settings and 13 with experimental tool selection. Both were local, with zero rejected requests. The only two successful MCP calls returned synthetic markers.

| Case | Owner / provider ID sequence |
| --- | --- |
| Both | A ACP seed exits → A native exits → A fresh ACP load exits. B is also seeded and closed in the same cwd before native starts. |
| Experimental | B native → `/new` changes provider ID to C in the same process → C native exits. A resumes separately under generation A2 and exits after the revoked call. D is a fresh unbound native process. |

```text
116×30  Welcome to Kimi Code!     Session: session_A
        ❯ PROBE_PROMPT_ACP_A     ● PROBE_REPLY_ACP_A
116×30  help · Esc / Enter / q to cancel · ↑↓ scroll
        Keyboard shortcuts       Slash commands
 92×24  Session: session_A       Model: parley-offline-fixture
        ❯ PROBE_PROMPT_ACP_A     ● PROBE_REPLY_ACP_A
        │ >                     │   (composer restored after Escape)
```

This probe uses the stock [local plugin flow](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html), [lifecycle hooks](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html), and [terminal controls](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/keyboard).

## Impact card

- **Goal** — Establish whether the provider can hand back the same conversation and keep native authority scoped.
- **Behaviour** — Exact-ID ACP ↔ native handoff and replay worked. The fixture could be called only in the experimental tool-selection case, and its stale description reached a different session after `/new`.
- **Numbers** — 2 opt-in cases, 16 accepted loopback model requests in total, 2 successful inert calls, 2 stale calls blocked before stdio, 0 overlapping owners in the harness, 0 paid or external model requests.
- **Screens** — Bounded 116×30 view, `/help`, Escape, 92×24 repaint. Redacted samples above.
- **For the human** — The probe changed no production code, live configuration, Chat controls, island buttons, or launch behavior.
- **Risk** — Kimi can retain model-visible session-specific tool descriptions across `/new`. The temporary file lease and hooks are fixture mechanisms, and hooks are documented to fail open on execution errors.
- **Cost** — No paid turns or live setup. Production effort and performance were not measured.
- **Verdict** — Provider presentation and history proved. End-to-end production isolation not proved; keep production authority disabled.

**Not verified** — Real Parley MCP, real model/provider variants, desktop read-only and island behavior, and production-grade authentication, revocation races, or recovery. The only tool was the inert fixture.
