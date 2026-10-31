// Acceptance 2: an independent straight-line Noise IK / IKpsk0 on node:crypto (X25519, ChaCha20-Poly1305,
// SHA-256) must produce the same bytes as the package for the same keys. Nothing here imports the package's
// crypto code; only the comparison does.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  randomBytes,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { initiator, noblePrimitives, responder, type PatternName } from '../src/index.js';
import { withEphemeral } from './helpers.js';

const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');

const nodePub = (priv: Buffer): Buffer =>
  createPublicKey(
    createPrivateKey({ key: Buffer.concat([PKCS8, priv]), format: 'der', type: 'pkcs8' }),
  )
    .export({ format: 'der', type: 'spki' })
    .subarray(SPKI.length);
const nodeDh = (priv: Buffer, pub: Buffer): Buffer =>
  diffieHellman({
    privateKey: createPrivateKey({
      key: Buffer.concat([PKCS8, priv]),
      format: 'der',
      type: 'pkcs8',
    }),
    publicKey: createPublicKey({ key: Buffer.concat([SPKI, pub]), format: 'der', type: 'spki' }),
  });
const sha = (d: Buffer): Buffer => createHash('sha256').update(d).digest();
const mac = (k: Buffer, d: Buffer): Buffer => createHmac('sha256', k).update(d).digest();
const nonce = (n: number): Buffer => {
  const b = Buffer.alloc(12);
  b.writeBigUInt64LE(BigInt(n), 4);
  return b;
};
function seal(k: Buffer, n: number, ad: Buffer, pt: Buffer): Buffer {
  const c = createCipheriv('chacha20-poly1305', k, nonce(n), { authTagLength: 16 });
  c.setAAD(ad, { plaintextLength: pt.length });
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
}
function open(k: Buffer, n: number, ad: Buffer, ct: Buffer): Buffer {
  const d = createDecipheriv('chacha20-poly1305', k, nonce(n), { authTagLength: 16 });
  d.setAAD(ad, { plaintextLength: ct.length - 16 });
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
}

class Sym {
  h: Buffer;
  ck: Buffer;
  k: Buffer | null = null;
  n = 0;
  constructor(name: string) {
    const b = Buffer.from(name);
    this.h = b.length <= 32 ? Buffer.concat([b, Buffer.alloc(32 - b.length)]) : sha(b);
    this.ck = this.h;
  }
  hkdf(ikm: Buffer, n: 2 | 3): Buffer[] {
    const t = mac(this.ck, ikm);
    const o1 = mac(t, Buffer.from([1]));
    const o2 = mac(t, Buffer.concat([o1, Buffer.from([2])]));
    return n === 2 ? [o1, o2] : [o1, o2, mac(t, Buffer.concat([o2, Buffer.from([3])]))];
  }
  mixHash(d: Buffer): void {
    this.h = sha(Buffer.concat([this.h, d]));
  }
  mixKey(ikm: Buffer): void {
    [this.ck, this.k] = this.hkdf(ikm, 2) as [Buffer, Buffer];
    this.n = 0;
  }
  mixKeyAndHash(ikm: Buffer): void {
    const [ck, h, k] = this.hkdf(ikm, 3) as [Buffer, Buffer, Buffer];
    this.ck = ck;
    this.mixHash(h);
    this.k = k;
    this.n = 0;
  }
  enc(pt: Buffer): Buffer {
    const ct = this.k ? seal(this.k, this.n++, this.h, pt) : pt;
    this.mixHash(ct);
    return ct;
  }
  dec(ct: Buffer): Buffer {
    const pt = this.k ? open(this.k, this.n++, this.h, ct) : ct;
    this.mixHash(ct);
    return pt;
  }
}

interface Keys {
  pattern: PatternName;
  prologue: Buffer;
  psk: Buffer | null;
  is: Buffer;
  ie: Buffer;
  rs: Buffer;
  re: Buffer;
  p1: Buffer;
  p2: Buffer;
  transport: Buffer[];
}

function reference(x: Keys): { msg1: Buffer; msg2: Buffer; h: Buffer; transport: Buffer[] } {
  const name = `Noise_${x.pattern}_25519_ChaChaPoly_SHA256`;
  const rsPub = nodePub(x.rs);
  const i = new Sym(name);
  i.mixHash(x.prologue);
  i.mixHash(rsPub);
  if (x.psk) i.mixKeyAndHash(x.psk);
  const iePub = nodePub(x.ie);
  i.mixHash(iePub);
  if (x.psk) i.mixKey(iePub);
  i.mixKey(nodeDh(x.ie, rsPub));
  const encS = i.enc(nodePub(x.is));
  i.mixKey(nodeDh(x.is, rsPub));
  const msg1 = Buffer.concat([iePub, encS, i.enc(x.p1)]);

  const r = new Sym(name);
  r.mixHash(x.prologue);
  r.mixHash(rsPub);
  if (x.psk) r.mixKeyAndHash(x.psk);
  const ie = msg1.subarray(0, 32);
  r.mixHash(ie);
  if (x.psk) r.mixKey(ie);
  r.mixKey(nodeDh(x.rs, ie));
  const isPub = r.dec(msg1.subarray(32, 80));
  r.mixKey(nodeDh(x.rs, isPub));
  expect(r.dec(msg1.subarray(80)).equals(x.p1)).toBe(true);
  const rePub = nodePub(x.re);
  r.mixHash(rePub);
  if (x.psk) r.mixKey(rePub);
  r.mixKey(nodeDh(x.re, ie));
  r.mixKey(nodeDh(x.re, isPub));
  const msg2 = Buffer.concat([rePub, r.enc(x.p2)]);

  const [k1, k2] = r.hkdf(Buffer.alloc(0), 2) as [Buffer, Buffer];
  const transport = x.transport.map((pt, n) =>
    seal(n % 2 === 0 ? k1 : k2, n >> 1, Buffer.alloc(0), pt),
  );
  return { msg1, msg2, h: r.h, transport };
}

function ours(x: Keys): {
  msg1: Uint8Array;
  msg2: Uint8Array;
  h: Uint8Array;
  transport: Uint8Array[];
} {
  const psk = x.psk ? { psk: new Uint8Array(x.psk) } : {};
  const kp = (priv: Buffer) => ({
    privateKey: new Uint8Array(priv),
    publicKey: noblePrimitives.publicKey(priv),
  });
  const i = initiator({
    pattern: x.pattern,
    prologue: x.prologue,
    s: kp(x.is),
    rs: noblePrimitives.publicKey(x.rs),
    ...psk,
    primitives: withEphemeral(noblePrimitives, new Uint8Array(x.ie)),
  });
  const r = responder({
    pattern: x.pattern,
    prologue: x.prologue,
    s: kp(x.rs),
    ...psk,
    primitives: withEphemeral(noblePrimitives, new Uint8Array(x.re)),
  });
  const msg1 = i.writeMessage(x.p1);
  r.readMessage(msg1);
  const msg2 = r.writeMessage(x.p2);
  i.readMessage(msg2);
  const h = i.handshakeHash();
  const ic = i.split();
  const rc = r.split();
  const transport = x.transport.map((pt, n) =>
    (n % 2 === 0 ? ic : rc).send.encryptWithAd(new Uint8Array(0), pt),
  );
  return { msg1, msg2, h, transport };
}

describe('cross-check against node:crypto', () => {
  for (const pattern of ['IK', 'IKpsk0'] as const) {
    it(`${pattern}: same handshake bytes, hash and transport for 25 random key sets`, () => {
      for (let round = 0; round < 25; round++) {
        const x: Keys = {
          pattern,
          prologue: randomBytes(round % 40),
          psk: pattern === 'IKpsk0' ? randomBytes(32) : null,
          is: randomBytes(32),
          ie: randomBytes(32),
          rs: randomBytes(32),
          re: randomBytes(32),
          p1: randomBytes(round * 3),
          p2: randomBytes(round * 70),
          transport: [randomBytes(1), randomBytes(0), randomBytes(1000), randomBytes(65_000)],
        };
        const a = reference(x);
        const b = ours(x);
        expect(Buffer.from(b.msg1).equals(a.msg1)).toBe(true);
        expect(Buffer.from(b.msg2).equals(a.msg2)).toBe(true);
        expect(Buffer.from(b.h).equals(a.h)).toBe(true);
        b.transport.forEach((t, n) => expect(Buffer.from(t).equals(a.transport[n]!)).toBe(true));
      }
    });
  }

  it('the reference AEAD round-trips (guards the reference itself)', () => {
    const k = randomBytes(32);
    const ct = seal(k, 7, Buffer.from('ad'), Buffer.from('hello'));
    expect(open(k, 7, Buffer.from('ad'), ct).toString()).toBe('hello');
  });
});
