import { deflateSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { EMPTY } from '../src/bytes.js';
import {
  FLAG_DEFLATE,
  FLAG_LAST,
  FrameCodec,
  MAX_CHUNK,
  MAX_MESSAGE,
  NoiseError,
  generateKeyPair,
  initiator,
  responder,
} from '../src/index.js';
import { seeded } from './helpers.js';

const MiB = 1024 * 1024;

function ciphers() {
  const hs = generateKeyPair();
  const i = initiator({ pattern: 'IK', prologue: EMPTY, s: generateKeyPair(), rs: hs.publicKey });
  const r = responder({ pattern: 'IK', prologue: EMPTY, s: hs });
  r.readMessage(i.writeMessage(EMPTY));
  i.readMessage(r.writeMessage(EMPTY));
  return { a: i.split(), b: r.split() };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(NoiseError);
    return (error as NoiseError).code;
  }
  throw new Error('expected a NoiseError');
}

function jsonLike(size: number): Uint8Array {
  const row = '{"id":"s-183","label":"Mobile-A3-noise","status":"active","unread":3},';
  return new TextEncoder().encode(row.repeat(Math.ceil(size / row.length)).slice(0, size));
}

describe('FrameCodec', () => {
  it('a 1 MiB incompressible frame goes out in chunks ≤ 65 535 bytes on the wire and comes back whole', () => {
    const { a, b } = ciphers();
    const frame = seeded('frame', MiB);
    const sender = new FrameCodec({ maxFrame: 8 * MiB });
    const receiver = new FrameCodec({ maxFrame: 8 * MiB });
    const plain = sender.encode(frame);
    expect(plain.length).toBe(Math.ceil(MiB / MAX_CHUNK));
    const wire = plain.map((m) => a.send.encryptWithAd(EMPTY, m));
    for (const w of wire) expect(w.length).toBeLessThanOrEqual(MAX_MESSAGE);
    expect(wire[0]!.length).toBe(MAX_MESSAGE);
    plain.forEach((m, n) => expect(m[0]).toBe(n === plain.length - 1 ? FLAG_LAST : 0));

    let out: Uint8Array | null = null;
    wire.forEach((w, n) => {
      out = receiver.decode(b.receive.decryptWithAd(EMPTY, w));
      expect(out === null).toBe(n < wire.length - 1);
    });
    expect(out).toEqual(frame);
  });

  it('a 1 MiB compressible frame is deflated, flagged on every chunk and restored', () => {
    const frame = jsonLike(MiB);
    const plain = new FrameCodec({ maxFrame: MiB }).encode(frame);
    expect(plain.length).toBeLessThan(3);
    for (const m of plain) expect(m[0]! & FLAG_DEFLATE).toBe(FLAG_DEFLATE);
    const receiver = new FrameCodec({ maxFrame: MiB });
    let out: Uint8Array | null = null;
    for (const m of plain) out = receiver.decode(m);
    expect(out).toEqual(frame);
  });

  it('a compressed frame split over many chunks is restored', () => {
    const frame = seeded('mixed', 200_000);
    frame.set(jsonLike(150_000));
    const plain = new FrameCodec({ maxFrame: MiB, chunkSize: 1000 }).encode(frame);
    expect(plain.length).toBeGreaterThan(10);
    const receiver = new FrameCodec({ maxFrame: MiB });
    const outs = plain.map((m) => receiver.decode(m));
    expect(outs.slice(0, -1).every((o) => o === null)).toBe(true);
    expect(outs.at(-1)).toEqual(frame);
  });

  it('small and empty frames go uncompressed in one chunk; frames in a row decode separately', () => {
    const codec = new FrameCodec({ maxFrame: 1024 });
    const receiver = new FrameCodec({ maxFrame: 1024 });
    for (const frame of [EMPTY, new TextEncoder().encode('{"id":"1"}'), jsonLike(1023)]) {
      const plain = codec.encode(frame);
      expect(plain).toHaveLength(1);
      expect(plain[0]![0]).toBe(FLAG_LAST);
      expect(receiver.decode(plain[0]!)).toEqual(frame);
    }
  });

  it('encode does not touch the frame; decode does not touch the message', () => {
    const frame = jsonLike(5000);
    const frameCopy = frame.slice();
    const plain = new FrameCodec({ maxFrame: MiB, chunkSize: 100 }).encode(frame);
    const copies = plain.map((m) => m.slice());
    const receiver = new FrameCodec({ maxFrame: MiB });
    for (const m of plain) receiver.decode(m);
    expect(frame).toEqual(frameCopy);
    expect(plain).toEqual(copies);
  });

  it('deflate bomb → ceiling error on the first chunk', () => {
    const bomb = deflateSync(new Uint8Array(64 * MiB));
    expect(bomb.length).toBeLessThan(MAX_CHUNK);
    const receiver = new FrameCodec({ maxFrame: MiB });
    expect(code(() => receiver.decode(Uint8Array.of(FLAG_LAST | FLAG_DEFLATE, ...bomb)))).toBe(
      'ceiling',
    );
    // Fails closed: the codec refuses everything after.
    expect(code(() => receiver.decode(Uint8Array.of(FLAG_LAST)))).toBe('state');
  });

  it('a frame just over the ceiling fails, one at the ceiling passes (plain and deflated)', () => {
    for (const frame of [seeded('x', 4097), jsonLike(4097)]) {
      const plain = new FrameCodec({ maxFrame: 4096 * 2, chunkSize: 1000 }).encode(frame);
      const ok = new FrameCodec({ maxFrame: 4097 });
      let out: Uint8Array | null = null;
      for (const m of plain) out = ok.decode(m);
      expect(out).toEqual(frame);
      const tight = new FrameCodec({ maxFrame: 4096 });
      expect(code(() => plain.forEach((m) => tight.decode(m)))).toBe('ceiling');
    }
  });

  it('malformed chunks fail closed', () => {
    expect(code(() => new FrameCodec({ maxFrame: 10 }).decode(EMPTY))).toBe('frame');
    expect(
      code(() => new FrameCodec({ maxFrame: 10 }).decode(Uint8Array.of(0x04 | FLAG_LAST))),
    ).toBe('frame');
    expect(code(() => new FrameCodec({ maxFrame: 10 }).decode(Uint8Array.of(0)))).toBe('frame');
    expect(
      code(() => new FrameCodec({ maxFrame: MiB }).decode(new Uint8Array(MAX_CHUNK + 2))),
    ).toBe('frame');

    const mixed = new FrameCodec({ maxFrame: 100 });
    expect(mixed.decode(Uint8Array.of(0, 1, 2))).toBeNull();
    expect(code(() => mixed.decode(Uint8Array.of(FLAG_LAST | FLAG_DEFLATE, 3)))).toBe('frame');
    expect(code(() => mixed.decode(Uint8Array.of(FLAG_LAST, 3)))).toBe('state');

    expect(
      code(() =>
        new FrameCodec({ maxFrame: 100 }).decode(
          Uint8Array.of(FLAG_LAST | FLAG_DEFLATE, 0xff, 0xff),
        ),
      ),
    ).toBe('frame');
    // A deflate stream cut short is an error, not a short frame.
    const cut = deflateSync(jsonLike(5000)).subarray(0, 20);
    expect(
      code(() =>
        new FrameCodec({ maxFrame: MiB }).decode(Uint8Array.of(FLAG_LAST | FLAG_DEFLATE, ...cut)),
      ),
    ).toBe('frame');
  });

  it('compress: false sends a compressible frame as is', () => {
    const frame = jsonLike(10_000);
    const plain = new FrameCodec({ maxFrame: MiB }).encode(frame, { compress: false });
    for (const m of plain) expect(m[0]! & FLAG_DEFLATE).toBe(0);
    const receiver = new FrameCodec({ maxFrame: MiB });
    expect(receiver.decode(plain[0]!)).toEqual(frame);
  });

  it('options are validated', () => {
    expect(code(() => new FrameCodec({ maxFrame: 1, compressMin: Number.NaN }))).toBe('size');
    expect(code(() => new FrameCodec({ maxFrame: 1, compressMin: -1 }))).toBe('size');
    expect(
      () => new FrameCodec({ maxFrame: 1, compressMin: Number.POSITIVE_INFINITY }),
    ).not.toThrow();
    expect(code(() => new FrameCodec({ maxFrame: -1 }))).toBe('size');
    expect(code(() => new FrameCodec({ maxFrame: 1, chunkSize: 0 }))).toBe('size');
    expect(code(() => new FrameCodec({ maxFrame: 1, chunkSize: MAX_CHUNK + 1 }))).toBe('size');
  });
});
