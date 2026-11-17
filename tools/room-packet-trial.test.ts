import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CALL_ERROR_PHRASES,
  analyzeChain,
  analyzeSession,
  armRate,
  bootstrap,
  claudeIds,
  computeFinal,
  decide,
  isCallError,
  main,
  makeSnapshot,
  mergeChain,
  realPathLoose,
  splitSegments,
  readRetention,
  readTranscriptText,
  ratio,
  summarizeArm,
  unknownIsError,
  unitsOf,
  type Arm,
  type Membership,
  type SessionFacts,
  type Unit,
  type WindowFacts,
} from './room-packet-trial.js';
import { TranscriptBuilder, buildHome, writeJournal, writeTranscript, type BuiltHome, type HomeSpec } from './fixtures/room-packet-trial/builder.js';
import type { WorkSession } from '../packages/core/src/work/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basicDir = path.join(here, 'fixtures', 'room-packet-trial', 'basic');
const START = '2026-11-20T10:00:00.000Z';
const CUTOFF = '2026-11-21T00:00:00.000Z';
const T09 = '2026-11-20T09:00:00.000Z';

const roots: string[] = [];
const freshRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'rpt-test-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) {
    for (const dir of ['home', 'project', 'claude']) {
      try { chmodSync(path.join(root, dir), 0o755); } catch { /* not made */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

interface Run { code: number; out: string; json: Record<string, unknown>; jsonFile: string }

async function run(built: BuiltHome, mode: '--status' | '--final', extra: string[] = [], root = path.dirname(built.home)): Promise<Run> {
  let out = '';
  const jsonFile = path.join(root, `out-${mode.slice(2)}.json`);
  const args = [mode, '--trial', 'exp-a', '--home', built.home, '--claude-root', built.claudeRoot, '--claude-settings', path.join(root, 'no-settings.json'), '--out', jsonFile, '--resamples', '300', ...extra];
  if (!args.includes('--cutoff')) args.push('--cutoff', CUTOFF);
  const code = await main(args, { write: (text) => { out += text; } });
  const json = existsSync(jsonFile) ? (JSON.parse(readFileSync(jsonFile, 'utf8')) as Record<string, unknown>) : {};
  return { code, out, json, jsonFile };
}

const arms = (json: Record<string, unknown>): Record<Arm, Record<string, unknown>> => json['arms'] as Record<Arm, Record<string, unknown>>;

/** The committed `basic/` fixture: sessions A (packet), B (control), C (packet, joins the room late), D (control, never in a room). */
async function basicHome(root = freshRoot(), memberOf: HomeSpec['rooms'] | null = null): Promise<BuiltHome> {
  const built = await buildHome({
    root,
    sessions: [
      { arm: 'packet', claudeId: 'claude-a' },
      { arm: 'control', claudeId: 'claude-b' },
      { arm: 'packet', claudeId: 'claude-c' },
      { arm: 'control', claudeId: 'claude-d' },
    ],
    rooms: memberOf ?? [{ members: [{ session: 0, from: T09 }, { session: 1, from: T09 }, { session: 2, from: '2026-11-20T10:30:00.000Z' }] }],
  });
  expect(built.ids).toEqual(['s-01', 's-02', 's-03', 's-04']);
  cpSync(path.join(basicDir, 'claude', '-fixture-project'), path.join(built.claudeRoot, '-fixture-project'), { recursive: true });
  cpSync(path.join(basicDir, 'events'), built.eventsDir, { recursive: true });
  return built;
}

// ---------------------------------------------------------------------------------------------------------------------
describe('criterion 1: the committed fixture gives the hand-made key', () => {
  it('windows, call errors, packet receipt, bridge outcomes, get_map packet requests, spend', async () => {
    const built = await basicHome();
    const result = await run(built, '--final');
    expect(result.code).toBe(0);
    const { packet, control } = arms(result.json);
    // Packet arm: A (3 compactions, all in the room) and C (1 outside, 1 in the room).
    expect(packet).toMatchObject({
      sessions: 2, sessionsWithWindow: 2, compactions: 5, compactionsInRoom: 4, compactionsOutOfRoom: 1, compactionsApproximate: 0,
      emptyWindowsInRoom: 1, packetsReceived: 3, packetsReceivedOutOfRoom: 0, getMapPacketRequests: 1,
      // 900/3 x 6 + 1200/3 x 4 + 800/3 x 2 = 1800 + 1600 + 533.33
      spendEstimateTokens: 3933, modelCallsInSpend: 12, modelCallsWithoutUsageInSpend: 1,
    });
    expect(packet.journal).toMatchObject({
      sessionsWithJournal: 2, sessionStartCompactLines: 5, transcriptCompactionsWholeFile: 5,
      bridgeOutcomes: { printed: 3, empty: 1, unreachable: 1 }, hostReasons: { sent: 3, 'no-packet': 1 },
    });
    // Control arm: B (2 compactions in the room, no packets) and D (1, never in a room).
    expect(control).toMatchObject({
      sessions: 2, sessionsWithWindow: 1, compactions: 3, compactionsInRoom: 2, compactionsOutOfRoom: 1,
      packetsReceived: 0, getMapPacketRequests: 0, spendEstimateTokens: 0,
    });
    const outcome = result.json['outcome'] as Record<Arm, Record<string, number>>;
    // A: window 1 has one call error (and one call without a result), window 2 none; C: one clean window in the room.
    expect(outcome.packet).toMatchObject({ windowsInRoom: 3, errorWindows: 1, unknownOutcomeWindows: 0, unfinishedWindows: 1, callErrorResults: 1, allErrorResults: 1 });
    // B: window 1 has only an unlisted is_error and a listed phrase without is_error, window 2 one call error; D: one call error (outside a room).
    expect(outcome.control).toMatchObject({ windowsInRoom: 2, errorWindows: 1, unknownOutcomeWindows: 0, unfinishedWindows: 1, callErrorResults: 2, allErrorResults: 3 });
    expect(result.json['verdict']).toBe('undetermined');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
const MEMBER: Membership = { exact: [{ from: 0, to: Number.POSITIVE_INFINITY }], approx: [] };

const sessionOf = (over: Partial<WorkSession> = {}): WorkSession =>
  ({
    id: 's-x', provider: 'claude', providerSessionId: 'c-x', previousAgents: undefined, history: [], closedAt: null, result: null, resultAt: null,
    trial: { name: 'exp-a', arm: 'packet', at: T09, tag: '1'.repeat(32) }, startedAt: START, endedAt: null, ...over,
  }) as unknown as WorkSession;

const analyze = (text: string | null, over: Partial<WorkSession> = {}, options: { membership?: Membership; cutoff?: string | null; journal?: Parameters<typeof analyzeSession>[0]['journal'] } = {}): SessionFacts =>
  analyzeSession({
    session: sessionOf(over),
    workId: 'w-1',
    membership: options.membership ?? MEMBER,
    hasMessages: false,
    journal: options.journal ?? { present: false, sessionStartCompactLines: 0, bridgeOutcomes: {}, hostReasons: {}, turnTrace: false },
    transcriptFiles: [{ id: 'c-x', text }],
    cutoffMs: options.cutoff === undefined ? Date.parse(CUTOFF) : options.cutoff === null ? null : Date.parse(options.cutoff),
  });

describe('criterion 2: special windows of table 1.2, one case each', () => {
  it('a window shorter than 30 calls that ends in a compaction counts as it is', () => {
    const text = new TranscriptBuilder('c-x', START).prompt().boundary().calls(4).boundary().calls(2, { result: 'error' }).text();
    const facts = analyze(text);
    expect(facts.windows[0]).toMatchObject({ calls: 4, outcome: 'ok', finished: true });
    expect(facts.windows[1]).toMatchObject({ calls: 2, outcome: 'error', finished: false });
  });

  it('a window without a tool call is a separate line, not part of the denominator', () => {
    const text = new TranscriptBuilder('c-x', START).prompt().boundary().model().boundary().calls(2).text();
    const facts = analyze(text);
    expect(facts.windows.map((window) => window.outcome)).toEqual(['empty', 'ok']);
    expect(unitsOf([facts], () => true, 'favourable')).toEqual([{ n: 1, e: 0 }]);
    expect(summarizeArm([facts]).emptyWindowsInRoom).toBe(1);
  });

  it('a window cut by the cutoff (under 30 calls, open) is kept as it is and flagged unfinished', () => {
    const text = new TranscriptBuilder('c-x', START).prompt().boundary().calls(3).at(100_000).calls(2).text();
    const facts = analyze(text, {}, { cutoff: '2026-11-20T10:30:00.000Z' });
    expect(facts.windows).toHaveLength(1);
    expect(facts.windows[0]).toMatchObject({ calls: 3, finished: false, outcome: 'ok' });
    expect(analyze(text, { closedAt: '2026-11-20T10:10:00.000Z' }, { cutoff: '2026-11-20T10:30:00.000Z' }).windows[0]!.finished).toBe(true);
  });

  it('a call without a result leaves the window outcome unknown; a result that is an error still decides the window', () => {
    const open = analyze(new TranscriptBuilder('c-x', START).prompt().boundary().call().call({ result: 'none' }).text());
    expect(open.windows[0]).toMatchObject({ calls: 2, unknownCalls: 1, outcome: 'unknown' });
    const decided = analyze(new TranscriptBuilder('c-x', START).prompt().boundary().call({ result: 'none' }).call({ result: 'error' }).text());
    expect(decided.windows[0]!.outcome).toBe('error');
  });

  it('a transcript torn mid-record makes the number of windows unknown', () => {
    const facts = analyze(new TranscriptBuilder('c-x', START).prompt().boundary().calls(3).tornText());
    expect(facts.unknownReasons).toContain('truncated-transcript');
  });

  it('a transcript that was not found makes the number unknown for a room member', () => {
    const facts = analyze(null);
    expect(facts.transcript).toBe('missing');
    expect(facts.unknownReasons).toEqual(['missing-transcript']);
  });

  it('an error without is_error does not count; an is_error with another text does not count; every listed phrase counts, any case', () => {
    const text = new TranscriptBuilder('c-x', START).prompt().boundary().call({ result: 'plain' }).call({ result: 'other-error' }).text();
    const facts = analyze(text);
    expect(facts.windows[0]!.outcome).toBe('ok');
    expect(facts.errorResults).toBe(1);
    expect(facts.matchingErrorResults).toBe(0);
    expect(CALL_ERROR_PHRASES).toEqual([
      'No such tool available', 'InputValidationError', 'could not be parsed as JSON', 'is required and must be', 'input schema was not in your prompt',
    ]);
    for (const phrase of CALL_ERROR_PHRASES) {
      expect(isCallError(`xx ${phrase.toUpperCase()} yy`)).toBe(true);
      expect(isCallError(`xx ${phrase.toLowerCase()} yy`)).toBe(true);
    }
    expect(isCallError('permission denied')).toBe(false);
  });

  it('only the first 30 calls of a window are looked at, and only the main chain', () => {
    const builder = new TranscriptBuilder('c-x', START).prompt().boundary().calls(30).call({ result: 'error' }).call({ sidechain: true, result: 'error' });
    const facts = analyze(builder.text());
    expect(facts.windows[0]).toMatchObject({ calls: 30, outcome: 'ok', finished: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('criterion 3: lifecycle of a session', () => {
  it('a provider switch and the return: only the claude segments are read, in order', () => {
    const session = sessionOf({
      providerSessionId: 'claude-2',
      previousAgents: [
        { provider: 'claude', providerSessionId: 'claude-1', startedAt: START },
        { provider: 'codex', providerSessionId: 'codex-1', startedAt: START },
      ] as NonNullable<WorkSession['previousAgents']>,
    });
    expect(claudeIds(session)).toEqual({ ids: ['claude-1', 'claude-2'], incomplete: false });
    const one = new TranscriptBuilder('claude-1', START).prompt().boundary().calls(2);
    const two = new TranscriptBuilder('claude-2', '2026-11-20T12:00:00.000Z').prompt().boundary().calls(3, { result: 'error' });
    const facts = analyzeSession({
      session, workId: 'w-1', membership: MEMBER, hasMessages: false,
      journal: { present: false, sessionStartCompactLines: 0, bridgeOutcomes: {}, hostReasons: {}, turnTrace: false },
      transcriptFiles: [{ id: 'claude-1', text: one.text() }, { id: 'claude-2', text: two.text() }],
      cutoffMs: Date.parse(CUTOFF),
    });
    expect(facts.unknownReasons).toEqual([]);
    expect(facts.windows.map((window) => [window.calls, window.outcome])).toEqual([[2, 'ok'], [3, 'error']]);
  });

  it('a fork with a copied history: the boundary and the calls are counted once; the copy keeps the original record', () => {
    const original = new TranscriptBuilder('claude-1', START, 'shared').prompt().boundary().packet(600).calls(3).call({ result: 'error' });
    const fork = new TranscriptBuilder('claude-2', START, 'shared').prompt().boundary().packet(600).calls(3).call({ result: 'error' });
    fork.calls(2); // the new part of the fork
    const session = sessionOf({
      providerSessionId: 'claude-2',
      previousAgents: [{ provider: 'claude', providerSessionId: 'claude-1', startedAt: START }] as NonNullable<WorkSession['previousAgents']>,
    });
    const facts = analyzeSession({
      session, workId: 'w-1', membership: MEMBER, hasMessages: false,
      journal: { present: false, sessionStartCompactLines: 0, bridgeOutcomes: {}, hostReasons: {}, turnTrace: false },
      transcriptFiles: [{ id: 'claude-1', text: original.text() }, { id: 'claude-2', text: fork.text() }],
      cutoffMs: Date.parse(CUTOFF),
    });
    expect(facts.compactions).toHaveLength(1);
    expect(facts.duplicatesMerged).toBeGreaterThan(0);
    expect(facts.windows).toHaveLength(1);
    expect(facts.windows[0]).toMatchObject({ calls: 6, errorCalls: 1 });
    expect(facts.compactions[0]!.received).toBe(true);
  });

  it('of two copies the one with usage data is kept; a record without a uuid is never merged', () => {
    const withoutUsage = { uuid: 'u1', type: 'assistant', message: { id: 'm1' } };
    const withUsage = { uuid: 'u1', type: 'assistant', message: { id: 'm1', usage: { input_tokens: 1 } } };
    expect(mergeChain([[withoutUsage], [withUsage]]).records[0]).toBe(withUsage);
    expect(mergeChain([[withUsage], [withoutUsage]]).records[0]).toBe(withUsage);
    expect(mergeChain([[{ type: 'x' }], [{ type: 'x' }]]).records).toHaveLength(2);
  });

  it('a cut history: 20 or more previous segments, or a claude segment with a start but no id — the session is kept, its outcome unknown', () => {
    expect(claudeIds(sessionOf({ previousAgents: Array.from({ length: 20 }, () => ({ provider: 'codex', providerSessionId: 'x', startedAt: START })) as NonNullable<WorkSession['previousAgents']> })).incomplete).toBe(true);
    expect(claudeIds(sessionOf({ previousAgents: Array.from({ length: 19 }, () => ({ provider: 'codex', providerSessionId: 'x', startedAt: START })) as NonNullable<WorkSession['previousAgents']> })).incomplete).toBe(false);
    expect(claudeIds(sessionOf({ previousAgents: [{ provider: 'claude', providerSessionId: null, startedAt: START }] as NonNullable<WorkSession['previousAgents']> })).incomplete).toBe(true);
    expect(claudeIds(sessionOf({ previousAgents: [{ provider: 'claude', providerSessionId: null, startedAt: null }] as NonNullable<WorkSession['previousAgents']> })).incomplete).toBe(false);
  });

  it('end to end: a cut history keeps the session in the cohort, lists it as unknown and blocks the verdict', async () => {
    const root = freshRoot();
    const built = await buildHome({
      root,
      sessions: [{ arm: 'packet', claudeId: 'claude-a', previousPad: 20 }, { arm: 'control', claudeId: 'claude-b' }],
      rooms: [{ members: [{ session: 0, from: T09 }, { session: 1, from: T09 }] }],
    });
    for (const id of ['claude-a', 'claude-b']) writeTranscript(built, id, new TranscriptBuilder(id, START).prompt().boundary().calls(2).text());
    const result = await run(built, '--final');
    expect(arms(result.json).packet).toMatchObject({ sessions: 1, incompleteHistory: 1, sessionsWithWindow: 0 });
    expect(result.json['verdict']).toBe('undetermined');
    expect(result.json['bounds']).toBeNull();
    expect(result.json['sessionsByUnknown']).toEqual([{ session: `${built.workId}/s-01`, arm: 'packet', reasons: ['incomplete-history'] }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('criterion 4: compactions outside a room', () => {
  it('stay out of the main calculation, are printed on their own line, and do not lower the delivery share', async () => {
    const built = await basicHome();
    const withSwarm = await basicHome(freshRoot());
    const result = await run(built, '--status');
    expect(result.out).toContain('outside a room (separate line, not counted)');
    expect(arms(result.json).packet.compactionsOutOfRoom).toBe(1);
    expect(arms(result.json).packet.packetsReceived).toBe(3);
    // the delivery share is packets / in-room compactions: 3/4, whatever happens outside a room
    expect(result.out).toContain('3/4 (75.0%)');
    expect(withSwarm.ids).toHaveLength(4);
  });

  it('a swarm member or a session without a room (packet arm, two compactions, no packets) leaves the share as it was', () => {
    const inRoom = analyze(new TranscriptBuilder('c-x', START).prompt().boundary().packet(900).calls(2).boundary().packet(900).calls(2).text());
    const swarm = analyze(new TranscriptBuilder('c-y', START).prompt().boundary().calls(2).boundary().calls(2).text(), {}, { membership: { exact: [], approx: [] } });
    expect(swarm.compactions.map((compaction) => compaction.room)).toEqual(['out', 'out']);
    const alone = summarizeArm([inRoom]);
    const together = summarizeArm([inRoom, swarm]);
    expect([alone.packetsReceived, alone.compactionsInRoom]).toEqual([2, 2]);
    expect([together.packetsReceived, together.compactionsInRoom]).toEqual([2, 2]);
    expect(together.compactionsOutOfRoom).toBe(2);
    expect(unitsOf([swarm], (_session, window) => window.room === 'in', 'favourable')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('criterion 5: --status shows no comparison and no error shares', () => {
  it('neither the table nor the JSON carries an outcome', async () => {
    const built = await basicHome();
    const result = await run(built, '--status');
    expect(result.code).toBe(0);
    expect(result.out).not.toMatch(/error|VERDICT|bound |R=|ensitivity|ratio|Outcome \(plan/);
    expect(Object.keys(result.json)).not.toContain('outcome');
    expect(Object.keys(result.json)).not.toContain('verdict');
    expect(JSON.stringify(result.json)).not.toMatch(/errorWindows|callErrorResults|verdict/);
    // what it does show: counts per arm
    expect(result.out).toContain('sessions in the cohort');
    expect(result.out).toContain('packets received / in-room compactions');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
const win = (outcome: WindowFacts['outcome'], over: Partial<WindowFacts> = {}): SessionFacts['windows'][number] => ({
  compaction: 0, calls: outcome === 'empty' ? 0 : 1, errorCalls: outcome === 'error' ? 1 : 0, unknownCalls: outcome === 'unknown' ? 1 : 0, outcome, finished: true, room: 'in', ...over,
});

const fake = (arm: Arm, outcomes: Array<WindowFacts['outcome']>, over: Partial<SessionFacts> = {}): SessionFacts => ({
  id: 's', workId: 'w', arm, assignedAt: T09, transcript: 'found', origin: 'record', tag: '0'.repeat(32), unknownReasons: [], compactions: [], windows: outcomes.map((o) => win(o)),
  getMapPacketRequests: 0, errorResults: 0, matchingErrorResults: 0, duplicatesMerged: 0, filesRead: 1, compactionsWholeFile: 0,
  journal: { present: false, sessionStartCompactLines: 0, bridgeOutcomes: {}, hostReasons: {}, turnTrace: false }, ...over,
});

const many = (count: number, make: (index: number) => SessionFacts): SessionFacts[] => Array.from({ length: count }, (_, index) => make(index));
const final = (cohort: SessionFacts[], extra: Partial<Parameters<typeof computeFinal>[0]> = {}) =>
  computeFinal({ cohort, damagedSessions: 0, unreadableWorks: 0, seed: 7, resamples: 400, ...extra });

describe('criterion 6: the calculation', () => {
  const units = (rates: number[]): Unit[] => rates.map((e) => ({ n: 1, e }));

  it('the bootstrap is reproducible for one seed and differs for another', () => {
    const packet = units([0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0]);
    const control = units([1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0]);
    const a = bootstrap(packet, control, 'pooled', 11, 500);
    const b = bootstrap(packet, control, 'pooled', 11, 500);
    const c = bootstrap(packet, control, 'pooled', 12, 500);
    expect(b).toEqual(a);
    expect([c.lo, c.hi]).not.toEqual([a.lo, a.hi]);
  });

  it('sessions are redrawn inside each arm separately', () => {
    const packet = units([0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
    const control = units([1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1]);
    const draws: Array<[Arm, readonly number[]]> = [];
    bootstrap(packet, control, 'pooled', 3, 40, (arm, indices) => draws.push([arm, indices]));
    expect(draws).toHaveLength(80);
    draws.forEach(([arm, indices], index) => {
      expect(arm).toBe(index % 2 === 0 ? 'packet' : 'control');
      const size = arm === 'packet' ? packet.length : control.length;
      expect(indices).toHaveLength(size);
      expect(indices.every((value) => Number.isInteger(value) && value >= 0 && value < size)).toBe(true);
    });
  });

  it('R with a zero control share: 1 when the packet share is zero too, infinity otherwise', () => {
    expect(ratio(0, 0)).toBe(1);
    expect(ratio(0.25, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(ratio(0.25, 0.5)).toBe(0.5);
    expect(armRate([{ n: 4, e: 1 }, { n: 1, e: 0 }], 'pooled')).toBe(0.2);
    expect(armRate([{ n: 4, e: 1 }, { n: 1, e: 0 }], 'equal')).toBe(0.125);
  });

  it('26 and 26 sessions, one window each, 4 windows with an error against 0: undetermined, no interval', () => {
    const cohort = [...many(26, (i) => fake('control', [i < 4 ? 'error' : 'ok'])), ...many(26, () => fake('packet', ['ok']))];
    const result = final(cohort);
    expect(result.verdict).toBe('undetermined');
    expect(result.bounds!.favourable).toMatchObject({ verdict: 'undetermined', interval: null });
    expect(result.bounds!.favourable.reason).toContain('no window with a call error');
  });

  it('fewer than 10 sessions with a window in an arm: undetermined without a calculation', () => {
    const cohort = [...many(26, (i) => fake('control', [i < 20 ? 'error' : 'ok'])), ...many(9, (i) => fake('packet', [i < 1 ? 'error' : 'ok']))];
    const result = final(cohort);
    expect(result.verdict).toBe('undetermined');
    expect(result.bounds!.unfavourable.reason).toContain('fewer than 10');
    expect(decide(units([0, 1, 0, 0, 0, 0, 0, 0, 0, 0]), units(new Array(9).fill(1)), 'pooled', 1, 50).interval).toBeNull();
  });

  it('an unknown number of windows in any session: undetermined, no calculation at all', () => {
    const cohort = [
      ...many(20, (i) => fake('control', [i < 15 ? 'error' : 'ok'])),
      ...many(20, (i) => fake('packet', [i < 2 ? 'error' : 'ok'])),
      fake('packet', [], { unknownReasons: ['missing-transcript'] }),
    ];
    const result = final(cohort);
    expect(result.verdict).toBe('undetermined');
    expect(result.bounds).toBeNull();
    expect(result.reasons.join(' ')).toContain('unknown number of windows');
  });

  it('the three verdicts: supports, below target, undetermined', () => {
    const clear = [...many(40, (i) => fake('control', [i < 32 ? 'error' : 'ok'])), ...many(40, (i) => fake('packet', [i < 4 ? 'error' : 'ok']))];
    expect(final(clear).verdict).toBe('supports');
    const weak = [...many(200, (i) => fake('control', [i < 160 ? 'error' : 'ok'])), ...many(200, (i) => fake('packet', [i < 120 ? 'error' : 'ok']))];
    expect(final(weak).verdict).toBe('below-target');
    const murky = [...many(12, (i) => fake('control', [i < 6 ? 'error' : 'ok'])), ...many(12, (i) => fake('packet', [i < 4 ? 'error' : 'ok']))];
    expect(final(murky).verdict).toBe('undetermined');
  });

  it('unknown outcomes get opposite assumptions per arm on the two bounds', () => {
    expect(unknownIsError('favourable', 'packet')).toBe(false);
    expect(unknownIsError('favourable', 'control')).toBe(true);
    expect(unknownIsError('unfavourable', 'packet')).toBe(true);
    expect(unknownIsError('unfavourable', 'control')).toBe(false);
    const sessions = [fake('packet', ['unknown']), fake('control', ['unknown'])];
    expect(unitsOf(sessions.filter((s) => s.arm === 'packet'), () => true, 'favourable')).toEqual([{ n: 1, e: 0 }]);
    expect(unitsOf(sessions.filter((s) => s.arm === 'packet'), () => true, 'unfavourable')).toEqual([{ n: 1, e: 1 }]);
    expect(unitsOf(sessions.filter((s) => s.arm === 'control'), () => true, 'favourable')).toEqual([{ n: 1, e: 1 }]);
    expect(unitsOf(sessions.filter((s) => s.arm === 'control'), () => true, 'unfavourable')).toEqual([{ n: 1, e: 0 }]);
  });

  it('when the two bounds give different verdicts the verdict is undetermined; when they agree it stands', () => {
    // Few unknown windows: both bounds still support.
    const agree = [
      ...many(40, (i) => fake('control', [i < 32 ? 'error' : i === 39 ? 'unknown' : 'ok'])),
      ...many(40, (i) => fake('packet', [i < 4 ? 'error' : i === 39 ? 'unknown' : 'ok'])),
    ];
    const agreed = final(agree);
    expect(agreed.bounds!.favourable.verdict).toBe('supports');
    expect(agreed.bounds!.unfavourable.verdict).toBe('supports');
    expect(agreed.verdict).toBe('supports');
    // Many unknown windows: the favourable bound supports, the unfavourable one does not.
    const split = [
      ...many(40, (i) => fake('control', [i < 16 ? 'error' : i < 30 ? 'unknown' : 'ok'])),
      ...many(40, (i) => fake('packet', [i < 3 ? 'error' : i < 20 ? 'unknown' : 'ok'])),
    ];
    const splitResult = final(split);
    expect(splitResult.bounds!.favourable.verdict).toBe('supports');
    expect(splitResult.bounds!.unfavourable.verdict).not.toBe('supports');
    expect(splitResult.verdict).toBe('undetermined');
    expect(splitResult.reasons).toContain('the two bounds disagree');
  });

  it('the pre-declared sensitivity checks are all computed and do not touch the verdict', () => {
    const cohort = [...many(40, (i) => fake('control', [i < 32 ? 'error' : 'ok', 'ok'])), ...many(40, (i) => fake('packet', [i < 4 ? 'error' : 'ok', 'ok']))];
    const result = final(cohort);
    expect(result.sensitivity.map((check) => check.name)).toEqual([
      'equal weight per session',
      'first compaction of each session only',
      'without unfinished windows',
      'all compactions including those outside a room',
    ]);
    expect(result.verdict).toBe('supports');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('criterion 7: a session without a transcript, with a torn one, or with a cut history gives "undetermined" even with a journal', () => {
  const journalWithCompactions = { present: true, sessionStartCompactLines: 3, bridgeOutcomes: { printed: 3 }, hostReasons: { sent: 3 }, turnTrace: true };

  it('no transcript file for a room member, journal present', async () => {
    const root = freshRoot();
    const built = await buildHome({ root, sessions: [{ arm: 'packet', claudeId: 'claude-a' }], rooms: [{ members: [{ session: 0, from: T09 }] }] });
    writeJournal(built, 's-01', [{ hook_event_name: 'SessionStart', source: 'compact' }, { hook_event_name: 'SessionStart', source: 'compact' }, { hook_event_name: 'SessionStart', source: 'compact' }]);
    const result = await run(built, '--final');
    expect(result.json['verdict']).toBe('undetermined');
    expect(arms(result.json).packet).toMatchObject({ transcriptMissing: 1, compactions: 0 });
    expect(arms(result.json).packet.journal).toMatchObject({ sessionStartCompactLines: 3, transcriptCompactionsWholeFile: 0 });
    expect(result.out).toContain('SessionStart compact lines / compactions in transcripts (whole file)');
  });

  it('a torn transcript, journal present', async () => {
    const root = freshRoot();
    const built = await buildHome({ root, sessions: [{ arm: 'packet', claudeId: 'claude-a' }], rooms: [{ members: [{ session: 0, from: T09 }] }] });
    writeTranscript(built, 'claude-a', new TranscriptBuilder('claude-a', START).prompt().boundary().calls(3).tornText());
    writeJournal(built, 's-01', [{ hook_event_name: 'SessionStart', source: 'compact' }]);
    const result = await run(built, '--final');
    expect(result.json['verdict']).toBe('undetermined');
    expect(arms(result.json).packet).toMatchObject({ truncatedTranscript: 1 });
  });

  it('a cut history, journal present', () => {
    const facts = analyze(new TranscriptBuilder('c-x', START).prompt().boundary().calls(2).text(), {
      previousAgents: Array.from({ length: 20 }, () => ({ provider: 'codex', providerSessionId: 'x', startedAt: START })) as NonNullable<WorkSession['previousAgents']>,
    }, { journal: journalWithCompactions });
    expect(facts.unknownReasons).toEqual(['incomplete-history']);
    expect(final([facts, ...many(20, () => fake('control', ['error'])), ...many(20, () => fake('packet', ['ok']))]).verdict).toBe('undetermined');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('criterion 8: the cohort and the cutoff', () => {
  it('two experiments with different names: only the named one is counted; a session of the old one that compacted meanwhile is not', async () => {
    const root = freshRoot();
    const built = await buildHome({
      root,
      sessions: [
        { arm: 'packet', claudeId: 'claude-a', trialName: 'exp-a' },
        { arm: 'control', claudeId: 'claude-b', trialName: 'exp-a' },
        { arm: 'packet', claudeId: 'claude-old', trialName: 'exp-old' },
      ],
      rooms: [{ members: [{ session: 0, from: T09 }, { session: 1, from: T09 }, { session: 2, from: T09 }] }],
    });
    for (const id of ['claude-a', 'claude-b', 'claude-old']) writeTranscript(built, id, new TranscriptBuilder(id, START).prompt().boundary().calls(2, { result: 'error' }).text());
    const result = await run(built, '--final');
    expect((result.json['cohort'] as Record<string, unknown>)['sessions']).toBe(2);
    expect((result.json['cohort'] as Record<string, unknown>)['otherTrialSessions']).toBe(1);
    expect(arms(result.json).packet.compactions).toBe(1);
    expect(result.out).toContain('sessions of other experiments (ignored): 1');
  });

  it('a window across the cutoff is counted only up to it; a record after the cutoff is not read; assignments after the cutoff are left out', async () => {
    const root = freshRoot();
    const built = await buildHome({
      root,
      sessions: [
        { arm: 'packet', claudeId: 'claude-a' },
        { arm: 'control', claudeId: 'claude-b' },
        { arm: 'packet', claudeId: 'claude-late', assignedAt: '2026-11-20T10:50:00.000Z' },
      ],
      rooms: [{ members: [{ session: 0, from: T09 }, { session: 1, from: T09 }] }],
    });
    // cutoff 10:30:00; second-by-second clock from 10:00:00
    const a = new TranscriptBuilder('claude-a', START).prompt().at(60).boundary().calls(3).at(1790).call({ result: 'error' }).at(1810).call({ result: 'error' }).at(1900).boundary().calls(2);
    writeTranscript(built, 'claude-a', a.text());
    writeTranscript(built, 'claude-b', new TranscriptBuilder('claude-b', START).prompt().boundary().calls(2).text());
    writeTranscript(built, 'claude-late', new TranscriptBuilder('claude-late', START).prompt().boundary().calls(2).text());
    const result = await run(built, '--final', ['--cutoff', '2026-11-20T10:30:00.000Z']);
    expect(arms(result.json).packet).toMatchObject({ sessions: 1, compactions: 1 });
    // 3 calls and the error at 10:29:50 count; the error at 10:30:10 and the boundary at 10:31:40 do not
    expect((result.json['outcome'] as Record<Arm, Record<string, number>>).packet).toMatchObject({ windowsInRoom: 1, errorWindows: 1, unfinishedWindows: 1 });
    expect((result.json['cohort'] as Record<string, unknown>)['assignedAfterCutoff']).toEqual([`${built.workId}/s-03`]);
    expect(result.out).toContain('cutoff: 2026-11-20T10:30:00.000Z');
    expect(result.out).toContain('first assignment: 2026-11-20T09:00:00.000Z; last assignment: 2026-11-20T10:50:00.000Z');
  });

  it('readTranscriptText stops at the first main-chain record not earlier than the cutoff and keeps untimed records before it', () => {
    const lines = [
      JSON.stringify({ type: 'mode' }),
      JSON.stringify({ type: 'user', timestamp: '2026-11-20T10:00:00.000Z' }),
      JSON.stringify({ type: 'user', isSidechain: true, timestamp: '2026-11-20T11:00:00.000Z' }),
      JSON.stringify({ type: 'user', timestamp: '2026-11-20T10:30:00.000Z' }),
      JSON.stringify({ type: 'user', timestamp: '2026-11-20T10:10:00.000Z' }),
    ].join('\n');
    const read = readTranscriptText(lines, Date.parse('2026-11-20T10:30:00.000Z'));
    expect(read.records).toHaveLength(3);
    expect(read.cut).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('criterion 9: nothing is written to the home or the transcript roots', () => {
  const listing = (dir: string): string[] => {
    const rows: string[] = [];
    const walk = (current: string): void => {
      for (const name of readdirSync(current).sort()) {
        const file = path.join(current, name);
        const info = statSync(file);
        rows.push(`${path.relative(dir, file)}|${info.isDirectory() ? 'dir' : info.size}|${info.mtimeMs}`);
        if (info.isDirectory()) walk(file);
      }
    };
    walk(dir);
    return rows;
  };

  it('with the write permission removed from the fixture directories the listing is the same before and after a run, in both modes', async () => {
    const root = freshRoot();
    const built = await basicHome(root);
    for (const dir of [built.home, built.project, built.claudeRoot]) {
      const all: string[] = [dir];
      const collect = (current: string): void => {
        for (const name of readdirSync(current)) {
          const file = path.join(current, name);
          if (statSync(file).isDirectory()) { all.push(file); collect(file); }
        }
      };
      collect(dir);
      for (const entry of all.reverse()) chmodSync(entry, 0o555);
    }
    const before = [built.home, built.project, built.claudeRoot].map(listing);
    const snapshotsBefore = readdirSync(tmpdir()).filter((name) => name.startsWith('room-packet-trial-snap-')).length;
    const status = await run(built, '--status', [], root);
    const finalRun = await run(built, '--final', [], root);
    const after = [built.home, built.project, built.claudeRoot].map(listing);
    expect(status.code).toBe(0);
    expect(finalRun.code).toBe(0);
    expect(after).toEqual(before);
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith('room-packet-trial-snap-')).length).toBe(snapshotsBefore);
    // restore for the cleanup
    const restore = (dir: string): void => {
      chmodSync(dir, 0o755);
      for (const name of readdirSync(dir)) if (statSync(path.join(dir, name)).isDirectory()) restore(path.join(dir, name));
    };
    for (const dir of [built.home, built.project, built.claudeRoot]) restore(dir);
  });

  it('refuses an --out path inside the home or a transcript root', async () => {
    const built = await basicHome();
    for (const target of [path.join(built.home, 'x.json'), path.join(built.claudeRoot, 'x.json')]) {
      let out = '';
      const code = await main(['--status', '--trial', 'exp-a', '--home', built.home, '--claude-root', built.claudeRoot, '--out', target], { write: (text) => { out += text; } });
      expect(code).toBe(2);
      expect(out).toContain('read-only');
      expect(existsSync(target)).toBe(false);
    }
  });

  it('the snapshot is a checked copy outside the home and cleanup removes it', async () => {
    const built = await basicHome();
    const snapshot = makeSnapshot(built.home);
    expect(snapshot.dir.startsWith(built.home)).toBe(false);
    expect(existsSync(path.join(snapshot.dir, 'parley.db'))).toBe(true);
    snapshot.cleanup();
    expect(existsSync(snapshot.dir)).toBe(false);
    expect(() => makeSnapshot(path.join(built.home, 'nothing-here'))).toThrow('no parley.db');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('criterion 10: a session with a damaged assignment', () => {
  it('is printed on its own line in both modes, stays out of the cohort and makes --final undetermined', async () => {
    const root = freshRoot();
    const built = await buildHome({
      root,
      sessions: [{ arm: 'packet', claudeId: 'claude-a' }, { arm: 'control', claudeId: 'claude-b' }, { arm: 'damaged', claudeId: 'claude-bad' }],
      rooms: [{ members: [{ session: 0, from: T09 }, { session: 1, from: T09 }, { session: 2, from: T09 }] }],
    });
    for (const id of ['claude-a', 'claude-b', 'claude-bad']) writeTranscript(built, id, new TranscriptBuilder(id, START).prompt().boundary().calls(2).text());
    const status = await run(built, '--status');
    const finalRun = await run(built, '--final');
    for (const result of [status, finalRun]) {
      expect(result.out).toContain('sessions with a damaged assignment (whole home, not in the cohort): 1');
      expect((result.json['cohort'] as Record<string, unknown>)['damagedSessions']).toEqual([`${built.workId}/s-03`]);
      expect((result.json['cohort'] as Record<string, unknown>)['sessions']).toBe(2);
    }
    expect(finalRun.json['verdict']).toBe('undetermined');
    expect(finalRun.json['bounds']).toBeNull();
    expect(finalRun.out).toContain('damaged assignment');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('item 14: membership of a room', () => {
  const memberCohort = (): SessionFacts[] => [...many(20, (i) => fake('control', [i < 15 ? 'error' : 'ok'])), ...many(20, (i) => fake('packet', [i < 2 ? 'error' : 'ok']))];

  it('a compaction outside a room is a separate line and does not change the verdict; a compaction with approximate membership makes it unknown', () => {
    const base = final(memberCohort());
    expect(base.verdict).toBe('supports');

    const outside = analyze(new TranscriptBuilder('c-x', START).prompt().boundary().calls(2).text(), {}, { membership: { exact: [], approx: [] } });
    expect(outside.compactions[0]!.room).toBe('out');
    expect(outside.unknownReasons).toEqual([]);
    expect(final([...memberCohort(), outside]).verdict).toBe('supports');

    const approx = analyze(
      new TranscriptBuilder('c-y', START).prompt().boundary().calls(2).text(), {},
      { membership: { exact: [], approx: [{ from: 0, to: Number.POSITIVE_INFINITY }] } },
    );
    expect(approx.compactions[0]!.room).toBe('approx');
    expect(approx.unknownReasons).toEqual(['approximate-membership']);
    const blocked = final([...memberCohort(), approx]);
    expect(blocked.verdict).toBe('undetermined');
    expect(blocked.bounds).toBeNull();
  });

  it('end to end: a room without a journal puts its member into the unknown line and its count on a separate line', async () => {
    const root = freshRoot();
    const built = await buildHome({
      root,
      sessions: [{ arm: 'packet', claudeId: 'claude-a' }, { arm: 'control', claudeId: 'claude-b' }],
      rooms: [{ members: [{ session: 0, from: T09 }], journal: false }, { members: [{ session: 1, from: T09 }] }],
    });
    for (const id of ['claude-a', 'claude-b']) writeTranscript(built, id, new TranscriptBuilder(id, START).prompt().boundary().calls(2).text());
    const result = await run(built, '--final');
    expect(arms(result.json).packet).toMatchObject({ approximateMembership: 1, compactionsApproximate: 1, compactionsInRoom: 0 });
    expect(arms(result.json).control).toMatchObject({ approximateMembership: 0, compactionsApproximate: 0, compactionsInRoom: 1 });
    expect(result.json['verdict']).toBe('undetermined');
    expect(result.out).toContain('approximate membership (separate line, unknown)');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('item 21: a session without a transcript, four cases', () => {
  const spec = (session: Partial<HomeSpec['sessions'][number]>, room: boolean): HomeSpec => ({
    root: freshRoot(),
    sessions: [{ arm: 'packet', claudeId: 'claude-a', ...session }],
    rooms: room ? [{ members: [{ session: 0, from: T09 }] }] : [],
  });

  it('never launched (no claude id): zero windows, known', async () => {
    const built = await buildHome(spec({ claudeId: null }, false));
    const result = await run(built, '--final');
    expect(arms(result.json).packet).toMatchObject({ notLaunched: 1, transcriptMissing: 0, sessionsWithWindow: 0 });
    expect((result.json['verdictReasons'] as string[]).join(' ')).not.toContain('unknown number');
  });

  it('opened and never touched: an id, no file, never in a room — zero windows, known, a "no conversation" line', async () => {
    const built = await buildHome(spec({}, false));
    const result = await run(built, '--final');
    expect(arms(result.json).packet).toMatchObject({ noConversation: 1, transcriptMissing: 0 });
    expect((result.json['verdictReasons'] as string[]).join(' ')).not.toContain('unknown number');
  });

  it('never in a room but with a trace of a turn: known, counted on its own line', async () => {
    const built = await buildHome(spec({ result: true }, false));
    const result = await run(built, '--final');
    expect(arms(result.json).packet).toMatchObject({ missingNotMember: 1, transcriptMissing: 0 });
  });

  it('a room member without a file: unknown — with or without a trace of a turn', async () => {
    const quiet = await buildHome(spec({}, true));
    const quietResult = await run(quiet, '--final');
    expect(arms(quietResult.json).packet).toMatchObject({ transcriptMissing: 1 });
    expect(quietResult.json['verdict']).toBe('undetermined');
    const traced = await buildHome(spec({ result: true }, true));
    const tracedResult = await run(traced, '--final');
    expect(arms(tracedResult.json).packet).toMatchObject({ transcriptMissing: 1 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('item 17: hook journals are counted for the whole file', () => {
  it('the table says so, the cancellation by the hook limit is "not determined", not zero', async () => {
    const built = await basicHome();
    const result = await run(built, '--status');
    expect(result.out).toContain('journal, WHOLE FILE, no cutoff');
    expect(result.out).toContain('bridge cancellations by the hook limit: not determined');
    expect(result.out).not.toContain('bridge cancellations by the hook limit: 0');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('item 23: retention of transcripts by Claude Code', () => {
  const settings = (content: string | null): string => {
    const file = path.join(freshRoot(), 'settings.json');
    if (content !== null) writeFileSync(file, content);
    return file;
  };

  it('value set (no warning at 49 and above, warning below), not set, no file, unreadable', () => {
    expect(readRetention(settings('{"cleanupPeriodDays": 60}'))).toEqual({ value: 60, source: 'file', warning: false });
    expect(readRetention(settings('{"cleanupPeriodDays": 49}'))).toEqual({ value: 49, source: 'file', warning: false });
    expect(readRetention(settings('{"cleanupPeriodDays": 48}'))).toEqual({ value: 48, source: 'file', warning: true });
    expect(readRetention(settings('{"cleanupPeriodDays": 7}'))).toEqual({ value: 7, source: 'file', warning: true });
    expect(readRetention(settings('{"theme": "dark"}'))).toEqual({ value: 30, source: 'default-unset', warning: true });
    expect(readRetention(settings(null))).toEqual({ value: 30, source: 'default-no-file', warning: true });
    expect(readRetention(settings('{ not json'))).toEqual({ value: 30, source: 'default-unreadable', warning: true });
  });

  it('both modes print the value and the warning', async () => {
    const built = await basicHome();
    const file = path.join(path.dirname(built.home), 'claude-settings.json');
    writeFileSync(file, '{"cleanupPeriodDays": 7}');
    for (const mode of ['--status', '--final'] as const) {
      const result = await run(built, mode, ['--claude-settings', file]);
      expect(result.out).toContain('cleanupPeriodDays: 7 (file) - WARNING: below 49 days');
    }
    writeFileSync(file, '{"cleanupPeriodDays": 90}');
    const quiet = await run(built, '--status', ['--claude-settings', file]);
    expect(quiet.out).toContain('cleanupPeriodDays: 90 (file)');
    expect(quiet.out).not.toContain('WARNING');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('command line', () => {
  it('--final needs a cutoff; exactly one mode; a bad experiment name', async () => {
    const write = { write: () => undefined };
    expect(await main(['--final', '--trial', 'exp-a'], write)).toBe(2);
    expect(await main(['--trial', 'exp-a'], write)).toBe(2);
    expect(await main(['--status', '--final', '--trial', 'exp-a'], write)).toBe(2);
    expect(await main(['--status', '--trial', 'Bad Name'], write)).toBe(2);
    expect(await main(['--help'], write)).toBe(0);
  });

  it('packet receipt: a packet insert after the boundary and before the first model record, in a hook_additional_context record', () => {
    const early = analyzeChain(
      JSON.parse(`[${new TranscriptBuilder('c', START).boundary().packet(500).model().calls(1).text().trim().split('\n').join(',')}]`) as Array<Record<string, unknown>>,
      false,
    );
    expect(early.compactions[0]).toMatchObject({ received: true, packetBytes: 500 });
    const late = analyzeChain(
      JSON.parse(`[${new TranscriptBuilder('c', START).boundary().model().packet(500).text().trim().split('\n').join(',')}]`) as Array<Record<string, unknown>>,
      false,
    );
    expect(late.compactions[0]!.received).toBe(false);
    const other = analyzeChain(
      JSON.parse(`[${new TranscriptBuilder('c', START).boundary().otherHook().model().text().trim().split('\n').join(',')}]`) as Array<Record<string, unknown>>,
      false,
    );
    expect(other.compactions[0]!.received).toBe(false);
  });

  it('a model call is counted once by its message id', () => {
    const builder = new TranscriptBuilder('c', START).boundary();
    builder.call({ messageId: 'same' });
    builder.call({ messageId: 'same' });
    const chain = analyzeChain(JSON.parse(`[${builder.text().trim().split('\n').join(',')}]`) as Array<Record<string, unknown>>, false);
    expect(chain.compactions[0]!.modelCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('items 25-30: corrections after the first acceptance', () => {
  it('25: the output guard compares real paths — the home and the output named through different names of one directory', async () => {
    const root = freshRoot();
    const built = await buildHome({ root, sessions: [{ arm: 'packet', claudeId: 'claude-a' }], rooms: [] });
    const alias = path.join(root, 'alias');
    symlinkSync(built.home, alias);
    const aliasClaude = path.join(root, 'claude-alias');
    symlinkSync(built.claudeRoot, aliasClaude);
    for (const [home, claude, target] of [
      [built.home, built.claudeRoot, path.join(alias, 'x.json')],
      [alias, built.claudeRoot, path.join(built.home, 'y.json')],
      [built.home, built.claudeRoot, path.join(aliasClaude, 'z.json')],
      [built.home, built.claudeRoot, path.join(alias, 'not-yet', 'deeper', 'w.json')],
    ] as const) {
      let out = '';
      const code = await main(['--status', '--trial', 'exp-a', '--home', home, '--claude-root', claude, '--out', target], { write: (text) => { out += text; } });
      expect(code).toBe(2);
      expect(out).toContain('read-only');
      expect(existsSync(target)).toBe(false);
    }
    expect(realPathLoose(path.join(alias, 'a', 'b'))).toBe(path.join(realPathLoose(built.home), 'a', 'b'));
  });

  it('26: unrelated segments are not stitched: a window ends at the end of its segment', () => {
    const first = new TranscriptBuilder('claude-1', START).prompt().boundary().calls(2);
    // the second file has no shared history; its calls before its own boundary must not join the first window
    const second = new TranscriptBuilder('claude-2', '2026-11-20T12:00:00.000Z').prompt().calls(3, { result: 'error' }).boundary().call();
    const session = sessionOf({
      providerSessionId: 'claude-2',
      previousAgents: [
        { provider: 'claude', providerSessionId: 'claude-1', startedAt: START, endedAt: '2026-11-20T11:00:00.000Z' },
        { provider: 'codex', providerSessionId: 'codex-1', startedAt: START, endedAt: '2026-11-20T11:30:00.000Z' },
      ] as NonNullable<WorkSession['previousAgents']>,
    });
    const facts = analyzeSession({
      session, workId: 'w-1', membership: MEMBER, hasMessages: false,
      journal: { present: false, sessionStartCompactLines: 0, bridgeOutcomes: {}, hostReasons: {}, turnTrace: false },
      transcriptFiles: [{ id: 'claude-1', text: first.text() }, { id: 'claude-2', text: second.text() }],
      cutoffMs: Date.parse(CUTOFF),
    });
    expect(facts.compactions).toHaveLength(2);
    expect(facts.windows.map((window) => [window.calls, window.outcome, window.finished])).toEqual([[2, 'ok', true], [1, 'ok', false]]);
    expect(facts.errorResults).toBe(3);
    // while a file that repeats the first file's records is the same segment
    const copy = new TranscriptBuilder('claude-3', START, 'claude-1').prompt().boundary().calls(2).calls(1);
    expect(splitSegments([JSON.parse(`[${first.text().trim().split('\n').join(',')}]`), JSON.parse(`[${copy.text().trim().split('\n').join(',')}]`)]).segments).toHaveLength(1);
  });

  it('26: a started Claude segment without an id is an incomplete history, not "never launched"', () => {
    const text = new TranscriptBuilder('c-x', START).prompt().boundary().calls(1).text();
    const previous = analyze(null, {
      providerSessionId: null,
      previousAgents: [{ provider: 'claude', providerSessionId: null, startedAt: START, endedAt: '2026-11-20T11:00:00.000Z' }] as NonNullable<WorkSession['previousAgents']>,
    });
    expect(previous.unknownReasons).toContain('incomplete-history');
    expect(previous.transcript).toBe('history-incomplete');
    const current = analyze(text, { providerSessionId: null });
    expect(current.unknownReasons).toContain('incomplete-history');
    expect(current.transcript).toBe('history-incomplete');
    // never started: still "not launched"
    const never = analyze(null, { providerSessionId: null, startedAt: null });
    expect(never.transcript).toBe('not-launched');
    expect(never.unknownReasons).toEqual([]);
    // switched to claude after another agent had run, claude itself never started: core's segment parser (`trialSegments`) takes the
    // session's first start for the current segment, so this is read as incomplete — the conservative side
    const switched = analyze(null, {
      providerSessionId: null,
      previousAgents: [{ provider: 'codex', providerSessionId: 'cx', startedAt: START, endedAt: '2026-11-20T11:00:00.000Z' }] as NonNullable<WorkSession['previousAgents']>,
    });
    expect(switched.transcript).toBe('history-incomplete');
  });

  const approxOutside: Membership = { exact: [], approx: [{ from: Date.parse('2027-01-01T00:00:00Z'), to: Number.POSITIVE_INFINITY }] };
  const solid = (): SessionFacts[] => [...many(12, (i) => fake('control', [i < 9 ? 'error' : 'ok'])), ...many(11, (i) => fake('packet', [i < 2 ? 'error' : 'ok']))];

  it('27: membership rebuilt without a journal blocks the whole session even if no boundary falls into the rebuilt period (12 and 12)', () => {
    const blocked = analyze(new TranscriptBuilder('c-x', START).prompt().boundary().calls(2).text(), {}, { membership: approxOutside });
    expect(blocked.compactions[0]!.room).toBe('out');
    expect(blocked.unknownReasons).toEqual(['approximate-membership']);
    const cohort = [...solid(), blocked];
    expect(cohort.filter((session) => session.arm === 'control')).toHaveLength(12);
    expect(cohort.filter((session) => session.arm === 'packet')).toHaveLength(12);
    expect(final(cohort).verdict).toBe('undetermined');
    expect(final(cohort).bounds).toBeNull();
    expect(final(solid().concat(fake('packet', ['ok']))).verdict).toBe('supports');
  });

  it('27: a boundary without a time leaves the participation unknown for the whole session', () => {
    const untimed = new TranscriptBuilder('c-x', START).prompt().raw(JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'untimed-1', isSidechain: false })).calls(2).text();
    const facts = analyze(untimed);
    expect(facts.unknownReasons).toEqual(['untimed-boundary']);
    expect(final([...solid(), facts]).verdict).toBe('undetermined');
  });

  it('28: "first compaction only" is the very first compaction; an empty first window gives no window', () => {
    const emptyFirst = (arm: Arm): SessionFacts => fake(arm, ['empty', 'error']);
    const allEmptyFirst = [...many(12, () => emptyFirst('control')), ...many(12, () => emptyFirst('packet'))];
    const check = final(allEmptyFirst).sensitivity.find((entry) => entry.name.startsWith('first compaction'))!;
    expect(check.bounds.favourable.interval).toBeNull();
    expect(check.bounds.favourable.reason).toContain('fewer than 10');
    const filled = [...many(12, () => fake('control', ['error', 'ok'])), ...many(12, (i) => fake('packet', [i < 2 ? 'error' : 'ok', 'error']))];
    const second = final(filled).sensitivity.find((entry) => entry.name.startsWith('first compaction'))!;
    // only the first window of each session: packet 2/12, control 12/12
    expect(second.bounds.favourable.interval!.r).toBeCloseTo(2 / 12, 6);
  });

  it('28: "all compactions" takes in a session whose only unknown part is the membership; other unknowns stay out', () => {
    const packet = [...many(9, (i) => fake('packet', [i < 2 ? 'error' : 'ok'])), fake('packet', ['ok'], { unknownReasons: ['approximate-membership'] })];
    const control = many(10, (i) => fake('control', [i < 8 ? 'error' : 'ok']));
    const result = final([...packet, ...control]);
    const all = result.sensitivity.find((entry) => entry.name.startsWith('all compactions'))!;
    const equal = result.sensitivity.find((entry) => entry.name.startsWith('equal weight'))!;
    expect(all.bounds.favourable.interval).not.toBeNull();
    expect(equal.bounds.favourable.interval).toBeNull();
    const withOther = final([...packet.slice(0, 9), fake('packet', ['ok'], { unknownReasons: ['missing-transcript'] }), ...control]);
    expect(withOther.sensitivity.find((entry) => entry.name.startsWith('all compactions'))!.bounds.favourable.interval).toBeNull();
  });

  it('29: compactions in the whole file are counted without the cutoff: two boundaries on either side of it give 2', async () => {
    const root = freshRoot();
    const built = await buildHome({ root, sessions: [{ arm: 'packet', claudeId: 'claude-a' }], rooms: [{ members: [{ session: 0, from: T09 }] }] });
    writeTranscript(built, 'claude-a', new TranscriptBuilder('claude-a', START).prompt().at(60).boundary().calls(1).at(7200).boundary().calls(1).text());
    writeJournal(built, 's-01', [{ hook_event_name: 'SessionStart', source: 'compact' }, { hook_event_name: 'SessionStart', source: 'compact' }]);
    const result = await run(built, '--status', ['--cutoff', '2026-11-20T11:00:00.000Z']);
    expect(arms(result.json).packet.compactions).toBe(1);
    expect(arms(result.json).packet.journal).toMatchObject({ sessionStartCompactLines: 2, transcriptCompactionsWholeFile: 2 });
    expect(result.out).toContain('2/2');
  });

  it('30: only the main chain counts: a packet insert, an error result and model calls of a side chain are ignored', () => {
    const builder = new TranscriptBuilder('c-x', START).prompt().boundary();
    builder.push({ type: 'attachment', isSidechain: true, attachment: { type: 'hook_additional_context', hookName: 'SessionStart', hookEvent: 'SessionStart', content: ['Room state packet side chain text'] } });
    builder.push({ type: 'attachment', isSidechain: true, attachment: { type: 'hook_cancelled', hookEvent: 'SessionStart' } });
    builder.call({ sidechain: true, result: 'error' }).model({ sidechain: true }).call();
    const facts = analyze(builder.text());
    expect(facts.compactions[0]).toMatchObject({ received: false, packetBytes: 0, modelCalls: 1, hookCancelledRecords: 0 });
    expect(facts.errorResults).toBe(0);
    expect(facts.windows[0]).toMatchObject({ calls: 1, outcome: 'ok' });
    expect(summarizeArm([facts]).spendEstimateTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('item 24: the cohort is the union of records, traces of deleted sessions and the assignment list', () => {
  const MEMBERS = (rooms = 1): HomeSpec['rooms'] =>
    Array.from({ length: rooms }, () => ({ members: [{ session: 0, from: T09 }, { session: 1, from: T09 }] }));

  /** Two sessions (packet, control) in one room, each with one compaction and two calls in a transcript. */
  async function pair(extra: Partial<HomeSpec> = {}, rooms: HomeSpec['rooms'] = MEMBERS()): Promise<{ built: BuiltHome; result: Run }> {
    const built = await buildHome({
      root: freshRoot(),
      sessions: [{ arm: 'packet', claudeId: 'claude-a' }, { arm: 'control', claudeId: 'claude-b' }],
      rooms,
      ...extra,
    });
    for (const id of ['claude-a', 'claude-b']) writeTranscript(built, id, new TranscriptBuilder(id, START).prompt().at(60).boundary().calls(2).text());
    const result = await run(built, '--final');
    return { built, result };
  }
  interface CohortJson {
    sessions: number; tracedSessions: number; blockers: string[]; damagedWorks: string[]; ledgerDisagreements: string[]; missingIntents: string[];
    ledger: { status: string; error: string | null; unreadableLines: number[]; intents: number; cancelled: number; confirmed: number };
  }
  const cohortOf = (result: Run): CohortJson => result.json['cohort'] as CohortJson;
  const unknownOf = (result: Run): Array<{ session: string; reasons: string[] }> => result.json['sessionsByUnknown'] as Array<{ session: string; reasons: string[] }>;

  it('a live record: counted as usual, the list agrees, nothing blocks', async () => {
    const { result } = await pair();
    expect(cohortOf(result)).toMatchObject({ sessions: 2, blockers: [], damagedWorks: [] });
    expect(cohortOf(result).ledger).toMatchObject({ status: 'ok', intents: 2, confirmed: 2, unreadableLines: [] });
    expect(unknownOf(result)).toEqual([]);
  });

  it('a deleted session with a trace: counted by the trace — arm and ids from it, its room participation kept; its hook journal is not read', async () => {
    const built = await buildHome({
      root: freshRoot(),
      sessions: [{ arm: 'packet', claudeId: 'claude-a' }, { arm: 'control', claudeId: 'claude-b' }],
      rooms: MEMBERS(),
      deleteSessions: [0],
    });
    for (const id of ['claude-a', 'claude-b']) writeTranscript(built, id, new TranscriptBuilder(id, START).prompt().at(60).boundary().calls(2).text());
    writeJournal(built, 's-01', [{ hook_event_name: 'SessionStart', source: 'compact' }, { hook_event_name: 'ParleyRoomPacketBridge', outcome: 'printed' }]);
    const result = await run(built, '--final');
    expect(cohortOf(result)).toMatchObject({ sessions: 2, tracedSessions: 1, blockers: [] });
    expect(arms(result.json).packet).toMatchObject({ sessions: 1, sessionsFromTrace: 1, compactionsInRoom: 1, sessionsWithWindow: 1 });
    // not "zero refusals": the journal is not available for a deleted session, so it is not counted at all
    expect(arms(result.json).packet.journal).toMatchObject({ sessionsWithJournal: 0, bridgeOutcomes: {} });
    expect(result.out).toContain('from the trace of a deleted session (no hook journal)');
    expect(unknownOf(result)).toEqual([]);
  });

  it('a session lost: an intent without a cancel, no record, no trace — unknown, named by the confirm line when there is one', async () => {
    const { result } = await pair({ lostIntents: [{ arm: 'packet', confirm: { workId: 'w-0001', sessionId: 's-77' } }, { arm: 'control' }] });
    expect(arms(result.json).packet).toMatchObject({ sessions: 2, sessionsLost: 1 });
    expect(arms(result.json).control).toMatchObject({ sessions: 2, sessionsLost: 1 });
    const names = unknownOf(result).map((entry) => entry.session).sort();
    expect(names).toHaveLength(2);
    expect(names).toContain('w-0001/s-77');
    expect(names.find((name) => name !== 'w-0001/s-77')).toMatch(/^-\/tag:f0+2$/);
    expect(unknownOf(result).every((entry) => entry.reasons[0] === 'lost-session')).toBe(true);
    expect(result.json['verdict']).toBe('undetermined');
    expect(result.json['bounds']).toBeNull();
  });

  it('a cancelled intent is not a lost session; a confirm line that names other numbers does not matter — the tag decides', async () => {
    const cancelled = JSON.stringify({ kind: 'intent', tag: 'e'.repeat(32), name: 'exp-a', arm: 'packet', at: T09 }) + '\n' + JSON.stringify({ kind: 'cancel', tag: 'e'.repeat(32), at: T09 }) + '\n';
    const renumbered = JSON.stringify({ kind: 'confirm', tag: '1'.padStart(32, '0'), projectPath: '/elsewhere', workId: 'w-9999', incarnation: 7, sessionId: 's-99', at: T09 }) + '\n';
    const { result } = await pair({ ledgerRaw: cancelled + renumbered });
    expect(cohortOf(result)).toMatchObject({ sessions: 2, blockers: [] });
    expect(unknownOf(result)).toEqual([]);
  });

  it('the arm in the list and in the map differ, or the list calls the tag cancelled: treated as a damaged assignment', async () => {
    for (const extra of [{ ledgerOtherArm: [0] }, { ledgerCancelled: [1] }] as Array<Partial<HomeSpec>>) {
      const { result } = await pair(extra);
      expect(cohortOf(result).ledgerDisagreements).toHaveLength(1);
      expect(cohortOf(result).blockers.join(' ')).toContain('arm in the list and in the map differ');
      expect(result.json['verdict']).toBe('undetermined');
      expect(result.json['bounds']).toBeNull();
    }
  });

  it('a session of the experiment with no intent line in an existing list blocks', async () => {
    const { result } = await pair({ ledgerSkip: [0] });
    expect(cohortOf(result).missingIntents).toHaveLength(1);
    expect(result.json['verdict']).toBe('undetermined');
    expect(result.json['bounds']).toBeNull();
  });

  it('no list file while sessions of the experiment exist, an unreadable list, a torn line, a garbage line: each blocks', async () => {
    const missing = await pair({ ledger: 'none' });
    expect(cohortOf(missing.result).ledger.status).toBe('missing');
    const directory = await pair({ ledger: 'directory' });
    expect(cohortOf(directory.result).ledger.status).toBe('unreadable');
    const torn = await pair({ ledgerRaw: '{"kind":"intent","tag":"abc' });
    const garbage = await pair({ ledgerRaw: 'not json at all\n' });
    for (const { result } of [missing, directory, torn, garbage]) {
      expect(cohortOf(result).blockers.length).toBeGreaterThan(0);
      expect(result.json['verdict']).toBe('undetermined');
      expect(result.json['bounds']).toBeNull();
    }
    expect(cohortOf(torn.result).ledger.unreadableLines).toHaveLength(1);
    expect(cohortOf(garbage.result).ledger.unreadableLines).toHaveLength(1);
  });

  it('no list file and no session of the experiment: nothing to notice, nothing blocks', async () => {
    const built = await buildHome({ root: freshRoot(), sessions: [{ arm: 'packet', claudeId: 'claude-a', trialName: 'exp-old' }], rooms: [], ledger: 'none' });
    const result = await run(built, '--status');
    expect(result.code).toBe(0);
    expect(cohortOf(result)).toMatchObject({ sessions: 0, blockers: [] });
    expect(cohortOf(result).ledger.status).toBe('missing');
  });

  it('a deleted room with a journal: the compaction made in it still counts in the main calculation, whatever the order of the deletions', async () => {
    for (const sessionsFirst of [false, true]) {
      const { result } = await pair({ deleteRooms: [0], deleteSessions: [0], sessionsFirst });
      expect(arms(result.json).packet).toMatchObject({ compactionsInRoom: 1, compactionsApproximate: 0, approximateMembership: 0 });
      expect(arms(result.json).control).toMatchObject({ compactionsInRoom: 1, approximateMembership: 0 });
      expect(cohortOf(result).blockers).toEqual([]);
      expect(unknownOf(result)).toEqual([]);
      expect((result.json['outcome'] as Record<Arm, Record<string, number>>).packet.windowsInRoom).toBe(1);
    }
  });

  it('a deleted room without a journal, or a deleted session that was in such a room, leaves the participation unknown', async () => {
    const roomGone = await pair({ deleteRooms: [0] }, [{ members: [{ session: 0, from: T09 }, { session: 1, from: T09 }], journal: false }]);
    expect(arms(roomGone.result.json).packet.approximateMembership).toBe(1);
    expect(roomGone.result.json['verdict']).toBe('undetermined');
    expect(roomGone.result.json['bounds']).toBeNull();
    const sessionGone = await pair({ deleteSessions: [0] }, [{ members: [{ session: 0, from: T09 }, { session: 1, from: T09 }], journal: false }]);
    expect(arms(sessionGone.result.json).packet).toMatchObject({ sessionsFromTrace: 1, approximateMembership: 1 });
    expect(sessionGone.result.json['bounds']).toBeNull();
  });

  it('a damaged trace: the work is named, the verdict is blocked and the participation of its sessions is not exact', async () => {
    const { result } = await pair({ deleteSessions: [0], traceDamage: true });
    expect(cohortOf(result).damagedWorks).toHaveLength(1);
    expect(result.json['verdict']).toBe('undetermined');
    expect(arms(result.json).control.approximateMembership).toBe(1);
    expect(result.out).toContain('works with a damaged trial trace or assignment: 1');
  });

  it('both modes print the state of the list', async () => {
    const built = await buildHome({ root: freshRoot(), sessions: [{ arm: 'packet', claudeId: 'claude-a' }], rooms: [] });
    for (const mode of ['--status', '--final'] as const) {
      const result = await run(built, mode);
      expect(result.out).toContain('assignment list: ok; intents 1, cancelled 0, confirmed 1; unreadable lines 0');
    }
  });
});
