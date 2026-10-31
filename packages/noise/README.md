# @parley/noise

Noise handshakes and transport framing for Parley remote access (spec
`docs/specs/2026-10-29-mobile-app-design.md` §7). Runs unchanged on Node, Hermes and in browsers: no `Buffer`,
`process` or `node:*` in `src/` (ESLint guard in the root config, import test in `test/no-buffer.test.ts`).

Our own Noise state machine (Noise spec rev 34) — **not audited**. Suite frozen in S7:

| Use               | Protocol name                                                              |
| ----------------- | -------------------------------------------------------------------------- |
| Pairing (§7.4)    | `Noise_IKpsk0_25519_ChaChaPoly_SHA256`, prologue `"parley-pair/1"`         |
| Connection (§7.5) | `Noise_IK_25519_ChaChaPoly_SHA256`, prologue `"parley-remote/1" ‖ routeId` |

## API

```ts
import {
  initiator,
  responder,
  generateKeyPair,
  derivePairKeys,
  sas,
  FrameCodec,
} from '@parley/noise';

// Pairing: the phone is the initiator; `k` and `s` come from the QR code.
const { psk, lookup } = derivePairKeys(s); // HKDF-SHA256, infos "parley-pair-psk-v1" / "parley-pair-lookup-v1"
const phone = initiator({ pattern: 'IKpsk0', prologue, s: DS, rs: HS_pub, psk });
const mac = responder({ pattern: 'IKpsk0', prologue, s: HS, psk });

const msg1 = phone.writeMessage(payload1);
mac.readMessage(msg1); // wrong psk → NoiseError 'decrypt' "cannot decrypt the remote static key"
const msg2 = mac.writeMessage(payload2);
phone.readMessage(msg2);

sas(phone.handshakeHash()) === sas(mac.handshakeHash()); // six digits, e.g. "123456"
const { send, receive } = phone.split(); // CipherState pair for this side
```

- `initiator(options)` / `responder(options)` → `HandshakeState`. Options: `pattern` (`'IK' | 'IKpsk0'`),
  `prologue`, `s` (own static `KeyPair`), `rs`, `psk` (32 bytes, IKpsk0 only), `primitives`.
  - Initiator: `rs` is the responder's static public key, required.
  - Responder: `rs` is optional; when set, reading msg1 fails with `'key'` unless the initiator's static key
    equals it.
- `writeMessage(payload?)` / `readMessage(message)` — strictly in turn. `remoteStatic()` returns the peer's
  static key once known (responder: after msg1).
- `handshakeHash()` — `h` of the **finished** handshake only (channel binding, Noise §11.2; input of the SAS).
- `split()` — once, after completion: `{ send, receive }` oriented for this side; wipes the handshake secrets.
- `CipherState.encryptWithAd(ad, pt)` / `decryptWithAd(ad, ct)` — transport uses an empty `ad`.
  `shouldClose` turns true at nonce 2³² (spec §7.6: close and handshake again); nonce 2⁶⁴−1 is refused
  (`'nonce'`).
- `FrameCodec({ maxFrame, compressMin?, chunkSize? })` — application frames ⇄ transport plaintexts (§7.7):
  `[flags][chunk]`, flag bit 0 = last chunk, bit 1 = `deflate-raw` (via `fflate`) on every chunk of the frame.
  Every encrypted message is ≤ 65 535 bytes. `encode(frame)` returns the plaintexts to encrypt;
  `decode(plaintext)` returns the frame on its last chunk, otherwise `null`. `maxFrame` is the ceiling of a
  received frame after decompression (spec §5.7: 64 KiB on the bridge, 8 MiB on the phone); it is enforced
  while inflating, so a deflate bomb fails after about `maxFrame` bytes, not after inflating it all.
- `sas(h)` — `uint32_be(HKDF(h, "parley-sas-v1", 4)) mod 10⁶`, six digits with leading zeros.
- `hkdf(ikm, info, length, salt?)` — RFC 5869 over the suite's HMAC (SHA-256).
- `randomBytes(n)`, `generateKeyPair()` — from `globalThis.crypto.getRandomValues`; throws when absent
  (React Native needs `expo-crypto` or `react-native-get-random-values` installed first).

All failures throw `NoiseError` with a `code`: `decrypt`, `state`, `size`, `nonce`, `key`, `frame`,
`ceiling`, `random`. Messages never contain keys, payloads or ciphertext.

## Invariants

- **Fail closed.** A `HandshakeState` that threw once is `failed`; every later call throws. A `FrameCodec`
  that threw once refuses all later input. A failed transport decryption does not advance the nonce, and the
  caller closes the session (§7.7): there is no resynchronisation, so truncated, reordered and replayed
  messages are errors.
- **Inputs are never written to.** Keys, payloads and messages passed in are copied where kept; everything
  returned is a fresh array. (The spike found `noise-handshake` decrypting in place.)
- **Strict turn order** and Noise's message limit of 65 535 bytes on both handshake and transport messages.
- **psk0 rule** (Noise §9): with a psk, every `e` token also calls `MixKey(e.pub)`.
- **Low-order public keys** are rejected (`'key'`): X25519 with an all-zero result throws.
- **Secrets** we own (copies of static and ephemeral private keys, psk, chaining key, cipher keys) are zeroed
  when the handshake fails or is split, and when a cipher is destroyed — best effort in JavaScript.

## Primitives

The state machine reaches cryptography only through `NoisePrimitives` (`src/primitives.ts`):
`generateKeyPair`, `publicKey`, `dh`, `encrypt`, `decrypt`, `hash`, `hmac`, plus `suite`, `dhLen`, `hashLen`.
`noblePrimitives` (`@noble/curves`, `@noble/ciphers`, `@noble/hashes`) is the default and the reference. A
faster implementation (for example `react-native-quick-crypto` in the app) is passed as `primitives` and must
first reproduce every vector in `test/vectors/`. The protocol name is built from `primitives.suite`.

## Tests

`pnpm --filter @parley/noise build` first (the import test runs `dist/`), then
`pnpm --filter @parley/noise test`:

- vectors — `IKpsk0` (flynn/noise × noiseprotocol, 3 for the frozen suite plus 3 BLAKE2b as a hash guard)
  and `IK` (cacophony, snow); provenance in `test/vectors/README.md`;
- cross-check against an independent IK / IKpsk0 written on `node:crypto`;
- negative cases, nonce limits, input immutability, codec, SAS and HKDF (RFC 5869 cases);
- import of `dist/` in a Node process with `Buffer` deleted.

`pnpm --filter @parley/noise bench` — one side of an IK handshake, median of 100; must stay under 5 ms on Node.
