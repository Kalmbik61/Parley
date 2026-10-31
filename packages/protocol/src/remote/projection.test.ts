import { describe, expect, it } from 'vitest';
import type { WorksSnapshot } from '../types.js';
import { projectWorksSnapshot, remoteWorksSnapshotSchema } from './index.js';

const session = (over: Record<string, unknown>) => ({
  id: 's-01', provider: 'claude', label: 'plan', task: 'SECRET TASK', parent: null, contextFrom: [],
  lifecycle: 'active', result: null, resultAt: null, closedAt: null,
  history: [{ event: 'pending', at: '2026-10-01T10:00:00Z' }, { event: 'active', at: '2026-10-01T10:05:00Z' }],
  startedAt: '2026-10-01T10:00:00Z', endedAt: null, pid: null, startedAtProcess: null, launchedBy: null,
  providerSessionId: null, metrics: { x: 1 }, summary: 'SECRET SUMMARY', summarySource: null, artifacts: [],
  worktree: null, role: { source: 'builtin', name: 'executor' }, model: 'sonnet', agentPlan: { steps: [] },
  ...over,
});

const fixture = {
  revision: 7,
  branches: { x: 'main' },
  entries: [
    {
      projectPath: '/p/a',
      map: {
        work: { id: 'w-0001', title: 'First', status: 'active', updatedAt: '2026-10-01T10:00:00Z' },
        sessions: [
          session({ createdBy: 's-00' }),
          session({ id: 's-02', lifecycle: 'closed', result: 'done', resultAt: '2026-10-01T11:00:00Z', closedAt: '2026-10-01T11:01:00Z', history: [], role: null, model: null, stuck: { kind: 'limit', since: 's', detail: null, resetsAt: null, window: 'week', account: null } }),
        ],
        rooms: [
          {
            id: 'r-01', title: 'Room', creator: 's-01', ownerId: 's-01', members: ['s-01'], createdAt: 'x', lead: 's-01', mode: 'free',
            archivedAt: '2026-10-02T00:00:00Z', memberLog: [],
            proposal: { kind: 'decision', id: 'p-01', from: 's-01', text: 'go', rev: 0, at: 't', plan: { anything: 1 } },
          },
        ],
        plans: [{}], planEffects: [], resources: {},
        swarms: [{
          id: 'sw-01', tag: 'Research', creator: { kind: 'session', sessionId: 's-01' }, objective: 'SECRET OBJECTIVE', queen: 's-01',
          members: [{ sessionId: 's-01', role: 'queen', n: 1, addedAt: 'a', handedAt: null }, { sessionId: 's-02', role: 'drone', n: 1, addedAt: 'a', handedAt: 'h' }],
          status: 'running', createdAt: 'c', endedAt: null, result: { summary: 'SECRET RESULT', at: 'x', deliveredAt: null },
          failure: 'f', seenAt: 's', expiredAt: 'e',
        }],
        messages: [{}, {}],
        compact: {
          version: 2,
          rooms: { '': { total: 5, top: 5, lastAt: null, unread: 2, decision: null }, 'r-01': { total: 3, top: 3, lastAt: null, unread: 1, decision: null } },
          unread: { letters: 3, rooms: {} }, mentionCandidates: [],
        },
      },
    },
    {
      projectPath: '/p/b',
      map: {
        work: { id: 'w-0002', title: 'Second', status: 'done', updatedAt: 'x' },
        sessions: [], rooms: [{ id: 'r-09', title: 'T', creator: 'human', ownerId: null, members: [], createdAt: 'x', lead: null, proposal: null }],
      },
    },
  ],
} as unknown as WorksSnapshot;

const FORBIDDEN = ['task', 'summary', 'history', 'metrics', 'agentPlan', 'plans', 'planEffects', 'resources', 'branches'];
const keys = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => keys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); if (k !== 'plan') keys(x, out); }
  return out;
};

describe('projectWorksSnapshot', () => {
  const p = projectWorksSnapshot(fixture);

  it('passes the schema; fields and order match', () => {
    expect(remoteWorksSnapshotSchema.safeParse(p).success).toBe(true);
    expect(p.revision).toBe(7);
    expect(p.works.map((w) => w.id)).toEqual(['w-0001', 'w-0002']);
    const w = p.works[0]!;
    expect(w).toMatchObject({ projectPath: '/p/a', title: 'First', status: 'active', messages: { direct: { total: 5, unread: 2 }, inline: 2 } });
    expect(w.sessions[0]).toEqual({
      id: 's-01', label: 'plan', provider: 'claude', model: 'sonnet', role: 'executor', parent: null, createdBy: 's-00', lifecycle: 'active',
      result: null, stuck: null, lastEvent: { event: 'active', at: '2026-10-01T10:05:00Z' }, startedAt: '2026-10-01T10:00:00Z', resultAt: null,
    });
    expect(w.swarms).toEqual([{
      id: 'sw-01', tag: 'Research', creator: { kind: 'session', sessionId: 's-01' }, queen: 's-01',
      members: [{ sessionId: 's-01', role: 'queen', n: 1, handedAt: null }, { sessionId: 's-02', role: 'drone', n: 1, handedAt: 'h' }],
      status: 'running', createdAt: 'c', endedAt: null,
    }]);
    expect(w.sessions[1]).toMatchObject({ lifecycle: 'closed', result: 'done', role: null, model: null, stuck: { kind: 'limit' } });
    expect(w.rooms[0]).toEqual({
      id: 'r-01', title: 'Room', members: ['s-01'], lead: 's-01', ownerId: 's-01', mode: 'free', archived: true,
      proposal: { kind: 'decision', id: 'p-01', from: 's-01', text: 'go', rev: 0, at: 't', plan: { anything: 1 } },
      messages: { total: 3, unread: 1 },
    });
  });

  it('has no host-only keys', () => {
    const found = keys(p).filter((k) => FORBIDDEN.includes(k));
    expect(found).toEqual([]);
    const swarmKeys = keys(p.works.flatMap((w) => w.swarms));
    for (const k of ['objective', 'result', 'failure', 'seenAt', 'expiredAt', 'addedAt']) expect(swarmKeys).not.toContain(k);
  });

  it('handles empty history, missing compact and missing revision', () => {
    const w = p.works[0]!;
    expect(w.sessions[1]!.lastEvent).toBeNull();
    const w2 = p.works[1]!;
    expect(w2.messages).toEqual({ direct: null, inline: 0 });
    expect(w2.swarms).toEqual([]);
    expect(w.sessions[1]!.createdBy).toBeNull();
    expect(w2.rooms[0]!.ownerId).toBeNull();
    expect(w2.rooms[0]).toMatchObject({ messages: null, archived: false, mode: null, lead: null, proposal: null });
    const noRev = projectWorksSnapshot({ entries: [], branches: {} });
    expect(noRev).toEqual({ revision: 0, works: [] });
  });

  it('reads counters of a version 1 compact', () => {
    const e = structuredClone(fixture.entries[0]!) as unknown as { map: Record<string, unknown> };
    e.map.compact = {
      version: 1,
      messages: { total: 9, included: 9, latestId: null, rooms: { '': { total: 4, included: 4, tailFrom: 1 }, 'r-01': { total: 6, included: 6, tailFrom: 1 } } },
      unread: { letters: 2, rooms: { 'r-01': 3 } }, cut: [], omitted: {},
    };
    const v1 = projectWorksSnapshot({ entries: [e as never], branches: {} });
    expect(v1.works[0]!.messages.direct).toEqual({ total: 4, unread: 2 });
    expect(v1.works[0]!.rooms[0]!.messages).toEqual({ total: 6, unread: 3 });
  });
});
