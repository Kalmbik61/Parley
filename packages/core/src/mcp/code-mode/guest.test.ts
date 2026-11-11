import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GUEST_LIMITS, type GuestBridge, type GuestCall, type GuestLimits, type GuestReply, PHYSICAL_MAXIMA, guestLimitsProblem, runGuest } from './guest.js';

/** A fixture bridge: answers each call with `answer(call)` after `latencyMs`, and records every call it saw. */
function fixtureBridge(answer: (c: GuestCall) => GuestReply | null = (c) => ({ rid: c.rid, ok: true, value: JSON.stringify({ method: c.method, args: JSON.parse(c.args) as unknown }) }), latencyMs = 0) {
  const calls: GuestCall[] = [];
  const ready: GuestReply[] = [];
  const waiters: ((r: GuestReply) => void)[] = [];
  const bridge: GuestBridge = {
    send(call) {
      calls.push(call);
      const reply = answer(call);
      if (reply === null) return; // never settles
      setTimeout(() => { const w = waiters.shift(); if (w) w(reply); else ready.push(reply); }, latencyMs);
    },
    next(timeoutMs) {
      const r = ready.shift();
      if (r) return Promise.resolve(r);
      return new Promise((resolve) => {
        const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); resolve(null); }, timeoutMs);
        const w = (x: GuestReply): void => { clearTimeout(t); resolve(x); };
        waiters.push(w);
      });
    },
  };
  return { bridge, calls };
}

const run = (code: string, opts: { limits?: Partial<GuestLimits>; methods?: string[]; answer?: Parameters<typeof fixtureBridge>[0]; latencyMs?: number } = {}) => {
  const f = fixtureBridge(opts.answer, opts.latencyMs);
  return runGuest(code, opts.methods ?? ['get_map', 'read_room'], { ...GUEST_LIMITS, ...opts.limits }, f.bridge).then((outcome) => ({ outcome, calls: f.calls }));
};

describe('guest: one async script, one capability', () => {
  it('awaits fixture reads and returns JSON text; handles are disposed', async () => {
    const { outcome, calls } = await run('const a = await parley.get_map({ session: "s-01" }); return { got: a.method, n: 1 };', { latencyMs: 5 });
    expect(outcome).toMatchObject({ ok: true, value: '{"got":"get_map","n":1}', rpcs: 1, unsettled: [], disposed: true });
    expect(calls).toEqual([{ rid: 1, method: 'get_map', args: '{"session":"s-01"}' }]);
  });

  it('runs at most two calls in flight and settles them all', async () => {
    const { outcome, calls } = await run('const r = await Promise.all([1,2,3,4].map((i) => parley.read_room({ room: "r-" + i }))); return r.length;', { latencyMs: 10 });
    expect(outcome).toMatchObject({ ok: true, value: '4', rpcs: 4, unsettled: [] });
    expect(calls.map((c) => c.rid)).toEqual([1, 2, 3, 4]);
  });

  it('active time excludes awaited host latency', async () => {
    const started = Date.now();
    const { outcome } = await run('await parley.get_map({}); await parley.get_map({}); return 1;', { latencyMs: 300, limits: { activeMs: 200 } });
    expect(outcome.ok).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
    expect(outcome.activeMs).toBeLessThan(200);
  });

  it('a host error rejects the guest promise and the script may catch it', async () => {
    const { outcome } = await run('try { await parley.get_map({}); } catch (e) { return "caught " + e.message; }', { answer: (c) => ({ rid: c.rid, ok: false, value: 'denied' }) });
    expect(outcome).toMatchObject({ ok: true, value: '"caught denied"' });
  });
});

describe('guest: refusals before any dispatch', () => {
  const syntaxCases: [string, string][] = [
    ['static import', 'import fs from "fs"; return 1;'],
    ['static export', 'export const x = 1;'],
    ['unterminated', 'return (1 + ;'],
    ['TypeScript annotation', 'const x: number = 1; return x;'],
  ];
  it.each(syntaxCases)('%s is a syntax error with zero calls', async (_label, code) => {
    const { outcome, calls } = await run(`await parley.get_map({}); ${code}`);
    expect(outcome).toMatchObject({ ok: false, error: { kind: 'syntax' }, rpcs: 0 });
    expect(calls).toHaveLength(0);
  });

  it('refuses oversized code, a bad method list and a bad memory limit before creating a runtime', async () => {
    expect((await run('x'.repeat(GUEST_LIMITS.codeBytes + 1))).outcome).toMatchObject({ ok: false, error: { kind: 'protocol', message: 'code too large' } });
    expect((await run('return 1', { methods: ['Get-Map'] })).outcome).toMatchObject({ ok: false, error: { kind: 'protocol' } });
    expect((await run('return 1', { limits: { memoryBytes: 1000 } })).outcome).toMatchObject({ ok: false, error: { kind: 'protocol' } });
  });

  it.each([
    ['memory above 48 MiB', { memoryBytes: 64 * 1024 * 1024 }, 'memoryBytes above the 48 MiB maximum'],
    ['memory of 2 GiB', { memoryBytes: 32768 * 65536 }, 'memoryBytes above the 48 MiB maximum'],
    ['stack above 128 KiB', { stackBytes: 256 * 1024 }, 'stackBytes above the 128 KiB maximum'],
    ['a fractional limit', { activeMs: 0.5 }, 'activeMs must be a positive safe integer'],
    ['a NaN limit', { wallMs: Number.NaN }, 'wallMs must be a positive safe integer'],
    ['an extra key', { extra: 1 } as Partial<GuestLimits>, 'limits must have exactly the known keys'],
  ])('refuses %s before allocating (physical maxima, F6)', async (_label, limits, message) => {
    const { outcome, calls } = await run('return 1', { limits });
    expect(outcome).toMatchObject({ ok: false, error: { kind: 'protocol', message: `bad limits: ${message}` }, rpcs: 0 });
    expect(calls).toHaveLength(0);
  });

  it('accepts lower limits within the maxima', async () => {
    expect((await run('return 1', { limits: { memoryBytes: 16 * 1024 * 1024, stackBytes: 32 * 1024 } })).outcome).toMatchObject({ ok: true, value: '1' });
    expect(PHYSICAL_MAXIMA).toEqual({ memoryBytes: 48 * 1024 * 1024, stackBytes: 128 * 1024 });
    expect(guestLimitsProblem(GUEST_LIMITS)).toBeNull();
  });
});

describe('guest: owned snapshots (A4)', () => {
  it('changes to the caller method list and limits after the call do not reach the run', async () => {
    const f = fixtureBridge();
    const methods = ['get_map'];
    const limits: GuestLimits = { ...GUEST_LIMITS, activeMs: 2000 };
    const pending = runGuest('const t = Date.now(); while (Date.now() - t < 150) {} return [typeof parley.report, Object.keys(parley)];', methods, limits, f.bridge);
    // Mutated synchronously after the call, i.e. while runGuest awaits the WASM module.
    methods.push('report');
    (limits as { activeMs: number }).activeMs = 1;
    (limits as { stackBytes: number }).stackBytes = 256 * 1024;
    (limits as { memoryBytes: number }).memoryBytes = 64 * 1024 * 1024;
    const outcome = await pending;
    expect(outcome).toMatchObject({ ok: true, value: '["undefined",["get_map"]]' });
  });
});

describe('guest: no ambient capability', () => {
  const absent = ['process', 'require', 'module', 'globalThis.fetch', 'globalThis.XMLHttpRequest', 'globalThis.WebAssembly', 'globalThis.Deno', 'globalThis.Bun', 'globalThis.std', 'globalThis.os', 'globalThis.__rpc', 'globalThis.eval', 'globalThis.Function', 'globalThis.setTimeout'];
  it.each(absent)('%s is not reachable', async (name) => {
    const { outcome } = await run(`return typeof ${name};`);
    expect(outcome).toMatchObject({ ok: true, value: '"undefined"' });
  });

  it('eval, every Function constructor and dynamic import fail inside the guest', async () => {
    const cases = [
      '(0, function(){}.constructor)("return 1")',
      '(async function(){}).constructor("return 1")',
      '(function*(){}).constructor("yield 1")',
      '(async function*(){}).constructor("yield 1")',
      'eval("1")',
    ];
    for (const c of cases) {
      const { outcome } = await run(`try { ${c}; return "reached"; } catch (e) { return "blocked"; }`);
      expect(outcome, c).toMatchObject({ ok: true, value: '"blocked"' });
    }
    const imp = await run('try { await import("fs"); return "loaded"; } catch (e) { return "blocked"; }');
    expect(imp.outcome).toMatchObject({ ok: true, value: '"blocked"' });
  });

  it('parley is frozen and exposes only the allowed methods', async () => {
    const { outcome, calls } = await run('parley.get_map = null; parley.report = 1; return [Object.keys(parley).sort(), Object.isFrozen(parley), typeof parley.report];');
    expect(outcome).toMatchObject({ ok: true, value: '[["get_map","read_room"],true,"undefined"]' });
    expect(calls).toHaveLength(0);
  });

  it('an unknown method name through a computed access is refused without a call', async () => {
    const { outcome, calls } = await run('const m = "re" + "port"; try { await parley[m]({}); } catch (e) { return e instanceof TypeError; }');
    expect(outcome).toMatchObject({ ok: true, value: 'true' });
    expect(calls).toHaveLength(0);
  });
});

describe('guest: resource bounds', () => {
  it('an infinite loop is interrupted by the active-time bound', async () => {
    const started = Date.now();
    const { outcome } = await run('for (;;) {}', { limits: { activeMs: 100 } });
    expect(outcome).toMatchObject({ ok: false, error: { kind: 'interrupted' }, disposed: true });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('an infinite loop after an await is interrupted too, with the earlier call audited', async () => {
    const { outcome, calls } = await run('await parley.get_map({}); for (;;) {}', { limits: { activeMs: 100 } });
    expect(outcome).toMatchObject({ ok: false, error: { kind: 'interrupted' }, rpcs: 1, unsettled: [] });
    expect(calls).toHaveLength(1);
  });

  it('deep recursion hits the 128 KiB guest stack, not the host', async () => {
    const { outcome } = await run('const f = (n) => f(n + 1) + 1; return f(0);');
    expect(outcome).toMatchObject({ ok: false, error: { kind: 'runtime' } });
    expect(outcome.error!.message).toMatch(/stack|recursion/i);
  });

  it('memory growth stops at the WASM maximum and the host survives', async () => {
    const { outcome } = await run('const a = []; for (;;) a.push("x".repeat(1 << 20) + a.length);', { limits: { activeMs: 20_000 } });
    expect(outcome.ok).toBe(false);
    expect(['memory', 'runtime']).toContain(outcome.error!.kind);
    // The host process is still healthy: a fresh guest runs.
    expect((await run('return 2')).outcome).toMatchObject({ ok: true, value: '2' });
  }, 30_000);

  it('a call the host never settles is reported unsettled at the wall deadline', async () => {
    const { outcome } = await run('await parley.get_map({}); return 1;', { answer: () => null, limits: { wallMs: 200 } });
    expect(outcome).toMatchObject({ ok: false, error: { kind: 'wall-time' }, unsettled: [1], disposed: true });
  });

  it('awaiting nothing the host can settle is a deadlock, not a hang', async () => {
    const { outcome } = await run('await new Promise(() => {}); return 1;');
    expect(outcome).toMatchObject({ ok: false, error: { kind: 'deadlock' } });
  });

  it('call budget, argument size and result size are enforced in the guest', async () => {
    const budget = await run('let n = 0; for (let i = 0; i < 40; i++) { try { await parley.get_map({}); n++; } catch { break; } } return n;');
    expect(budget.outcome).toMatchObject({ ok: true, value: '32', rpcs: 32 });
    const big = await run(`try { await parley.get_map({ a: "x".repeat(${GUEST_LIMITS.argBytes}) }); } catch (e) { return e.message; }`);
    expect(big.outcome).toMatchObject({ ok: true, value: '"parley: arguments too large"', rpcs: 0 });
    const result = await run(`return "x".repeat(${GUEST_LIMITS.resultBytes});`);
    expect(result.outcome).toMatchObject({ ok: false, error: { kind: 'result-size', message: 'result too large' } });
  });

  it('the result budget counts the JSON text: exactly resultBytes passes, one byte more is a typed result-size error', async () => {
    // the JSON text of a string is the string plus its two quotes
    const exact = await run(`return "x".repeat(${GUEST_LIMITS.resultBytes - 2});`);
    expect(exact.outcome.ok).toBe(true);
    expect(Buffer.byteLength(exact.outcome.value as string, 'utf8')).toBe(GUEST_LIMITS.resultBytes);
    const over = await run(`return "x".repeat(${GUEST_LIMITS.resultBytes - 1});`);
    expect(over.outcome).toMatchObject({ ok: false, error: { kind: 'result-size' } });
    expect(over.outcome.value).toBeUndefined();
    // a value that is not a string at the end (a function has no JSON text) stays the old kind
    const none = await run('return () => 1;');
    expect(none.outcome.ok === false ? none.outcome.error?.kind : null).not.toBe('result-size');
  });
});

describe('refused: what the guest answered without the parent (T7a-guest-floor)', () => {
  const CLEAN = { operations: 0, argumentBytes: 0, responseBytes: 0, notSerializable: 0, notParsed: 0 };
  const caught = (expr: string): string => `try { await ${expr}; return "read"; } catch (e) { return e.message; }`;

  it('nothing refused: every count is zero, on a clean run and on the early returns', async () => {
    expect((await run('return (await parley.get_map({})).method;')).outcome).toMatchObject({ ok: true, refused: CLEAN });
    expect(await runGuest('x'.repeat(GUEST_LIMITS.codeBytes + 1), ['get_map'], GUEST_LIMITS, fixtureBridge().bridge)).toMatchObject({ ok: false, refused: CLEAN });
    expect(await runGuest('return 1', ['BAD NAME'], GUEST_LIMITS, fixtureBridge().bridge)).toMatchObject({ ok: false, refused: CLEAN });
    expect(await runGuest(1 as unknown as string, ['get_map'], GUEST_LIMITS, fixtureBridge().bridge)).toMatchObject({ ok: false, refused: CLEAN });
    expect(await runGuest('return 1', ['get_map'], { ...GUEST_LIMITS, maxRpcs: 0 }, fixtureBridge().bridge)).toMatchObject({ ok: false, refused: CLEAN });
  });

  it('the call budget: counted once per refusal, and a refusal does not move rpcs', async () => {
    const { outcome, calls } = await run('let n = 0; for (let i = 0; i < 40; i++) { try { await parley.get_map({}); } catch { n++; } } return n;');
    expect(outcome).toMatchObject({ ok: true, value: '8', rpcs: 32, unsettled: [], refused: { ...CLEAN, operations: 8 } });
    expect(calls).toHaveLength(32);
  });

  it('argument size: counted, nothing sent', async () => {
    const { outcome, calls } = await run(caught(`parley.get_map({ a: "x".repeat(${GUEST_LIMITS.argBytes}) })`));
    expect(outcome).toMatchObject({ ok: true, value: '"parley: arguments too large"', rpcs: 0, refused: { ...CLEAN, argumentBytes: 1 } });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['a function', 'parley.get_map(() => 1)'],
    ['a symbol', 'parley.get_map(Symbol("s"))'],
    ['toJSON returning undefined', 'parley.get_map({ toJSON() { return undefined; } })'],
  ])('arguments that stringify to nothing (%s): counted, nothing sent', async (_name, expr) => {
    const { outcome, calls } = await run(caught(expr));
    expect(outcome).toMatchObject({ ok: true, value: '"parley: unknown method"', rpcs: 0, refused: { ...CLEAN, notSerializable: 1 } });
    expect(calls).toHaveLength(0);
  });

  it('the guest cut a reply at its own response budget: counted, and the script only saw a refusal', async () => {
    const { outcome } = await run(caught('parley.get_map({})'), { limits: { responseBytes: 10 }, answer: (c) => ({ rid: c.rid, ok: true, value: JSON.stringify({ pad: 'x'.repeat(100) }) }) });
    expect(outcome).toMatchObject({ ok: true, value: '"parley: response budget exhausted"', rpcs: 1, refused: { ...CLEAN, responseBytes: 1 } });
  });

  it('several reasons in one run are counted apart', async () => {
    const { outcome } = await run(`for (const a of [() => 1, () => 2, { a: "x".repeat(${GUEST_LIMITS.argBytes}) }]) { try { await parley.get_map(a); } catch {} } return 1;`);
    expect(outcome).toMatchObject({ ok: true, refused: { ...CLEAN, argumentBytes: 1, notSerializable: 2 } });
  });

  it('the count is out of the script\'s reach: a replaced JSON.stringify is one more refusal, and no global can lower it', async () => {
    const { outcome } = await run(`JSON.stringify = () => 5; try { await parley.get_map({}); } catch {} globalThis.refused = {}; globalThis.__rpc = () => 0; return 1;`);
    expect(outcome.refused).toEqual({ ...CLEAN, notSerializable: 1 });
    const again = await run('return typeof __rpc + typeof refused;');
    expect(again.outcome).toMatchObject({ ok: true, value: '"undefinedundefined"', refused: CLEAN });
  });

  it.each([
    ['a cycle', 'const a = {}; a.a = a; ', 'parley.get_map(a)'],
    ['a BigInt', '', 'parley.get_map({ n: 1n })'],
    ['a throwing getter', '', 'parley.get_map({ get a() { throw new Error("g"); } })'],
    ['a throwing toJSON', '', 'parley.get_map({ toJSON() { throw new Error("t"); } })'],
    ['a method that does not exist', '', 'parley.write_x({})'],
  ])('named residual, the script\'s own error with no call formed (%s): not counted', async (_name, pre, expr) => {
    const { outcome, calls } = await run(`${pre}${caught(expr)}`);
    expect(outcome).toMatchObject({ ok: true, rpcs: 0, unsettled: [], refused: CLEAN });
    expect(calls).toHaveLength(0);
  });

  it('a parsed reply is acknowledged, one per reply, including one the script ignored after the parse', async () => {
    expect((await run('await parley.get_map({}); await parley.get_map({}); return 1;')).outcome).toMatchObject({ ok: true, refused: CLEAN });
  });

  it('a parse that fails for lack of memory is not acknowledged, whatever the script does with the error', async () => {
    const value = JSON.stringify({ ok: true, value: Array.from({ length: 25000 }, (_, i) => ({ i, s: 'abcdefgh' })) });
    const { outcome } = await run('const hog = []; try { for (;;) hog.push("x".repeat(1 << 16)); } catch {} hog.length = Math.max(0, hog.length - 16); let m = "none"; try { await parley.get_map({}); m = "read"; } catch { m = "caught"; } hog.length = 0; return m;', { answer: (c) => ({ rid: c.rid, ok: true, value }) });
    expect(outcome).toMatchObject({ ok: true, value: '"caught"', refused: { ...CLEAN, notParsed: 1 } });
  });

  it('the script cannot acknowledge: the name is gone, a replaced JSON.parse is not asked, and a replaced then never gets the callback', async () => {
    expect((await run('return typeof __parsed + typeof __rpc;')).outcome).toMatchObject({ value: '"undefinedundefined"' });
    const parse = await run('JSON.parse = () => ({ forged: true }); const r = await parley.get_map({}); return r.forged === undefined && r.method === "get_map";');
    expect(parse.outcome).toMatchObject({ ok: true, value: 'true', refused: CLEAN });
    const then = await run('const o = Promise.prototype.then; let got = 0; Promise.prototype.then = function (f, r) { got++; return o.call(this, f, r); }; const p = parley.get_map({}); Promise.prototype.then = o; await p; return got;');
    expect(then.outcome).toMatchObject({ ok: true, value: '0', refused: CLEAN });
    const apply = await run('const o = Reflect.apply; let got = 0; Reflect.apply = function (f, t, a) { got++; return o(f, t, a); }; const p = parley.get_map({}); Reflect.apply = o; await p; return got;');
    expect(apply.outcome).toMatchObject({ ok: true, value: '0', refused: CLEAN });
  });

  it('a reply the guest refused to deliver is not owed an acknowledgement, and a refusal from the parent neither', async () => {
    const cut = await run(caught('parley.get_map({})'), { limits: { responseBytes: 10 }, answer: (c) => ({ rid: c.rid, ok: true, value: JSON.stringify({ pad: 'x'.repeat(100) }) }) });
    expect(cut.outcome).toMatchObject({ refused: { ...CLEAN, responseBytes: 1 } });
    const failed = await run(caught('parley.get_map({})'), { answer: (c) => ({ rid: c.rid, ok: false, value: 'parley: refused' }) });
    expect(failed.outcome).toMatchObject({ ok: true, value: '"parley: refused"', refused: CLEAN });
  });

  it.each([
    ['memory', 'const hog = []; try { for (;;) hog.push("x".repeat(1 << 16)); } catch {} hog.length = 0; return 1;'],
    ['stack', 'function f() { return f() + 1; } try { f(); } catch {} return 1;'],
  ])('named residual: a %s overflow the script caught, with no read involved, is not counted', async (_name, code) => {
    expect((await run(code)).outcome).toMatchObject({ ok: true, value: '1', rpcs: 0, refused: CLEAN });
  });

  it('moderately deep arguments form a call as usual (the deep case is a named residual, pinned on the real helper: this process has another stack)', async () => {
    const { outcome } = await run(`let d = {}; for (let i = 0; i < 3000; i++) d = { d }; ${caught('parley.get_map(d)')}`);
    expect(outcome).toMatchObject({ ok: true, value: '"read"', rpcs: 1, refused: CLEAN });
  });

  describe('Promise species cannot acknowledge or hide a parse (s-290 m-6109)', () => {
    const SEEN = 'let seen = []; class P extends Promise { constructor(ex) { super((res, rej) => { ex((v) => { seen.push(typeof v); res(v); }, (e) => { seen.push("rejected"); rej(e); }); }); } } ';
    it('a replaced constructor sees the parsed value through its own resolve, never the string or the callback', async () => {
      const { outcome } = await run(`${SEEN}const o = Promise.prototype.constructor; Promise.prototype.constructor = P; const r = await parley.get_map({}); Promise.prototype.constructor = o; return { first: seen[0], method: r.method };`);
      expect(outcome).toMatchObject({ ok: true, value: '{"first":"object","method":"get_map"}', refused: CLEAN });
    });

    it('so does a Symbol.species getter', async () => {
      const { outcome } = await run(`${SEEN}Object.defineProperty(Promise, Symbol.species, { get() { return P; } }); const r = await parley.get_map({}); return { first: seen[0], method: r.method };`);
      expect(outcome).toMatchObject({ ok: true, value: '{"first":"object","method":"get_map"}', refused: CLEAN });
    });

    it('a species that swallows the rejection of a failed parse still leaves it unacknowledged', async () => {
      const value = JSON.stringify({ ok: true, value: Array.from({ length: 25000 }, (_, i) => ({ i, s: 'abcdefgh' })) });
      const { outcome } = await run('class S extends Promise { constructor(ex) { super((a) => { ex(a, () => a("suppressed")); }); } } const hog = []; try { for (;;) hog.push("x".repeat(1 << 16)); } catch {} hog.length = Math.max(0, hog.length - 16); const o = Promise.prototype.constructor; Promise.prototype.constructor = S; let m; try { m = await parley.get_map({}); } catch { m = "caught"; } Promise.prototype.constructor = o; hog.length = 0; return m;', { answer: (c) => ({ rid: c.rid, ok: true, value }) });
      expect(outcome).toMatchObject({ ok: true, value: '"suppressed"', refused: { ...CLEAN, notParsed: 1 } });
    });

    it('a species that never settles, raced away: the call stays in `unsettled`', async () => {
      const { outcome } = await run('class N extends Promise { constructor(ex) { super(() => { ex(() => {}, () => {}); }); } } const o = Promise.prototype.constructor; Promise.prototype.constructor = N; const p = parley.get_map({}); Promise.prototype.constructor = o; return await Promise.race([p, Promise.resolve("raced")]);', { answer: () => null });
      expect(outcome).toMatchObject({ ok: true, value: '"raced"', unsettled: [1], refused: CLEAN });
    });

    it('the wrapper gives nothing away: caller and arguments throw', async () => {
      const { outcome } = await run('const f = parley.get_map; try { return String(f.caller) + String(f.arguments); } catch { return "threw"; }');
      expect(outcome).toMatchObject({ ok: true, value: '"threw"', refused: CLEAN });
    });
  });

  it('calls the script left behind are in `unsettled`, the queued one included, and were not refused', async () => {
    const { outcome, calls } = await run('parley.get_map({}); parley.get_map({}); parley.get_map({}); return 1;', { answer: () => null });
    expect(outcome).toMatchObject({ ok: true, rpcs: 3, unsettled: [1, 2, 3], refused: CLEAN });
    expect(calls).toHaveLength(2);
  });
});

describe('static dependency check: no node:os in the helper graph', () => {
  const OS_IMPORT = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:node:)?os["']/;
  const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : /\.(m?js|cjs)$/.test(n) ? [p] : [];
  });

  it('guest.ts and helper-entry.ts import no os module', () => {
    for (const f of ['guest.ts', 'helper-entry.ts']) expect(readFileSync(new URL(f, import.meta.url), 'utf8'), f).not.toMatch(OS_IMPORT);
  });

  it('the resolved QuickJS packages import no os module', () => {
    // Package roots from each resolved entry (their exports maps hide package.json).
    const root = (from: string, name: string): string => {
      for (let d = path.dirname(realpathSync(createRequire(from).resolve(name))); d !== path.dirname(d); d = path.dirname(d)) {
        if (existsSync(path.join(d, 'package.json')) && (JSON.parse(readFileSync(path.join(d, 'package.json'), 'utf8')) as { name?: string }).name === name) return d;
      }
      throw new Error(name);
    };
    const here = fileURLToPath(new URL('guest.ts', import.meta.url));
    const core = root(here, 'quickjs-emscripten-core');
    const sync = root(here, '@jitl/quickjs-wasmfile-release-sync');
    const ffi = root(path.join(core, 'package.json'), '@jitl/quickjs-ffi-types');
    const files = [core, ffi, sync].flatMap(filesUnder);
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(OS_IMPORT);
  });
});
