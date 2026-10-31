import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { METHODS, NOTIFICATIONS } from '../methods.js';
import type { Events } from '../events.js';
import {
  REMOTE_EVENTS,
  REMOTE_FORBIDDEN,
  REMOTE_METHODS,
  REMOTE_NOTIFICATIONS,
  REMOTE_STAGES,
  REMOTE_PARAM_RULES,
  checkRemoteParams,
  isRemoteForbidden,
  b64urlDecode,
  b64urlEncode,
  buildPairUrl,
  parsePairUrl,
  relayUrlFor,
  pushRequestSchema,
  pushDataSchema,
  pairCredentialsFrame,
  pairMsg1Payload,
  pairMsg2Payload,
  pairAnswerParams,
  bridgeMethodSchemas,
  bridgeEventSchemas,
  appRequestFrame,
  connectFrame,
  hostHelloFrame,
} from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const bytes = (n: number, v = 7) => new Uint8Array(n).fill(v);

describe('allowlist', () => {
  const stages = Object.values(REMOTE_STAGES);

  it('forbidden list does not intersect any stage; pty.input/resize are in none', () => {
    for (const st of stages) {
      for (const name of [...st.methods, ...st.notifications, ...st.events]) {
        expect(isRemoteForbidden(name), name).toBe(false);
        expect(REMOTE_FORBIDDEN).not.toContain(name);
      }
      expect(st.methods).not.toContain('pty.input');
      expect(st.notifications).not.toContain('pty.input');
      expect(st.notifications).not.toContain('pty.resize');
    }
    expect(REMOTE_METHODS).toBe(REMOTE_STAGES.A.methods);
    expect(isRemoteForbidden('settings.get')).toBe(true);
    expect(isRemoteForbidden('pty.input')).toBe(true);
  });

  it('every listed name exists in the root protocol', () => {
    const m = METHODS as Record<string, unknown>;
    const n = NOTIFICATIONS as Record<string, unknown>;
    for (const st of stages) {
      for (const name of st.methods) expect(m, name).toHaveProperty([name]);
      for (const name of st.notifications) expect(n, name).toHaveProperty([name]);
    }
    // Compile-time counterpart: a renamed method or event breaks the build here.
    const methods = REMOTE_STAGES.C.methods satisfies readonly (keyof typeof METHODS)[];
    const notes = REMOTE_STAGES.C.notifications satisfies readonly (keyof typeof NOTIFICATIONS)[];
    const events = REMOTE_STAGES.C.events satisfies readonly (keyof Events)[];
    expect(methods.length + notes.length + events.length).toBeGreaterThan(0);
    expect(REMOTE_NOTIFICATIONS).toEqual([]);
    expect(REMOTE_EVENTS).toContain('works.changed');
  });

  it('stages are cumulative', () => {
    for (const x of REMOTE_STAGES.A.methods) expect(REMOTE_STAGES.B.methods).toContain(x);
    for (const x of REMOTE_STAGES.B.methods) expect(REMOTE_STAGES.C.methods).toContain(x);
  });

  it('rooms.resolveProposal needs rev', () => {
    const base = { projectPath: '/p', workId: 'w-1', roomId: 'r-1', proposalId: 'p', action: 'accept' };
    expect(checkRemoteParams('rooms.resolveProposal', base)).toBe(false);
    expect(checkRemoteParams('rooms.resolveProposal', { ...base, rev: 2 })).toBe(true);
    expect(checkRemoteParams('rooms.resolveProposal', { ...base, rev: '2' })).toBe(false);
    expect(checkRemoteParams('rooms.resolveProposal', null)).toBe(false);
    expect(checkRemoteParams('works.list', {})).toBe(true);
    expect(Object.keys(REMOTE_PARAM_RULES)).toContain('pty.send');
  });

  it('stage B text rules', () => {
    expect(checkRemoteParams('rooms.send', { kind: 'note', text: 'a' })).toBe(true);
    expect(checkRemoteParams('rooms.send', { kind: 'decision', text: 'a' })).toBe(false);
    expect(checkRemoteParams('rooms.send', { kind: 'note', text: 'я'.repeat(8193) })).toBe(false);
    expect(checkRemoteParams('rooms.send', { kind: 'note', text: 'я'.repeat(8192) })).toBe(true);
    expect(checkRemoteParams('pty.send', { text: 'a'.repeat(16385) })).toBe(false);
    expect(checkRemoteParams('pty.send', { text: 'a'.repeat(16384) })).toBe(true);
  });
});

describe('b64url', () => {
  it('round-trips and is strict', () => {
    for (let n = 0; n < 40; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      expect(b64urlDecode(b64urlEncode(b))).toEqual(b);
    }
    expect(b64urlEncode(Uint8Array.of(251, 255))).toBe('-_8');
    expect(() => b64urlDecode('AB=')).toThrow();
    expect(() => b64urlDecode('A+')).toThrow();
    expect(() => b64urlDecode('A')).toThrow();
    expect(() => b64urlDecode('AB')).toThrow(); // non-canonical trailing bits
  });
});

describe('pair url', () => {
  const k = bytes(32, 1);
  const s = bytes(16, 2);
  it('round-trips and stays small', () => {
    const url = buildPairUrl({ k, s, r: 'relay.example.com:8787' });
    expect(parsePairUrl(url)).toEqual({ k, s, r: 'relay.example.com:8787' });
    const long = buildPairUrl({ k, s, r: 'a'.repeat(30) });
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(150);
  });

  const good = (over: Record<string, string>) => {
    const f = { v: '1', k: b64urlEncode(k), s: b64urlEncode(s), r: 'relay.example.com', ...over };
    return `parley://pair?v=${f.v}&k=${f.k}&s=${f.s}&r=${f.r}`;
  };
  it('rejects bad input without echoing secrets', () => {
    expect(() => parsePairUrl(good({}))).not.toThrow();
    expect(() => parsePairUrl(good({ v: '2' }))).toThrow();
    expect(() => parsePairUrl(good({ k: b64urlEncode(bytes(31)) }))).toThrow();
    expect(() => parsePairUrl(good({ s: b64urlEncode(bytes(15)) }))).toThrow();
    expect(() => parsePairUrl(good({ s: b64urlEncode(bytes(17)) }))).toThrow();
    expect(() => parsePairUrl(good({ r: 'relay.example.com/path' }))).toThrow();
    expect(() => parsePairUrl(good({ r: 'user@relay.example.com' }))).toThrow();
    expect(() => parsePairUrl(good({ r: 'a'.repeat(65) }))).toThrow();
    expect(() => parsePairUrl(good({ r: 'a'.repeat(64) }))).not.toThrow();
    expect(() => parsePairUrl(good({ r: 'host:99999' }))).toThrow();
    expect(() => parsePairUrl('https://pair?v=1')).toThrow();
    expect(() => parsePairUrl(good({}) + '&x=1')).toThrow();
    expect(() => parsePairUrl(good({}) + '&s=AAAA')).toThrow();
    try {
      parsePairUrl(good({ v: '2' }));
    } catch (e) {
      expect(String(e)).not.toContain(b64urlEncode(s));
    }
  });
});

describe('relayUrlFor', () => {
  it.each(['192.168.1.5:8787', '10.0.0.2', '172.20.1.1', '169.254.1.1', 'mac.local'])('%s is local', r => {
    expect(relayUrlFor(r, { allowLocal: true })).toBe(`ws://${r}`);
    expect(() => relayUrlFor(r, { allowLocal: false })).toThrow();
  });
  it.each(['relay.example.com', '172.32.0.1', '172.15.0.1', '8.8.8.8:443'])('%s is public', r => {
    expect(relayUrlFor(r, { allowLocal: false })).toBe(`wss://${r}`);
    expect(relayUrlFor(r, { allowLocal: true })).toBe(`wss://${r}`);
  });
});

describe('schemas', () => {
  const id16 = b64urlEncode(bytes(16, 3));
  const id32 = b64urlEncode(bytes(32, 4));
  it('app frames', () => {
    expect(appRequestFrame.safeParse({ id: 'a', method: 'works.list' }).success).toBe(true);
    expect(appRequestFrame.safeParse({ id: 'x'.repeat(33), method: 'm' }).success).toBe(false);
  });
  it('bridge methods and events', () => {
    expect(bridgeMethodSchemas['push.register'].safeParse({ apnsToken: null, env: 'sandbox' }).success).toBe(true);
    expect(bridgeMethodSchemas['push.register'].safeParse({ apnsToken: 'zz', env: 'sandbox' }).success).toBe(false);
    expect(bridgeEventSchemas['session.closing'].safeParse({ reason: 'rekey' }).success).toBe(true);
    expect(bridgeEventSchemas['bridge.status'].safeParse({ host: 'incompatible', epoch: null }).success).toBe(true);
  });
  it('relay frames', () => {
    expect(hostHelloFrame.safeParse({ v: 1, t: 'hello', route: id16, secret: id32 }).success).toBe(true);
    expect(connectFrame.safeParse({ v: 1, t: 'connect', route: id16, device: id16, token: id32 }).success).toBe(true);
    expect(connectFrame.safeParse({ v: 1, t: 'connect', route: id16, device: id16, token: id16 }).success).toBe(false);
    expect(connectFrame.safeParse({ v: 1, t: 'connect', route: id16, device: id16, token: id32, x: 1 }).success).toBe(false);
  });
  it('pairing payloads', () => {
    expect(pairMsg1Payload.safeParse({ v: 1, name: 'iPhone', platform: 'ios', app: '1.0.0' }).success).toBe(true);
    expect(pairMsg2Payload.safeParse({ v: 1 }).success).toBe(true);
    expect(pairMsg2Payload.safeParse({ v: 1, hostName: 'Mac' }).success).toBe(false);
    expect(
      pairCredentialsFrame.safeParse({
        t: 'credentials', hostId: 'h', hostName: 'Mac', deviceId: id16, routeId: id16, relayToken: id32, relays: ['r.example.com'],
      }).success,
    ).toBe(true);
    expect(pairAnswerParams.safeParse({ requestId: id16, allow: true }).success).toBe(true);
    expect(pairAnswerParams.safeParse({ allow: true }).success).toBe(false);
  });
  it('push gateway is strict', () => {
    const body = { v: 1, token: 'ab'.repeat(32), env: 'production', count: 3, route: id16 };
    expect(pushRequestSchema.safeParse(body).success).toBe(true);
    expect(pushRequestSchema.safeParse({ ...body, text: 'hi' }).success).toBe(false);
    expect(pushRequestSchema.safeParse({ ...body, env: 'dev' }).success).toBe(false);
    expect(pushDataSchema.safeParse({ v: 1, kind: 'needs-you', count: 3, route: id16 }).success).toBe(true);
    expect(pushDataSchema.safeParse({ v: 1, kind: 'other', count: 3, route: id16 }).success).toBe(false);
  });
});

describe('built entry', () => {
  const dist = resolve(here, '../../dist/remote');
  it('imports with Buffer deleted and has a clean import graph', () => {
    expect(existsSync(join(dist, 'index.js')), 'run `pnpm --filter @parley/protocol build` first').toBe(true);
    const url = pathToFileURL(join(dist, 'index.js')).href;
    const script = `delete globalThis.Buffer;
if (globalThis.Buffer !== undefined) throw new Error('Buffer still present');
const m = await import(${JSON.stringify(url)});
const u = m.buildPairUrl({ k: new Uint8Array(32).fill(1), s: new Uint8Array(16).fill(2), r: 'relay.example.com' });
const p = m.parsePairUrl(u);
if (p.r !== 'relay.example.com' || p.k.length !== 32) throw new Error('parse failed');
console.log('ok');`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(out.trim()).toBe('ok');

    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.js') ? [join(d, e.name)] : [],
      );
    const files = walk(dist);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
        const spec = m[1]!;
        expect(spec.startsWith('node:'), `${f}: ${spec}`).toBe(false);
        expect(spec.endsWith('framing.js'), `${f}: ${spec}`).toBe(false);
        if (spec.startsWith('.')) {
          expect(resolve(dirname(f), spec).startsWith(dist), `${f}: ${spec}`).toBe(true);
        } else expect(spec).toBe('zod');
      }
    }
  });
});
