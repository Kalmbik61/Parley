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
docker pull caddy:2.11.7
RELAY_SETUP_STAND=1 RELAY_SETUP_FULL=1 pnpm --filter @parley/desktop exec vitest run test/relay-setup
```

The person's own web server (S1–S3 of the spec, servers with Docker already installed; the same two commands and images):

```
RELAY_SETUP_STAND=1 RELAY_SETUP_FULL=1 pnpm --filter @parley/desktop exec vitest run test/relay-setup/stand-web.test.ts
```

| Case | What it does |
|---|---|
| S1 | A Caddy of the person on 80/443 (project `course-platform-prod`, mounts `:ro`, import directory), a `relay` service of their own in its network, an old `.env` of a `proxy` install → `caddy-site`; Caddyfile sha256 unchanged, Caddy admin config holds both sites, `http://parley-relay:8787/v1/health` from the Caddy container, `relay` still the person's, repeat does nothing, `compose down`/`up` of their project (exit code printed), removal takes only our file |
| S2 | The manual layout of the course VPS (`docker/course-vps/`, bytes of the layout file, image ref `parley-relay:stand`): repeat, second repeat (nothing), rollback blocked, removal with data |
| S2b | The same layout: removal at once, without a repeat |
| S3 | nginx on the host (`systemctl` is a stand shim, `docker/systemctl-shim.sh`) → `nginx-acme`: `nginx -t`, the default site still answers, our name reaches our Caddy; removal restores `/etc/nginx` byte for byte |

S1 and S2 servers run with `--dns 127.0.0.1`: nothing inside them can reach an ACME server (the course names are real; S1 asserts that a public name does not resolve). S2 also models the container of run 2 that never started (`parley-relay-caddy-1`, state Created).

S3 is online: the server pulls the pinned Caddy from Docker Hub, and the stand's own Caddy (`parley-relay-acme`) then asks Let's Encrypt **production** for a certificate for the TEST-NET name `203-0-113-7.sslip.io`. The validation fails (nothing answers at 203.0.113.7), but the request leaves this Mac and counts for that name at Let's Encrypt.

Each server keeps ~470 MB of anonymous volume until its container is removed with `docker rm -fv`; the suites do that, and remove their temporary directories.

The tests remove their containers (`parley-stand-*`) when they finish.

## What runs where

| Case (plan A18a) | Test |
|---|---|
| 1 clean Ubuntu 24.04 / Debian 12: Docker from the official apt repo, relay up | `stand-install` «clean install» |
| 2 second run changes nothing | `stand-install` «re-run changes nothing» |
| 3 update keeps `data/` (volume) and changes the image | `stand-install` «update keeps the data» |
| 4 roll back; remove keeps data until confirmed | `stand-install` same test |
| 5 nginx on 80: `nginx-acme` plan, `/etc/nginx` untouched by the probe; 443 busy → 8443 in the address | `stand` «nginx on 80 under a service», `stand-install` «443 taken» |
| 6 host key change stops the run | `stand` «changed host key» |
| 7 hostile input refused before connecting | unit tests (`src/main/relay-setup/input.test.ts`, `service.test.ts`) |
| 8 no credential in log, IPC or on disk | unit test «no password, passphrase or sudo password reaches…» |
| 9 Alpine: stop after the probe, nothing changed | `stand` «Alpine» |
| 10 Caddy of the person in Docker (`:ro` mounts, a `relay` service of their own) → `caddy-site`; their sites keep answering; repeat; `down`/`up` of their project; removal takes only our file | `stand-web` S1 |
| 11 manual layout of the course VPS: repeat, second repeat, rollback blocked, removal with data; run 2's `Created` container | `stand-web` S2 |
| 12 the same layout: removal at once | `stand-web` S2b |
| 13 nginx on the host → `nginx-acme` (own Caddy on 8443): nginx still answers, our name reaches our Caddy, removal restores `/etc/nginx` | `stand-web` S3 |

Layouts the stand covers: `caddy` (own Caddy), `caddy-site` in Docker (S1, S2), `nginx-acme` on the host (S3) and, through the probe cases, the `proxy` plan. Not covered: `caddy-site` under systemd, `nginx-acme` in Docker, a working TLS certificate.

## What the stand does not cover

- **TLS.** There is no ACME server (Pebble) in the stand: Caddy cannot get a certificate for `*.sslip.io` from here,
  so the HTTPS health probe is replaced by a probe of the relay container from inside the server. The health check
  itself (`health.ts`) and the order «health → `configure`» are covered by unit tests with a stubbed fetcher.
- **`ufw`.** The containers have no active firewall; the `ufw` step and its removal are covered by plan unit tests only.
- **The published image.** The digest in `src/main/relay-setup/image.ts` is a placeholder until the human publishes the
  image; the stand preloads `parley-relay:stand` into each server's Docker, so the `docker pull` step finds it and is
  skipped.
- **Caddy.** The compose file pins `caddy:2.11.7@sha256:…`; an image loaded from a tarball has no registry digest, so the
  server's Docker pulls Caddy from Docker Hub: the full flow needs internet access from the containers.
- **systemd.** The containers have none. `docker/docker-shim.sh` and `docker/stand-dockerd.sh` start `dockerd` after the
  wizard's `apt` install and make Docker commands wait for it — what the package postinst does on a real server.
