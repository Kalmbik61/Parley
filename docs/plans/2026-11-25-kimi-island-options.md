# T1 — Kimi permission options in the island

Base: `c5592604` (0.39.1). Scope: `packages/desktop/src/renderer/island/IslandView.tsx`, `requests.ts`, their focused tests and an isolated UI fixture. Native Terminal integration and launch modes are separate tasks.

## Cause and contract

The island's `Actions` renders generic Allow/Deny and ignores `card.permissionOptions`. The Kimi host resolver in `feed/kimi-interactions.ts` requires a matching `decision.optionId`. Chat's `PermissionCard.tsx` already renders provider-supplied options and maps their kinds to allow or deny.

## Acceptance

- Render each supplied option in exact provider order and with its exact name. Send its exact `optionId` and the allow/deny kind derived from the provider kind. Preserve session-only approval semantics. Do not infer permanent approval.
- Preserve the existing arm and deciding guards. Only an absent options field uses generic Allow/Deny. An empty options array offers no generic decision buttons.
- Include option identity, name, kind, order and preview in request identity alongside the existing truncation rules. Changed content on the same card replaces stale choices, re-arms decisions and prevents late responses from affecting the new request.
- Write focused tests before implementation for the three Kimi decisions and their exact payloads, generic fallback, same-card refresh and stale responses, and arming and duplicate-send guards.
- Run focused desktop tests and desktop typecheck. Reproduce three long labels in an isolated UI fixture and capture layout evidence without answering a live approval or restarting the app.

## Isolated layout fixture

The [fixture](../../packages/desktop/e2e/fixtures/kimi-island-options.html) renders the production `IslandView` and its styles with inert callbacks. It has no host bridge and cannot submit a permission.

From the repository root after installing dependencies:

```sh
pnpm --filter '@parley/desktop^...' build
cd packages/desktop
pnpm exec node --input-type=module -e '
  import { createServer } from "vite";
  import react from "@vitejs/plugin-react";
  import tailwindcss from "@tailwindcss/vite";
  const server = await createServer({
    configFile: false,
    plugins: [react(), tailwindcss()],
    server: { host: "127.0.0.1", port: 4652, strictPort: true },
  });
  await server.listen();
  server.printUrls();
'
```

Open `http://127.0.0.1:4652/e2e/fixtures/kimi-island-options.html` at a 480 × 520 CSS pixel viewport (the native island frame). All three labels should wrap inside the 440 px card and become enabled after the normal arming delay.

The [480 × 520 capture](../../packages/desktop/e2e/fixtures/kimi-island-options.png) shows all three labels at two lines each. In headless Chrome, every text line fit inside its button, every button fit inside the island, and the fixture reported no page errors.
