# Kimi launch modes — browser fixture

This fixture uses the production launch-row editor and Kimi Chat configuration
menu with the desktop stylesheet. It advertises the Kimi launch capability and
handles only fake Kimi configuration calls. It cannot launch a session, reach a
provider, or change real settings.

From the repository root after installing the workspace dependencies:

```sh
pnpm --filter '@parley/desktop^...' build
pnpm --filter @parley/desktop exec vite build --config e2e/fixtures/kimi-launch-modes/vite.config.mts
pnpm --filter @parley/desktop exec vite preview --config e2e/fixtures/kimi-launch-modes/vite.config.mts
```

Open `http://127.0.0.1:5417/` in the Parley browser. The launch picker starts at
**Use Kimi settings**. Its output previews the selected creation preference or
shows that the field would be omitted. The Chat menu starts from a mocked
unverified `default` snapshot and records changes below the menu, including
**Always Ask** and **Plan**. Press Ctrl-C in the preview shell to stop serving.
