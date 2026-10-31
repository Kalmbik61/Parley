// Acceptance 7 probe: one side of a Noise IK handshake on Node, median of 100 runs, must stay under 5 ms.
// Run: pnpm --filter @parley/noise bench. The initiator side is timed (msg1 write + msg2 read + split);
// the responder side is measured separately for reference. Both sides do four DH operations.
import { performance } from 'node:perf_hooks';
import { EMPTY } from '../src/bytes.js';
import { generateKeyPair, initiator, responder } from '../src/index.js';

const RUNS = 100;
const prologue = new TextEncoder().encode('parley-remote/1');
const hs = generateKeyPair();
const ds = generateKeyPair();
const payload = new Uint8Array(8);

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2;
};

function once(): { init: number; resp: number } {
  const i = initiator({ pattern: 'IK', prologue, s: ds, rs: hs.publicKey });
  const r = responder({ pattern: 'IK', prologue, s: hs });
  let t = performance.now();
  const msg1 = i.writeMessage(payload);
  let init = performance.now() - t;
  t = performance.now();
  r.readMessage(msg1);
  const msg2 = r.writeMessage(EMPTY);
  r.split();
  const resp = performance.now() - t;
  t = performance.now();
  i.readMessage(msg2);
  i.split();
  init += performance.now() - t;
  return { init, resp };
}

for (let n = 0; n < 20; n++) once(); // warm-up
const runs = Array.from({ length: RUNS }, once);
const init = median(runs.map((r) => r.init));
const resp = median(runs.map((r) => r.resp));
console.log(
  `IK one side, median of ${RUNS}: initiator ${init.toFixed(2)} ms, responder ${resp.toFixed(2)} ms`,
);
if (Math.max(init, resp) >= 5) {
  console.error('FAIL: one side must stay under 5 ms');
  process.exitCode = 1;
}
