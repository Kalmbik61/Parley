# Kimi Chat and Terminal as shared views

Source base: `1e31045dace781de95026c762f1425a67744b54e`.

## T-UI — Desktop compatibility

Chat and Terminal are views of one live native Kimi PTY. Peers own the host and advertise `kimi-shared-terminal` only when the native PTY runs throughout the session and accepts Chat's ordinary `pty.send`. This task adds only the protocol feature constant and adapts the desktop renderer.

- On a shared Kimi host, changing views never calls `kimi.getControl` or `kimi.setControl`, changes the owner, or starts or stops a process. Terminal shows the native surface directly without the legacy Take Over, Return to Chat, or read-only banner. Raw input and resize retain the existing `kimi-pty-generation` requirement.
- Chat composer, resend and outbox use their ordinary behavior, including busy, draft and approval rules. Persisted `kimiTerminal` markers from old hosts must not block these paths, hide supported island requests, or produce a false native-only status.
- Preserve the provider's exact permission options. An unknown/native modal offers Open Terminal without writing fallback keys. Preserve launch permission choices and existing capability checks. A shared host need not advertise `kimi.setConfig`, and Chat must not offer unavailable ACP configuration controls.
- Hosts without the shared feature keep the ownership-based behavior. Other providers are unchanged.

Scope: one protocol feature constant and its re-export, renderer Chat, Terminal and Island, focused tests, and a browser fixture. The lead approved narrow IslandApp wiring to pass the negotiated flag to the island model and requests, and the tab gate accepting the shared feature plus `feed.snapshot` without requiring `kimi.getState`. Do not change host code or run live providers.

Acceptance: demonstrate a failing then passing regression for both views of one session with a stale marker. Verify no ownership RPC on tab changes, normal composer and outbox, visible raw terminal with generation, exact permission options, Open Terminal for an unknown prompt, and legacy-host compatibility. Run focused desktop/protocol tests and relevant typecheck/build. Capture production components in Parley's browser with a synthetic host fixture. Commit locally for review.

## Browser fixture

Serve the desktop package with the [isolated Vite command for desktop fixtures](2026-11-25-kimi-native-terminal.md#reproduce) and open `/e2e/fixtures/kimi-shared-views.html`. The fixture mounts the production tab body and Terminal surface with one fake session and a stale ownership marker. Use `?view=terminal`, `?prompt=permission`, or `?prompt=native` to open a specific state directly. The fixture never starts a provider.
