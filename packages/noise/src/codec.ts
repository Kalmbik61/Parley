import { Inflate, deflateSync } from 'fflate';
import { NoiseError } from './errors.js';
import { MAX_MESSAGE } from './handshake.js';

/** Flag bit 0: the last chunk of an application frame. */
export const FLAG_LAST = 0x01;
/** Flag bit 1: the frame is `deflate-raw` compressed; set on every chunk of that frame. */
export const FLAG_DEFLATE = 0x02;
const KNOWN_FLAGS = FLAG_LAST | FLAG_DEFLATE;
/** Largest chunk: a transport message of 65 535 bytes holds the 16-byte tag and the flags byte. */
export const MAX_CHUNK = MAX_MESSAGE - 16 - 1;
/** Compressed input is fed to the inflater in slices of this size, so one step inflates at most ~0.5 MiB. */
const INFLATE_SLICE = 512;

export interface FrameCodecOptions {
  /** Ceiling of one received application frame in bytes, after decompression (spec §5.7). */
  maxFrame: number;
  /** Frames of at least this many bytes are compressed when that makes them smaller. Default 1024. */
  compressMin?: number;
  /** Chunk size for sending, 1…MAX_CHUNK. Default MAX_CHUNK. */
  chunkSize?: number;
}

/**
 * Splits application frames into transport plaintexts and joins them back (spec §7.7):
 * `[flags][chunk]`, one per Noise transport message. Encryption is the caller's: each plaintext goes
 * through `CipherState.encryptWithAd(EMPTY, …)` and each decrypted message into `decode`.
 *
 * The decoder fails closed: a bad flags byte, an empty middle chunk, a frame over `maxFrame` (counted on the
 * wire and again after decompression, while inflating), or corrupt deflate data throws, and every later
 * `decode` throws too — the session must be closed.
 */
export class FrameCodec {
  readonly #maxFrame: number;
  readonly #compressMin: number;
  readonly #chunkSize: number;
  #parts: Uint8Array[] = [];
  #size = 0;
  /** Compressed bytes received for the current frame. */
  #wire = 0;
  #inFrame = false;
  #compressed = false;
  #inflater: Inflate | null = null;
  #failed = false;

  constructor(options: FrameCodecOptions) {
    const { maxFrame, compressMin = 1024, chunkSize = MAX_CHUNK } = options;
    if (!Number.isInteger(maxFrame) || maxFrame < 0)
      throw new NoiseError('size', 'maxFrame must be a non-negative integer');
    if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK) {
      throw new NoiseError('size', 'chunkSize out of range');
    }
    // Infinity is allowed (never compress); NaN or a negative value would silently change behaviour.
    if (!(compressMin >= 0))
      throw new NoiseError('size', 'compressMin must be a non-negative number');
    this.#maxFrame = maxFrame;
    this.#compressMin = compressMin;
    this.#chunkSize = chunkSize;
  }

  /**
   * Transport plaintexts for one application frame; the frame itself is not modified. Pass `{compress: false}`
   * for frames that carry secrets (tokens, credentials): compressing a secret next to attacker-influenced text
   * leaks it through the length (CRIME-style).
   */
  encode(frame: Uint8Array, options: { compress?: boolean } = {}): Uint8Array[] {
    let body = frame;
    let flags = 0;
    if (options.compress !== false && frame.length >= this.#compressMin) {
      const packed = deflateSync(frame);
      if (packed.length < frame.length) {
        body = packed;
        flags = FLAG_DEFLATE;
      }
    }
    const out: Uint8Array[] = [];
    let at = 0;
    do {
      const end = Math.min(body.length, at + this.#chunkSize);
      const message = new Uint8Array(1 + end - at);
      message[0] = flags | (end === body.length ? FLAG_LAST : 0);
      message.set(body.subarray(at, end), 1);
      out.push(message);
      at = end;
    } while (at < body.length);
    return out;
  }

  /** Feeds one decrypted transport plaintext; returns the frame when its last chunk arrives, else null. */
  decode(message: Uint8Array): Uint8Array | null {
    if (this.#failed) throw new NoiseError('state', 'frame codec failed earlier');
    try {
      return this.#decode(message);
    } catch (error) {
      this.#failed = true;
      this.#parts = [];
      this.#inflater = null;
      throw error instanceof NoiseError
        ? error
        : new NoiseError('frame', 'corrupt compressed frame');
    }
  }

  #decode(message: Uint8Array): Uint8Array | null {
    if (message.length === 0) throw new NoiseError('frame', 'empty transport message');
    if (message.length > MAX_CHUNK + 1) throw new NoiseError('frame', 'chunk too long');
    const flags = message[0]!;
    if (flags & ~KNOWN_FLAGS) throw new NoiseError('frame', 'unknown frame flags');
    const last = (flags & FLAG_LAST) !== 0;
    const compressed = (flags & FLAG_DEFLATE) !== 0;
    const chunk = message.subarray(1);

    if (!this.#inFrame) {
      this.#inFrame = true;
      this.#compressed = compressed;
      this.#size = 0;
      this.#parts = [];
      this.#inflater = compressed ? this.#newInflater() : null;
    } else if (compressed !== this.#compressed) {
      throw new NoiseError('frame', 'compression flag changed inside a frame');
    }
    if (!last && chunk.length === 0) throw new NoiseError('frame', 'empty middle chunk');

    if (this.#inflater) {
      // A compressed frame is smaller than its plaintext (the sender only compresses when it shrinks),
      // so its wire size is bounded by the same ceiling.
      this.#wire += chunk.length;
      if (this.#wire > this.#maxFrame) throw new NoiseError('ceiling', 'frame exceeds the ceiling');
      for (let at = 0; at < chunk.length; at += INFLATE_SLICE) {
        this.#inflater.push(chunk.slice(at, Math.min(chunk.length, at + INFLATE_SLICE)), false);
      }
      if (last) this.#inflater.push(new Uint8Array(0), true);
    } else {
      this.#add(chunk.slice());
    }

    if (!last) return null;
    const frame = joined(this.#parts, this.#size);
    this.#inFrame = false;
    this.#parts = [];
    this.#inflater = null;
    this.#wire = 0;
    return frame;
  }

  #newInflater(): Inflate {
    this.#wire = 0;
    return new Inflate((data) => this.#add(data.slice()));
  }

  #add(data: Uint8Array): void {
    if (data.length === 0) return;
    this.#size += data.length;
    if (this.#size > this.#maxFrame) throw new NoiseError('ceiling', 'frame exceeds the ceiling');
    this.#parts.push(data);
  }
}

function joined(parts: Uint8Array[], size: number): Uint8Array {
  if (parts.length === 1 && parts[0]!.length === size) return parts[0]!;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
