// Code Mode MCP wrappers (plan T7a-wrappers): code_search, code_docs and code_execute over the catalogue and the T5b3
// broker. These tests use the source modules with stubbed brokers (descriptors, discovery, refusals, the mapping of a run to
// an ExecuteResult, the lazy backend, registration) and, in the last block, the real broker under the sandboxed helper.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addSession, transitionSession } from '../work/map.js';
import { PARLEY } from '../work/types.js';
import { createWork, readStoredMap, updateMap, workPaths } from '../work/store.js';
import type { McpContext } from './context.js';
import { type Catalog, INITIAL_COHORT, buildCatalog, declarationsFor } from './code-mode/catalog.js';
import { MIGRATABLE_READS, MIGRATION_REGISTRY } from './code-mode/migration-registry.js';
import type { Broker, BrokerRunResult } from './code-mode/broker.js';
import {
  BUSY_REASONS,
  CONTRACT_LIMITS,
  CONTRACT_VERSION,
  ERROR_MESSAGES,
  REQUEST_SCHEMAS,
  type AgentView,
  type ExecuteResult,
  compileCallValidators,
  computeApiRevision,
  encodeCursor,
  operationEvidence,
  parsePage,
  requestKey,
} from './code-mode/contracts.js';
import { LIVE_POLICY_UNAVAILABLE, resolveLiveNativePolicy } from './code-mode/native-policy.js';
import { runRecordPath } from './code-mode/run-record.js';
import { type CodeModeBackend, createCodeModeSurface, liveBackend } from './code-mode-tools.js';
import { STALE_AGENT, TOOLS, createParleyServer } from './tools.js';
import { type AgentHost, type Script, okEnvelope, startAgentHost } from '../../../../tests/fixtures/code-mode/agent-host.js';
import type * as BrokerModule from './code-mode/broker.js';
import type * as CatalogModule from './code-mode/catalog.js';
import type * as FixtureModule from '../../../../tests/fixtures/code-mode/native-policy.js';
import type * as ToolsModule from './code-mode-tools.js';

const catalog = buildCatalog(TOOLS);
const LAUNCH = 'launch-fixture-1';
const SECRET = 'sk-ant-api03-SYNTHETIC-SECRET-VALUE';
const holdRoots: string[] = [];
/** Each broker's run record lives in a fresh directory unless a test shares one. */
const HOLD = () => { const workDir = mkdtempSync(path.join(tmpdir(), 'parley-t7a-hold-')); holdRoots.push(workDir); return { workDir, sessionId: 's-1' }; };
afterAll(() => { for (const d of holdRoots) rmSync(d, { recursive: true, force: true }); });
const NO_REFUSALS = { operations: 0, argumentBytes: 0, responseBytes: 0, notSerializable: 0, notParsed: 0 };
const text = (r: { content: unknown }): string => (r.content as { text: string }[])[0]!.text;
const json = (r: { content: unknown }): Record<string, unknown> => JSON.parse(text(r)) as Record<string, unknown>;
/**
 * The agent view (contract v4) as the older assertions of this file read it: a field the view leaves out takes its empty value, so `runId: null`,
 * `error: null`, `operations: []` read as before. What the view drops on purpose (the contract number, the revision, the hashes, the sizes, the
 * rows of clean reads, the run id of a completed run) is therefore NOT visible through this helper: a test about those reads `agentView` itself.
 */
const fromView = (v: AgentView): ExecuteResult => ({ ...v, contract: CONTRACT_VERSION, runId: v.runId ?? null, error: v.error ?? null, value: v.value ?? null, diagnostics: v.diagnostics ?? [], diagnosticsTruncated: v.diagnosticsTruncated ?? false, operations: v.operations ?? [] }) as unknown as ExecuteResult;
const agentView = (r: { content: unknown }): AgentView => JSON.parse(text(r)) as AgentView;
const execResult = (r: { content: unknown }): ExecuteResult => fromView(agentView(r));
const NO_REVISION = computeApiRevision({ catalog, launch: LAUNCH, policySnapshot: 'unavailable' });
const POLICY = `np1.${'a'.repeat(64)}`;
const BROKER_REVISION = computeApiRevision({ catalog, launch: LAUNCH, policySnapshot: POLICY });
const VAL = compileCallValidators(catalog, BROKER_REVISION);

type Run = (code: string, apiRevision: string, signal?: AbortSignal) => Promise<BrokerRunResult>;
/** A broker that is only a spy: it has the shape of the real one and does what the test says. */
function stubBroker(run: Run, methods: readonly string[] = [...INITIAL_COHORT].sort()): Broker & { run: ReturnType<typeof vi.fn> } {
  return {
    launch: { launchId: LAUNCH, apiRevision: BROKER_REVISION, sourceId: 'fixture-policy', authority: 'fixture', policyRevision: 'p1', policySnapshot: POLICY, methods: Object.freeze([...methods]) },
    stashSize: () => 0,
    run: vi.fn(run),
  } as never;
}
const NEVER: Run = () => { throw new Error('the broker must not be asked'); };
const evidence = (ordinal: number, over: Record<string, unknown> = {}) => operationEvidence(VAL, { ordinal, method: 'get_map', args: {}, dispatched: true, outcome: 'succeeded', responseBytes: 10, incomplete: false, ...over } as never);
const ledgerOf = (entries: Record<string, unknown>[]) => ({ entries }) as never;
function helperResult(over: Partial<BrokerRunResult> = {}): BrokerRunResult {
  return {
    audit: [], incomplete: false, status: 'finished', cleanup: 'confirmed', runStatus: 'completed', runId: 'run-9-1', reason: null, spawned: true, hostCalls: 0,
    ledger: ledgerOf([]), evidence: [], drained: null, outcome: { ok: true, value: '{"n":1}', rpcs: 0, unsettled: [], activeMs: 1, disposed: true, refused: NO_REFUSALS },
    probes: null, listenerHits: null, launch: null, helperProfileSha256: null, timings: { preflightMs: 0, selfTestMs: 0, totalMs: 0 }, peakRssKb: 0,
    killedBy: null, maxPendingBytes: 0, preflight: null, ...over,
  } as BrokerRunResult;
}
const backendOf = (broker: Broker | null): CodeModeBackend => ({ catalog, launchId: LAUNCH, broker });
const surfaceOf = (broker: Broker | null) => createCodeModeSurface({ backend: () => backendOf(broker) });
const execute = (s: ReturnType<typeof surfaceOf>, code = 'return 1', apiRevision = BROKER_REVISION) => s.call('code_execute', { code, apiRevision });

describe('descriptors', () => {
  const s = surfaceOf(null);

  it('three tools, closed schemas taken from the contract, no generated types in the execute schema', () => {
    expect(s.tools.map((t) => t.name)).toEqual(['code_search', 'code_docs', 'code_execute']);
    expect([...s.names]).toEqual(['code_search', 'code_docs', 'code_execute']);
    expect(s.tools.map((t) => t.inputSchema)).toEqual([REQUEST_SCHEMAS.search, REQUEST_SCHEMAS.docs, REQUEST_SCHEMAS.execute]);
    for (const t of s.tools) expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(Object.keys((s.tools[2]!.inputSchema as { properties: object }).properties)).toEqual(['code', 'apiRevision']);
    expect(JSON.stringify(s.tools[2])).not.toContain('declare ');
    for (const t of s.tools) expect(t.description!.length).toBeGreaterThan(20);
  });

  it('annotations by value; they are not permissions', () => {
    const hints = Object.fromEntries(s.tools.map((t) => [t.name, t.annotations]));
    expect(hints['code_search']).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(hints['code_docs']).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(hints['code_execute']).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  });

  it('the descriptors are deeply frozen and are the same bytes before and after the surface is used', async () => {
    const own = surfaceOf(null);
    const before = JSON.stringify(own.tools);
    await own.call('code_search', { query: 'map' });
    await own.call('code_docs', { names: ['get_map'] });
    await own.call('code_execute', { code: 'return 1', apiRevision: NO_REVISION });
    expect(JSON.stringify(own.tools)).toBe(before);
    expect(before).toBe(JSON.stringify(s.tools));
    expect(Object.isFrozen(own.tools)).toBe(true);
    for (const t of own.tools) expect([Object.isFrozen(t), Object.isFrozen(t.inputSchema), Object.isFrozen(t.annotations)]).toEqual([true, true, true]);
    expect(() => { (own.tools[0]!.inputSchema as { type: string }).type = 'array'; }).toThrow(TypeError);
  });
});

describe('hints are tied to what the broker can run (T7a negative tests, lead m-5887)', () => {
  it('the hints follow the maximum effect of the allowlist (T11 B0): every allowlisted method is a registry read and a catalogue read', () => {
    const effect = new Map(MIGRATION_REGISTRY.entries.map((e) => [e.name, e.effect] as const));
    expect(catalog.allowlist).toEqual([...MIGRATABLE_READS].sort());
    for (const name of MIGRATABLE_READS) {
      expect(effect.get(name), name).toBe('read');
      expect(catalog.entries.find((e) => e.name === name)?.effect, name).toBe('read');
    }
    // The tripwire: a non-read on the allowlist must revisit destructiveHint and openWorldHint first.
    expect(surfaceOf(null).tools[2]!.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  });

  it('a broker whose launch methods reach outside this catalogue\'s allowlist is not used: unavailable, nothing run', async () => {
    const narrow = buildCatalog(TOOLS, { allowlist: ['get_map'] });
    const broker = stubBroker(async () => { throw new Error('must not run'); }, ['get_map', 'read_room']);
    const surface = createCodeModeSurface({ backend: () => ({ catalog: narrow, launchId: 'launch-1', broker }) });
    const r = await surface.call('code_execute', { code: 'return 1', apiRevision: broker.launch.apiRevision });
    expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toMatchObject({ runId: null, error: { kind: 'unavailable' } });
    expect(broker.run).not.toHaveBeenCalled();
  });

  it('every method of the initial cohort is a catalogue read, so read-only reach is what the hints describe', () => {
    for (const name of INITIAL_COHORT) expect(catalog.entries.find((e) => e.name === name)?.effect, name).toBe('read');
    // The tripwire: widening the cohort (or marking one of its methods as an effect) must revisit the hints first.
    expect([...INITIAL_COHORT].sort()).toEqual(['backlog_list', 'get_map', 'list_roles', 'read_guide', 'read_room']);
    expect(surfaceOf(null).tools[2]!.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  });

  it('a broker whose launch methods reach outside the read cohort is not used: unavailable, nothing run', async () => {
    for (const methods of [['get_map', 'send_message'], ['report'], ['browser_action', 'get_map'], ['close_session'], ['get_capacity'], ['fixture_read', 'get_map']]) {
      const broker = stubBroker(NEVER, methods);
      const r = await execute(surfaceOf(broker));
      expect(agentView(r), methods.join()).toEqual({ status: 'error', incomplete: true, error: { kind: 'unavailable', message: ERROR_MESSAGES.unavailable } });
      expect(broker.run).not.toHaveBeenCalled();
    }
  });

  it('a catalogue that offers a write or destructive method in the cohort gets no execution', async () => {
    const writeCatalog = { ...catalog, entries: catalog.entries.map((e) => (e.name === 'get_map' ? { ...e, effect: 'write' as const } : e)) } as Catalog;
    const broker = stubBroker(NEVER);
    const surface = createCodeModeSurface({ backend: () => ({ catalog: writeCatalog, launchId: LAUNCH, broker }) });
    expect(execResult(await surface.call('code_execute', { code: 'return 1', apiRevision: BROKER_REVISION }))).toMatchObject({ status: 'error', error: { kind: 'unavailable' } });
    expect(broker.run).not.toHaveBeenCalled();
    // and its docs still never offer a declaration for a method that is not a read
    const docs = json(await surface.call('code_docs', { names: ['get_map'] }));
    expect(docs['items']).toEqual([]);
    expect(docs['missing']).toEqual(['get_map']);
  });
});

describe('code_search', () => {
  const surface = surfaceOf(null);
  const search = (args: Record<string, unknown>, s = surface) => s.call('code_search', args);

  it('finds a method by name and by description, with host-chosen fields only', async () => {
    const page = json(await search({ query: 'get_map' }));
    expect(page).toMatchObject({ kind: 'search', apiRevision: NO_REVISION, complete: true, nextCursor: null });
    const items = page['items'] as { name: string; summary: string; effect: string; availability: string }[];
    expect(items[0]).toMatchObject({ name: 'get_map', effect: 'read', availability: 'documented' });
    expect(items[0]!.summary.length).toBeLessThanOrEqual(200);
    expect(Object.keys(items[0]!).sort()).toEqual(['availability', 'effect', 'name', 'summary']);
    const byDescription = (json(await search({ query: 'backlog' }))['items'] as { name: string }[]).map((i) => i.name);
    expect(byDescription).toContain('backlog_list');
  });

  it('puts the exact name first and the names that start with the first word next, sorted; the order is stable', async () => {
    const names = (json(await search({ query: 'read' }))['items'] as { name: string }[]).map((i) => i.name);
    // names that start with the word come first (sorted), then the other names that contain it, then description matches
    const prefix = names.filter((n) => n.startsWith('read'));
    expect(names.slice(0, prefix.length)).toEqual([...prefix].sort());
    expect(prefix).toContain('read_room');
    const exact = (json(await search({ query: 'read_room' }))['items'] as { name: string }[])[0]!.name;
    expect(exact).toBe('read_room');
    const again = (json(await search({ query: 'read' }))['items'] as { name: string }[]).map((i) => i.name);
    expect(again).toEqual(names);
  });

  it('lists methods that are not documented as unavailable, so the model learns to use the classic tool', async () => {
    const send = (json(await search({ query: 'send_message' }))['items'] as { name: string; availability: string; effect: string }[]).find((i) => i.name === 'send_message');
    expect(send).toMatchObject({ availability: 'unavailable' });
    expect(send!.effect).not.toBe('read');
  });

  it('availability is executable only for a method the broker can run', async () => {
    const broker = stubBroker(NEVER, ['get_map', 'read_guide']);
    const s = surfaceOf(broker);
    const items = json(await search({ query: 'get_map' }, s))['items'] as { name: string; availability: string }[];
    expect(items.find((i) => i.name === 'get_map')!.availability).toBe('executable');
    const room = json(await search({ query: 'read_room' }, s))['items'] as { name: string; availability: string }[];
    expect(room.find((i) => i.name === 'read_room')!.availability).toBe('documented');
    // with no broker nothing is executable
    const none = json(await search({ query: 'get_map' }))['items'] as { name: string; availability: string }[];
    expect(none.every((i) => i.availability !== 'executable')).toBe(true);
    expect(json(await search({ query: 'get_map' }, s))['apiRevision']).toBe(BROKER_REVISION);
  });

  it('pages: at most 8 KiB, an opaque cursor, complete only when nothing follows, the limit honoured', async () => {
    const first = await search({ query: ' ', limit: 3 });
    const p1 = json(first);
    expect((p1['items'] as unknown[]).length).toBe(3);
    expect(p1).toMatchObject({ complete: false });
    expect(Buffer.byteLength(text(first), 'utf8')).toBeLessThanOrEqual(CONTRACT_LIMITS.searchPageBytes);
    const seen = new Set((p1['items'] as { name: string }[]).map((i) => i.name));
    let cursor = p1['nextCursor'] as string;
    // opaque: URL-safe characters only, and nothing of the request or of the catalogue is readable in it
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain('get_map');
    for (let guard = 0; guard < 100 && cursor !== null; guard++) {
      const page = json(await search({ query: ' ', limit: 3, cursor }));
      for (const item of page['items'] as { name: string }[]) { expect(seen.has(item.name)).toBe(false); seen.add(item.name); }
      expect(page['complete']).toBe(page['nextCursor'] === null);
      cursor = page['nextCursor'] as string;
    }
    expect(seen.size).toBe(catalog.entries.length);
    expect(parsePage(text(first), 'search')).toMatchObject({ kind: 'search' });
  });

  it('refuses with a fixed text, never a caller value: bad request, foreign or stale cursor, unknown field', async () => {
    // a cursor made for a docs page (right revision, wrong kind) and one made for another search (right kind, other request)
    const docsCursor = encodeCursor(NO_REVISION, 'docs', requestKey('docs', { names: ['get_map'] }), 1);
    const otherSearch = encodeCursor(NO_REVISION, 'search', requestKey('search', { query: 'other' }), 1);
    const refused: Record<string, unknown>[] = [
      {}, { query: '' }, { query: 'x'.repeat(257) }, { query: SECRET, limit: 0 }, { query: 'a', limit: 21 }, { query: 'a', extra: SECRET },
      { query: 'a', cursor: SECRET }, { query: 'a', cursor: 'AAAA' }, { query: 'a', cursor: docsCursor }, { query: 'a', cursor: otherSearch },
    ];
    for (const args of refused) {
      const r = await search(args);
      expect(r.isError, JSON.stringify(args).slice(0, 40)).toBe(true);
      expect(text(r)).not.toContain(SECRET);
      expect(text(r).length).toBeLessThan(160);
    }
    const stale = json(await search({ query: ' ', limit: 1 }, surfaceOf(stubBroker(NEVER))))['nextCursor'] as string;
    const r = await search({ query: ' ', limit: 1, cursor: stale });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/stale|apiRevision|cursor/i);
  });
});

describe('code_docs', () => {
  const surface = surfaceOf(null);
  const docs = (args: Record<string, unknown>, s = surface) => s.call('code_docs', args);

  it('returns the declaration, effect, availability and schema hash of a documented method; the typed output is decoded', async () => {
    const page = json(await docs({ names: ['get_map'] }));
    const [item] = page['items'] as { name: string; declaration: string; effect: string; availability: string; inputSchemaSha256: string; output: string }[];
    expect(item).toMatchObject({ name: 'get_map', effect: 'read', availability: 'documented', output: 'decoded' });
    expect(item!.declaration).toBe(declarationsFor(catalog, ['get_map']));
    expect(item!.inputSchemaSha256).toBe(catalog.entries.find((e) => e.name === 'get_map')!.schemaSha256);
    expect(page).toMatchObject({ kind: 'docs', missing: [], complete: true, nextCursor: null, apiRevision: NO_REVISION });
  });

  it('names that have no documentation are listed as missing, never given a declaration', async () => {
    const page = json(await docs({ names: ['get_map', 'send_message', 'no_such_method', 'browser_action'] }));
    expect((page['items'] as { name: string }[]).map((i) => i.name)).toEqual(['get_map']);
    expect(page['missing']).toEqual(['send_message', 'no_such_method', 'browser_action']);
  });

  it('five names fit one page (16 KiB) or continue with a cursor, in the order asked, nothing dropped', async () => {
    const names = ['get_map', 'read_room', 'read_guide', 'list_roles', 'backlog_list'];
    const first = await docs({ names });
    expect(Buffer.byteLength(text(first), 'utf8')).toBeLessThanOrEqual(CONTRACT_LIMITS.docsPageBytes);
    const got: string[] = [];
    let page = json(first);
    for (let guard = 0; guard < 10; guard++) {
      got.push(...(page['items'] as { name: string }[]).map((i) => i.name));
      if (page['nextCursor'] === null) break;
      page = json(await docs({ names, cursor: page['nextCursor'] }));
    }
    expect(got).toEqual(names);
  });

  it('refuses six names, duplicates, bad names, a foreign cursor and extra fields with a fixed text', async () => {
    const searchCursor = json(await surface.call('code_search', { query: ' ', limit: 1 }))['nextCursor'];
    const refused: Record<string, unknown>[] = [
      {}, { names: [] }, { names: ['a', 'b', 'c', 'd', 'e', 'f'] }, { names: ['get_map', 'get_map'] }, { names: ['Get-Map'] }, { names: [SECRET] },
      { names: ['get_map'], extra: 1 }, { names: ['get_map'], cursor: String(searchCursor) },
    ];
    for (const args of refused) {
      const r = await docs(args);
      expect(r.isError, JSON.stringify(args).slice(0, 40)).toBe(true);
      expect(text(r)).not.toContain(SECRET);
    }
  });
});

describe('code_execute: refusals before any dispatch', () => {
  const REFUSED = (r: ExecuteResult, kind: string) => expect(r).toMatchObject({ contract: CONTRACT_VERSION, runId: null, status: 'error', error: { kind, message: ERROR_MESSAGES[kind as keyof typeof ERROR_MESSAGES] }, value: null, incomplete: true, operations: [] });

  it('no broker (the live resolver is unavailable): unavailable, the broker is never reached, nothing dispatched', async () => {
    expect(resolveLiveNativePolicy({ provider: 'claude', anything: true })).toBe(LIVE_POLICY_UNAVAILABLE);
    const live = await liveBackend(catalog, LAUNCH);
    expect(live.broker).toBeNull();
    const s = createCodeModeSurface({ backend: () => live });
    const r = await s.call('code_execute', { code: 'return 1', apiRevision: NO_REVISION });
    expect(r.isError).toBe(true);
    REFUSED(execResult(r), 'unavailable');
    expect(execResult(r).runId).toBeNull();
  });

  it('request refusals: missing, malformed, extra field, empty or oversized code -> invalid-request; another revision -> stale-revision', async () => {
    const broker = stubBroker(NEVER);
    const s = surfaceOf(broker);
    const cases: [Record<string, unknown>, string][] = [
      [{}, 'invalid-request'], [{ code: 'return 1' }, 'invalid-request'], [{ apiRevision: BROKER_REVISION }, 'invalid-request'],
      [{ code: '', apiRevision: BROKER_REVISION }, 'invalid-request'], [{ code: 'return 1', apiRevision: 'cm1.abc' }, 'invalid-request'],
      [{ code: 'return 1', apiRevision: BROKER_REVISION, timeoutMs: 1 }, 'invalid-request'], [{ code: 7, apiRevision: BROKER_REVISION }, 'invalid-request'],
      [{ code: 'x'.repeat(CONTRACT_LIMITS.codeBytes + 1), apiRevision: BROKER_REVISION }, 'invalid-request'],
      [{ code: 'return 1', apiRevision: NO_REVISION }, 'stale-revision'], [{ code: 'return 1', apiRevision: `cm1.${'1'.repeat(64)}` }, 'stale-revision'],
    ];
    for (const [args, kind] of cases) {
      const r = await s.call('code_execute', args);
      expect(r.isError, JSON.stringify(args).slice(0, 50)).toBe(true);
      REFUSED(execResult(r), kind);
      expect(text(r)).not.toContain('timeoutMs');
    }
    expect(broker.run).not.toHaveBeenCalled();
  });

  it('a pre-run result has no run id that could be taken for a real one, no operations and no diagnostic', async () => {
    const r = execResult(await surfaceOf(null).call('code_execute', { code: 'return 1', apiRevision: NO_REVISION }));
    expect(r.runId).toBeNull();
    expect(r.operations).toEqual([]);
    expect(r.diagnostics).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/run-\d+-\d+/);
  });
});

describe('code_execute: a run becomes an ExecuteResult (mapping, fixed texts, the incomplete claim)', () => {
  const run = async (result: BrokerRunResult) => {
    const broker = stubBroker(async () => result);
    const r = await execute(surfaceOf(broker));
    return { r, body: execResult(r), broker };
  };

  it('a completed run: value, real run id, the broker incomplete claim passed through; not an error', async () => {
    const { r, body, broker } = await run(helperResult({ evidence: [evidence(1)] }));
    expect(r.isError).toBeFalsy();
    // the agent view: a clean read has no row, a completed run has no run id, and the contract number and the revision are not in the text
    expect(agentView(r)).toEqual({ status: 'completed', incomplete: false, value: { n: 1 } });
    expect(body).toMatchObject({ status: 'completed', error: null, value: { n: 1 }, incomplete: false });
    expect(broker.run).toHaveBeenCalledTimes(1);
    expect(broker.run.mock.calls[0]![0]).toBe('return 1');
    expect(broker.run.mock.calls[0]![1]).toBe(BROKER_REVISION);
    expect(text(r)).not.toContain(BROKER_REVISION);
  });

  it('the broker claim raises incomplete although the evidence says complete (swallowed refusal), and nothing lowers it', async () => {
    const { body } = await run(helperResult({ incomplete: true, evidence: [evidence(1), evidence(2, { method: 'read_room', dispatched: false, outcome: 'refused', responseBytes: null })] }));
    expect(body).toMatchObject({ status: 'completed', incomplete: true });
    expect(body.operations.every((op) => !op.incomplete)).toBe(true);
    const clean = await run(helperResult({ incomplete: false, evidence: [evidence(1)] }));
    expect(clean.body.incomplete).toBe(false);
  });

  it('an unread run: completed with incomplete, or error with incomplete (both script forms)', async () => {
    const unread = evidence(1, { outcome: 'unread', responseBytes: 5, incomplete: true });
    const done = await run(helperResult({ incomplete: true, evidence: [unread] }));
    expect(done.body).toMatchObject({ status: 'completed', incomplete: true, operations: [{ outcome: 'unread', incomplete: true }] });
    const thrown = await run(helperResult({ incomplete: true, runStatus: 'error', evidence: [unread], outcome: { ok: false, error: { kind: 'runtime', message: SECRET }, rpcs: 1, unsettled: [], activeMs: 1, disposed: true, refused: NO_REFUSALS } }));
    expect(thrown.r.isError).toBe(true);
    expect(thrown.body).toMatchObject({ status: 'error', error: { kind: 'runtime' }, value: null, incomplete: true });
  });

  it.each([
    ['cancelled', { status: 'cancelled', runStatus: 'error' }, 'cancelled'],
    ['wall-time', { status: 'wall-time', runStatus: 'error', reason: 'run wall deadline' }, 'timeout'],
    ['quota', { status: 'quota', runStatus: 'error', reason: 'response budget exhausted' }, 'quota'],
    ['violation', { status: 'violation', runStatus: 'error', reason: SECRET }, 'helper-failure'],
    ['crashed', { status: 'crashed', runStatus: 'error', reason: SECRET }, 'helper-failure'],
    ['policy', { status: 'policy', runStatus: 'error', reason: 'native policy revoked' }, 'unavailable'],
    ['unavailable after the lease', { status: 'unavailable', runStatus: 'error', reason: SECRET }, 'unavailable'],
  ])('helper %s -> error kind %s with a fixed message and no helper text', async (_name, over, kind) => {
    const { r, body } = await run(helperResult({ outcome: null, ...(over as Partial<BrokerRunResult>) }));
    expect(r.isError).toBe(true);
    expect(body).toMatchObject({ status: 'error', error: { kind, message: ERROR_MESSAGES[kind as keyof typeof ERROR_MESSAGES] }, value: null, incomplete: true });
    expect(text(r)).not.toContain(SECRET);
    expect(text(r)).not.toContain('run wall deadline');
    expect(body.runId).toBe('run-9-1');
  });

  it.each([
    ['syntax', 'syntax'], ['runtime', 'runtime'], ['deadlock', 'runtime'], ['interrupted', 'timeout'], ['wall-time', 'timeout'],
    ['result', 'invalid-output'], ['result-size', 'invalid-output'], ['memory', 'quota'], ['protocol', 'helper-failure'],
  ])('a script that ended with a %s error -> %s, the guest message never crosses', async (guestKind, kind) => {
    const { r, body } = await run(helperResult({ runStatus: 'error', outcome: { ok: false, error: { kind: guestKind as never, message: `Error: ${SECRET}` }, rpcs: 0, unsettled: [], activeMs: 1, disposed: true, refused: NO_REFUSALS } }));
    expect(body).toMatchObject({ status: 'error', error: { kind, message: ERROR_MESSAGES[kind as keyof typeof ERROR_MESSAGES] }, value: null, incomplete: true });
    expect(text(r)).not.toContain(SECRET);
  });

  it('partial-or-unknown: calls still unsettled when the run ended keep their state and the status', async () => {
    const { r, body } = await run(helperResult({
      runStatus: 'partial-or-unknown', status: 'wall-time', reason: 'run wall deadline', outcome: null,
      evidence: [evidence(1), evidence(2, { method: 'read_room', outcome: 'unknown', responseBytes: null, incomplete: true })],
      ledger: ledgerOf([{ ordinal: 1, state: 'succeeded', method: 'get_map', refusal: null }, { ordinal: 2, state: 'unknown', method: 'read_room', refusal: null }]),
    }));
    expect(r.isError).toBe(true);
    expect(body).toMatchObject({ status: 'partial-or-unknown', error: { kind: 'timeout' }, value: null, incomplete: true });
    expect(body.diagnostics.map((d) => d.code)).toEqual(['call-unsettled', 'limit-reached']);
    expect(body.diagnostics[0]).toMatchObject({ params: { ordinal: 2, method: 'read_room' } });
  });

  it('the CPU limit (a guest interrupted by active time) is a timeout that names the limit, not a cancellation', async () => {
    const { body } = await run(helperResult({ runStatus: 'error', outcome: { ok: false, error: { kind: 'interrupted', message: 'x' }, rpcs: 0, unsettled: [], activeMs: 1200, disposed: true, refused: NO_REFUSALS } }));
    expect(body).toMatchObject({ status: 'error', error: { kind: 'timeout' }, incomplete: true });
    expect(body.diagnostics).toEqual([{ code: 'limit-reached', params: { limit: 'active-time' }, message: 'limit reached: active-time' }]);
  });

  it.each([
    ['unknown', { outcome: 'unknown', responseBytes: null, incomplete: true }, 'unknown'],
    ['draining', { outcome: 'draining', responseBytes: null, incomplete: true }, 'draining'],
  ])('a script that finished with a call whose outcome is %s: kind unsettled, never cancelled (nothing cancelled it)', async (_name, over, state) => {
    const { r, body } = await run(helperResult({ runStatus: 'partial-or-unknown', evidence: [evidence(1, over)], ledger: ledgerOf([{ ordinal: 1, state, method: 'get_map', refusal: null }]) }));
    expect(r.isError).toBe(true);
    expect(body).toMatchObject({ status: 'partial-or-unknown', error: { kind: 'unsettled', message: ERROR_MESSAGES.unsettled }, value: null, incomplete: true });
    expect(ERROR_MESSAGES.unsettled).toBe("A call's outcome is unknown.");
    expect(body.diagnostics.map((d) => d.code)).toEqual(['call-unsettled']);
  });

  it('a script that threw (or returned a bad value) with a call that has no outcome is unsettled, not the script error: that call may have run', async () => {
    const open = evidence(1, { outcome: 'unknown', responseBytes: null, incomplete: true });
    const ledger = ledgerOf([{ ordinal: 1, state: 'unknown', method: 'get_map', refusal: null }]);
    for (const guest of ['syntax', 'runtime', 'deadlock', 'interrupted', 'wall-time', 'result', 'memory', 'protocol']) {
      const { body } = await run(helperResult({ runStatus: 'partial-or-unknown', evidence: [open], ledger, outcome: { ok: false, error: { kind: guest as never, message: 'x' }, rpcs: 1, unsettled: [1], activeMs: 1, disposed: true, refused: NO_REFUSALS } }));
      expect(body, guest).toMatchObject({ status: 'partial-or-unknown', error: { kind: 'unsettled' }, incomplete: true });
    }
    const badValue = await run(helperResult({ runStatus: 'partial-or-unknown', evidence: [open], ledger, outcome: { ok: true, value: '1', rpcs: 1, unsettled: [1], activeMs: 1, disposed: true, refused: NO_REFUSALS } }));
    expect(badValue.body.error).toMatchObject({ kind: 'unsettled' });
    // the top-level reasons for stopping a run keep their own kinds even with such a call
    const walled = await run(helperResult({ status: 'wall-time', runStatus: 'partial-or-unknown', evidence: [open], ledger, outcome: null }));
    expect(walled.body.error).toMatchObject({ kind: 'timeout' });
    const aborted = await run(helperResult({ status: 'cancelled', runStatus: 'partial-or-unknown', evidence: [open], ledger, outcome: null }));
    expect(aborted.body.error).toMatchObject({ kind: 'cancelled' });
  });

  it('an unconfirmed cleanup, and any finished run no rule maps, fail to helper-failure; nothing falls through to cancelled', async () => {
    const pending = await run(helperResult({ runStatus: 'partial-or-unknown', cleanup: 'pending' }));
    expect(pending.body).toMatchObject({ status: 'partial-or-unknown', error: { kind: 'helper-failure' } });
    const unmapped = await run(helperResult({ runStatus: 'partial-or-unknown', cleanup: 'confirmed', outcome: null, evidence: [evidence(1)] }));
    expect(unmapped.body).toMatchObject({ status: 'partial-or-unknown', error: { kind: 'helper-failure' }, incomplete: true });
    const noOutcome = await run(helperResult({ runStatus: 'error', outcome: null, status: 'finished' }));
    expect(noOutcome.body).toMatchObject({ status: 'error', error: { kind: 'helper-failure' } });
  });

  it('diagnostics come only from typed evidence: failed, unsettled, and the limits named by typed refusals; none from free text', async () => {
    const { body } = await run(helperResult({
      incomplete: true, runStatus: 'completed',
      evidence: [
        evidence(1, { outcome: 'failed', responseBytes: 4 }),
        evidence(2, { dispatched: false, outcome: 'refused', responseBytes: null }),
        evidence(3, { dispatched: false, outcome: 'refused', responseBytes: null }),
        evidence(4, { dispatched: false, outcome: 'refused', responseBytes: null }),
      ],
      ledger: ledgerOf([
        { ordinal: 1, state: 'failed', method: 'get_map', refusal: null },
        { ordinal: 2, state: 'refused', method: 'get_map', refusal: 'response-budget-exhausted' },
        { ordinal: 3, state: 'refused', method: 'get_map', refusal: 'response-budget-exhausted' },
        { ordinal: 4, state: 'refused', method: 'get_map', refusal: 'invalid-arguments' },
        { ordinal: 5, state: 'refused', method: null, refusal: 'call-budget' },
      ]),
    }));
    expect(body.diagnostics.map((d) => [d.code, d.params])).toEqual([
      ['call-failed', { ordinal: 1, method: 'get_map' }],
      ['limit-reached', { limit: 'response-bytes' }],
      ['limit-reached', { limit: 'operations' }],
    ]);
    // the refused calls with no diagnostic code (invalid arguments here) are still operations, and the run is incomplete
    expect(body.operations.map((o) => o.outcome)).toEqual(['failed', 'refused', 'refused', 'refused']);
    expect(body.incomplete).toBe(true);
  });

  it('the three refusals the ledger cannot describe leave no diagnostic and still floor the run incomplete', async () => {
    const refused = (ordinal: number) => evidence(ordinal, { dispatched: false, outcome: 'refused', responseBytes: null });
    const { body } = await run(helperResult({
      incomplete: true, evidence: [refused(1), refused(2), refused(3)],
      ledger: ledgerOf([{ ordinal: 1, state: 'refused', method: 'get_map', refusal: 'invalid-arguments' }, { ordinal: 2, state: 'refused', method: 'get_map', refusal: 'not-json' }, { ordinal: 3, state: 'refused', method: null, refusal: 'policy' }]),
    }));
    expect(body.diagnostics).toEqual([]);
    expect(body).toMatchObject({ status: 'completed', incomplete: true });
  });

  it('a final value over the result budget is not returned: error invalid-output, value null, the evidence kept', async () => {
    const { body } = await run(helperResult({ evidence: [evidence(1)], outcome: { ok: true, value: JSON.stringify('x'.repeat(CONTRACT_LIMITS.resultBytes)), rpcs: 1, unsettled: [], activeMs: 1, disposed: true, refused: NO_REFUSALS } }));
    expect(body).toMatchObject({ status: 'error', error: { kind: 'invalid-output' }, value: null, incomplete: true, operations: [{ ordinal: 1 }] });
    expect(body.diagnostics).toEqual([{ code: 'limit-reached', params: { limit: 'result-bytes' }, message: 'limit reached: result-bytes' }]);
  });

  describe('response-bytes diagnostic for a read the run budget cut (unread): typed evidence only, never from unread alone', () => {
    const unread = (runBudgetCut: boolean, extra: Record<string, unknown> = {}) => helperResult({
      runStatus: 'partial-or-unknown',
      evidence: [evidence(1, { outcome: 'unread', incomplete: true }), ...(extra['more'] as never[] ?? [])],
      ledger: ledgerOf([{ ordinal: 1, state: 'unread', method: 'get_map', refusal: null, runBudgetCut }]),
    });
    const limits = (body: { diagnostics: { code: string; params: Record<string, unknown> }[] }) => body.diagnostics.filter((d) => d.code === 'limit-reached').map((d) => d.params['limit']);

    it('an unread whose cut was the run budget names response-bytes', async () => {
      const { body } = await run(unread(true));
      expect(limits(body as never)).toEqual(['response-bytes']);
    });

    it('an unread for another cause (the per-call ceiling, an unreadable body) names nothing', async () => {
      const { body } = await run(unread(false));
      expect(limits(body as never)).toEqual([]);
    });

    it('the flag on a call that is not unread names nothing', async () => {
      const { body } = await run(helperResult({ runStatus: 'partial-or-unknown', evidence: [evidence(1)], ledger: ledgerOf([{ ordinal: 1, state: 'succeeded', method: 'get_map', refusal: null, runBudgetCut: true }]) }));
      expect(limits(body as never)).toEqual([]);
    });

    it('once, however many calls were cut, and next to the guest-refusal source of the same limit', async () => {
      const { body } = await run(helperResult({
        runStatus: 'partial-or-unknown',
        evidence: [evidence(1, { outcome: 'unread', incomplete: true }), evidence(2, { outcome: 'unread', incomplete: true })],
        ledger: ledgerOf([{ ordinal: 1, state: 'unread', method: 'get_map', refusal: null, runBudgetCut: true }, { ordinal: 2, state: 'unread', method: 'get_map', refusal: null, runBudgetCut: true }]),
        outcome: { ok: true, value: '{"n":1}', rpcs: 2, unsettled: [], activeMs: 1, disposed: true, refused: { ...NO_REFUSALS, responseBytes: 1 } },
      }));
      expect(limits(body as never)).toEqual(['response-bytes']);
    });
  });

  describe('result-bytes diagnostic: a final value over the 16 KiB budget names the limit (T10 cost)', () => {
    const LIMIT = CONTRACT_LIMITS.resultBytes;
    const outcomeOf = (value: string) => ({ ok: true as const, value, rpcs: 0, unsettled: [], activeMs: 1, disposed: true, refused: NO_REFUSALS });
    // the JSON text of a string is the string plus its two quotes
    const jsonOf = (bytes: number): string => JSON.stringify('x'.repeat(bytes - 2));
    const RESULT_BYTES = [{ code: 'limit-reached', params: { limit: 'result-bytes' }, message: 'limit reached: result-bytes' }];

    it('the guest names a too-large value with its typed kind: invalid-output as before, plus the diagnostic, and no guest text crosses', async () => {
      const { r, body } = await run(helperResult({ runStatus: 'error', outcome: { ok: false, error: { kind: 'result-size' as never, message: `Error: ${SECRET}` }, rpcs: 0, unsettled: [], activeMs: 1, disposed: true, refused: NO_REFUSALS } }));
      expect(body).toMatchObject({ status: 'error', error: { kind: 'invalid-output', message: ERROR_MESSAGES['invalid-output'] }, value: null });
      expect(body.diagnostics).toEqual(RESULT_BYTES);
      expect(text(r)).not.toContain(SECRET);
    });

    it('a valid JSON value over the budget that reached the parent gives the diagnostic, run error or completed', async () => {
      for (const runStatus of ['error', 'completed'] as const) {
        const { body } = await run(helperResult({ runStatus, outcome: outcomeOf(jsonOf(LIMIT + 1)) }));
        expect(body, runStatus).toMatchObject({ status: 'error', error: { kind: 'invalid-output' }, value: null });
        expect(body.diagnostics, runStatus).toEqual(RESULT_BYTES);
      }
    });

    it('exactly the budget passes: completed, the value returned, no diagnostic', async () => {
      const { body } = await run(helperResult({ outcome: outcomeOf(jsonOf(LIMIT)) }));
      expect(Buffer.byteLength(JSON.stringify(body.value), 'utf8')).toBe(LIMIT);
      expect(body).toMatchObject({ status: 'completed', error: null });
      expect(body.diagnostics).toEqual([]);
    });

    it('a value that is not strict JSON gives no diagnostic, whatever its size: the old invalid-output path', async () => {
      for (const value of ['{"a":', `{"a":${'1,'.repeat(LIMIT)}`, '[1,]' + ' '.repeat(LIMIT), `${'['.repeat(40)}${']'.repeat(40)}${' '.repeat(LIMIT)}`]) {
        const { body } = await run(helperResult({ runStatus: 'error', outcome: outcomeOf(value) }));
        expect(body, value.slice(0, 12)).toMatchObject({ status: 'error', error: { kind: 'invalid-output' }, value: null });
        expect(body.diagnostics, value.slice(0, 12)).toEqual([]);
      }
    });

    it('no other error kind names it, and a small value never does', async () => {
      const { body } = await run(helperResult({ runStatus: 'error', outcome: { ok: false, error: { kind: 'result', message: 'non-string result' }, rpcs: 0, unsettled: [], activeMs: 1, disposed: true, refused: NO_REFUSALS } }));
      expect(body).toMatchObject({ error: { kind: 'invalid-output' } });
      expect(body.diagnostics).toEqual([]);
      expect((await run(helperResult({ runStatus: 'error', outcome: outcomeOf(jsonOf(LIMIT - 1)) }))).body.diagnostics).toEqual([]);
    });

    it('it is listed once beside the other limits a run reached', async () => {
      const { body } = await run(helperResult({ runStatus: 'error', status: 'wall-time', outcome: outcomeOf(jsonOf(LIMIT + 1)) }));
      expect(body.diagnostics.map((d) => d.params['limit'])).toEqual(['wall-time', 'result-bytes']);
    });
  });

  it.each([
    ['cancelled before the run started', { status: 'cancelled', reason: 'aborted before start' }],
    ['refused before the lease', { status: 'unavailable', reason: 'stale apiRevision' }],
    ['native policy gone before the run', { status: 'unavailable', reason: 'native policy revoked: use the Parley tools, listed or loadable on demand; a method no longer offered is unavailable until this session restarts' }],
  ])('a run that never got an id (%s) is the same refusal as any other before a run: unavailable, no run id, no operations', async (_name, over) => {
    const { r, body } = await run(helperResult({ runId: null, runStatus: null, spawned: false, cleanup: 'none', outcome: null, ledger: null, evidence: [], incomplete: true, ...(over as Partial<BrokerRunResult>) }));
    expect(r.isError).toBe(true);
    expect(body).toMatchObject({ runId: null, status: 'error', error: { kind: 'unavailable' }, operations: [], incomplete: true });
    expect(text(r)).not.toContain('revoked');
  });

  it('a run that throws is a fixed isError text, never an exception to the client and never the thrown text', async () => {
    const broker = stubBroker(async () => { throw new Error(SECRET); });
    const r = await execute(surfaceOf(broker));
    expect(r.isError).toBe(true);
    expect(text(r)).not.toContain(SECRET);
    expect(text(r).length).toBeLessThan(160);
  });

  it('the abort signal of the call reaches the broker', async () => {
    const broker = stubBroker(async () => helperResult());
    const controller = new AbortController();
    await surfaceOf(broker).call('code_execute', { code: 'return 1', apiRevision: BROKER_REVISION }, controller.signal);
    expect(broker.run.mock.calls[0]![2]).toBe(controller.signal);
  });
});

describe('code_execute: what the guest refused names its limit (T7a-guest-floor)', () => {
  const run = async (refused: Record<string, number>) => execResult(await execute(surfaceOf(stubBroker(async () => helperResult({ incomplete: true, outcome: { ok: true, value: '1', rpcs: 0, unsettled: [], activeMs: 1, disposed: true, refused: { ...NO_REFUSALS, ...refused } } })))));
  it.each([
    ['operations', 'operations'],
    ['argumentBytes', 'argument-bytes'],
    ['responseBytes', 'response-bytes'],
    ['notParsed', 'memory'],
  ])('%s gives limit-reached:%s, once however many', async (key, limit) => {
    const body = await run({ [key]: 3 });
    expect(body.diagnostics).toEqual([expect.objectContaining({ code: 'limit-reached', params: { limit } })]);
    expect(body.incomplete).toBe(true);
  });
  it('E-1b: a call the guest refused as an unknown method or arguments that are not JSON has no limit to name, but it is counted: calls-not-made', async () => {
    const body = await run({ notSerializable: 2 });
    expect(body.diagnostics).toEqual([expect.objectContaining({ code: 'calls-not-made', params: { cause: 'refused-in-script', count: 2 }, message: '2 call(s) refused inside the script: unknown method or arguments not JSON' })]);
    expect(body.incomplete).toBe(true);
  });
  it('E-1b: more refusals than the call ceiling cannot be counted in a closed number: the run is not shown as completed, it is an invalid-output error with its run id', async () => {
    const at = (n: number) => run({ notSerializable: n });
    expect(await at(32)).toMatchObject({ status: 'completed', diagnostics: [{ code: 'calls-not-made', params: { cause: 'refused-in-script', count: 32 } }] });
    expect(await at(33)).toMatchObject({ status: 'error', error: { kind: 'invalid-output' }, incomplete: true, runId: 'run-9-1' });
  });
  it('E-1b: a diagnostic the contract cannot hold takes no other diagnostic with it: the limit still reaches the agent, on a completed run and on one that ended', async () => {
    const done = await run({ notSerializable: 33, responseBytes: 1 });
    expect(done).toMatchObject({ status: 'error', error: { kind: 'invalid-output' }, runId: 'run-9-1' });
    expect(done.diagnostics).toEqual([expect.objectContaining({ code: 'limit-reached', params: { limit: 'response-bytes' } })]);
    expect(done.diagnosticsTruncated).toBe(true);
    const ended = execResult(await execute(surfaceOf(stubBroker(async () => helperResult({ status: 'wall-time', runStatus: 'error', incomplete: true, evidence: [evidence(1), evidence(2, { method: 'read_room', dispatched: false, outcome: 'refused', responseBytes: null })], outcome: { ok: true, value: '1', rpcs: 0, unsettled: [], activeMs: 1, disposed: true, refused: { ...NO_REFUSALS, notSerializable: 33 } } })))));
    expect(ended).toMatchObject({ status: 'error', error: { kind: 'timeout' }, runId: 'run-9-1', diagnosticsTruncated: true });
    expect(ended.operations.map((o) => o.ordinal)).toEqual([1, 2]);
    expect(ended.diagnostics).toEqual([expect.objectContaining({ code: 'limit-reached', params: { limit: 'wall-time' } })]);
  });
  it('nothing refused, nothing named', async () => {
    expect((await run({})).diagnostics).toEqual([]);
  });
});

describe('code_execute: a held session (busy)', () => {
  const busyWith = (reason: string) => helperResult({ status: 'busy', runStatus: null, runId: null, spawned: false, cleanup: 'none', outcome: null, reason, ledger: null, evidence: [], incomplete: true });

  it.each([
    ['busy: a run is active (run-123-4)', 'a-run-is-active'],
    ['busy: previous run cleanup unknown (run-123-4)', 'previous-run-cleanup-unknown'],
    ['busy: previous run has calls with unknown outcome (run-123-4)', 'previous-run-has-calls-with-unknown-outcome'],
    ['busy: previous run preflight pending (run-123-4)', 'previous-run-preflight-pending'],
    ['busy: previous run cleanup pending (run-123-4)', 'previous-run-cleanup-pending'],
    ['busy: previous run draining (run-123-4)', 'previous-run-draining'],
    ['busy: some reason this version does not know (run-5-6)', 'other'],
    [`busy: ${SECRET} (run-5-6)`, 'other'],
    ['not even a busy string', 'other'],
  ])('%s -> %s, with no run id, process id or holder text', async (reason, named) => {
    const broker = stubBroker(async () => busyWith(reason));
    const r = await execute(surfaceOf(broker));
    const body = execResult(r);
    expect(r.isError).toBe(true);
    expect(body).toMatchObject({ runId: null, status: 'error', error: { kind: 'busy', message: ERROR_MESSAGES.busy }, value: null, incomplete: true, operations: [] });
    expect(body.diagnostics).toEqual([{ code: 'busy', params: { reason: named }, message: expect.any(String) }]);
    expect(BUSY_REASONS).toContain(named);
    expect(text(r)).not.toMatch(/run-\d+-\d+|SYNTHETIC/);
  });

  it('every named reason has its own text', async () => {
    const texts = new Set<string>();
    for (const reason of ['a run is active', 'previous run cleanup unknown', 'previous run has calls with unknown outcome', 'previous run preflight pending', 'previous run cleanup pending', 'previous run draining']) {
      const r = await execute(surfaceOf(stubBroker(async () => busyWith(`busy: ${reason} (run-1-1)`))));
      texts.add(execResult(r).diagnostics[0]!.message);
    }
    expect(texts.size).toBe(6);
  });
});

describe('the backend is built lazily, once, and a failure is final', () => {
  it('not at construction and not at listing; once for any number of calls across the three tools', async () => {
    const backend = vi.fn(() => backendOf(stubBroker(async () => helperResult())));
    const s = createCodeModeSurface({ backend });
    void s.tools;
    expect(backend).not.toHaveBeenCalled();
    await s.call('code_search', { query: 'map' });
    await s.call('code_docs', { names: ['get_map'] });
    await s.call('code_execute', { code: 'return 1', apiRevision: BROKER_REVISION });
    await s.call('code_search', { query: 'room' });
    expect(backend).toHaveBeenCalledTimes(1);
  });

  it('a backend that throws makes all three tools unavailable with fixed texts, and is not retried', async () => {
    const backend = vi.fn((): CodeModeBackend => { throw new Error(SECRET); });
    const s = createCodeModeSurface({ backend });
    const search = await s.call('code_search', { query: 'map' });
    const docs = await s.call('code_docs', { names: ['get_map'] });
    const exec = await s.call('code_execute', { code: 'return 1', apiRevision: NO_REVISION });
    for (const r of [search, docs, exec]) { expect(r.isError).toBe(true); expect(text(r)).not.toContain(SECRET); }
    expect(agentView(exec)).toEqual({ status: 'error', incomplete: true, error: { kind: 'unavailable', message: ERROR_MESSAGES.unavailable } });
    await s.call('code_search', { query: 'map' });
    expect(backend).toHaveBeenCalledTimes(1);
  });

  it('a broker whose revision is not a well-formed apiRevision is not used', async () => {
    const odd = stubBroker(NEVER);
    (odd.launch as { apiRevision: string }).apiRevision = 'not-a-revision';
    const r = await execute(createCodeModeSurface({ backend: () => backendOf(odd) }), 'return 1', NO_REVISION);
    expect(execResult(r)).toMatchObject({ status: 'error', error: { kind: 'unavailable' } });
    expect(odd.run).not.toHaveBeenCalled();
  });

  it('an unknown tool name is refused, not passed on', async () => {
    const r = await surfaceOf(null).call('code_nothing', {});
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('This is not a Code Mode tool.');
  });
});

describe('registration in the parley server', () => {
  let root: string;
  let project: string;
  let workId: string;
  let previous: string | undefined;
  const clients: Client[] = [];
  const AGENT = { url: 'http://127.0.0.1:1/agent/browser', token: 'a'.repeat(64) };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'parley-code-mode-tools-'));
    project = path.join(root, 'project');
    await mkdir(project);
    previous = process.env.PARLEY_HOME;
    process.env.PARLEY_HOME = path.join(root, 'home');
    workId = (await createWork(project, { title: 'Code Mode tools' })).work.id;
    await updateMap(project, workId, (map) => {
      transitionSession(map, addSession(map, { provider: 'claude', label: 'lead', task: 'Check the surface' }).id, 'active');
    });
  });
  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close()));
    clients.length = 0;
    if (previous === undefined) delete process.env.PARLEY_HOME;
    else process.env.PARLEY_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });

  async function connect(extra: Partial<McpContext> = {}, surface?: ReturnType<typeof surfaceOf>): Promise<Client> {
    const server = createParleyServer({ projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false, ...extra }, undefined, surface);
    const client = new Client({ name: 'test', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    clients.push(client);
    return client;
  }
  const listed = async (extra: Partial<McpContext> = {}, surface?: ReturnType<typeof surfaceOf>) => (await (await connect(extra, surface)).listTools()).tools;

  it('without a surface the classic list is byte-identical: 49 tools / 43,063 B, short 46 / 41,497 B (agent channel)', async () => {
    const full = await listed({ agent: AGENT });
    const short = await listed({ agent: AGENT, toolProfile: 'short' });
    expect([full.length, Buffer.byteLength(JSON.stringify(full), 'utf8')]).toEqual([49, 43_063]);
    expect([short.length, Buffer.byteLength(JSON.stringify(short), 'utf8')]).toEqual([46, 41_497]);
    for (const tools of [full, short]) for (const name of ['code_search', 'code_docs', 'code_execute']) expect(tools.map((t) => t.name)).not.toContain(name);
  });

  it('with a surface exactly the three tools are added, in both profiles, and the classic tools are unchanged', async () => {
    const surface = surfaceOf(null);
    for (const extra of [{ agent: AGENT }, { agent: AGENT, toolProfile: 'short' as const }, {}]) {
      const off = await listed(extra);
      const on = await listed(extra, surface);
      expect(on.map((t) => t.name)).toEqual([...off.map((t) => t.name), 'code_search', 'code_docs', 'code_execute']);
      expect(JSON.stringify(on.slice(0, off.length))).toBe(JSON.stringify(off));
    }
  });

  it('a call without a surface is the classic unknown-tool answer; with one it reaches the wrapper', async () => {
    const off = await (await connect()).callTool({ name: 'code_search', arguments: { query: 'map' } });
    expect(off.isError).toBe(true);
    const on = await (await connect({}, surfaceOf(null))).callTool({ name: 'code_search', arguments: { query: 'get_map' } });
    expect(on.isError).toBeFalsy();
    expect(JSON.parse((on.content as { text: string }[])[0]!.text)).toMatchObject({ kind: 'search' });
  });

  it.each([
    ['a Claude session', {}],
    ['a Codex session with the short profile', { sessionId: 's-02', toolProfile: 'short' as const }],
    ['a session with no agent channel', { channel: false }],
    ['a session with an agent channel', { agent: AGENT }],
  ])('%s: through the server code_execute is unavailable: the live backend has no broker to ask (the zero requests are shown against a real host in the native block)', async (_label, extra) => {
    await updateMap(project, workId, (map) => { addSession(map, { provider: 'codex', label: 'codex', task: 'Check the surface' }); });
    const surface = createCodeModeSurface({ backend: () => liveBackend(catalog, LAUNCH) });
    const client = await connect(extra, surface);
    const r = await client.callTool({ name: 'code_execute', arguments: { code: 'return 1', apiRevision: NO_REVISION } });
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toEqual({ status: 'error', incomplete: true, error: { kind: 'unavailable', message: ERROR_MESSAGES.unavailable } });
  });

  it('a session that now belongs to another agent is fenced first: no tool of the surface reaches the backend', async () => {
    await updateMap(project, workId, (map) => { map.sessions[0]!.agentRevision = 'rev-new'; });
    const backend = vi.fn(() => backendOf(null));
    const surface = createCodeModeSurface({ backend });
    const client = await connect({ agentRevision: 'rev-old' }, surface);
    for (const [name, args] of [['code_search', { query: 'map' }], ['code_docs', { names: ['get_map'] }], ['code_execute', { code: 'return 1', apiRevision: NO_REVISION }]] as const) {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError, name).toBe(true);
      expect((r.content as { text: string }[])[0]!.text).toBe(STALE_AGENT);
    }
    expect(backend).not.toHaveBeenCalled();
  });

  it('declaration bytes of the three descriptors (report only)', () => {
    const bytes = Buffer.byteLength(JSON.stringify(surfaceOf(null).tools), 'utf8');
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(3_000);
  });
});


// ----- The real broker under the sandboxed helper (the native legs; s-296 replays them) -----

const coreDir = fileURLToPath(new URL('../../', import.meta.url));
const distUrl = (rel: string): string => pathToFileURL(path.join(coreDir, 'dist', rel)).href;
const supported = process.platform === 'darwin' && process.arch === 'arm64' && existsSync('/usr/bin/sandbox-exec') && existsSync(path.join(coreDir, 'native/darwin-arm64/manifest.json'));
if (!supported) console.warn('code-mode-tools.test: the native legs are NOT RUN: they need darwin/arm64 sandbox-exec and the built product probe');

describe.skipIf(!supported)('the wrappers over the real broker, helper and a synthetic agent host', () => {
  const hosts: AgentHost[] = [];
  const TT = 30_000;
  beforeAll(() => {
    execFileSync('pnpm', ['exec', 'tsc', '-p', path.join(coreDir, 'tsconfig.json')], { stdio: 'ignore', cwd: coreDir });
  }, 120_000);
  afterEach(async () => { await Promise.all(hosts.splice(0).map((h) => h.close())); });

  const startHost = async (script: Script): Promise<AgentHost> => { const h = await startAgentHost(script); hosts.push(h); return h; };
  /** Fresh dist module instances: a new process-wide lease and mint, so a held lease never leaks into the next test. */
  async function fresh() {
    vi.resetModules();
    const NP = (await import(distUrl('mcp/code-mode/native-policy.js'))) as Record<string, unknown>;
    vi.doMock('./code-mode/native-policy.js', () => NP);
    const B = (await import(distUrl('mcp/code-mode/broker.js'))) as typeof BrokerModule;
    const F = (await import('../../../../tests/fixtures/code-mode/native-policy.js')) as typeof FixtureModule;
    const C = (await import(distUrl('mcp/code-mode/catalog.js'))) as typeof CatalogModule;
    const W = (await import(distUrl('mcp/code-mode-tools.js'))) as typeof ToolsModule;
    const T = (await import(distUrl('mcp/tools.js'))) as { TOOLS: Parameters<typeof CatalogModule.buildCatalog>[0] };
    return { B, F, W, catalog: C.buildCatalog(T.TOOLS, { migrated: [...C.INITIAL_COHORT] }) };
  }
  const reply = (text: string) => ({ body: okEnvelope({ content: [{ type: 'text', text }] }) });
  const ROLES = JSON.stringify({ roles: [], partial: false, diagnostics: [] });
  const tools = (call: (n: number, body: Record<string, unknown>) => Awaited<ReturnType<Script>> | Promise<Awaited<ReturnType<Script>>>): Script => {
    let n = 0;
    return (r) => {
      const body = JSON.parse(r.raw) as Record<string, unknown>;
      if (body['op'] === 'list') return { body: okEnvelope({ tools: [] }) };
      return call(++n, body);
    };
  };
  const callsOf = (h: AgentHost) => h.log.map((x) => JSON.parse(x.raw) as Record<string, unknown>).filter((b) => b['op'] === 'call');

  async function setup(script: Script, rule: FixtureModule.FixtureRule = () => 'allow') {
    const { B, F, W, catalog: cat } = await fresh();
    const h = await startHost(script);
    const hold = HOLD();
    const broker = B.createBroker({ hold, source: F.createFixturePolicySource(F.FIXTURE_HOST, rule).source, catalog: cat, launchId: 'launch-1', agent: h.agent, launch: { toolProfile: 'short' } });
    const surface = W.createCodeModeSurface({ backend: () => ({ catalog: cat, launchId: 'launch-1', broker }) });
    const run = async (code: string) => {
      const r = await surface.call('code_execute', { code, apiRevision: broker.launch.apiRevision });
      return { r, body: fromView(JSON.parse((r.content as { text: string }[])[0]!.text) as AgentView) };
    };
    return { B, F, W, catalog: cat, h, broker, surface, run, hold };
  }

  it('a read that is complete: completed, the real run id, incomplete false, one succeeded operation', async () => {
    const { run, h } = await setup(tools(() => reply(ROLES)));
    const { r } = await run('const r = await parley.list_roles({}); return r.ok;');
    expect(r.isError).toBeFalsy();
    // a clean read is the status, the completeness and the value: no row, and no run id on a completed run
    expect(agentView(r)).toEqual({ status: 'completed', incomplete: false, value: true });
    expect(callsOf(h)).toHaveLength(1);
  }, TT);

  it('a swallowed refusal still ends incomplete:true through the real wrapper, although every operation says complete (T7a obligation)', async () => {
    const { run, h } = await setup(tools(() => reply(ROLES)), (q) => (q.method === 'read_room' ? 'deny' : 'allow'));
    const { body } = await run('await parley.list_roles({}); let seen = "none"; try { await parley.read_room({ room: "r-1" }); } catch (e) { seen = "swallowed"; } return seen;');
    expect(body).toMatchObject({ status: 'completed', value: 'swallowed', incomplete: true });
    expect(body.operations.map((o) => [o.method, o.outcome, o.dispatched, o.incomplete])).toEqual([['read_room', 'refused', false, false]]);
    expect(callsOf(h)).toHaveLength(1);
  }, TT);

  it.each([
    ['a refusal after a complete 200', '{"ok":false,"error":{"code":"internal","message":"x"}}'],
    ['a body that is not JSON', 'not json'],
  ])('an unread read (%s): caught gives completed + incomplete, uncaught gives error + incomplete', async (_name, body200) => {
    const caught = await setup(tools(() => ({ body: body200 })));
    const a = await caught.run('try { await parley.read_guide({}); return "read"; } catch (e) { return e.message; }');
    expect(a.body).toMatchObject({ status: 'completed', value: 'parley: call response not delivered', incomplete: true, operations: [{ method: 'read_guide', outcome: 'unread', incomplete: true }] });
    const uncaught = await setup(tools(() => ({ body: body200 })));
    const b = await uncaught.run('return (await parley.read_guide({})).ok;');
    expect(b.r.isError).toBe(true);
    expect(b.body).toMatchObject({ status: 'error', error: { kind: 'runtime' }, value: null, incomplete: true, operations: [{ outcome: 'unread' }] });
  }, 2 * TT);

  describe('a read dropped by the run response budget names response-bytes through the real broker (T9a D)', () => {
    // Each answer is a valid read_guide result of about a quarter of the 1 MiB run budget.
    const BIG = { body: okEnvelope({ content: [{ type: 'text', text: JSON.stringify({ text: 'g'.repeat(258_000), offset: 0, bytes: 258_000, totalBytes: 258_000, sha256: 'a'.repeat(64), complete: true, next: null }) }] }) };
    const CAUGHT5 = 'const out = []; for (let i = 0; i < 5; i++) { try { await parley.read_guide({}); out.push("read"); } catch (e) { out.push(e.message); } } return out;';

    it('four reads fit and the fifth is cut by what is left of the run budget: unread, and the limit is named once', async () => {
      const { run, h } = await setup(tools(() => BIG));
      const { body } = await run(CAUGHT5);
      expect(body.operations.map((o) => o.outcome)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded', 'unread']);
      expect(body.diagnostics.filter((d) => d.code === 'limit-reached').map((d) => d.params['limit'])).toEqual(['response-bytes']);
      expect(callsOf(h)).toHaveLength(5);
    }, TT);

    it('one answer over the per-call ceiling with the whole run budget left is unread but names no response-bytes limit', async () => {
      const { run } = await setup(tools(() => ({ body: okEnvelope({ content: [{ type: 'text', text: 'z'.repeat(1024 * 1024 + 1) }] }) })));
      const { body } = await run('try { await parley.read_guide({}); return "read"; } catch (e) { return e.message; }');
      expect(body.operations.map((o) => o.outcome)).toEqual(['unread']);
      expect(body.diagnostics.filter((d) => d.params['limit'] === 'response-bytes')).toEqual([]);
    }, TT);
  });

  it('no broker (the live backend): zero requests reach the host for execute, search and docs; execute is unavailable', async () => {
    const { W, catalog: cat } = await fresh();
    const h = await startHost(tools(() => reply(ROLES)));
    const surface = W.createCodeModeSurface({ backend: () => W.liveBackend(cat, 'launch-1') });
    const r = await surface.call('code_execute', { code: 'return await parley.list_roles({})', apiRevision: `cm1.${'0'.repeat(64)}` });
    expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toEqual({ status: 'error', incomplete: true, error: { kind: 'unavailable', message: ERROR_MESSAGES.unavailable } });
    await surface.call('code_search', { query: 'map' });
    await surface.call('code_docs', { names: ['get_map'] });
    expect(h.log).toHaveLength(0);
  }, TT);

  it('a write or external method cannot be called: it is not in the guest api, and nothing is dispatched', async () => {
    const { run, h } = await setup(tools(() => reply(ROLES)));
    for (const method of ['send_message', 'report', 'close_session', 'browser_action', 'create_session']) {
      const { body } = await run(`return await parley.${method}({});`);
      expect(body, method).toMatchObject({ status: 'error', error: { kind: 'runtime' }, value: null, incomplete: true, operations: [] });
    }
    expect(callsOf(h)).toHaveLength(0);
  }, 3 * TT);

  it('a catalogue that offers a write method in the cohort never gets a broker: the backend fails, everything is unavailable, zero requests', async () => {
    const { B, F, W, catalog: cat } = await fresh();
    const h = await startHost(tools(() => reply(ROLES)));
    const writeMap = { ...cat, entries: cat.entries.map((e) => (e.name === 'get_map' ? { ...e, effect: 'write' as const } : e)) };
    const surface = W.createCodeModeSurface({
      backend: () => ({ catalog: writeMap, launchId: 'launch-1', broker: B.createBroker({ hold: HOLD(), source: F.createFixturePolicySource(F.FIXTURE_HOST, () => 'allow').source, catalog: writeMap, launchId: 'launch-1', agent: h.agent, launch: {} }) }),
    });
    const r = await surface.call('code_execute', { code: 'return 1', apiRevision: `cm1.${'0'.repeat(64)}` });
    expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toEqual({ status: 'error', incomplete: true, error: { kind: 'unavailable', message: ERROR_MESSAGES.unavailable } });
    expect((await surface.call('code_search', { query: 'map' })).isError).toBe(true);
    expect(h.log).toHaveLength(0);
  }, TT);

  it('a held lease reaches the caller as a named busy reason, with no run id, while search and docs keep answering', async () => {
    const { run, surface, h } = await setup(tools(() => ({ status: 500 })));
    const first = await run('try { await parley.read_guide({}); } catch (e) { return e.message; }');
    expect(first.body).toMatchObject({ status: 'partial-or-unknown', incomplete: true, operations: [{ method: 'read_guide', outcome: 'unknown' }] });
    expect(first.body.diagnostics.map((d) => d.code)).toContain('call-unsettled');
    const second = await run('return 1');
    expect(second.r.isError).toBe(true);
    expect(second.body).toMatchObject({ runId: null, status: 'error', error: { kind: 'busy' }, operations: [], incomplete: true });
    expect(second.body.diagnostics).toEqual([{ code: 'busy', params: { reason: 'previous-run-has-calls-with-unknown-outcome' }, message: expect.stringContaining('unknown outcome') }]);
    expect(JSON.stringify(second.body)).not.toMatch(/run-\d+-\d+/);
    expect((await surface.call('code_search', { query: 'map' })).isError).toBeFalsy();
    expect((await surface.call('code_docs', { names: ['get_map'] })).isError).toBeFalsy();
    expect(callsOf(h)).toHaveLength(1);
  }, 2 * TT);

  it('a read the host answers late, awaited by the script: completed, nothing missing, and the next run is admitted at once', async () => {
    const { run, h } = await setup(tools(() => ({ ...reply(ROLES), delayMs: 1500 })));
    const t0 = Date.now();
    const first = await run('const r = await parley.list_roles({}); return r.ok;');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);
    expect(first.r.isError).toBeFalsy();
    expect(first.body).toMatchObject({ status: 'completed', value: true, incomplete: false, operations: [] });
    const second = await run('return 2');
    expect(second.body).toMatchObject({ status: 'completed', value: 2, error: null });
    expect(callsOf(h)).toHaveLength(1);
  }, 2 * TT);

  describe('a held record through the real wrapper (T7a-sleep)', () => {
    const plant = (workDir: string, sessionId: string, lines: string[]): void => {
      mkdirSync(path.join(workDir, 'code-mode'), { recursive: true, mode: 0o700 });
      writeFileSync(path.join(workDir, 'code-mode', `${sessionId}.run`), lines.map((l) => `${l}\n`).join(''));
    };
    const header = (over: Record<string, unknown> = {}): string => JSON.stringify({ v: 1, runId: 'run-1-1', launchId: 'other', pid: 999_999, startedAt: null, nonce: 'a'.repeat(32), at: 't', ...over });
    const INTENT = JSON.stringify({ o: 1, m: 'get_map', a: 'b'.repeat(64) });

    async function heldSetup(workDir: string, sessionId: string) {
      const { B, F, W, catalog: cat } = await fresh();
      const h = await startHost(tools(() => reply(ROLES)));
      const broker = B.createBroker({ hold: { workDir, sessionId }, source: F.createFixturePolicySource(F.FIXTURE_HOST, () => 'allow').source, catalog: cat, launchId: 'launch-1', agent: h.agent, launch: { toolProfile: 'short' } });
      const surface = W.createCodeModeSurface({ backend: () => ({ catalog: cat, launchId: 'launch-1', broker }) });
      return { h, broker, surface };
    }

    it.each([
      ['previous-process-unaccounted', () => [header(), INTENT]],
      ['held-by-other-process', () => [header({ pid: process.pid })]],
      ['run-record-unavailable', () => ['torn']],
    ])('%s: a typed busy reason, zero calls, no run id or pid, and it points to the Parley tools, listed or loadable on demand', async (reason, lines) => {
      const { workDir, sessionId } = HOLD();
      plant(workDir, sessionId, lines());
      const { surface, broker, h } = await heldSetup(workDir, sessionId);
      const r = await surface.call('code_execute', { code: 'return 1', apiRevision: broker.launch.apiRevision });
      const body = JSON.parse((r.content as { text: string }[])[0]!.text) as ExecuteResult;
      expect(body).toMatchObject({ status: 'error', error: { kind: 'busy' }, incomplete: true });
      expect(Object.keys(body)).toEqual(['status', 'incomplete', 'error', 'diagnostics']);
      expect(body.diagnostics).toEqual([expect.objectContaining({ code: 'busy', params: { reason } })]);
      expect(body.diagnostics[0]!.message).toContain('Use the Parley tools, listed or loadable on demand; a method no longer offered is unavailable until this session restarts.');
      if (reason === 'held-by-other-process') expect(body.diagnostics[0]!.message).toContain('may still be finishing');
      expect(body.diagnostics[0]!.message).not.toMatch(/classic/i);
      expect(JSON.stringify(body)).not.toContain(String(process.pid));
      expect(callsOf(h)).toHaveLength(0);
    }, TT);

    /** A real work and session, for tools that answer through the real server. */
    async function withWork<R>(body: (w: { project: string; id: string; workDir: string; sessionId: string }) => Promise<R>): Promise<R> {
      const root = await mkdtemp(path.join(tmpdir(), 'parley-t8h-work-'));
      const was = process.env.PARLEY_HOME;
      process.env.PARLEY_HOME = path.join(root, 'home');
      const project = path.join(root, 'project');
      await mkdir(project, { recursive: true });
      try {
        const id = (await createWork(project, { title: 'T8h' })).work.id;
        let sessionId = '';
        await updateMap(project, id, (map) => { const added = addSession(map, { provider: 'claude', label: 'lead', task: 'Hold' }); transitionSession(map, added.id, 'active'); sessionId = added.id; });
        return await body({ project, id, workDir: workPaths(project, id).dir, sessionId });
      } finally {
        if (was === undefined) delete process.env.PARLEY_HOME; else process.env.PARLEY_HOME = was;
        await rm(root, { recursive: true, force: true });
      }
    }
    const connected = async (server: ReturnType<typeof createParleyServer>): Promise<Client> => {
      const client = new Client({ name: 'test', version: '0' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(a), server.connect(b)]);
      return client;
    };
    const textOf = (r: unknown): string => ((r as { content: { text: string }[] }).content)[0]!.text;

    it('§6: the busy text is true with five methods migrated: they are not listed, not callable, and a classic relaunch has them back', async () => {
      await withWork(async ({ project, id, workDir, sessionId }) => {
        const five = ['get_map', 'read_room', 'read_guide', 'list_roles', 'backlog_list'];
        plant(workDir, sessionId, [header(), INTENT]);
        const { surface, broker } = await heldSetup(workDir, sessionId);
        const busy = JSON.parse(textOf(await surface.call('code_execute', { code: 'return 1', apiRevision: broker.launch.apiRevision }))) as ExecuteResult;
        expect(busy.diagnostics[0]!.message).toContain('a method no longer offered is unavailable until this session restarts');
        const context: McpContext = { projectPath: project, workId: id, workDir, sessionId, channel: false };
        const { replacementSurfaceFactory } = await import('./code-mode-tools.js');
        const { MIGRATION_REGISTRY } = await import('./code-mode/migration-registry.js');
        const replacement = await connected(createParleyServer(context, undefined, replacementSurfaceFactory(context, { ...MIGRATION_REGISTRY, proven: five })));
        const classic = await connected(createParleyServer(context));
        try {
          const listed = (await replacement.listTools()).tools.map((t) => t.name);
          for (const name of five) {
            expect(listed, name).not.toContain(name);
            expect(textOf(await replacement.callTool({ name, arguments: {} })), name).toBe(`unknown tool ${name}`);
          }
          expect(listed).toContain('report');
          expect((await replacement.callTool({ name: 'report', arguments: { status: 'progress', summary: 'x' } })).isError).toBeFalsy();
          // "Use the Parley tools, listed or loadable on demand" holds, and "until this session restarts" too: a held session's next launch is classic.
          const relaunched = (await classic.listTools()).tools.map((t) => t.name);
          for (const name of five) expect(relaunched, name).toContain(name);
        } finally { await replacement.close(); await classic.close(); }
      });
    }, 2 * TT);

    it('§9.2, the detector mid-script: admission stops, the started read drains, direct tools answer, a pending direct wait_for gets its mail, report is delivered, nothing is called again', async () => {
      await withWork(async ({ project, id, workDir, sessionId }) => {
        const { B, F, W, catalog: cat } = await fresh();
        const fake = F.createFixturePolicySource(F.FIXTURE_HOST, () => 'allow');
        let release!: () => void;
        const slow = new Promise<void>((r) => { release = r; });
        const h = await startHost(tools(async (n) => {
          if (n === 1) { await slow; return reply(ROLES); }
          // The rule changes while the second read answers, so the script's third read meets the edge with the policy gone.
          fake.bump();
          return reply('{}');
        }));
        const broker = B.createBroker({ hold: { workDir, sessionId }, source: fake.source, catalog: cat, launchId: 'launch-1', agent: h.agent, launch: { toolProfile: 'short' } });
        const surface = W.createCodeModeSurface({ backend: () => ({ catalog: cat, launchId: 'launch-1', broker }) });
        const server = createParleyServer({ projectPath: project, workId: id, workDir, sessionId, channel: false, pollMs: 20, settleMs: 0, settleMaxMs: 0 }, undefined, surface as never);
        const client = await connected(server);
        try {
          const running = client.callTool({ name: 'code_execute', arguments: { apiRevision: broker.launch.apiRevision, code: 'const first = parley.list_roles({}); try { await parley.get_map({}); } catch {} try { await parley.read_guide({}); } catch {} await first; return 1;' } }, undefined, { timeout: TT });
          await vi.waitFor(() => { expect(callsOf(h)).toHaveLength(2); }, { timeout: TT });
          await vi.waitFor(() => { expect(fake.queries.length).toBeGreaterThan(0); }, { timeout: TT });

          // While the first read still drains, every direct tool works: a read, a pending wait that gets its mail, and the report.
          const map = await client.callTool({ name: 'get_map', arguments: {} });
          expect(map.isError).toBeFalsy();
          const waiting = client.callTool({ name: 'wait_for', arguments: { target: 'inbox', timeoutSec: 20 } }, undefined, { timeout: TT });
          await new Promise((r) => setTimeout(r, 100));
          await updateMap(project, id, (m, letters) => { letters.add({ roomId: null, from: PARLEY, to: [sessionId], text: 'the mail arrives', kind: 'note', at: new Date().toISOString() }); });
          expect(textOf(await waiting)).toContain('the mail arrives');
          expect((await client.callTool({ name: 'report', arguments: { status: 'progress', summary: 'still here' } })).isError).toBeFalsy();
          expect((await readStoredMap(project, id)).sessions.find((s) => s.id === sessionId)?.summary).toContain('still here');

          release();
          const answer = JSON.parse(textOf(await running)) as ExecuteResult;
          expect(answer.operations.find((o) => o.method === 'list_roles')).toMatchObject({ dispatched: true, outcome: 'succeeded' });
          expect(answer.operations.find((o) => o.method === 'read_guide')).toMatchObject({ dispatched: false, outcome: 'refused' });
          expect(answer.incomplete).toBe(true);
          // Nothing was replayed, and the next run refuses at once with no call.
          expect(callsOf(h)).toHaveLength(2);
          const next = JSON.parse(textOf(await client.callTool({ name: 'code_execute', arguments: { apiRevision: broker.launch.apiRevision, code: 'return 2' } }))) as ExecuteResult;
          expect(next).toMatchObject({ status: 'error', error: { kind: 'unavailable' } });
          expect(next).not.toHaveProperty('runId');
          expect(next).not.toHaveProperty('operations');
          expect(callsOf(h)).toHaveLength(2);
        } finally { await client.close(); }
      });
    }, 2 * TT);

    it('a held record leaves classic reads, code_search and code_docs working, through the real server', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'parley-t7a-classic-'));
      const was = process.env.PARLEY_HOME;
      process.env.PARLEY_HOME = path.join(root, 'home');
      const project = path.join(root, 'project');
      await mkdir(project, { recursive: true });
      try {
        const id = (await createWork(project, { title: 'Held' })).work.id;
        let sessionId = '';
        await updateMap(project, id, (map) => { const added = addSession(map, { provider: 'claude', label: 'lead', task: 'Hold' }); transitionSession(map, added.id, 'active'); sessionId = added.id; });
        const workDir = workPaths(project, id).dir;
        plant(workDir, sessionId, [header(), INTENT]);
        const { surface, broker } = await heldSetup(workDir, sessionId);
        const server = createParleyServer({ projectPath: project, workId: id, workDir, sessionId, channel: false }, undefined, surface as never);
        const client = new Client({ name: 'test', version: '0' });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(a), server.connect(b)]);
        try {
          const textOf = (r: unknown): string => ((r as { content: { text: string }[] }).content)[0]!.text;
          const exec = await client.callTool({ name: 'code_execute', arguments: { code: 'return 1', apiRevision: broker.launch.apiRevision } });
          expect(exec.isError).toBe(true);
          expect(JSON.parse(textOf(exec))).toMatchObject({ error: { kind: 'busy' } });
          const search = await client.callTool({ name: 'code_search', arguments: { query: 'get_map' } });
          expect(search.isError).toBeFalsy();
          expect(JSON.parse(textOf(search))).toMatchObject({ kind: 'search' });
          const docs = await client.callTool({ name: 'code_docs', arguments: { names: ['get_map'] } });
          expect(docs.isError).toBeFalsy();
          expect(JSON.parse(textOf(docs))).toMatchObject({ kind: 'docs' });
          const classic = await client.callTool({ name: 'get_map', arguments: {} });
          expect(classic.isError).toBeFalsy();
          expect(textOf(classic)).toContain('"sessionId"');
          const roles = await client.callTool({ name: 'list_roles', arguments: {} });
          expect(roles.isError).toBeFalsy();
        } finally { await client.close(); }
      } finally {
        if (was === undefined) delete process.env.PARLEY_HOME; else process.env.PARLEY_HOME = was;
        await rm(root, { recursive: true, force: true });
      }
    }, 2 * TT);
  });

  it('a read the script did NOT await: the parent waits for the call to settle, the script read nothing, and the run says incomplete (T7a-guest-floor)', async () => {
    const { run, h } = await setup(tools(() => ({ ...reply(ROLES), delayMs: 1500 })));
    const t0 = Date.now();
    const first = await run('parley.list_roles({}); return "returned";');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);
    expect(first.body).toMatchObject({ status: 'completed', value: 'returned', incomplete: true, operations: [{ method: 'list_roles', outcome: 'succeeded', incomplete: false }] });
    expect(callsOf(h)).toHaveLength(1);
  }, 2 * TT);

  describe('a refusal the guest answered itself, swallowed by the script (T7a-guest-floor)', () => {
    const CAUGHT = (expr: string): string => `try { await ${expr}; return "read"; } catch (e) { return e.message; }`;

    it('33 reads, each caught: completed, incomplete, and it names the operations limit', async () => {
      const { run, h } = await setup(tools(() => reply(ROLES)));
      const { body } = await run('let n = 0; for (let i = 0; i < 33; i++) { try { await parley.list_roles({}); } catch { n++; } } return n;');
      expect(body).toMatchObject({ status: 'completed', value: 1, incomplete: true });
      expect(body.diagnostics).toEqual([expect.objectContaining({ code: 'limit-reached', params: { limit: 'operations' } })]);
      expect(callsOf(h)).toHaveLength(32);
    }, TT);

    it('70 KB of arguments, caught: zero calls, incomplete, and it names the argument-bytes limit', async () => {
      const { run, h } = await setup(tools(() => reply(ROLES)));
      const { body } = await run(CAUGHT('parley.list_roles({ a: "y".repeat(70000) })'));
      expect(body).toMatchObject({ status: 'completed', value: 'parley: arguments too large', incomplete: true, operations: [] });
      expect(body.diagnostics).toEqual([expect.objectContaining({ code: 'limit-reached', params: { limit: 'argument-bytes' } })]);
      expect(callsOf(h)).toHaveLength(0);
    }, TT);

    it.each([
      ['a function', 'parley.list_roles(() => 1)'],
      ['a symbol', 'parley.list_roles(Symbol("s"))'],
      ['toJSON returning undefined', 'parley.list_roles({ toJSON() { return undefined; } })'],
    ])('arguments that stringify to nothing (%s), caught: zero calls, incomplete, no limit to name', async (_name, expr) => {
      const { run, h } = await setup(tools(() => reply(ROLES)));
      const { body } = await run(CAUGHT(expr));
      // E-1b: no operation and no limit, but the refused call is counted, so the incomplete says why
      expect(body).toMatchObject({ status: 'completed', value: 'parley: unknown method', incomplete: true, operations: [], diagnostics: [{ code: 'calls-not-made', params: { cause: 'refused-in-script', count: 1 } }] });
      expect(callsOf(h)).toHaveLength(0);
    }, TT);

    it('E-1b: ceiling+1 refused calls in a loop that catches each one: error, never completed; at the ceiling it is completed with the count', async () => {
      const loop = (n: number): string => `let k = 0; for (let i = 0; i < ${n}; i++) { try { await parley.list_roles(() => 1); } catch { k++; } } return k;`;
      const ok = await setup(tools(() => reply(ROLES)));
      expect((await ok.run(loop(32))).body).toMatchObject({ status: 'completed', value: 32, incomplete: true, diagnostics: [{ code: 'calls-not-made', params: { cause: 'refused-in-script', count: 32 } }] });
      const over = await setup(tools(() => reply(ROLES)));
      const { r, body } = await over.run(loop(33));
      expect(r.isError).toBe(true);
      expect(body).toMatchObject({ status: 'error', error: { kind: 'invalid-output' }, incomplete: true });
      expect(body.runId).toMatch(/^run-\d+-\d+$/);
      expect(callsOf(over.h)).toHaveLength(0);
      // the same loop and 70 KB of arguments, caught: the argument-bytes limit still arrives beside the error
      const both = await setup(tools(() => reply(ROLES)));
      const mixed = await both.run(`${loop(33).replace('return k;', '')} try { await parley.list_roles({ a: "y".repeat(70000) }); } catch {} return 1;`);
      expect(mixed.body).toMatchObject({ status: 'error', error: { kind: 'invalid-output' }, diagnosticsTruncated: true });
      expect(mixed.body.diagnostics).toEqual([expect.objectContaining({ code: 'limit-reached', params: { limit: 'argument-bytes' } })]);
    }, 3 * TT);

    it('T19: three reads not awaited: the third never left the guest, so it is named as not-started; the host saw two calls and the run record holds two', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const { run, h, hold } = await setup(tools(async () => { await gate; return reply(ROLES); }));
      const running = run('parley.list_roles({}); parley.list_roles({}); parley.list_roles({}); return 1;');
      await vi.waitFor(() => { expect(callsOf(h)).toHaveLength(2); }, { timeout: TT });
      // while the two admitted calls are held, the third is only in the guest's queue: the record has intents for two
      const intents = readFileSync(runRecordPath(hold.workDir, hold.sessionId), 'utf8').split('\n').filter((l) => l.includes('"m":"list_roles"'));
      expect(intents).toHaveLength(2);
      release();
      const { body } = await running;
      expect(body).toMatchObject({ status: 'completed', value: 1, incomplete: true });
      // the third call has no operation and a count of one: the two admitted calls are operations, not "not started"
      expect(body.diagnostics.filter((d) => d.code === 'calls-not-made')).toEqual([expect.objectContaining({ params: { cause: 'not-started', count: 1 } })]);
      expect(callsOf(h)).toHaveLength(2);
    }, 2 * TT);

    it('Promise.race of three: the losers\' data was not seen, and the run says incomplete', async () => {
      const { run } = await setup(tools(() => reply(ROLES)));
      const { body } = await run('await Promise.race([parley.list_roles({}), parley.list_roles({}), parley.list_roles({})]); return 1;');
      expect(body).toMatchObject({ status: 'completed', value: 1, incomplete: true });
    }, TT);

    // A read the decoder calls complete, delivered, whose parse in the guest fails for lack of memory, and the script swallows that.
    const ROLES_BIG = JSON.stringify({ roles: Array.from({ length: 6000 }, (_, i) => ({ id: `r-${i}`, name: 'n', description: 'd', source: 'user', provider: 'p', model: null, effort: null, readOnly: false })), partial: false, diagnostics: [] });
    const HOG = (free: number): string => `const hog = []; try { for (;;) hog.push("x".repeat(1 << 16)); } catch {} hog.length = Math.max(0, hog.length - ${free}); let m = "none"; try { const r = await parley.list_roles({}); m = "read " + r.ok; } catch { m = "caught"; } hog.length = 0; return m;`;
    it('a parse that runs out of memory and is swallowed, across 12 to 48 of 64 KiB blocks freed: never complete, and it names memory', async () => {
      // Which block count fails where depends on the body and the engine, so the rule is asserted for each outcome, not a table of counts.
      const seen: Record<string, number> = {};
      for (const free of [12, 16, 20, 24, 32, 48]) {
        const { run } = await setup(tools(() => reply(ROLES_BIG)));
        const { body } = await run(HOG(free));
        const what = body.status !== 'completed' ? 'ended' : (body.value as string);
        seen[what] = (seen[what] ?? 0) + 1;
        if (what === 'ended') expect(body.incomplete, `${free}`).toBe(true);
        else if (what === 'caught') {
          expect(body, `${free}`).toMatchObject({ incomplete: true, operations: [] });
          expect(body.diagnostics, `${free}`).toEqual([expect.objectContaining({ code: 'limit-reached', params: { limit: 'memory' } })]);
        } else expect(body, `${free}`).toMatchObject({ value: 'read true', incomplete: false, diagnostics: [] });
      }
      expect(seen['caught']).toBeGreaterThan(0);
    }, 3 * TT);

    it('the floor does not over-reach: 32 awaited complete reads, nothing swallowed, stay complete', async () => {
      const { run, h } = await setup(tools(() => reply(ROLES)));
      const { body } = await run('for (let i = 0; i < 32; i++) await parley.list_roles({}); return 1;');
      expect(body).toMatchObject({ status: 'completed', value: 1, incomplete: false, diagnostics: [] });
      expect(callsOf(h)).toHaveLength(32);
    }, TT);

    it.each([
      ['a cycle', 'const a = {}; a.a = a; ', 'parley.list_roles(a)'],
      ['a BigInt', '', 'parley.list_roles({ n: 1n })'],
      ['deep arguments, caught as a stack overflow on the real helper', 'let d = {}; for (let i = 0; i < 20000; i++) d = { d }; ', 'parley.list_roles(d)'],
      ['a throwing getter', '', 'parley.list_roles({ get a() { throw new Error("g"); } })'],
      ['a method that does not exist', '', 'parley.write_x({})'],
    ])('NAMED RESIDUAL, the script\'s own error with no call formed (%s): completed, incomplete:false, zero calls', async (_name, pre, expr) => {
      const { run, h } = await setup(tools(() => reply(ROLES)));
      const { body } = await run(`${pre}${CAUGHT(expr)}`);
      expect(body).toMatchObject({ status: 'completed', incomplete: false, operations: [] });
      expect(callsOf(h)).toHaveLength(0);
    }, TT);
  });

  it.each([
    ['a script still waiting for the read is cancelled', 'await parley.read_guide({}); return "returned";', 'cancelled'],
    ['a script that had already returned leaves a call with no outcome, which nothing cancelled', 'parley.read_guide({}); return "returned";', 'unsettled'],
  ])('a caller abort while a read is in flight (%s): partial-or-unknown and incomplete; the next runs are busy and time alone does not free the session', async (_name, code, kind) => {
    // The abort follows the host's receipt of the call, not a timer: on a loaded machine a slow helper start let a fixed 500 ms beat the call (s-296 m-6793).
    const ctl = new AbortController();
    const { surface, broker, h } = await setup(tools(() => { setTimeout(() => ctl.abort(), 100); return { hang: true }; }));
    const aborted = await surface.call('code_execute', { code, apiRevision: broker.launch.apiRevision }, ctl.signal);
    const first = JSON.parse((aborted.content as { text: string }[])[0]!.text) as ExecuteResult;
    expect(aborted.isError).toBe(true);
    expect(first).toMatchObject({ status: 'partial-or-unknown', error: { kind }, incomplete: true, operations: [{ ordinal: 1, method: 'read_guide', dispatched: true, outcome: expect.stringMatching(/^(draining|unknown)$/), incomplete: true }] });
    expect(first.runId).toMatch(/^run-\d+-\d+$/);
    expect(first.diagnostics.map((d) => d.code)).toEqual(['call-unsettled']);
    const named = ['previous-run-draining', 'previous-run-has-calls-with-unknown-outcome'];
    const next = async () => JSON.parse(((await surface.call('code_execute', { code: 'return 1', apiRevision: broker.launch.apiRevision })).content as { text: string }[])[0]!.text) as ExecuteResult;
    const immediately = await next();
    expect(immediately).toMatchObject({ status: 'error', error: { kind: 'busy' }, incomplete: true });
    expect(immediately).not.toHaveProperty('runId');
    expect(named).toContain((immediately.diagnostics[0]!.params as { reason: string }).reason);
    await new Promise((r) => setTimeout(r, 2000));
    const later = await next();
    expect(later).toMatchObject({ error: { kind: 'busy' } });
    expect(named).toContain((later.diagnostics[0]!.params as { reason: string }).reason);
    expect(callsOf(h)).toHaveLength(1);
  }, 2 * TT);

  it.each([
    ['a 500', { status: 500 }],
    ['a 401', { status: 401 }],
    ['a 418', { status: 418 }],
    ['a stream failure after a 200', { body: 'y'.repeat(100), drop: { afterBytes: 40 } as const }],
  ])('%s on a caught read: the call is unsettled (kind unsettled, nothing cancelled it) and the next run is busy', async (_name, reply404) => {
    const { run, h } = await setup(tools(() => reply404));
    const first = await run('try { await parley.read_guide({}); } catch (e) { return e.message; }');
    expect(first.r.isError).toBe(true);
    expect(first.body).toMatchObject({ status: 'partial-or-unknown', error: { kind: 'unsettled', message: "A call's outcome is unknown." }, value: null, incomplete: true, operations: [{ method: 'read_guide', outcome: 'unknown', incomplete: true }] });
    expect(first.body.diagnostics.map((d) => d.code)).toContain('call-unsettled');
    const second = await run('return 1');
    expect(second.body).toMatchObject({ runId: null, status: 'error', error: { kind: 'busy' } });
    expect(second.body.diagnostics).toEqual([{ code: 'busy', params: { reason: 'previous-run-has-calls-with-unknown-outcome' }, message: expect.any(String) }]);
    // a failed stream is retried before it is given up, so the host may have seen several requests
    expect(callsOf(h).length).toBeGreaterThanOrEqual(1);
  }, 2 * TT);

  it('a 404 on the only attempt (spec §5.2): unavailable, nothing dispatched, and the next run is admitted at once', async () => {
    const { run, h } = await setup(tools(() => ({ status: 404 })));
    const thrown = await run('return await parley.read_guide({});');
    expect(thrown.r.isError).toBe(true);
    expect(thrown.body).toMatchObject({ status: 'error', error: { kind: 'unavailable' }, value: null, operations: [{ method: 'read_guide', dispatched: false, outcome: 'refused' }] });
    expect(thrown.body.diagnostics.map((d) => d.code)).not.toContain('call-unsettled');
    const caught = await run('try { await parley.read_guide({}); return "sent"; } catch (e) { return e.message; }');
    expect(caught.body).toMatchObject({ status: 'completed', value: 'parley: host unavailable, call not dispatched', operations: [{ method: 'read_guide', dispatched: false, outcome: 'refused' }] });
    expect((await run('return 1')).body).toMatchObject({ status: 'completed', value: 1 });
    expect(callsOf(h)).toHaveLength(2);
  }, 2 * TT);

  it('a script that throws with a read that never got an outcome is unsettled, not a script error (the read may have run)', async () => {
    const { run } = await setup(tools(() => ({ status: 500 })));
    const { r, body } = await run('parley.read_guide({}); throw new Error("script failure");');
    expect(r.isError).toBe(true);
    expect(body).toMatchObject({ status: 'partial-or-unknown', error: { kind: 'unsettled' }, value: null, incomplete: true, operations: [{ method: 'read_guide', outcome: 'unknown' }] });
    const next = await run('return 1');
    expect(next.body).toMatchObject({ error: { kind: 'busy' } });
  }, 2 * TT);

  it('a script that spins (the CPU limit) ends as a timeout that names active-time, with no operation and nothing cancelled', async () => {
    const { run, h } = await setup(tools(() => reply(ROLES)));
    const { r, body } = await run('while (true) {}');
    expect(r.isError).toBe(true);
    expect(body).toMatchObject({ status: 'error', error: { kind: 'timeout' }, value: null, incomplete: true, operations: [] });
    expect(body.diagnostics).toContainEqual({ code: 'limit-reached', params: { limit: 'active-time' }, message: 'limit reached: active-time' });
    expect(callsOf(h)).toHaveLength(0);
  }, TT);

  it('the sentinel texts of a failing run never cross: the helper reason and the guest message stay out', async () => {
    const { run } = await setup(tools(() => reply(ROLES)));
    const { r } = await run(`throw new Error(${JSON.stringify(SECRET)});`);
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    const { r: syntax } = await run('return (');
    expect(JSON.parse((syntax.content as { text: string }[])[0]!.text)).toMatchObject({ status: 'error', error: { kind: 'syntax' } });
  }, 2 * TT);
});
