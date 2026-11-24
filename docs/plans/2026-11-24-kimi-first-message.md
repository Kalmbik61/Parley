# Kimi first message and recovery

The reported S32 session was recorded active and got a Kimi session ID in 548 ms. The native wire history contains initialization metadata and MCP discovery, but no user prompt. The desktop showed Not sent.

1. Trace live session ownership, starting, sending and unexpected process exit in host Kimi ACP, PTY registration and Chat outbox. Identify a reproducible defect, add the smallest targeted regression, fix it and verify delivery or recoverability. Check failures before/after process registration and distinguish an unsent prompt from a provider turn failure. Preserve genuine user drafts and avoid automatic replay of potentially delivered messages.
2. Independently reproduce the desktop path in an isolated Electron window with the real Kimi 2.7.3 CLI and a loopback model endpoint. Send the reported short Cyrillic text and check for a visible reply. Verify resumed sessions where diagnosis warrants. Inspect only targeted session metadata for the reported incident. Avoid billing or modifying the user's live chat during testing.
