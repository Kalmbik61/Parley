# @parley/push-gateway

A small stateless service that turns a "needs you" signal from a Parley bridge into an APNs alert for the
Parley iOS app. It runs on the app author's server, because only the owner of the app's APNs key can push to it.

## API

- `GET /v1/health` → `200 {"ok":true}`.
- `POST /v1/push` with a strict JSON body `{v: 1, token, env: "sandbox" | "production", count, route}`:
  - `token` is a hex APNs device token, `count` an integer 0–9999, `route` a 16-byte base64url route id.
    Extra fields or wrong types → `400`. The request carries no free text.
  - The gateway builds the notification itself: title `Parley`, body `N waiting`, `badge` = `count`,
    `thread-id` and `apns-collapse-id` = `route`, `apns-push-type: alert`, and the data
    `{v: 1, kind: "needs-you", count, route}`.
  - Answers: `200` APNs accepted; `410` APNs says the token is invalid (passed out as is, the bridge forgets
    the token); `400` bad request (or APNs rejected it); `429` rate limited (by this gateway or by APNs).
    `502` means the gateway could not get an answer from APNs (network, timeout, rejected key); retry later.

## Limits (in memory)

Per token: at most 1 push per 3 s and 60 per hour. Per IP: at most 600 requests per hour. Request bodies are
capped at 4 KiB; there are header and request timeouts. The counters live in two bounded maps and are lost on
restart. Behind a reverse proxy set `TRUST_PROXY=1` to count the last `X-Forwarded-For` address instead of the
socket address.

## What the gateway sees and what it does not store

It sees, per request: the device token, the route id, the count and the client IP. It stores none of this:
nothing is written to disk, and request bodies, tokens and IPs are never logged (the only log lines are the
start-up message and fatal configuration errors, which never include secrets). The rate-limit counters are the
only in-memory state and expire within an hour. There are no accounts: anyone who knows a token can push to it,
within the limits above.

## Configuration (environment)

| Variable | Meaning |
| --- | --- |
| `APNS_KEY` or `APNS_KEY_PATH` | The `.p8` key (PEM text, `\n` allowed) or a path to it, e.g. a Docker secret |
| `APNS_KEY_ID` | Key ID of the APNs key |
| `APNS_TEAM_ID` | Apple Team ID |
| `APNS_TOPIC` | The app's bundle ID |
| `PORT`, `HOST` | Listen address, default `0.0.0.0:8080` |
| `TRUST_PROXY` | `1` to trust `X-Forwarded-For` |

Without the key, Key ID, Team ID or topic, the service refuses to start. The JWT (ES256) is signed in-process
and refreshed every 50 minutes. The gateway speaks plain HTTP: terminate TLS in front of it.

## Docker

From the repository root:

```sh
docker build -f packages/push-gateway/Dockerfile -t parley-push-gateway .
docker run -e APNS_KEY_ID=… -e APNS_TEAM_ID=… -e APNS_TOPIC=… \
  -v /path/to/AuthKey.p8:/run/secrets/apns.p8:ro -e APNS_KEY_PATH=/run/secrets/apns.p8 \
  -p 8080:8080 parley-push-gateway
```

## Development

`pnpm --filter @parley/push-gateway build | typecheck | test`. Tests run against a local HTTP/2 mock of APNs and
generate their keys at runtime; no key is committed.
