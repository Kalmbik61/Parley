# @parley/relay

Relay v1 for the Parley mobile app: it keeps the bridge's control connection per route, lets in only the devices
the bridge registered, and splices two WebSockets into a pipe. It never sees or stores message content (that is
Noise, end to end). Spec: `docs/specs/2026-10-29-mobile-app-design.md` §6.

- `/v1/host` (bridge control), `/v1/accept` (bridge stream), `/v1/connect` (phone), `GET /v1/health`.
- State: a JSON file (`DATA_FILE`, default `./data/relay.json`, mode 0600, atomic write) with the sha256 of each
  route secret and of each device token. Writes are deferred by 1 s and flushed on stop; a crash loses at most that
  second, which the bridge restores with its next `hello` and `devices`. Offers and streams live in memory.
- Routes are collected hourly: a route without devices whose bridge has been away for 24 h, and any route whose
  bridge has been away for 30 days. A returning bridge recreates its route with the same `hello`. A route collected
  with devices leaves a tombstone for a year: until then only its old secret can recreate it, because phones and
  the push gateway know the route id.
- At most 10 000 routes. When the table is full, a new route evicts the least recently seen route without an
  attached bridge, routes without devices first. An evicted route with devices leaves the same tombstone, so its
  bridge recreates it with its next `hello` and resends `devices`. Routes with an attached bridge are never
  evicted; if every route has one, `rate_limited`.
- Limits per client address (IPv6: per /64; `::ffff:` mapped addresses count as IPv4): at most 32 open
  connections (upgrades included, beyond that HTTP 429), plus the frame limits of spec §6.4. The first frame on a
  new socket must arrive within 5 s. Everyone behind one carrier-grade NAT or one shared /64 shares these limits;
  that is fine for a personal relay, a public one would need a higher cap.
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
