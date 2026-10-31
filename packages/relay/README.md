# @parley/relay

Relay v1 for the Parley mobile app: it keeps the bridge's control connection per route, lets in only the devices
the bridge registered, and splices two WebSockets into a pipe. It never sees or stores message content (that is
Noise, end to end). Spec: `docs/specs/2026-10-29-mobile-app-design.md` §6.

- `/v1/host` (bridge control), `/v1/accept` (bridge stream), `/v1/connect` (phone), `GET /v1/health`.
- State: a JSON file (`DATA_FILE`, default `./data/relay.json`, mode 0600, atomic write) with the sha256 of each
  route secret and of each device token. Offers and streams live in memory.
- Config (environment): `PORT` (8787), `HOST` (`127.0.0.1`), `DATA_FILE`, `TRUST_PROXY=1` (client IP = last
  `x-forwarded-for` entry; only behind a proxy).

## Local dev-relay (no TLS, development only)

```
pnpm --filter @parley/relay dev
```

Listens on the Mac's LAN address and prints `ws://<IP>:<port>` for the Relay field in Settings. State is in memory
unless `DATA_FILE` is set. Over plain `ws://` the route secret and device tokens cross the LAN in clear text.

## Server

Build the image from the repository root and start it with Caddy:

```
docker buildx build --platform linux/amd64,linux/arm64 -f packages/relay/Dockerfile -t parley-relay .
cd packages/relay/deploy && RELAY_DOMAIN=relay.example.com docker compose up -d
```
