# @parley/relay

Relay v1 for the Parley mobile app (see "Remote access (mobile)" in the repository README for what the feature does and does not do): it keeps the bridge's control connection per route, lets in only the devices
the bridge registered, and splices two WebSockets into a pipe. It never sees or stores message content (that is
Noise, end to end). Spec: `docs/specs/2026-10-29-mobile-app-design.md` §6.

**One relay per user.** There is no shared relay: you run your own, on your own server, and put its address into
Parley (Settings → Remote access → Relay on the Mac; the address travels to the phone in the pairing QR code, the
phone never asks for it). A route is one Mac; a route serves at most 5 paired phones.

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

> **No TLS.** Plain `ws://` only, for development on one Wi-Fi network. The message content is still end-to-end
> encrypted, but the route secret and the device tokens cross the network in clear text, so a neighbour on the same
> Wi-Fi can take the route over (denial of service, not access to your Mac). Do not use it for real work.

It listens on the Mac's LAN address and prints `ws://<IP>:<port>` for the Relay field in Settings → Remote access
(the window marks such an address "Local dev relay, no TLS"). State is in memory unless `DATA_FILE` is set. Only
developer builds of the app accept it: a release build refuses a QR code with a private address and connects over
`wss://` only. The relay is not part of Parley.app; the window and the bridge never start it.

## Server

You need a Linux server with Docker and Compose, ports 80 and 443 open, and a domain pointing at it (Caddy gets
the certificate from Let's Encrypt on the first start). TLS is required: iOS refuses a relay without a valid
certificate, so there is no self-signed option.

### Manual install (the verified path)

Build the image from the repository root and start it with Caddy:

```
docker buildx build --platform linux/amd64,linux/arm64 -f packages/relay/Dockerfile -t parley-relay .
cd packages/relay/deploy && RELAY_DOMAIN=relay.example.com docker compose up -d
curl https://relay.example.com/v1/health
```

`compose.yml` keeps the relay's own port off the host (only Caddy publishes 80 and 443) and sets `TRUST_PROXY=1`
for it; the state lives in the `relay-data` volume (`/data/relay.json`). If you build the image on another machine,
copy it to the server (`docker save` / `docker load`) and keep the name `parley-relay`, or edit `image:` in
`compose.yml`. Then enter `relay.example.com` (host, optionally `:port`, no scheme) in Settings → Remote access →
Relay and press Check. Moving to another relay means pairing the phones again and revoking the old entries under
Devices.

If something already holds ports 80 or 443, run the relay behind your existing reverse proxy instead of Caddy: bind
it to `127.0.0.1:8787`, pass WebSocket upgrades (`Upgrade` and `Connection` headers) under `/v1/`, use timeouts
longer than 60 s and set `TRUST_PROXY=1`.

### Setup wizard (planned, not available yet)

Settings → Remote access → "Set up on my server…" is meant to do the steps above over SSH from the Parley window on
the Mac (the bridge knows nothing about SSH). **The wizard is not built yet: the button says so, and nothing below
is verified.** The design (spec §6.7): you enter the host, SSH port and user and choose a key from `~/.ssh` or a
password; the first connection shows the server's key fingerprint for you to accept (a changed key stops the run);
the wizard reads the server first (OS, architecture, Docker, who listens on 80 and 443, `ufw`), shows the full list
of commands and changes nothing until you press "Run"; it installs Docker from Docker's apt repository if missing,
writes `/opt/parley-relay/` (`compose.yml`, `Caddyfile`, `.env`, `data/`), pulls the relay image of the version that
matches your Parley by digest, starts it and checks `https://<address>/v1/health`. Without a domain it uses
`<ip-with-dashes>.sslip.io`. SSH passwords and key passphrases stay in memory for one run; nothing is stored. A
second run updates the image and keeps `data/`; "Roll back" and "Remove relay" are separate buttons. Ubuntu
22.04/24.04 and Debian 12 first; elsewhere it stops after the survey and points back to this page.

### Not yet checked

A relay on a real server reached from a phone on a mobile network (Wi-Fi to LTE, a sleeping Mac, a stopped relay) is
the pending acceptance step A18b; until it is done, treat the manual path as built and tested locally only.
