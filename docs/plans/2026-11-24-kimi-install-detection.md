# Kimi Code in provider settings

The desktop host can start with a PATH that omits the official standalone installation. On macOS, Kimi Code 2.7.3 was found at `~/.kimi-code/bin/kimi`. The missing-CLI card currently presents two actions that reload the provider list.

1. **Host and discovery** — In core's binary resolver and CLI installation descriptors, the host's installation dispatch and relevant protocol contracts, support the official Kimi installer through the existing install flow. Keep explicit overrides and PATH precedence, with the official installed executable as the fallback. Use the vendor's shell installer at `https://code.kimi.com/kimi-code/install.sh` on Unix and the documented manual command on Windows. Retain the existing isolation and confirmation boundary. Acceptance requires regression coverage for desktop-style PATH, install dispatch and separation of missing CLI from authentication.
2. **Desktop** — In the provider card, install metadata and localized strings, expose the existing Install confirmation for missing Kimi when the host supports it. Retain the guide as fallback, retain login guidance and use one Check again action. Cover the missing, installed and sign-in states, with tests for the install confirmation and refresh. Use the same command and source as the host.

Verify the combined change with focused tests, type checks and a read-only probe of the installed CLI under a minimal PATH. External installation and account changes are outside the verification scope.
