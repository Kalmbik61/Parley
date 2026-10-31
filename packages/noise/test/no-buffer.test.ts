// Acceptance 6 (like A1 acceptance 4): the built package imports and runs in a Node process without Buffer,
// and nothing under dist/ imports a Node built-in.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { here } from './helpers.js';

const dist = resolve(here, '../dist');
const ALLOWED = new Set([
  '@noble/curves/ed25519.js',
  '@noble/ciphers/chacha.js',
  '@noble/hashes/sha2.js',
  '@noble/hashes/hmac.js',
  'fflate',
]);

describe('built package', () => {
  it('runs a pairing handshake, transport and codec with Buffer deleted', () => {
    expect(
      existsSync(join(dist, 'index.js')),
      'run `pnpm --filter @parley/noise build` first',
    ).toBe(true);
    const url = pathToFileURL(join(dist, 'index.js')).href;
    const script = `delete globalThis.Buffer;
if (globalThis.Buffer !== undefined) throw new Error('Buffer still present');
const m = await import(${JSON.stringify(url)});
const hs = m.generateKeyPair(), ds = m.generateKeyPair();
const { psk } = m.derivePairKeys(m.randomBytes(16));
const prologue = new TextEncoder().encode('parley-pair/1');
const i = m.initiator({ pattern: 'IKpsk0', prologue, s: ds, rs: hs.publicKey, psk });
const r = m.responder({ pattern: 'IKpsk0', prologue, s: hs, psk });
r.readMessage(i.writeMessage(new TextEncoder().encode('{"v":1}')));
i.readMessage(r.writeMessage(new Uint8Array(0)));
if (m.sas(i.handshakeHash()) !== m.sas(r.handshakeHash())) throw new Error('sas');
const a = i.split(), b = r.split();
const frame = new TextEncoder().encode('{"event":"x","data":"' + 'y'.repeat(5000) + '"}');
const tx = new m.FrameCodec({ maxFrame: 1 << 20 }), rx = new m.FrameCodec({ maxFrame: 1 << 20 });
let out = null;
for (const p of tx.encode(frame)) out = rx.decode(b.receive.decryptWithAd(new Uint8Array(0), a.send.encryptWithAd(new Uint8Array(0), p)));
if (new TextDecoder().decode(out) !== new TextDecoder().decode(frame)) throw new Error('frame');
console.log('ok');`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('ok');
  });

  it('dist imports only relative files, @noble and fflate — no node: built-ins', () => {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.js') ? [join(d, e.name)] : [],
      );
    const files = walk(dist);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(/\bBuffer\b|\bprocess\b/.test(src.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')), f).toBe(
        false,
      );
      for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
        const spec = m[1]!;
        expect(spec.startsWith('node:'), `${f}: ${spec}`).toBe(false);
        if (spec.startsWith('.'))
          expect(resolve(dirname(f), spec).startsWith(dist), `${f}: ${spec}`).toBe(true);
        else expect(ALLOWED.has(spec), `${f}: ${spec}`).toBe(true);
      }
    }
  });
});
