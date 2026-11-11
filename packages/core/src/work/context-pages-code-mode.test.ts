// The Code Mode label on a `get_map` session row (plan T12a-indicator): display only, an unknown field of the row, never in the schema.
// Rows come from real decision/record FILES through the real reader; without the callback every row is as it was.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codeModeStateOf } from '../mcp/code-mode/mode-state.js';
import { writeExposureRecord } from '../mcp/code-mode/exposure-record.js';
import { type LaunchDecision, writeLaunchDecision } from '../mcp/code-mode/launch-decision.js';
import { mapOverview, mcpResultBytes, topologyListPage } from './context-pages.js';
import { mapLetterReader } from './letter-store.js';
import { addSession } from './map.js';
import { addRoom } from './rooms.js';
import { HUMAN, type WindowWorkMap } from './types.js';

let workDir: string;
beforeEach(() => { workDir = mkdtempSync(path.join(tmpdir(), 'parley-t12a-indicator-')); });
afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

const NONCE = 'a'.repeat(32);
const decide = (sid: string, over: Partial<LaunchDecision> = {}): void => {
  expect(writeLaunchDecision(workDir, sid, { v: 1, nonce: NONCE, effective: 'replacement', requested: true, reason: null, provider: 'claude', at: '2026-11-09T00:00:00.000Z', ...over })).toBe(true);
};
const confirm = (sid: string): void => {
  expect(writeExposureRecord(workDir, sid, { v: 1, effective: 'replacement', reason: null, migrated: [], residual: [], registryRevision: 'r', residualSchemaSha256: null, launchId: 'l', nonce: NONCE } as never)).toBe(true);
};

const mapOf = (count: number): WindowWorkMap => {
  const map: WindowWorkMap = { schemaVersion: 2, work: { id: 'w-0001', title: 'W', goal: 'G', status: 'active', createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' }, sessions: [], messages: [], rooms: [] };
  for (let i = 0; i < count; i += 1) addSession(map, { provider: 'claude', label: `session ${i}`, task: 'task' });
  return map;
};
const rows = (page: { items: readonly Record<string, unknown>[] }) => page.items;
const real = (id: string) => codeModeStateOf(workDir, id);

describe('get_map session rows: codeMode is an extra field, only when asked for', () => {
  it('without the callback every row, page and overview is byte-identical to today', () => {
    const map = mapOf(8);
    const letters = mapLetterReader(map);
    const plain = JSON.stringify(mapOverview(map, 's-01', letters));
    expect(plain).not.toContain('codeMode');
    expect(JSON.stringify(topologyListPage(map, 's-01', letters, { field: 'sessions' }))).not.toContain('codeMode');
    // The callback present changes only the session rows; with every row dropped of that key the overview is the old one.
    const withCallback = mapOverview(map, 's-01', letters, real);
    const stripped = JSON.parse(JSON.stringify(withCallback)) as { map: { sessions: Record<string, unknown>[] } };
    for (const row of stripped.map.sessions) delete row['codeMode'];
    const old = JSON.parse(plain) as { map: { collections: { sessions: { bytes: number } } } };
    const fresh = stripped as unknown as typeof old;
    expect(Object.keys(fresh.map.collections.sessions).sort()).toEqual(Object.keys(old.map.collections.sessions).sort());
    expect(stripped.map.sessions).toEqual((JSON.parse(plain) as typeof stripped).map.sessions);
  });

  it('with it, the key is on overview rows and collection pages for sessions only; other collections stay as they were', () => {
    const map = mapOf(3);
    addRoom(map, { title: 'room', creator: HUMAN, members: ['s-01', 's-02'], lead: 's-01' });
    map.work.deletedSessions = ['s-90'];
    const letters = mapLetterReader(map);
    expect(topologyListPage(map, 's-01', letters, { field: 'rooms' }).items).toHaveLength(1);
    expect(topologyListPage(map, 's-01', letters, { field: 'deletedSessions' }).items).toHaveLength(1);
    const overview = mapOverview(map, 's-01', letters, real);
    expect(overview.map.sessions.every((row) => (row as Record<string, unknown>)['codeMode'] !== undefined)).toBe(true);
    for (const field of ['rooms', 'plans', 'deletedSessions', 'unreadRooms'] as const) {
      expect(JSON.stringify(topologyListPage(map, 's-01', letters, { field, codeModeOf: real }))).not.toContain('codeMode');
    }
    expect(rows(topologyListPage(map, 's-01', letters, { field: 'sessions', codeModeOf: real })).every((row) => 'codeMode' in row)).toBe(true);
  });

  it('three states from FILES through the real reader: unknown, classic with its reason, code-mode; a launch without a record is unknown', () => {
    const map = mapOf(5);
    decide('s-02', { nonce: null, effective: 'classic', reason: 'not-requested' });
    decide('s-03'); confirm('s-03');
    decide('s-04'); // replacement, not yet confirmed
    const by = Object.fromEntries(rows(topologyListPage(map, 's-01', mapLetterReader(map), { field: 'sessions', codeModeOf: real })).map((row) => [row['id'], row['codeMode']]));
    expect(by).toEqual({ 's-01': 'unknown', 's-02': 'classic', 's-03': 'code-mode', 's-04': 'unknown', 's-05': 'unknown' });
  });

  it('a state that moves: unknown, then the record is written, then code-mode on the next read', () => {
    const map = mapOf(1);
    const read = () => (rows(topologyListPage(map, 's-01', mapLetterReader(map), { field: 'sessions', codeModeOf: real }))[0] as { codeMode: unknown }).codeMode;
    expect(read()).toBe('unknown');
    decide('s-01');
    expect(read()).toBe('unknown'); // decided, not confirmed yet
    confirm('s-01');
    expect(read()).toBe('code-mode');
  });

  it('a reader that throws leaves the page whole, with unknown on that row', () => {
    const map = mapOf(4);
    const boom = (id: string) => { if (id === 's-02') throw new Error('disk gone'); return { mode: 'classic' as const, reason: 'not-requested' as const }; };
    const page = topologyListPage(map, 's-01', mapLetterReader(map), { field: 'sessions', codeModeOf: boom });
    expect(page.items).toHaveLength(4);
    expect(page.items.map((row) => row['codeMode'])).toEqual(['classic', 'unknown', 'classic', 'classic']);
  });

  it('only the bare mode word travels on a row: no reason, no extra key, no free text', () => {
    const map = mapOf(1);
    const odd = () => ({ mode: 'classic', reason: 'not-requested', nonce: 'secret', path: '/x' }) as never;
    const page = topologyListPage(map, 's-01', mapLetterReader(map), { field: 'sessions', codeModeOf: odd });
    expect(rows(page)[0]!['codeMode']).toBe('classic');
    for (const text of ['not-requested', 'secret', '/x', 'reason', 'nonce']) expect(JSON.stringify(page), text).not.toContain(text);
  });

  it.each([['a mode that is not a string', { mode: 4, reason: null }], ['an unrecognised mode', { mode: 'alongside', reason: null }], ['an inherited key', { mode: 'toString', reason: null }], ['nothing', undefined], ['null', null]])('a callback that answers %s: unknown on that row', (_n, answer) => {
    const map = mapOf(1);
    const row = rows(topologyListPage(map, 's-01', mapLetterReader(map), { field: 'sessions', codeModeOf: (() => answer) as never }))[0]!;
    expect(row['codeMode']).toBe('unknown');
  });

  it('the reader is asked only for rows that are returned (plus the one that overflowed), not for every session', () => {
    const map = mapOf(119);
    const spy = vi.fn(real);
    const page = topologyListPage(map, 's-01', mapLetterReader(map), { field: 'sessions', maxBytes: 2048, codeModeOf: spy });
    expect(page.page.returned).toBeLessThan(119);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(page.page.returned + 1);
    const overview = mapOverview(map, 's-01', mapLetterReader(map), spy);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(page.page.returned + 1 + overview.map.sessions.length + 1);
  });

  it.each([1, 5, 20, 50])('paging conservation with the field at %i sessions: every session once, cursors resume, byte budgets hold', (count) => {
    const map = mapOf(count);
    for (let i = 1; i <= count; i += 1) if (i % 3 === 0) decide(`s-${String(i).padStart(2, '0')}`, { nonce: null, effective: 'classic', reason: 'held-run' });
    const letters = mapLetterReader(map);
    const overview = mapOverview(map, 's-01', letters, real);
    expect(mcpResultBytes(overview)).toBeLessThanOrEqual(49152);
    // The overview's own cursor continues with the default page size (the cursor binds the page size)...
    const seen = overview.map.sessions.map((row) => row.id);
    for (let cursor = overview.map.collections.sessions.next; cursor !== null;) {
      const page = topologyListPage(map, 's-01', letters, { field: 'sessions', cursor, codeModeOf: real });
      seen.push(...page.items.map((row) => row['id'] as string));
      cursor = page.page.next;
    }
    expect(seen).toHaveLength(count);
    expect(new Set(seen).size).toBe(count);
    // ...and a small page size walks the same sessions once each, every page inside its byte budget.
    const small: string[] = [];
    for (let cursor: string | undefined; ;) {
      const page = topologyListPage(map, 's-01', letters, { field: 'sessions', maxBytes: 2048, codeModeOf: real, ...(cursor === undefined ? {} : { cursor }) });
      expect(mcpResultBytes(page)).toBeLessThanOrEqual(2048);
      small.push(...page.items.map((row) => row['id'] as string));
      if (page.page.next === null) break;
      cursor = page.page.next;
    }
    expect(small).toEqual(seen);
  });

  it('the cursor is not tied to a label: a record written between two pages neither breaks nor repeats the walk', () => {
    const map = mapOf(60);
    const letters = mapLetterReader(map);
    const first = topologyListPage(map, 's-01', letters, { field: 'sessions', maxBytes: 2048, codeModeOf: real });
    expect(first.page.next).not.toBeNull();
    decide('s-60'); confirm('s-60');
    const second = topologyListPage(map, 's-01', letters, { field: 'sessions', maxBytes: 2048, cursor: first.page.next!, codeModeOf: real });
    expect(second.items[0]!['id']).not.toBe(first.items[0]!['id']);
    expect(new Set([...first.items, ...second.items].map((row) => row['id'])).size).toBe(first.items.length + second.items.length);
  });
});
