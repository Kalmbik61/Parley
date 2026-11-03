// Crypto timing for A20 item 16 (Hermes speed of the frozen Noise suite, spec §7.1 / S7 §7.1): one side of an IK handshake and
// ChaCha20-Poly1305 on 64 KiB / 1 MiB, all through `@parley/noise` (the code the app really runs). Pure TypeScript, no React Native.
import { initiator, noblePrimitives, responder } from '@parley/noise';

export interface BenchRow {
  id: string;
  label: string;
  median: number;
  min: number;
  max: number;
  runs: number;
}

export interface BenchOptions {
  runs: number;
  warmup: number;
  now: () => number;
}

/** Thresholds of the S7 verdict (§7.1), milliseconds: one IK side and one 64 KiB frame. */
export const THRESHOLDS = { ikOneSide: 150, chacha64KiB: 50 } as const;

export function summarize(samples: number[]): Pick<BenchRow, 'median' | 'min' | 'max' | 'runs'> {
  if (samples.length === 0) throw new Error('no samples');
  const s = [...samples].sort((a, b) => a - b);
  const median = ((s[(s.length - 1) >> 1] as number) + (s[s.length >> 1] as number)) / 2;
  return { median, min: s[0] as number, max: s[s.length - 1] as number, runs: s.length };
}

function measure(run: () => number | void, opts: BenchOptions): ReturnType<typeof summarize> {
  for (let i = 0; i < opts.warmup; i++) run();
  const samples: number[] = [];
  for (let i = 0; i < opts.runs; i++) {
    const t0 = opts.now();
    const own = run();
    samples.push(typeof own === 'number' ? own : opts.now() - t0);
  }
  return summarize(samples);
}

const filled = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
const prologue = new TextEncoder().encode('parley-remote/1');

export interface BenchCase {
  id: string;
  label: string;
  run: () => number | void;
}

export function benchCases(now: () => number): BenchCase[] {
  const p = noblePrimitives;
  const a = p.generateKeyPair();
  const b = p.generateKeyPair();
  const key = filled(32);
  const nonce = new Uint8Array(12);
  const ad = new Uint8Array(0);
  const k64 = filled(64 * 1024);
  const m1 = filled(1024 * 1024);
  const c64 = p.encrypt(key, nonce, ad, k64);
  const c1 = p.encrypt(key, nonce, ad, m1);
  // One IK handshake with both sides; the initiator and responder shares are timed separately (as `@parley/noise` bench does).
  const ik = (side: 'init' | 'resp') => (): number => {
    const i = initiator({ pattern: 'IK', prologue, s: a, rs: b.publicKey });
    const r = responder({ pattern: 'IK', prologue, s: b });
    const payload = new Uint8Array(8);
    let t = now();
    const msg1 = i.writeMessage(payload);
    let init = now() - t;
    t = now();
    r.readMessage(msg1);
    const msg2 = r.writeMessage(new Uint8Array(0));
    r.split();
    const resp = now() - t;
    t = now();
    i.readMessage(msg2);
    i.split();
    init += now() - t;
    return side === 'init' ? init : resp;
  };
  return [
    { id: 'x25519-keygen', label: 'x25519 key pair', run: () => void p.generateKeyPair() },
    { id: 'x25519-dh', label: 'x25519 DH', run: () => void p.dh(a.privateKey, b.publicKey) },
    { id: 'ik-initiator', label: 'Noise IK, initiator side', run: ik('init') },
    { id: 'ik-responder', label: 'Noise IK, responder side', run: ik('resp') },
    { id: 'chacha-enc-64k', label: 'ChaCha20-Poly1305 encrypt 64 KiB', run: () => void p.encrypt(key, nonce, ad, k64) },
    { id: 'chacha-dec-64k', label: 'ChaCha20-Poly1305 decrypt 64 KiB', run: () => void p.decrypt(key, nonce, ad, c64) },
    { id: 'chacha-enc-1m', label: 'ChaCha20-Poly1305 encrypt 1 MiB', run: () => void p.encrypt(key, nonce, ad, m1) },
    { id: 'chacha-dec-1m', label: 'ChaCha20-Poly1305 decrypt 1 MiB', run: () => void p.decrypt(key, nonce, ad, c1) },
    { id: 'sha256-64k', label: 'SHA-256 64 KiB', run: () => void p.hash(k64) },
  ];
}

export interface BenchReport {
  schema: 'parley-mobile-bench/1';
  at: string;
  device: Record<string, unknown>;
  runs: number;
  rows: BenchRow[];
  verdict: { ikOneSideMs: number; chacha64KiBMs: number; ok: boolean; thresholds: typeof THRESHOLDS };
}

/** Runs every case; `yieldToUi` lets the screen repaint between cases. */
export async function runBench(
  opts: BenchOptions,
  device: Record<string, unknown>,
  onRow?: (row: BenchRow) => void,
  yieldToUi: () => Promise<void> = () => Promise.resolve(),
): Promise<BenchReport> {
  const rows: BenchRow[] = [];
  for (const c of benchCases(opts.now)) {
    await yieldToUi();
    const row = { id: c.id, label: c.label, ...measure(c.run, opts) };
    rows.push(row);
    onRow?.(row);
  }
  const med = (id: string) => rows.find((r) => r.id === id)?.median ?? Number.POSITIVE_INFINITY;
  const ikOneSideMs = Math.max(med('ik-initiator'), med('ik-responder'));
  const chacha64KiBMs = Math.max(med('chacha-enc-64k'), med('chacha-dec-64k'));
  return {
    schema: 'parley-mobile-bench/1',
    at: new Date().toISOString(),
    device,
    runs: opts.runs,
    rows,
    verdict: {
      ikOneSideMs,
      chacha64KiBMs,
      ok: ikOneSideMs <= THRESHOLDS.ikOneSide && chacha64KiBMs <= THRESHOLDS.chacha64KiB,
      thresholds: THRESHOLDS,
    },
  };
}
