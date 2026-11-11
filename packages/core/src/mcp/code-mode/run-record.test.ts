// The durable run record (plan T7a-sleep): the classifier in-process, with the process view replaced; then real processes, a real helper
// and real signals, because the point is what is left once a process has gone.

import { type ChildProcess, execFileSync, fork, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ProcessProbe, REAL_PROBE, RECORD_MAX_BYTES, createRunRecordStore, runRecordPath } from './run-record.js';

const NONCE = 'a'.repeat(32);
const HOLDER = 4242;
const START = 1_800_000_000;
const SHA = 'b'.repeat(64);
const roots: string[] = [];
const newRoot = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'parley-t7a-run-')); roots.push(d); return d; };
afterAll(() => { for (const d of roots) { try { chmodSync(path.join(d, 'code-mode'), 0o700); } catch { /* none */ } rmSync(d, { recursive: true, force: true }); } });

let workDir: string;
let file: string;
beforeEach(() => {
  workDir = newRoot();
  file = runRecordPath(workDir, 's-1');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
});

const header = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ v: 1, runId: 'run-1-1', launchId: 'l', pid: HOLDER, startedAt: START, nonce: NONCE, at: 't', ...over });
const plant = (...lines: unknown[]): void => { writeFileSync(file, lines.map((l) => `${typeof l === 'string' ? l : JSON.stringify(l)}\n`).join(''), { mode: 0o600 }); };
const intent = (o: number): unknown => ({ o, m: 'get_map', a: SHA });
const done = (o: number, s: string): unknown => ({ o, s });
/** The holder's process as this store would see it. */
const probe = (alive: boolean, startedAt: number | null = START): ProcessProbe => ({ alive: () => alive, startedAt: (pid) => (pid === process.pid ? 99 : startedAt) });
const DEAD = probe(false);
const ALIVE = probe(true);
const store = (p: ProcessProbe = DEAD, session = 's-1') => createRunRecordStore({ workDir, sessionId: session, launchId: 'l' }, p);
const firstLine = (): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8').split('\n')[0]!) as Record<string, unknown>;

describe('the record is created, written and released by its holder', () => {
  it('created exclusively, mode 0600, naming the run, this process and its start time; released by unlink', () => {
    const s = store();
    const o = s.open('run-9-1');
    expect(o.ok).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(firstLine()).toMatchObject({ v: 1, runId: 'run-9-1', launchId: 'l', pid: process.pid, startedAt: 99 });
    expect(firstLine()['nonce']).toMatch(/^[0-9a-f]{32}$/);
    if (o.ok) o.handle.release();
    expect(existsSync(file)).toBe(false);
  });

  it('an intent line is on disk when intent returns, with the method and the hash and nothing else; only for the open run', () => {
    const s = store();
    const o = s.open('run-9-1');
    expect(s.intent('run-other', 1, 'get_map', SHA)).toBe(false);
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
    expect(s.intent('run-9-1', 1, 'get_map', SHA)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8').split('\n')[1]!)).toEqual({ o: 1, m: 'get_map', a: SHA });
    if (o.ok) o.handle.release();
    expect(s.intent('run-9-1', 2, 'get_map', SHA)).toBe(false);
  });

  it('sync writes each terminal state once, skips an entry still being decided, and writes cleanup unknown once', () => {
    const s = store();
    const o = s.open('run-9-1');
    if (!o.ok) throw new Error('open');
    const entries = [{ ordinal: 1, state: 'dispatched', refusal: null }, { ordinal: 2, state: 'refused', refusal: null }];
    o.handle.sync({ entries, cleanupUnknown: false });
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
    const later = [{ ordinal: 1, state: 'unknown', refusal: null }, { ordinal: 2, state: 'refused', refusal: 'policy' }];
    o.handle.sync({ entries: later, cleanupUnknown: true });
    o.handle.sync({ entries: later, cleanupUnknown: true });
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(1).map((l) => JSON.parse(l) as unknown)).toEqual([{ o: 1, s: 'unknown' }, { o: 2, s: 'refused' }, { cleanup: 'unknown' }]);
  });

  it('a bad session id or work directory refuses at construction, so a broker cannot run without a record', () => {
    for (const sessionId of ['', '../x', 'S-1', 'a/b', 'a.b']) expect(() => createRunRecordStore({ workDir, sessionId, launchId: 'l' }), sessionId).toThrow(TypeError);
    expect(() => createRunRecordStore({ workDir: '', sessionId: 's-1', launchId: 'l' })).toThrow(TypeError);
  });

  it.each([0o755, 0o750, 0o705, 0o770])('an existing code-mode directory with mode %o: busy whatever is in it, nothing created, the mode left alone (T7b-rr)', (mode) => {
    const dir = path.dirname(file);
    chmodSync(dir, mode);
    expect(store().open('r')).toEqual({ ok: false, busy: 'run-record-unavailable' });
    expect(readdirSync(dir)).toEqual([]);
    plant(header());
    expect(store().open('r')).toEqual({ ok: false, busy: 'run-record-unavailable' });
    expect(statSync(dir).mode & 0o777).toBe(mode);
    expect(readdirSync(dir)).toEqual(['s-1.run']);
  });

  it('a symlinked code-mode directory: busy, nothing lands in its target, and a record behind it is not believed (T7b-rr)', () => {
    const elsewhere = path.join(newRoot(), 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    rmSync(path.dirname(file), { recursive: true });
    symlinkSync(elsewhere, path.dirname(file));
    expect(store().open('r')).toEqual({ ok: false, busy: 'run-record-unavailable' });
    expect(readdirSync(elsewhere)).toEqual([]);
    writeFileSync(path.join(elsewhere, 's-1.run'), `${JSON.stringify(header())}\n`);
    expect(store().open('r')).toEqual({ ok: false, busy: 'run-record-unavailable' });
    expect(readFileSync(path.join(elsewhere, 's-1.run'), 'utf8')).toBe(`${JSON.stringify(header())}\n`);
  });

  it('a directory the store makes itself is 0700', () => {
    const wd = newRoot();
    const o = createRunRecordStore({ workDir: wd, sessionId: 's-1', launchId: 'l' }, DEAD).open('r');
    expect(o.ok).toBe(true);
    expect(statSync(path.join(wd, 'code-mode')).mode & 0o777).toBe(0o700);
  });

  it('a directory that cannot be written: busy, nothing created', () => {
    const parent = newRoot();
    chmodSync(parent, 0o500);
    try {
      const s = createRunRecordStore({ workDir: parent, sessionId: 's-1', launchId: 'l' }, DEAD);
      expect(s.open('r')).toEqual({ ok: false, busy: 'run-record-unavailable' });
    } finally { chmodSync(parent, 0o700); }
  });
});

describe('what a later process finds (the classifier)', () => {
  const unaccounted: [string, unknown[]][] = [
    ['an intent with no terminal line', [intent(1)]],
    ['an unknown line', [intent(1), done(1, 'unknown')]],
    ['one intent settled and one not', [intent(1), done(1, 'succeeded'), intent(2)]],
    ['cleanup unknown, whatever the calls say (s-296 B2)', [intent(1), done(1, 'succeeded'), { cleanup: 'unknown' }]],
    ['cleanup unknown with no calls', [{ cleanup: 'unknown' }]],
  ];
  it.each(unaccounted)('%s, holder dead: previous-process-unaccounted, and the file stays', (_name, lines) => {
    plant(header(), ...lines);
    const before = readFileSync(file, 'utf8');
    expect(store().open('r')).toEqual({ ok: false, busy: 'previous-process-unaccounted' });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it.each([...unaccounted, ['nothing dispatched', []] as [string, unknown[]], ['all accounted', [intent(1), done(1, 'succeeded')]] as [string, unknown[]]])('%s, holder alive: held-by-other-process, and the file stays', (_name, lines) => {
    plant(header(), ...lines);
    const before = readFileSync(file, 'utf8');
    expect(store(ALIVE).open('r')).toEqual({ ok: false, busy: 'held-by-other-process' });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  const accounted: [string, unknown[]][] = [
    ['nothing dispatched', []],
    ...['succeeded', 'failed', 'cancelled', 'unread', 'refused'].map((s): [string, unknown[]] => [`one call, ${s}`, [intent(1), done(1, s)]]),
    ['a refused line with no intent', [done(3, 'refused')]],
  ];
  it.each(accounted)('%s, holder dead: reclaimed, the new record is ours, no claim left', (_name, lines) => {
    plant(header(), ...lines);
    expect(store().open('r').ok).toBe(true);
    expect(firstLine()).toMatchObject({ runId: 'r', pid: process.pid });
    expect(readdirSync(path.dirname(file))).toEqual(['s-1.run']);
  });

  it.each([
    ['a torn last line', `${JSON.stringify(header())}\n{"o":1,`],
    ['an empty file', ''],
    ['no newline after the header', JSON.stringify(header())],
    ['an unknown version', `${JSON.stringify(header({ v: 2 }))}\n`],
    ['an extra header key', `${JSON.stringify(header({ x: 1 }))}\n`],
    ['pid 0', `${JSON.stringify(header({ pid: 0 }))}\n`],
    ['pid -1', `${JSON.stringify(header({ pid: -1 }))}\n`],
    ['pid 1.5', `${JSON.stringify(header({ pid: 1.5 }))}\n`],
    ['pid a string', `${JSON.stringify(header({ pid: '42' }))}\n`],
    ['a bad nonce', `${JSON.stringify(header({ nonce: 'zz' }))}\n`],
    ['a bad start time', `${JSON.stringify(header({ startedAt: 'x' }))}\n`],
    ['an unknown line', `${JSON.stringify(header())}\n{"q":1}\n`],
    ['an unknown state', `${JSON.stringify(header())}\n{"o":1,"s":"fine"}\n`],
    ['a bad intent', `${JSON.stringify(header())}\n{"o":1,"m":"Bad Name","a":"x"}\n`],
    ['not JSON', 'not json\n'],
    ['a fragment after the last line', `${JSON.stringify(header())}\n${JSON.stringify(done(1, 'refused'))}x`],
    ['oversized, though every line is valid', `${JSON.stringify(header())}\n${`${JSON.stringify(done(1, 'refused'))}\n`.repeat(Math.ceil(RECORD_MAX_BYTES / 20))}`],
  ])('%s: run-record-unavailable, and the file stays', (_name, text) => {
    writeFileSync(file, text);
    expect(store().open('r')).toEqual({ ok: false, busy: 'run-record-unavailable' });
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('a FIFO at the path: no hang, run-record-unavailable (s-296)', () => {
    spawnSync('/usr/bin/mkfifo', [file]);
    expect(lstatSync(file).isFIFO()).toBe(true);
    expect(store().open('r')).toEqual({ ok: false, busy: 'run-record-unavailable' });
  }, 5000);

  it('a symlink at the path is not followed', () => {
    const elsewhere = path.join(workDir, 'elsewhere');
    writeFileSync(elsewhere, `${JSON.stringify(header())}\n`);
    symlinkSync(elsewhere, file);
    expect(store().open('r')).toEqual({ ok: false, busy: 'run-record-unavailable' });
  });

  it('a directory at the path', () => {
    mkdirSync(file);
    expect(store().open('r')).toEqual({ ok: false, busy: 'run-record-unavailable' });
  });
});

describe('holder liveness: a doubt reads as alive', () => {
  const accounted = (over: Record<string, unknown> = {}): void => plant(header(over));
  it('a live pid with a start time more than 2 s away is a reused pid: the holder is dead', () => {
    accounted();
    expect(store(probe(true, START + 3)).open('r').ok).toBe(true);
    plant(header(), intent(1));
    expect(store(probe(true, START - 3)).open('r')).toEqual({ ok: false, busy: 'previous-process-unaccounted' });
  });
  it.each([0, 1, 2, -2])('a difference of %i s is the same process', (d) => {
    accounted();
    expect(store(probe(true, START + d)).open('r')).toEqual({ ok: false, busy: 'held-by-other-process' });
  });
  it('ps failing, or a header with no start time, reads as alive', () => {
    accounted();
    expect(store(probe(true, null)).open('r')).toEqual({ ok: false, busy: 'held-by-other-process' });
    accounted({ startedAt: null });
    expect(store(probe(true, START)).open('r')).toEqual({ ok: false, busy: 'held-by-other-process' });
  });
  it('the real start time is in UTC seconds whatever the zone of this process, and stable', () => {
    const was = process.env['TZ'];
    try {
      const reference = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { TZ: 'UTC', LC_ALL: 'C' } }).stdout.trim();
      const expected = Math.floor(Date.parse(`${reference} UTC`) / 1000);
      for (const tz of ['Asia/Tokyo', 'America/New_York', 'UTC']) {
        process.env['TZ'] = tz;
        expect(REAL_PROBE.startedAt(process.pid), tz).toBe(expected);
      }
    } finally { if (was === undefined) delete process.env['TZ']; else process.env['TZ'] = was; }
  });
  it('the real probe: a pid that does not exist is dead; this process is alive; no start time for a pid that does not exist', () => {
    expect(REAL_PROBE.alive(process.pid)).toBe(true);
    expect(REAL_PROBE.alive(999_999)).toBe(false);
    expect(REAL_PROBE.startedAt(999_999)).toBeNull();
  });
});

describe('own pid (s-296 B3)', () => {
  it('a record of this pid from a sibling in this process is held, even with everything accounted', () => {
    plant(header({ pid: process.pid, startedAt: 99 }));
    expect(store().open('r')).toEqual({ ok: false, busy: 'held-by-other-process' });
  });
  it('a record of this pid from an earlier process that had this pid: the holder is dead', () => {
    plant(header({ pid: process.pid, startedAt: 40 }));
    expect(store().open('r').ok).toBe(true);
    plant(header({ pid: process.pid, startedAt: 40 }), intent(1));
    expect(store().open('r')).toEqual({ ok: false, busy: 'previous-process-unaccounted' });
  });
  it('this store takes back only its own failed unlink, by nonce; another store of this process does not', () => {
    const s = store();
    const o = s.open('r1');
    if (!o.ok) throw new Error('open');
    chmodSync(path.dirname(file), 0o500);
    o.handle.release();
    chmodSync(path.dirname(file), 0o700);
    expect(existsSync(file)).toBe(true);
    expect(store().open('r2')).toEqual({ ok: false, busy: 'held-by-other-process' });
    expect(s.open('r3').ok).toBe(true);
    expect(firstLine()).toMatchObject({ runId: 'r3' });
  });
});

describe('reclaim goes through a claim (s-296 B1, C3)', () => {
  it('a claim left by a reclaimer that died: busy, and the record stays', () => {
    plant(header());
    linkSync(file, `${file}.claim.${NONCE}`);
    expect(store().open('r')).toEqual({ ok: false, busy: 'run-record-unavailable' });
    expect(existsSync(file)).toBe(true);
  });
  it('a stray claim with no record: the next acquire wins, and the claim is junk', () => {
    writeFileSync(`${file}.claim.${NONCE}`, 'x');
    expect(store().open('r').ok).toBe(true);
  });
  it('a stale reader: another process replaced the record after this one read it. Busy, and the winner keeps its file', () => {
    plant(header());
    const winner = `${JSON.stringify(header({ nonce: 'c'.repeat(32), pid: 777 }))}\n`;
    // The liveness check runs between the read and the claim: that is where the other process gets in.
    const stale: ProcessProbe = { alive: () => { unlinkSync(file); writeFileSync(file, winner); return false; }, startedAt: () => START };
    expect(store(stale).open('r')).toEqual({ ok: false, busy: 'held-by-other-process' });
    expect(readFileSync(file, 'utf8')).toBe(winner);
    expect(readdirSync(path.dirname(file))).toEqual(['s-1.run']);
  });
  it('a record swapped for a FIFO after the read: the claim reread does not hang', () => {
    plant(header());
    const swap: ProcessProbe = { alive: () => { unlinkSync(file); spawnSync('/usr/bin/mkfifo', [file]); return false; }, startedAt: () => START };
    expect(store(swap).open('r')).toEqual({ ok: false, busy: 'held-by-other-process' });
    expect(readdirSync(path.dirname(file))).toEqual(['s-1.run']);
  }, 5000);
  it('the record gone by the claim: busy, no error', () => {
    plant(header());
    const gone: ProcessProbe = { alive: () => { unlinkSync(file); return false; }, startedAt: () => START };
    expect(store(gone).open('r')).toEqual({ ok: false, busy: 'held-by-other-process' });
  });
});

// ----- Real processes -----

const coreDir = fileURLToPath(new URL('../../../', import.meta.url));
const distDir = path.join(coreDir, 'dist');
const holderScript = fileURLToPath(new URL('../../../../../tests/fixtures/code-mode/run-record-holder.mjs', import.meta.url));
const supported = process.platform === 'darwin' && process.arch === 'arm64' && existsSync('/usr/bin/sandbox-exec') && existsSync(path.join(coreDir, 'native/darwin-arm64/manifest.json'));

describe.skipIf(!supported)('a real process holding a real run, ended for real', () => {
  beforeAll(() => { execFileSync('pnpm', ['exec', 'tsc', '-p', path.join(coreDir, 'tsconfig.json')], { stdio: 'ignore', cwd: coreDir }); }, 120_000);

  const running: ChildProcess[] = [];
  afterAll(() => { for (const c of running) c.kill('SIGKILL'); });

  function start(mode: string, wd: string): { child: ChildProcess; line: (pred: (o: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>> } {
    const child = spawn(process.execPath, [holderScript, distDir, mode, wd, 's-1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    running.push(child);
    const seen: Record<string, unknown>[] = [];
    const waiters: (() => void)[] = [];
    createInterface({ input: child.stdout! }).on('line', (l) => { seen.push(JSON.parse(l) as Record<string, unknown>); for (const w of waiters.splice(0)) w(); });
    const line = async (pred: (o: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
      for (;;) {
        const hit = seen.find(pred);
        if (hit !== undefined) return hit;
        await new Promise<void>((r) => { waiters.push(r); });
      }
    };
    return { child, line };
  }
  const gone = (c: ChildProcess): Promise<void> => new Promise((r) => { if (c.exitCode !== null || c.signalCode !== null) r(); else c.once('exit', () => r()); });
  const ends: [string, (c: ChildProcess) => void][] = [
    ['SIGKILL', (c) => { c.kill('SIGKILL'); }],
    ['SIGTERM', (c) => { c.kill('SIGTERM'); }],
    ['its client closing stdin', (c) => { c.stdin!.end(); }],
  ];
  const probeOf = async (wd: string): Promise<Record<string, unknown>> => start('probe', wd).line(() => true);

  it.each(ends)('a read in flight, ended by %s: the next process is refused, previous-process-unaccounted', async (_name, end) => {
    const wd = newRoot();
    const { child, line } = start('hanging', wd);
    await line((o) => o['called'] === true);
    end(child);
    await gone(child);
    expect(readFileSync(runRecordPath(wd, 's-1'), 'utf8')).toContain('"m":"get_map"');
    expect(await probeOf(wd)).toEqual({ ok: false, busy: 'previous-process-unaccounted' });
  }, 30_000);

  it('a read that came back unknown, then the process ended: refused, and the unknown line is there', async () => {
    const wd = newRoot();
    const { child, line } = start('unknown', wd);
    await line((o) => o['returned'] !== undefined);
    child.kill('SIGKILL');
    await gone(child);
    expect(readFileSync(runRecordPath(wd, 's-1'), 'utf8')).toContain('"s":"unknown"');
    expect(await probeOf(wd)).toEqual({ ok: false, busy: 'previous-process-unaccounted' });
  }, 30_000);

  it('killed while draining: the run had returned, the read had not settled; refused', async () => {
    const wd = newRoot();
    const { child, line } = start('draining', wd);
    await line((o) => o['returned'] !== undefined);
    child.kill('SIGKILL');
    await gone(child);
    expect(await probeOf(wd)).toEqual({ ok: false, busy: 'previous-process-unaccounted' });
  }, 40_000);

  it('a live holder: held-by-other-process; once it dies the same record reads as unaccounted', async () => {
    const wd = newRoot();
    const { child, line } = start('hanging', wd);
    await line((o) => o['called'] === true);
    expect(await probeOf(wd)).toEqual({ ok: false, busy: 'held-by-other-process' });
    child.kill('SIGKILL');
    await gone(child);
    expect(await probeOf(wd)).toEqual({ ok: false, busy: 'previous-process-unaccounted' });
  }, 30_000);

  it('a run that settled: the record is gone at quiescent, and the next process is free. No new wedge', async () => {
    const wd = newRoot();
    const { child, line } = start('settled', wd);
    await line((o) => o['drained'] === true);
    expect(existsSync(runRecordPath(wd, 's-1'))).toBe(false);
    expect(await probeOf(wd)).toEqual({ ok: true });
    child.kill('SIGKILL');
  }, 30_000);

  it('killed with nothing dispatched: accounted, so the next process takes it', async () => {
    const wd = newRoot();
    const { child, line } = start('open-only', wd);
    await line((o) => o['ready'] === true);
    child.kill('SIGKILL');
    await gone(child);
    expect(existsSync(runRecordPath(wd, 's-1'))).toBe(true);
    expect(await probeOf(wd)).toEqual({ ok: true });
  }, 30_000);
});

// Forced simultaneous starts, in forked processes: the reclaim race s-296 measured on unlink-then-create.
const racer = `
const { createRunRecordStore, runRecordPath } = await import(process.argv[2]);
const { readFileSync } = await import('node:fs');
process.on('message', ({ workDir, sessionId, at }) => {
  const store = createRunRecordStore({ workDir, sessionId, launchId: 'l' });
  while (Date.now() < at) { /* barrier */ }
  const o = store.open('r-' + process.pid);
  setTimeout(() => {
    let holds = false;
    try { holds = JSON.parse(readFileSync(runRecordPath(workDir, sessionId), 'utf8').split('\\n')[0]).pid === process.pid; } catch { /* gone */ }
    if (o.ok) o.handle.release();
    process.send({ got: o.ok, holds });
  }, 60);
});
process.send({ ready: true });
`;

describe.skipIf(!supported)('the race, in real processes', () => {
  beforeAll(() => { execFileSync('pnpm', ['exec', 'tsc', '-p', path.join(coreDir, 'tsconfig.json')], { stdio: 'ignore', cwd: coreDir }); }, 120_000);

  async function race(kids: number, rounds: number, setup: (session: string) => void, wd: string): Promise<{ winners: number; lost: number }[]> {
    const script = path.join(wd, 'racer.mjs');
    writeFileSync(script, racer);
    const moduleUrl = new URL(`file://${path.join(distDir, 'mcp/code-mode/run-record.js')}`).href;
    const children = Array.from({ length: kids }, () => fork(script, [moduleUrl], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
    await Promise.all(children.map((c) => new Promise((r) => { c.once('message', r); })));
    const results: { winners: number; lost: number }[] = [];
    try {
      for (let i = 0; i < rounds; i++) {
        const sessionId = `s-${i}`;
        setup(sessionId);
        const at = Date.now() + 15;
        const res = await Promise.all(children.map((c) => new Promise<{ got: boolean; holds: boolean }>((r) => { c.once('message', r as never); c.send({ workDir: wd, sessionId, at }); })));
        results.push({ winners: res.filter((x) => x.got).length, lost: res.filter((x) => x.got && !x.holds).length });
      }
    } finally { for (const c of children) c.kill('SIGKILL'); }
    return results;
  }

  it('20 processes on a fresh path: exactly one wins', async () => {
    const wd = newRoot();
    const results = await race(20, 5, () => {}, wd);
    expect(results.map((r) => r.winners)).toEqual([1, 1, 1, 1, 1]);
    expect(results.every((r) => r.lost === 0)).toBe(true);
  }, 60_000);

  it('6 processes reclaiming one dead, accounted record, 300 rounds: never two winners, and no winner loses its record', async () => {
    const wd = newRoot();
    mkdirSync(path.join(wd, 'code-mode'), { recursive: true, mode: 0o700 });
    const results = await race(6, 300, (session) => { writeFileSync(runRecordPath(wd, session), `${JSON.stringify(header({ pid: 999_999, nonce: `${session.replace('s-', '').padStart(4, '0')}${'d'.repeat(28)}` }))}\n`); }, wd);
    expect(results.filter((r) => r.winners > 1)).toEqual([]);
    expect(results.filter((r) => r.lost > 0)).toEqual([]);
    expect(results.filter((r) => r.winners === 1).length).toBeGreaterThan(0);
    expect(readdirSync(path.join(wd, 'code-mode')).filter((n) => n.includes('.claim.'))).toEqual([]);
  }, 180_000);
});
