# Relay setup wizard — Docker stand

Real `sshd` servers in containers, the real `ssh2` client and the real wizard service (mobile plan A18a). Only DNS,
the bridge `configure` and the HTTPS health probe are stubs.

Needs a running Docker daemon. The tests skip themselves otherwise.

## Commands

Probe cases (Ubuntu 24.04, Debian 12, nginx on 80, Alpine, sudo user, wrong password, changed host key) — about 15 s
after the images are built:

```
RELAY_SETUP_STAND=1 pnpm --filter @parley/desktop exec vitest run test/relay-setup/stand.test.ts
```

Full install on servers with their own Docker (privileged containers, real `apt`, real `docker compose`): needs the
relay image built from the repository and Caddy on this Mac first.

```
docker build -f packages/relay/Dockerfile -t parley-relay:stand .
docker pull caddy:2
RELAY_SETUP_STAND=1 RELAY_SETUP_FULL=1 pnpm --filter @parley/desktop exec vitest run test/relay-setup
```

The tests remove their containers (`parley-stand-*`) when they finish.

## What runs where

| Case (plan A18a) | Test |
|---|---|
| 1 clean Ubuntu 24.04 / Debian 12: Docker from the official apt repo, relay up | `stand-install` «clean install» |
| 2 second run changes nothing | `stand-install` «re-run changes nothing» |
| 3 update keeps `data/` (volume) and changes the image | `stand-install` «update keeps the data» |
| 4 roll back; remove keeps data until confirmed | `stand-install` same test |
| 5 nginx on 80 untouched + snippet; 443 busy → 8443 in the address | `stand` «nginx on 80», `stand-install` «443 taken» |
| 6 host key change stops the run | `stand` «changed host key» |
| 7 hostile input refused before connecting | unit tests (`src/main/relay-setup/input.test.ts`, `service.test.ts`) |
| 8 no credential in log, IPC or on disk | unit test «no password, passphrase or sudo password reaches…» |
| 9 Alpine: stop after the probe, nothing changed | `stand` «Alpine» |

## What the stand does not cover

- **TLS.** There is no ACME server (Pebble) in the stand: Caddy cannot get a certificate for `*.sslip.io` from here,
  so the HTTPS health probe is replaced by a probe of the relay container from inside the server. The health check
  itself (`health.ts`) and the order «health → `configure`» are covered by unit tests with a stubbed fetcher.
- **`ufw`.** The containers have no active firewall; the `ufw` step and its removal are covered by plan unit tests only.
- **The published image.** The digest in `src/main/relay-setup/image.ts` is a placeholder until the human publishes the
  image; the stand preloads `parley-relay:stand` into each server's Docker, so the `docker pull` step finds it and is
  skipped.
- **systemd.** The containers have none. `docker/docker-shim.sh` and `docker/stand-dockerd.sh` start `dockerd` after the
  wizard's `apt` install and make Docker commands wait for it — what the package postinst does on a real server.
