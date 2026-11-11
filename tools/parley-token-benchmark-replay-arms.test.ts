// T9a harness, slice H2c-1: one arm through the real `server.js`, the real host, and for the replacement arm the real broker and helper. This file owns the
// fixture mint expression (a static guard keeps it out of every other file) and the `vi.mock` that lets the host log tell a real handler start.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentViewOf } from './parley-token-benchmark-replay-judge.js';
import { type ArmScript, ArmError, HelperWatch, type ProcessRow, type ReplacementScript, canaryReadable, checkEnd, checkMode, extractAnswer, resolveArgs, faultsOf, isHelperCommand, killHelper, recordOf, recordingTransport, waitForTap, resolveSdk, runArm, sdkPreflight, settleChild, writePreload } from './parley-token-benchmark-replay-arms.js';
import { type BuiltData, buildGoalData, restoreForArm } from './parley-token-benchmark-replay-data.js';
import type { RecordView } from '../packages/core/src/mcp/code-mode/run-record.js';
import { checkGoalFile, type Goal } from './parley-token-benchmark-replay-schema.js';

vi.mock('../packages/core/dist/index.js', async (orig) => (await import('./parley-token-benchmark-replay-probe.js')).withHandlerProbe(await orig()));

const distDir = path.resolve('packages/core/dist');
const FIVE = ['get_map', 'read_room', 'read_guide', 'list_roles', 'backlog_list'];
const MINT = 'np.claimFixtureSourceMint()';
let root = '';
let preload = '';
let built: BuiltData;

const DATA = {
  self: 'caller',
  sessions: [{ key: 'caller', label: 'Synthetic caller', provider: 'codex', lifecycle: 'active', task: 'Inspect', summary: 'CALLER-SUMMARY' }, { key: 'peer', label: 'Amber peer', provider: 'claude', lifecycle: 'active', task: 'Review amber', summary: 'AMBER-SUMMARY' }],
  rooms: [{ key: 'amber', title: 'Amber room', lead: 'caller', members: ['caller', 'peer'], messages: [{ from: 'peer', kind: 'note', text: 'AMBER-FIRST' }] }],
};
function goalOf(faults: Record<string, unknown> = {}): Goal {
  const r = checkGoalFile({ version: 1, goals: [{ id: 'g', class: 'read-dto', kind: 'run', goal: 's', arms: ['classic', 'replacement'], data: DATA, ...(Object.keys(faults).length > 0 ? { faults } : {}), answer: { summaries: 'peer summary' }, criteria: [{ answer: { path: 'summaries', present: true } }] }] });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.goals[0]!;
}
const CLASSIC: ArmScript = { calls: [{ name: 'get_map', args: {} }], extract: { summaries: { call: 0, path: 'map.sessions[*].summary' } } };
const REPLACEMENT: ArmScript = { code: 'const m = await parley.get_map({}); return m.value.map.sessions.map((s) => s.unknownFields.summary);', extract: { summaries: { path: '' } } };

beforeAll(() => { preload = writePreload(mkdtempSync(path.join(tmpdir(), 'parley-replay-preload-')), { distDir, proven: FIVE, mintExpression: MINT }); });
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'parley-replay-arms-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
async function arm(which: 'classic' | 'replacement', faults: Record<string, unknown> = {}, script?: ArmScript, over: { preloadPath?: string | null } = {}): Promise<Awaited<ReturnType<typeof runArm>>> {
  const goal = goalOf(faults);
  built = await buildGoalData(goal, path.join(root, 'g'));
  return runArm({ goal, arm: which, built, script: script ?? (which === 'classic' ? CLASSIC : REPLACEMENT), distDir, preloadPath: over.preloadPath === undefined ? preload : over.preloadPath });
}
async function runArmWith(over: Partial<Parameters<typeof runArm>[0]>): Promise<Awaited<ReturnType<typeof runArm>>> {
  const goal = goalOf();
  built = await buildGoalData(goal, path.join(root, 'g'));
  return runArm({ goal, arm: 'replacement', built, script: REPLACEMENT, distDir, preloadPath: preload, ...over });
}
const T = 120_000;

describe('extractAnswer: declarative paths over what the arm produced', () => {
  const sources = [{ sessions: [{ id: 's-01', summary: 'A', extra: 1 }, { id: 's-02', summary: 'B', extra: 2 }], title: 'T' }, 'second'];
  it('a path into the call named, a wildcard maps, project keeps the named keys of each element, a missing path leaves the name out', () => {
    expect(extractAnswer({ s: { call: 0, path: 'sessions[*].summary' } }, sources)).toEqual({ s: ['A', 'B'] });
    expect(extractAnswer({ t: { path: 'title' }, second: { call: 1, path: '' } }, sources)).toEqual({ t: 'T', second: 'second' });
    expect(extractAnswer({ p: { path: 'sessions', project: ['id'] } }, sources)).toEqual({ p: [{ id: 's-01' }, { id: 's-02' }] });
    expect(extractAnswer({ gone: { path: 'nothing.here' }, kept: { path: 'title' } }, sources)).toEqual({ kept: 'T' });
    expect(extractAnswer({ whole: { path: '' } }, ['x'])).toEqual({ whole: 'x' });
    // prefix cuts a string to its first characters and leaves anything else as it is
    expect(extractAnswer({ cut: { path: 'title', prefix: 1 }, long: { call: 1, path: '', prefix: 3 }, list: { path: 'sessions', prefix: 1 }, each: { path: 'sessions[*].summary', prefix: 0 + 1 } }, sources)).toEqual({ cut: 'T', long: 'sec', list: sources[0]!['sessions' as never], each: ['A', 'B'] });
    expect(extractAnswer({ skipped: { path: 'sessions[*].id', skip: 1 }, many: { calls: [0, 1], path: 'sessions[*].id' } }, [sources[0], sources[0]])).toEqual({ skipped: ['s-02'], many: ['s-01', 's-02', 's-01', 's-02'] });
  });
});

describe('extractAnswer: the options that read a result the way the agent was given it', () => {
  const plan = { text: JSON.stringify({ roomId: 'r-01', goal: 'G', items: [{ title: 'T', owner: 's-02', extra: 1 }] }) };
  it('parse opens JSON text, shape renames members, raw takes the whole result, is derives a fact, where keeps matching elements', () => {
    expect(extractAnswer({ p: { path: 'text', parse: 'json', shape: { room: 'roomId', goal: 'goal', items: { path: 'items', project: ['title'] } } } }, [plan]))
      .toEqual({ p: { room: 'r-01', goal: 'G', items: [{ title: 'T' }] } });
    expect(extractAnswer({ bad: { path: 'goal', parse: 'json' }, notText: { path: 'x', parse: 'json' } }, [{ goal: 'not json', x: 1 }])).toEqual({});
    expect(extractAnswer({ e: { call: 0, path: '', raw: true } }, ['text'], [{ content: [{ type: 'text', text: 'text' }], isError: true }])).toEqual({ e: { content: [{ type: 'text', text: 'text' }], isError: true } });
    expect(extractAnswer({ u: { path: 'error.kind', raw: true, is: 'unavailable' } }, [null], [{ error: { kind: 'unavailable' } }])).toEqual({ u: true });
    expect(extractAnswer({ u: { path: 'error.kind', raw: true, is: 'unavailable' } }, [null], [{ error: { kind: 'unsettled' } }])).toEqual({ u: false });
    expect(extractAnswer({ u: { path: 'error.kind', raw: true, is: 'unavailable' } }, [null], [{ status: 'completed' }])).toEqual({});
    expect(extractAnswer({ d: { path: 'diagnostics', raw: true, where: { code: 'limit-reached' } } }, [null], [{ diagnostics: [{ code: 'call-failed' }, { code: 'limit-reached', params: { limit: 'x' } }] }])).toEqual({ d: [{ code: 'limit-reached', params: { limit: 'x' } }] });
    expect(extractAnswer({ d: { path: 'diagnostics', raw: true, where: { code: 'limit-reached' } } }, [null], [{ diagnostics: [] }])).toEqual({ d: [] });
  });
});

describe('resolveArgs: a classic argument may be a cursor from an earlier call', () => {
  it('takes the value at the path of the call named, and a missing one stops by name', () => {
    expect(resolveArgs({ field: 'x', cursor: { $from: { call: 0, path: 'page.next' } }, n: 2 }, [{ page: { next: 'before:26' } }])).toEqual({ field: 'x', cursor: 'before:26', n: 2 });
    expect(() => resolveArgs({ cursor: { $from: { call: 0, path: 'page.next' } } }, [{ page: { next: null } }])).toThrow(/nothing at page.next of call 0/);
    expect(() => resolveArgs({ cursor: { $from: { call: 3, path: 'a' } } }, [{}])).toThrow(/nothing at a of call 3/);
    expect(resolveArgs({ a: { $from: 1, b: 2 } }, [])).toEqual({ a: { $from: 1, b: 2 } });
  });
});

describe('HelperWatch: a process that outlives its server is found, the parent filter would not', () => {
  it('finds a process that names the arm directory, and a recorded pid that is still alive; nothing once they are gone', async () => {
    const marker = path.join(root, 'arm-marker');
    const stray = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], { detached: true, stdio: 'ignore' });
    stray.unref();
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    other.unref();
    const watch = new HelperWatch(marker);
    watch.record(other.pid!);
    expect(watch.leftovers()).toEqual([stray.pid!, other.pid!].sort((a, b) => a - b));
    process.kill(stray.pid!, 'SIGKILL');
    process.kill(other.pid!, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
    expect(watch.leftovers()).toEqual([]);
  });

  it('a pid reused by another command is not counted as the helper', async () => {
    const watch = new HelperWatch(path.join(root, 'none'));
    const a = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 150)'], { stdio: 'ignore' });
    watch.record(a.pid!);
    await new Promise((r) => a.once('exit', r));
    expect(watch.leftovers()).toEqual([]);
  });
});

describe('HelperWatch over a fake process table: descendants are followed, a reused pid is not the helper', () => {
  const row = (pid: number, ppid: number, command: string): ProcessRow => ({ pid, ppid, command });
  it('records the whole tree under the server, not its siblings, and finds them after the server is gone and they are re-parented', () => {
    let table = [row(1, 0, 'launchd'), row(100, 1, 'server'), row(101, 100, 'sandbox-exec'), row(102, 101, 'helper'), row(200, 1, 'other')];
    const watch = new HelperWatch('/no/such/marker', () => table);
    watch.snapshot(100);
    table = [row(1, 0, 'launchd'), row(102, 1, 'helper'), row(200, 1, 'other')];
    expect(watch.leftovers()).toEqual([102]);
  });
  it('a pid that now runs another command is not counted', () => {
    let table = [row(100, 1, 'server'), row(101, 100, 'helper')];
    const watch = new HelperWatch('/no/such/marker', () => table);
    watch.snapshot(100);
    table = [row(101, 1, 'an unrelated reused pid')];
    expect(watch.leftovers()).toEqual([]);
    table = [row(101, 1, 'helper')];
    expect(watch.leftovers()).toEqual([101]);
  });
});

describe('the pieces an arm trusts, each with its failure', () => {
  const view = (v: RecordView) => () => v;
  it('recordOf: the four states, none only when no file exists, and an unreadable record stops the arm instead of being judged', () => {
    const rec = (v: RecordView, exists: boolean) => recordOf('/w', 's-01', view(v) as never, () => exists);
    expect(rec({ kind: 'free' }, false)).toBe('none');
    expect(rec({ kind: 'free' }, true)).toBe('free');
    expect(rec({ kind: 'held-live', methods: [] }, true)).toBe('held-live');
    expect(rec({ kind: 'unaccounted', methods: [] }, true)).toBe('unaccounted');
    expect(() => rec({ kind: 'unreadable' }, true)).toThrow(ArmError);
  });
  it('canaryReadable reads the caller\'s summary in the local store: the canary, or not', async () => {
    built = await buildGoalData(goalOf({ localCanary: 'C1' }), path.join(root, 'g'));
    await restoreForArm(built, 'C1');
    expect(await canaryReadable(built, 'C1')).toBe(true);
    expect(await canaryReadable(built, 'C2')).toBe(false);
    await restoreForArm(built, null);
    expect(await canaryReadable(built, 'C1')).toBe(false);
  });
  it('checkMode: a replacement list has code_execute, a classic one never does', () => {
    expect(() => checkMode('replacement', ['code_execute', 'code_search'])).not.toThrow();
    expect(() => checkMode('replacement', ['get_map'])).toThrow(ArmError);
    expect(() => checkMode('classic', ['get_map'])).not.toThrow();
    expect(() => checkMode('classic', ['get_map', 'code_execute'])).toThrow(ArmError);
  });
});

describe('the MCP client SDK is core\'s declared one, from inside the repository', () => {
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  it('resolves through the core package, to a path inside the repository, with a version; the preflight reports it', async () => {
    const info = resolveSdk();
    expect(info.root.startsWith(`${realpathSync(repo)}${path.sep}`)).toBe(true);
    expect(JSON.parse(readFileSync(path.join(info.root, 'package.json'), 'utf8')).version).toBe(info.version);
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(existsSync(new URL(info.clientUrl)) || existsSync(info.clientUrl.replace('file://', ''))).toBe(true);
    expect(await sdkPreflight()).toEqual(info);
  });
  it('refuses a resolution outside the repository: a repository root that does not contain where the SDK was found', () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'parley-not-the-repo-'));
    expect(() => resolveSdk(undefined, elsewhere)).toThrow(/outside the repository/);
    expect(() => resolveSdk(undefined, repo)).not.toThrow();
    rmSync(elsewhere, { recursive: true, force: true });
  });
});

describe('settleChild: the server goes on its own, or the record is read first and then it is killed', () => {
  it('a child that exits within the grace is not killed and nothing is read', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 100)'], { stdio: 'ignore' });
    let read = 0;
    const end = await settleChild(child.pid!, 5_000, () => { read++; });
    expect(end.killedByHarness).toBe(false);
    expect(read).toBe(0);
  });
  it('a child that outlives the grace: beforeKill runs while it is still alive, then it is killed and gone', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const kill = vi.spyOn(process, 'kill');
    let killSentAtRead: boolean | null = null;
    const end = await settleChild(child.pid!, 300, () => { killSentAtRead = kill.mock.calls.some((c) => c[1] === 'SIGKILL'); });
    expect(end.killedByHarness).toBe(true);
    expect(end.waitedMs).toBeGreaterThanOrEqual(300);
    expect(killSentAtRead).toBe(false);
    expect(kill.mock.calls.some((c) => c[0] === child.pid && c[1] === 'SIGKILL')).toBe(true);
    kill.mockRestore();
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });
});

describe('checkEnd: a kill by the harness fails the arm unless the goal says the server may outlive its client', () => {
  it('no kill passes; a kill fails, naming the wait; a kill the goal declared passes', () => {
    expect(() => checkEnd({ killedByHarness: false, waitedMs: 3 }, undefined)).not.toThrow();
    expect(() => checkEnd({ killedByHarness: true, waitedMs: 10_000 }, undefined)).toThrow(/outlived its client by 10000 ms/);
    expect(() => checkEnd({ killedByHarness: true, waitedMs: 10_000 }, false)).toThrow(ArmError);
    expect(() => checkEnd({ killedByHarness: true, waitedMs: 10_000 }, true)).not.toThrow();
  });
});

describe('HelperWatch.settle: wait on the observed condition, bounded, and report the time', () => {
  const row = (pid: number, ppid: number, command: string): ProcessRow => ({ pid, ppid, command });
  it('a helper that is still dying is waited for: empty once it is gone, with the time it took', async () => {
    let polls = 0;
    const table = () => (++polls <= 4 ? [row(100, 1, 'server'), row(101, 1, 'helper')] : [row(100, 1, 'server')]);
    const watch = new HelperWatch('/no/marker', table);
    watch.record(101);
    const left = await watch.settle(5_000, 20);
    expect(left.pids).toEqual([]);
    expect(left.waitedMs).toBeGreaterThan(0);
    expect(left.waitedMs).toBeLessThan(5_000);
  });
  it('a helper that stays is still there when the bound is reached, and the wait is the bound', async () => {
    const table = [row(100, 1, 'server'), row(101, 1, 'helper')];
    const watch = new HelperWatch('/no/marker', () => table);
    watch.record(101);
    const left = await watch.settle(200, 20);
    expect(left.pids).toEqual([101]);
    expect(left.waitedMs).toBeGreaterThanOrEqual(200);
  });
});

describe('the classic arm: the real server.js, its direct tools, the real host', () => {
  it('answers from the map through the host; the log shows a list and a started call; nothing is left behind', async () => {
    const o = await arm('classic');
    expect(o.answer).toEqual({ summaries: ['CALLER-SUMMARY', 'AMBER-SUMMARY'] });
    expect(o.result).toBeNull();
    expect(o.attemptedExecute).toBe(false);
    expect(o.hostLog.filter((e) => e.op === 'call').map((e) => [e.method, e.handlerStarted])).toEqual([['get_map', true]]);
    expect(o.received).toContain('AMBER-SUMMARY');
    expect(o.record).toBe('none');
    expect(o.leftoverHelper).toBe(false);
    expect(o.canaryReadable).toBeNull();
    expect(o.skipped).toBe(0);
  }, T);
});

describe('the replacement arm: replacement mode, a real broker, the real helper, the real host', () => {
  it('get_map is gone from the list, code_execute runs the script, the read reaches the host once, the result is a real ExecuteResult', async () => {
    const o = await arm('replacement');
    expect(o.attemptedExecute).toBe(true);
    // the decoder reshapes the read (fields sit under `unknownFields`), so the script reads that shape; classic's text is a different shape for the same data
    expect(o.result).toMatchObject({ status: 'completed', error: null });
    expect(o.result!.operations.map((x) => [x.method, x.dispatched, x.outcome])).toEqual([['get_map', true, 'succeeded']]);
    expect(o.answer).toEqual({ summaries: ['CALLER-SUMMARY', 'AMBER-SUMMARY'] });
    expect(o.hostLog.filter((e) => e.op === 'call').map((e) => [e.method, e.handlerStarted])).toEqual([['get_map', true]]);
    expect(new Set(o.hostLog.filter((e) => e.op === 'call').map((e) => e.callId)).size).toBe(1);
    expect(o.leftoverHelper).toBe(false);
  }, T);

  it('the list the client got: the five proven reads are gone, the three wrappers are there, and nothing else changed', async () => {
    const classic = await arm('classic');
    const replacement = await arm('replacement');
    const names = (o: { tools: readonly { name: string }[] }) => o.tools.map((t) => t.name);
    expect(names(classic)).toContain('get_map');
    expect(names(classic).some((n) => n.startsWith('code_'))).toBe(false);
    expect(names(replacement).filter((n) => FIVE.includes(n))).toEqual([]);
    expect(names(replacement).slice(-3)).toEqual(['code_search', 'code_docs', 'code_execute']);
    expect(names(replacement).slice(0, -3)).toEqual(names(classic).filter((n) => !FIVE.includes(n)));
  }, T);

  it('the same data gives the same answer on both arms: the semantic comparison equalAcrossArms reads', async () => {
    const classic = await arm('classic');
    const replacement = await arm('replacement');
    expect(replacement.answer).toEqual(classic.answer);
  }, T);

  it('a helper left alive after the server is gone is reported by the observation; with none left it is not', async () => {
    let planted = 0;
    const o = await runArmWith({ leftoverWaitMs: 300, beforeVerdict: (watch) => { void watch; const stray = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', path.join(built.dir, 'leaked-helper')], { detached: true, stdio: 'ignore' }); stray.unref(); planted = stray.pid!; } });
    expect(o.leftoverHelper).toBe(true);
    expect(o.helperGoneAfterMs).toBeGreaterThanOrEqual(300);
    process.kill(planted, 'SIGKILL');
    const clean = await arm('replacement');
    expect(clean.leftoverHelper).toBe(false);
    expect(clean.serverKilledByHarness).toBe(false);
    expect(clean.helperGoneAfterMs).toBeLessThan(5_000);
  }, T);

  it('a completed run and a refused one both leave no run record: none, not free (a record that exists and is accounted is free)', async () => {
    const done = await arm('replacement');
    expect(done.record).toBe('none');
    const refused = await arm('replacement', { policy: { state: 'deny' } });
    expect(refused.record).toBe('none');
  }, T);

  it('a policy that says deny: the script is refused at the edge, zero requests reach the host', async () => {
    const o = await arm('replacement', { policy: { state: 'deny' } });
    expect(o.hostLog.filter((e) => e.op === 'call')).toEqual([]);
    expect(o.attemptedExecute).toBe(true);
    expect(o.result!.operations.every((x) => !x.dispatched)).toBe(true);
  }, T);

  it('a preload whose anchor moved fails by name at load: the arm is never silently classic', async () => {
    const bad = writePreload(path.join(root, 'bad'), { distDir, proven: FIVE, mintExpression: MINT }).replace('.mjs', '.mjs');
    const { readFileSync, writeFileSync } = await import('node:fs');
    writeFileSync(bad, readFileSync(bad, 'utf8').replace("swap(text, 'proven: Object.freeze([])'", "swap(text, 'proven: Object.freeze([1])'"));
    await expect(arm('replacement', {}, undefined, { preloadPath: bad })).rejects.toThrow();
  }, T);

  it('without a preload there is no replacement arm', async () => {
    await expect(arm('replacement', {}, undefined, { preloadPath: null })).rejects.toThrow(ArmError);
  }, T);

  it('an arm gives back what it took, whether it finished or failed: PARLEY_HOME is the caller\'s, no host is left listening', async () => {
    const home = process.env['PARLEY_HOME'];
    await arm('classic');
    expect(process.env['PARLEY_HOME']).toBe(home);
    await expect(arm('replacement', {}, undefined, { preloadPath: null })).rejects.toThrow(ArmError);
    expect(process.env['PARLEY_HOME']).toBe(home);
  }, T);
});

describe('the host fault meets the arm: classic has its own fallback, replacement has none', () => {
  it('a 404 on host calls: classic reads its local store and returns the canary; replacement reports the host unavailable and never receives it', async () => {
    const faults = { host: { call: '404' }, localCanary: 'SYNTHETIC-LOCAL-ONLY-CANARY' };
    const classic = await arm('classic', faults);
    expect(classic.received).toContain('SYNTHETIC-LOCAL-ONLY-CANARY');
    expect(classic.canaryReadable).toBe(true);
    const replacement = await arm('replacement', faults);
    expect(replacement.received).not.toContain('SYNTHETIC-LOCAL-ONLY-CANARY');
    expect(replacement.canaryReadable).toBe(true);
    expect(replacement.faultFiredAtSeq.host).toBeDefined();
    expect(existsSync(distDir)).toBe(true);
  }, T);
});

// ---------- the arm ends its server by closing stdin only ----------

describe('a server that ignores the end of its stdin: the harness is the only thing that may kill it, and it reads the record first', () => {
  // A real child behind the real SDK transport: a minimal MCP server that answers initialize and tools/list, ignores stdin EOF for 6 s, and logs the signals it gets.
  const FAKE = `
const fs = require('node:fs');
const marker = process.env.PARLEY_HOME + '-fake';
fs.writeFileSync(marker + '.pid', String(process.pid));
process.on('SIGTERM', () => fs.appendFileSync(marker + '.sig', 'TERM\\n'));
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  for (let i = buf.indexOf('\\n'); i >= 0; i = buf.indexOf('\\n')) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim() === '') continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    const result = m.method === 'initialize' ? { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } : m.method === 'tools/list' ? { tools: [] } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  }
});
process.stdin.on('end', () => { fs.appendFileSync(marker + '.sig', 'EOF\\n'); setTimeout(() => process.exit(0), 6000); });
`;
  async function lingering(over: Partial<Parameters<typeof runArm>[0]>): Promise<{ result: Awaited<ReturnType<typeof runArm>> | Error; signals: string; aliveAtRecord: boolean | null }> {
    const fakeDist = path.join(root, 'fake-dist');
    mkdirSync(path.join(fakeDist, 'mcp'), { recursive: true });
    writeFileSync(path.join(fakeDist, 'mcp', 'server.js'), FAKE);
    const goal = goalOf();
    built = await buildGoalData(goal, path.join(root, 'g'));
    let aliveAtRecord: boolean | null = null;
    const inspect = (() => {
      const pid = Number(readFileSync(`${built.home}-fake.pid`, 'utf8'));
      try { process.kill(pid, 0); aliveAtRecord = true; } catch { aliveAtRecord = false; }
      return { kind: 'free' };
    }) as never;
    let result: Awaited<ReturnType<typeof runArm>> | Error;
    try { result = await runArm({ goal, arm: 'classic', built, script: { calls: [], extract: {} }, distDir: fakeDist, preloadPath: null, exitGraceMs: 3_000, leftoverWaitMs: 100, inspect, ...over }); } catch (e) { result = e as Error; }
    const sig = `${built.home}-fake.sig`;
    return { result, signals: existsSync(sig) ? readFileSync(sig, 'utf8') : '', aliveAtRecord };
  }

  it('without the goal\'s say-so the arm fails, naming the wait; the server was never signalled, and the record was read while it was alive', async () => {
    const o = await lingering({});
    expect(o.result).toBeInstanceOf(ArmError);
    expect((o.result as Error).message).toMatch(/outlived its client by \d+ ms/);
    expect(o.signals).toBe('EOF\n');
    expect(o.aliveAtRecord).toBe(true);
  }, T);

  it('with it the arm reports the kill; still no SIGTERM, the record read before the SIGKILL, and the child gone', async () => {
    const o = await lingering({ mayOutliveClient: true });
    expect(o.result).not.toBeInstanceOf(Error);
    const r = o.result as Awaited<ReturnType<typeof runArm>>;
    expect(r.serverKilledByHarness).toBe(true);
    expect(o.signals).toBe('EOF\n');
    expect(o.aliveAtRecord).toBe(true);
    expect(() => process.kill(Number(readFileSync(`${built.home}-fake.pid`, 'utf8')), 0)).toThrow();
  }, T);
});

describe('recordingTransport.close: stdin only, and a named failure when the SDK keeps its child differently', () => {
  class Fake { constructor(_options: unknown) { void _options; } }
  const make = (child: unknown) => {
    const t = recordingTransport(Fake as never, {} as never);
    (t as unknown as { _process: unknown })._process = child;
    return t;
  };
  it('ends the child\'s stdin once and sends no signal', async () => {
    const calls: string[] = [];
    await make({ stdin: { end: () => calls.push('end') }, kill: () => calls.push('kill') }).close();
    expect(calls).toEqual(['end']);
  });
  it('a transport with no child has nothing to close; a child without stdin is a harness failure, named', async () => {
    await expect(make(undefined).close()).resolves.toBeUndefined();
    await expect(make({}).close()).rejects.toThrow(ArmError);
    await expect(make({}).close()).rejects.toThrow(/keeps its child differently/);
  });
});

// ---------- H2c-2: faults that act on a running arm ----------

const room = (): string => built.ids.rooms['amber']!;
function faultGoal(cls: string, faults: Record<string, unknown>, criteria: unknown[]): Goal {
  const r = checkGoalFile({ version: 1, goals: [{ id: 'f', class: cls, kind: 'run', goal: 's', arms: ['replacement'], armsReason: 'replacement-only: classic has no such surface', data: DATA, faults, answer: {}, criteria }] });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.goals[0]!;
}
async function faulted(goal: Goal, make: () => ReplacementScript, over: Partial<Parameters<typeof runArm>[0]> = {}): Promise<Awaited<ReturnType<typeof runArm>>> {
  built = await buildGoalData(goal, path.join(root, 'g'));
  return runArm({ goal, arm: 'replacement', built, script: make(), distDir, preloadPath: preload, ...over });
}
const HANG_READ_ROOM = { call: 'hang', callMethod: 'read_room' };
const READ_ROOM_ONCE = (): ReplacementScript => ({ code: `const r = await parley.read_room({ room: ${JSON.stringify(room())} }); return r;`, extract: {} });
const CALLS = (calls: number, id: string) => ({ host: { calls, distinctCalls: calls, handlerStarts: { method: id, n: calls }, callsAfter: undefined } });
void CALLS;

describe('faultsOf: what a goal asks the runner to do to a running arm', () => {
  const g = (faults: Record<string, unknown>, criteria: unknown[] = [{ answer: { path: 'summaries', present: true } }]): Goal => {
    const r = checkGoalFile({ version: 1, goals: [{ id: 'g', class: 'read-dto', kind: 'run', goal: 's', arms: ['classic', 'replacement'], data: DATA, faults, answer: { summaries: 'peer summary' }, criteria }] });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.goals[0]!;
  };
  it('nothing declared asks for nothing', () => {
    expect(faultsOf(g({}))).toEqual({ abortAfter: null, guest: null, policyChange: null, policyState: null, limits: null, concurrentRuns: false, wantsNextRun: false });
  });
  it('a policy with afterCalls is a change mid-run and has no state from the start; without it, it is the state from the start', () => {
    expect(faultsOf(g({ policy: { state: 'deny', afterCalls: 2 } }))).toMatchObject({ policyChange: { state: 'deny', afterCalls: 2 }, policyState: null });
    expect(faultsOf(g({ policy: { state: 'ask' } }))).toMatchObject({ policyChange: null, policyState: 'ask' });
  });
  it('the guest fault keeps its event and call count (kill-helper names its call, no-await acts on the first)', () => {
    expect(faultsOf(g({ guest: { event: 'kill-helper', afterCalls: 3 } })).guest).toEqual({ event: 'kill-helper', afterCalls: 3 });
    expect(faultsOf(g({ guest: { event: 'no-await' } })).guest).toEqual({ event: 'no-await', afterCalls: 1 });
  });
  it('abort, limits and the concurrent second run are read as declared; a nextRun criterion asks for a further request', () => {
    expect(faultsOf(g({ abort: { afterCalls: 2 }, limits: { wallMs: 3000 } }))).toMatchObject({ abortAfter: 2, limits: { wallMs: 3000 }, concurrentRuns: false });
    const second = faultGoal('resource', { resource: { bound: 'concurrentRuns', input: 'second-while-first-active' } }, [{ run: { result: 'first', attemptedExecute: true, status: 'completed' } }, { run: { result: 'second', attemptedExecute: true, status: 'error', errorKind: 'busy', busyReason: 'a-run-is-active', runId: null, operations: [] } }, { host: { calls: 1, distinctCalls: 1 } }]);
    expect(faultsOf(second).concurrentRuns).toBe(true);
    expect(faultsOf(g({}, [{ run: { nextRun: { admitted: true } } }])).wantsNextRun).toBe(true);
    expect(faultsOf(g({}, [{ run: { status: 'completed' } }])).wantsNextRun).toBe(false);
  });
});

describe('HelperWatch.descendants: the helper tree under the server, nothing else', () => {
  const row = (pid: number, ppid: number, command: string): ProcessRow => ({ pid, ppid, command });
  it('lists every process below the root and none beside it', () => {
    const watch = new HelperWatch('/no/marker', () => [row(1, 0, 'launchd'), row(102, 101, 'helper'), row(100, 1, 'server'), row(201, 200, 'other child'), row(101, 100, 'sandbox-exec'), row(200, 1, 'other')]);
    expect(watch.descendants(100).map((r) => r.pid).sort()).toEqual([101, 102]);
    expect(watch.descendants(999)).toEqual([]);
  });
});

describe('abort: the client cancels on an observed host receipt; the model is told nothing, so the answer is the one the server computed', () => {
  const goal = (): Goal => faultGoal('abort', { host: HANG_READ_ROOM, abort: { afterCalls: 1 }, limits: { wallMs: 3000 } }, [{ run: { attemptedExecute: true, incomplete: true, status: 'partial-or-unknown' } }, { host: { calls: 1, distinctCalls: 1, handlerStarts: { method: 'read_room', n: 1 }, callsAfter: { fault: 'abort', n: 0 }, maxAttemptsPerCall: 1 } }]);
  it('the run ends cancelled and unsettled, nothing is dispatched after the abort, and the answer never reaches the client', async () => {
    // the script asks for the run's value: the agent holds none, so the answer stays empty whatever the server computed
    const o = await faulted(goal(), () => ({ ...READ_ROOM_ONCE(), extract: { v: { path: '' } } }));
    expect(o.resultFromTap).toBe(true);
    expect(o.answer).toEqual({});
    expect(o.result).toMatchObject({ status: 'partial-or-unknown', error: { kind: 'cancelled' }, incomplete: true });
    expect(o.result!.operations.map((x) => [x.method, x.dispatched, x.outcome])).toEqual([['read_room', true, 'unknown']]);
    expect(o.faultFiredAtSeq.abort).toBeDefined();
    const calls = o.hostLog.filter((e) => e.op === 'call');
    expect(calls).toHaveLength(1);
    expect(o.hostLog.filter((e) => e.seq > o.faultFiredAtSeq.abort!)).toEqual([]);
    expect(o.received).not.toContain(o.result!.runId!);
    expect(o.record).toBe('unaccounted');
    expect(o.leftoverHelper).toBe(false);
    expect(o.serverKilledByHarness).toBe(false);
  }, T);
  it('an ordinary run does not come from the tap, and a run that never reached the receipt has nothing to cancel: no abort fired', async () => {
    const ok = await arm('replacement');
    expect(ok.resultFromTap).toBe(false);
    const never = await faulted(faultGoal('abort', { host: HANG_READ_ROOM, abort: { afterCalls: 5 }, limits: { wallMs: 3000 } }, [{ run: { attemptedExecute: true } }, { host: { calls: 5, callsAfter: { fault: 'abort', n: 0 } } }]), READ_ROOM_ONCE);
    expect(never.faultFiredAtSeq.abort).toBeUndefined();
    expect(never.resultFromTap).toBe(false);
  }, T);
});

describe('kill-helper: the helper is lost on an observed receipt, and the call that was pending keeps its unsettled evidence', () => {
  it('the helper tree is killed at the receipt; the run reports a helper failure with the call draining; nothing is left', async () => {
    const goal = faultGoal('ipc', { host: HANG_READ_ROOM, guest: { event: 'kill-helper', afterCalls: 1 }, limits: { wallMs: 3000 } }, [{ run: { attemptedExecute: true, status: 'partial-or-unknown', incomplete: true } }, { host: { calls: 1, distinctCalls: 1, handlerStarts: { method: 'read_room', n: 1 }, callsAfter: { fault: 'guest', n: 0 }, maxAttemptsPerCall: 1 } }]);
    const o = await faulted(goal, READ_ROOM_ONCE);
    expect(o.faultFiredAtSeq.guest).toBeDefined();
    expect(o.result).toMatchObject({ status: 'partial-or-unknown', error: { kind: 'helper-failure' }, incomplete: true });
    expect(o.result!.operations.map((x) => [x.method, x.dispatched, x.outcome])).toEqual([['read_room', true, 'draining']]);
    expect(o.hostLog.filter((e) => e.op === 'call')).toHaveLength(1);
    expect(o.record).toBe('unaccounted');
    expect(o.leftoverHelper).toBe(false);
  }, T);
  it('no-await: the first receipt marks the fault as fired and the unawaited read cannot make a completed run', async () => {
    const goal = faultGoal('draining', { host: HANG_READ_ROOM, guest: { event: 'no-await' }, limits: { wallMs: 3000 } }, [{ run: { attemptedExecute: true, status: 'partial-or-unknown', incomplete: true } }, { host: { calls: 1, distinctCalls: 1, handlerStarts: { method: 'read_room', n: 1 }, maxAttemptsPerCall: 1 } }]);
    const o = await faulted(goal, () => ({ code: `parley.read_room({ room: ${JSON.stringify(room())} }); return 1;`, extract: {} }));
    expect(o.faultFiredAtSeq.guest).toBeDefined();
    expect(o.result!.status).toBe('partial-or-unknown');
    expect(o.result!.operations.map((x) => x.outcome)).toEqual(['draining']);
    expect(o.hostLog.filter((e) => e.op === 'call')).toHaveLength(1);
  }, T);
});

describe('a second script request while the first is active, and a further one after it ended', () => {
  const GET_MAP: ReplacementScript = { code: 'const m = await parley.get_map({}); return m.value.map.sessions.map((s) => s.unknownFields.summary);', extract: { summaries: { path: '' } } };
  it('concurrentRuns: the first call is held until the second has its answer; the second is busy with no run and no call, the first completes normally', async () => {
    const goal = faultGoal('resource', { resource: { bound: 'concurrentRuns', input: 'second-while-first-active' } }, [{ run: { result: 'first', attemptedExecute: true, status: 'completed' } }, { run: { result: 'second', attemptedExecute: true, status: 'error', errorKind: 'busy', busyReason: 'a-run-is-active', runId: null, operations: [] } }, { host: { calls: 1, distinctCalls: 1 } }]);
    const o = await faulted(goal, () => GET_MAP);
    expect(o.faultFiredAtSeq.concurrentRuns).toBeDefined();
    expect(o.second).toMatchObject({ attempted: true, result: { status: 'error', error: { kind: 'busy' }, runId: null, operations: [], diagnostics: [{ code: 'busy', params: { reason: 'a-run-is-active' } }] } });
    expect(o.result).toMatchObject({ status: 'completed' });
    expect(o.answer).toEqual({ summaries: ['CALLER-SUMMARY', 'AMBER-SUMMARY'] });
    expect(o.hostLog.filter((e) => e.op === 'call')).toHaveLength(1);
    expect(o.nextRun).toBeNull();
  }, T);
  it('one run plus one busy, with the SAME code in both: the tap tells them apart by the order they were sent (H3), and each wire text is the projection of its own parent result', async () => {
    const goal = faultGoal('resource', { resource: { bound: 'concurrentRuns', input: 'second-while-first-active' } }, [{ run: { result: 'first', attemptedExecute: true, status: 'completed' } }, { run: { result: 'second', attemptedExecute: true, status: 'error', errorKind: 'busy', busyReason: 'a-run-is-active', runId: null, operations: [] } }, { host: { calls: 1, distinctCalls: 1 } }]);
    const o = await faulted(goal, () => ({ ...GET_MAP, second: GET_MAP.code }));
    expect(o.result).toMatchObject({ status: 'completed' });
    expect(o.second).toMatchObject({ attempted: true, result: { status: 'error', error: { kind: 'busy' } } });
    expect(o.executes!.map((e) => [e.seq, e.full?.['status']]).sort()).toEqual([[1, 'completed'], [2, 'error']]);
    for (const e of o.executes!) expect(agentViewOf(e.full!)).toEqual(JSON.parse(e.text));
  }, T);
  it('the judge reads the parent: the rows of the parent result carry the hashes and sizes the agent text does not, and the invariant holds on a real arm', async () => {
    const o = await arm('replacement');
    expect(o.executes).toHaveLength(1);
    const wire = JSON.parse(o.executes![0]!.text) as { status: string; incomplete: boolean; value: unknown; operations?: Record<string, unknown>[] };
    expect(wire.status).toBe('completed');
    expect(Object.keys(wire).every((k) => ['status', 'incomplete', 'value', 'operations', 'diagnostics'].includes(k))).toBe(true);
    for (const row of wire.operations ?? []) expect(Object.keys(row).sort()).toEqual(['dispatched', 'incomplete', 'method', 'ordinal', 'outcome']);
    const full = o.executes![0]!.full as { contract: number; apiRevision: string; operations: Record<string, unknown>[] };
    expect(full).toMatchObject({ contract: 4, status: 'completed', operations: [{ method: 'get_map', outcome: 'succeeded' }] });
    expect(Object.keys(full.operations[0]!)).toEqual(expect.arrayContaining(['argsSha256', 'responseBytes']));
    expect(o.executes![0]!.text).not.toContain(full.apiRevision);
    expect(o.result!.operations).toHaveLength(1);
    expect(o.cancelledAnswered).toBe(false);
  }, T);
  it('without the fault there is no second request', async () => {
    const o = await arm('replacement');
    expect(o.second).toBeNull();
    expect(o.nextRun).toBeNull();
    expect(o.faultFiredAtSeq.concurrentRuns).toBeUndefined();
  }, T);
  it('nextRun after a run that left an unknown call: refused, with the record\'s reason; after a completed run: admitted', async () => {
    const hung = faultGoal('resource', { resource: { bound: 'wallMs', input: 'far-over' }, host: { call: 'hang', callMethod: 'get_map' }, limits: { wallMs: 3000 } }, [{ run: { attemptedExecute: true, status: 'partial-or-unknown', incomplete: true, noValue: true, limitReached: 'wall-time', nextRun: { admitted: false, busyReason: 'previous-run-has-calls-with-unknown-outcome' } } }, { host: { calls: 1, distinctCalls: 1 } }]);
    const o = await faulted(hung, () => GET_MAP);
    expect(o.result).toMatchObject({ status: 'partial-or-unknown', value: null });
    expect(o.result!.diagnostics.map((d) => d.params)).toContainEqual({ limit: 'wall-time' });
    expect(o.nextRun).toEqual({ admitted: false, busyReason: 'previous-run-has-calls-with-unknown-outcome' });
    expect(o.record).toBe('unaccounted');
    const fine = faultGoal('resource', { resource: { bound: 'wallMs', input: 'far-over' }, host: { call: 'hang', callMethod: 'get_map' }, limits: { wallMs: 3000 } }, [{ run: { attemptedExecute: true, nextRun: { admitted: true } } }]);
    const control = await faulted({ ...fine, faults: {} }, () => GET_MAP);
    expect(control.result).toMatchObject({ status: 'completed' });
    expect(control.nextRun).toEqual({ admitted: true, busyReason: null });
  }, T);
});

describe('limits are lowered only, and a policy that changes mid-run acts on the calls after the change', () => {
  it('a limit the product does not allow (a raise) stops the arm by name before anything is launched', async () => {
    const goal = faultGoal('resource', { limits: { maxRpcs: 2 }, resource: { bound: 'maxRpcs', input: 'at-limit' } }, [{ run: { attemptedExecute: true } }]);
    await expect(faulted({ ...goal, faults: { limits: { maxRpcs: 1000 } } }, READ_ROOM_ONCE)).rejects.toThrow(/not a lowering of the shipped ones/);
  }, T);
  it('maxRpcs 2: the third read is refused by the product and never reaches the host', async () => {
    const goal = faultGoal('resource', { limits: { maxRpcs: 2 }, resource: { bound: 'maxRpcs', input: 'one-over' } }, [{ run: { attemptedExecute: true } }]);
    const o = await faulted(goal, () => ({ code: 'await parley.get_map({}); await parley.get_map({}); await parley.get_map({}); return 1;', extract: {} }));
    expect(o.hostLog.filter((e) => e.op === 'call')).toHaveLength(2);
    expect(o.result!.diagnostics.map((d) => d.params)).toContainEqual({ limit: 'operations' });
  }, T);
  it('a policy that turns deny after the first call: the first read is served, the next is refused at the edge and never reaches the host', async () => {
    const goal = faultGoal('policy-zero-call', { policy: { state: 'deny', afterCalls: 1 } }, [{ run: { attemptedExecute: true } }, { host: { calls: 1, callsAfter: { fault: 'policy', n: 0 } } }]);
    const o = await faulted(goal, () => ({ code: 'const a = await parley.get_map({}); let b = null; try { b = await parley.get_map({}); } catch (e) { b = String(e); } return [a.ok, b];', extract: {} }));
    expect(o.faultFiredAtSeq.policy).toBeDefined();
    expect(o.hostLog.filter((e) => e.op === 'call')).toHaveLength(1);
    expect(o.result!.operations.map((x) => [x.dispatched, x.outcome])[0]).toEqual([true, 'succeeded']);
    expect(o.result!.operations.slice(1).every((x) => !x.dispatched)).toBe(true);
  }, T);
});

describe('nothing an earlier arm left behind in the arm directory is read by the next one', () => {
  it('a stale policy file does not change the policy, and a stale tap is not taken for the server\'s answer', async () => {
    const goal = goalOf();
    built = await buildGoalData(goal, path.join(root, 'g'));
    writeFileSync(path.join(built.dir, 'policy-state'), 'deny');
    const ok = await runArm({ goal, arm: 'replacement', built, script: REPLACEMENT, distDir, preloadPath: preload });
    expect(ok.result).toMatchObject({ status: 'completed' });
    const abort = faultGoal('abort', { host: HANG_READ_ROOM, abort: { afterCalls: 1 }, limits: { wallMs: 3000 } }, [{ run: { attemptedExecute: true, incomplete: true, status: 'partial-or-unknown' } }, { host: { calls: 1, distinctCalls: 1, handlerStarts: { method: 'read_room', n: 1 }, callsAfter: { fault: 'abort', n: 0 }, maxAttemptsPerCall: 1 } }]);
    built = await buildGoalData(abort, path.join(root, 'g2'));
    writeFileSync(path.join(built.dir, 'tap.jsonl'), JSON.stringify({ seq: 1, code: createHash('sha256').update(READ_ROOM_ONCE().code).digest('hex'), result: { content: [{ type: 'text', text: JSON.stringify({ status: 'completed', error: null, runId: 'stale', incomplete: false, operations: [], diagnostics: [], value: 1 }) }] } }) + '\n');
    const o = await runArm({ goal: abort, arm: 'replacement', built, script: READ_ROOM_ONCE(), distDir, preloadPath: preload });
    expect(o.result).toMatchObject({ status: 'partial-or-unknown', error: { kind: 'cancelled' } });
    expect(o.result!.runId).not.toBe('stale');
  }, T);
});

describe('the tap is read-only: with it off, what the agent receives is the same', () => {
  const same = (text: string): string => text.replace(/run-\d+-\d+/g, 'run-X').replace(/cm1\.[0-9a-f]{64}/g, 'cm1.X'); // the run id carries the pid, the api revision the launch id
  const firstDifference = (a: string, b: string): string | null => { if (a === b) return null; let i = 0; while (a[i] === b[i]) i++; return `at ${i}: ${JSON.stringify(a.slice(Math.max(0, i - 60), i + 80))} vs ${JSON.stringify(b.slice(Math.max(0, i - 60), i + 80))}`; };
  it('an ordinary run gives the same answer, the same result and the same bytes with the tap on and off, and the tap leaves a file only when it is on', async () => {
    const goal = goalOf();
    built = await buildGoalData(goal, path.join(root, 'g'));
    const on = await runArm({ goal, arm: 'replacement', built, script: REPLACEMENT, distDir, preloadPath: preload });
    expect(existsSync(path.join(built.dir, 'tap.jsonl'))).toBe(true);
    const off = await runArm({ goal, arm: 'replacement', built, script: REPLACEMENT, distDir, preloadPath: preload, tap: false });
    expect(existsSync(path.join(built.dir, 'tap.jsonl'))).toBe(false);
    expect(off.answer).toEqual(on.answer);
    // with the tap off the judge has only what the agent was sent: the status, the completeness and the error are the same; the rows a clean read does not have are not
    expect({ status: off.result!.status, incomplete: off.result!.incomplete, error: off.result!.error }).toEqual({ status: on.result!.status, incomplete: on.result!.incomplete, error: on.result!.error });
    expect(firstDifference(same(off.received), same(on.received))).toBeNull();
    expect(off.hostLog.map((e) => [e.op, e.method])).toEqual(on.hostLog.map((e) => [e.op, e.method]));
    expect(off.record).toBe(on.record);
  }, T);
});

describe('a lost tap never reaches the product, and kill-helper counts only the helper', () => {
  it('an unwritable tap on an ordinary run: the same answer, result and bytes as with the tap off', async () => {
    const goal = goalOf();
    built = await buildGoalData(goal, path.join(root, 'g'));
    const off = await runArm({ goal, arm: 'replacement', built, script: REPLACEMENT, distDir, preloadPath: preload, tap: false });
    const lost = await runArm({ goal, arm: 'replacement', built, script: REPLACEMENT, distDir, preloadPath: preload, tapFile: path.join(root, 'no-such-dir', 'tap.jsonl') });
    expect(lost.result).toMatchObject({ status: 'completed', error: null });
    expect(lost.answer).toEqual(off.answer);
    expect(lost.result!.operations).toEqual(off.result!.operations);
    expect(lost.received.replace(/run-\d+-\d+/g, 'run-X').replace(/cm1\.[0-9a-f]{64}/g, 'cm1.X')).toBe(off.received.replace(/run-\d+-\d+/g, 'run-X').replace(/cm1\.[0-9a-f]{64}/g, 'cm1.X'));
  }, T);
  it('an unwritable tap on an abort: the harness names the lost tap, the product never sees it', async () => {
    const goal = faultGoal('abort', { host: HANG_READ_ROOM, abort: { afterCalls: 1 }, limits: { wallMs: 3000 } }, [{ run: { attemptedExecute: true } }, { host: { calls: 1, callsAfter: { fault: 'abort', n: 0 } } }]);
    await expect(faulted(goal, READ_ROOM_ONCE, { tapFile: path.join(root, 'no-such-dir', 'tap.jsonl'), tapWaitMs: 6_000 })).rejects.toThrow(/computed no answer for the cancelled script request/);
  }, T);
  it('a kill-helper that found no helper marks no fault as fired, whatever else it took', async () => {
    const goal = faultGoal('ipc', { host: HANG_READ_ROOM, guest: { event: 'kill-helper', afterCalls: 1 }, limits: { wallMs: 3000 } }, [{ run: { attemptedExecute: true } }, { host: { calls: 1, callsAfter: { fault: 'guest', n: 0 } } }]);
    const o = await faulted(goal, READ_ROOM_ONCE, { killer: () => ({ fired: false, killed: [] }) });
    expect(o.faultFiredAtSeq.guest).toBeUndefined();
  }, T);
  it('killHelper: the helper in the tree fires the fault; a transient child alone does not, and is killed all the same', () => {
    const row = (pid: number, ppid: number, command: string): ProcessRow => ({ pid, ppid, command });
    const kills: number[] = [];
    const only = (rows: ProcessRow[]) => { kills.length = 0; return killHelper(new HelperWatch('/no/marker', () => rows), 100, (pid) => { kills.push(pid); }); };
    expect(only([row(100, 1, 'node server.js'), row(101, 100, '/bin/ps -A -o pid=')])).toEqual({ fired: false, killed: [101] });
    const real = only([row(100, 1, 'node server.js'), row(101, 100, '/usr/bin/sandbox-exec -p profile node --permission helper-entry.js'), row(102, 101, 'node helper-entry.js')]);
    expect(real).toEqual({ fired: true, killed: [101, 102] });
    expect(kills).toEqual([101, 102]);
    const stays = new HelperWatch('/no/marker', () => [row(100, 1, 'node server.js'), row(101, 100, 'sandbox-exec helper-entry')]);
    killHelper(stays, 100, () => undefined);
    expect(stays.leftovers()).toEqual([101]); // recorded before the kill, so a survivor is found afterwards
    expect(only([row(100, 1, 'node server.js')])).toEqual({ fired: false, killed: [] });
    expect(isHelperCommand('/usr/bin/sandbox-exec -p x')).toBe(true);
    expect(isHelperCommand('/bin/ps -A')).toBe(false);
  });
});

describe('waitForTap: the answer to THIS script request, by the order the client sent it in', () => {
  const line = (seq: number, code: string, runId: string, full: object | null = null) => `${JSON.stringify({ seq, code, result: { content: [{ type: 'text', text: JSON.stringify({ runId }) }] }, full })}\n`;
  it('picks the line of the request asked for, whatever else the file holds, and waits for it, bounded', async () => {
    const file = path.join(root, 'tap.jsonl');
    writeFileSync(file, line(1, 'aaa', 'run-A') + line(2, 'bbb', 'run-B'));
    expect(await waitForTap(file, 500, 2)).toEqual({ runId: 'run-B' });
    expect(await waitForTap(file, 500, 1)).toEqual({ runId: 'run-A' });
    await expect(waitForTap(file, 200, 3)).rejects.toThrow(/computed no answer/);
    await expect(waitForTap(path.join(root, 'none.jsonl'), 100, 1)).rejects.toThrow(ArmError);
    setTimeout(() => writeFileSync(file, line(1, 'aaa', 'run-A') + line(2, 'bbb', 'run-B') + line(3, 'ccc', 'run-C')), 120);
    expect(await waitForTap(file, 2_000, 3)).toEqual({ runId: 'run-C' });
  });
  it('H3: two requests with the SAME code are two lines, told apart by their order, never by the code', async () => {
    const file = path.join(root, 'tap-same.jsonl');
    writeFileSync(file, line(1, 'same', 'run-first') + line(2, 'same', 'busy-second'));
    expect(await waitForTap(file, 500, 1)).toEqual({ runId: 'run-first' });
    expect(await waitForTap(file, 500, 2)).toEqual({ runId: 'busy-second' });
  });
  it('returns the parent\'s own result when the line has one, and what the agent was sent only when it has none', async () => {
    const file = path.join(root, 'tap-full.jsonl');
    writeFileSync(file, line(1, 'aaa', 'wire', { status: 'completed', operations: [{ ordinal: 1 }] }) + line(2, 'bbb', 'wire-only', null));
    expect(await waitForTap(file, 500, 1)).toEqual({ status: 'completed', operations: [{ ordinal: 1 }] });
    expect(await waitForTap(file, 500, 2)).toEqual({ runId: 'wire-only' });
  });
});

describe('the phase cannot fire a fault into the goal\'s observation', () => {
  it('a host fault that only the phase\'s own read would trigger stays out of faultFiredAtSeq', async () => {
    const goal = goalOf({ host: { call: '404', callMethod: 'read_room' } });
    built = await buildGoalData(goal, path.join(root, 'g'));
    const on = await runArm({ goal, arm: 'classic', built, script: CLASSIC, distDir, preloadPath: null, phase: async (t) => t.call('read_room', { room: built.ids.rooms['amber']! }) });
    expect(on.faultFiredAtSeq.host).toBeUndefined();
    expect(on.hostLog.filter((e) => e.op === 'call').map((e) => e.method)).toEqual(['get_map']);
  }, T);
});

describe('the conservation phase reads on the live arm and leaves the goal\'s observation byte-identical', () => {
  const same = (text: string): string => text.replace(/run-\d+-\d+/g, 'run-X').replace(/cm1\.[0-9a-f]{64}/g, 'cm1.X');
  const compare = (on: Awaited<ReturnType<typeof runArm>>, off: Awaited<ReturnType<typeof runArm>>): void => {
    expect(on.answer).toEqual(off.answer);
    expect(on.result?.operations).toEqual(off.result?.operations);
    expect(on.hostLog.map((e) => [e.op, e.method, e.handlerStarted])).toEqual(off.hostLog.map((e) => [e.op, e.method, e.handlerStarted]));
    expect(on.faultFiredAtSeq).toEqual(off.faultFiredAtSeq);
    expect(on.hostMaxPending).toEqual(off.hostMaxPending);
    expect(same(on.received)).toBe(same(off.received));
    expect(on.record).toBe(off.record);
  };
  it('replacement: two catalogue searches and a script run inside the phase, and nothing of them in what the goal is judged on', async () => {
    const goal = goalOf();
    built = await buildGoalData(goal, path.join(root, 'g'));
    const off = await runArm({ goal, arm: 'replacement', built, script: REPLACEMENT, distDir, preloadPath: preload });
    const seen: unknown[] = [];
    const on = await runArm({ goal, arm: 'replacement', built, script: REPLACEMENT, distDir, preloadPath: preload, phase: async (t) => {
      const a = await t.search('parley');
      const b = await t.search('parley');
      const run = await t.run('const m = await parley.get_map({}); return m.ok;');
      seen.push(t.arm, a.text === b.text, run.result.status);
      return { names: Object.keys(a.body), same: a.text === b.text };
    } });
    expect(seen).toEqual(['replacement', true, 'completed']);
    expect(on.phase).toEqual({ names: expect.any(Array), same: true });
    expect(off.phase).toBeUndefined();
    compare(on, off);
    expect(on.hostLog.filter((e) => e.op === 'call')).toHaveLength(1); // the phase's own get_map is not in it
  }, T);
  it('classic: a direct call inside the phase is not in the host log of the observation either', async () => {
    const goal = goalOf();
    built = await buildGoalData(goal, path.join(root, 'g'));
    const off = await runArm({ goal, arm: 'classic', built, script: CLASSIC, distDir, preloadPath: null });
    const on = await runArm({ goal, arm: 'classic', built, script: CLASSIC, distDir, preloadPath: null, phase: async (t) => t.call('get_map', {}) });
    expect(JSON.stringify(on.phase)).toContain('AMBER-SUMMARY');
    compare(on, off);
    expect(on.hostLog.filter((e) => e.op === 'call')).toHaveLength(1);
  }, T);
});

describe('the per-message list: what each message the client received answered, and its bytes', () => {
  const bytes = (o: { received: string }): number => Buffer.byteLength(o.received, 'utf8');
  const sum = (o: { messages: readonly { bytes: number }[] }): number => o.messages.reduce((n, m) => n + m.bytes, 0);
  it('classic: the handshake, the tool list and the call, each named; the sum is the received bytes', async () => {
    const o = await arm('classic');
    expect(sum(o)).toBe(bytes(o));
    expect(o.messages.map((m) => m.kind)).toEqual(['handshake', 'tools/list', 'tools/call get_map']);
    expect(new Set(o.messages.map((m) => m.id)).size).toBe(o.messages.length);
    expect(o.messages.every((m) => m.bytes > 0)).toBe(true);
  }, T);
  it('replacement: the search and the script run are named by their tool; the sum is the received bytes', async () => {
    const o = await arm('replacement');
    expect(sum(o)).toBe(bytes(o));
    expect(o.messages.map((m) => m.kind)).toEqual(['handshake', 'tools/list', 'tools/call code_search', 'tools/call code_execute']);
  }, T);
  it('with the conservation phase the list stops where the goal\'s bytes stop: the phase\'s own reads are in neither', async () => {
    const goal = goalOf();
    built = await buildGoalData(goal, path.join(root, 'g'));
    const on = await runArm({ goal, arm: 'replacement', built, script: REPLACEMENT, distDir, preloadPath: preload, phase: async (t) => { await t.search('parley'); await t.search('parley'); return null; } });
    expect(sum(on)).toBe(bytes(on));
    expect(on.messages.filter((m) => m.kind === 'tools/call code_search')).toHaveLength(1);
  }, T);
});
