import { describe, expect, it } from 'vitest';
import { applyAgentSwitch, PREVIOUS_AGENTS_MAX, switchBlockers } from './agent-switch.js';
import { addSession, parseMap } from './map.js';
import type { AgentBinding, WindowWorkMap, WorkMap } from './types.js';

const emptyMap = (): WindowWorkMap => ({
  schemaVersion: 2,
  work: {
    id: 'w-0001', title: 'Работа', goal: 'цель', status: 'active',
    createdAt: '2026-10-30T10:00:00.000Z', updatedAt: '2026-10-30T10:00:00.000Z',
  },
  sessions: [],
  messages: [],
  rooms: [],
});

const binding = (n = 0): AgentBinding => ({
  provider: 'claude', model: 'opus', effort: 'high', providerSessionId: `uuid-${n}`,
  startedAt: '2026-10-30T10:00:00.000Z', endedAt: '2026-10-30T11:00:00.000Z',
  reason: 'limit', requestedBy: 'human', carried: 'handover',
});

const stuck = { kind: 'limit', since: '2026-10-30T10:30:00.000Z', detail: null, resetsAt: null, window: null, account: null } as const;

function fixture(): WindowWorkMap {
  const map = emptyMap();
  const session = addSession(map, { provider: 'claude', label: 'a', task: 't' });
  const child = addSession(map, { provider: 'claude', label: 'b', task: 't' });
  child.parent = session.id;
  session.parent = 's-00';
  Object.assign(session, {
    providerSessionId: 'old-uuid', pid: 42, startedAtProcess: 'stamp', stuck, model: 'opus', effort: 'high',
    codexThreadBinding: { launchRevision: 'x', pid: 42, startedAtProcess: 'stamp', threadId: null },
    agentPlan: [{ text: 'step' }], worktree: { path: '/tmp/wt', branch: 'b' },
    role: { source: 'builtin', name: 'executor' },
  });
  map.rooms.push({
    id: 'r-01', ownerId: session.id, members: [session.id, child.id], lead: session.id,
  } as unknown as WorkMap['rooms'][number]);
  return map;
}

describe('applyAgentSwitch', () => {
  it('resets the conversation fields and leaves identity, rooms, plan and worktree alone', () => {
    const map = fixture();
    const before = structuredClone(map);
    const next = applyAgentSwitch(map, 's-01', { provider: 'codex', model: 'gpt-6.1-sol' }, binding(), 'rev-1');
    const session = next.sessions[0]!;
    expect(session.provider).toBe('codex');
    expect(session.model).toBe('gpt-6.1-sol');
    expect(session).not.toHaveProperty('effort');
    expect(session.providerSessionId).toBeNull();
    expect(session.pid).toBeNull();
    expect(session.startedAtProcess).toBeNull();
    expect(session.stuck).toBeNull();
    expect(session).not.toHaveProperty('codexThreadBinding');
    expect(session.previousAgents).toEqual([binding()]);
    expect(session.agentRevision).toBe('rev-1');
    for (const key of ['id', 'parent', 'role', 'worktree', 'agentPlan'] as const) {
      expect(session[key]).toEqual(before.sessions[0]![key]);
    }
    expect(next.sessions[1]).toEqual(before.sessions[1]);
    expect(next.rooms).toEqual(before.rooms);
    expect(map).toEqual(before);
  });

  it('merges the two oldest segments at the cap instead of dropping them', () => {
    const usage = (n: number) => ({
      input: n, output: n, cacheRead: null, cacheWrite: 0, totalInput: n, source: 'frozen-snapshot', observedAt: `t${n}`,
      stale: false, completeness: 'complete', coverage: 'conversation', binding: 'b', epoch: null, closed: true,
    }) as AgentBinding['usage'];
    let map: WorkMap = fixture();
    for (let n = 0; n < PREVIOUS_AGENTS_MAX + 1; n += 1) {
      map = applyAgentSwitch(map, 's-01', { provider: n % 2 === 0 ? 'codex' : 'claude' },
        { ...binding(n), startedAt: `s${n}`, endedAt: `e${n}`, usage: usage(n + 1), costUsd: n === 0 ? null : 1 }, `rev-${n}`);
    }
    const list = map.sessions[0]!.previousAgents!;
    expect(list).toHaveLength(PREVIOUS_AGENTS_MAX);
    expect(list[0]).toMatchObject({ startedAt: 's0', endedAt: 'e1', providerSessionId: 'uuid-1', costUsd: null });
    expect(list[0]!.usage).toMatchObject({ input: 3, output: 3, cacheRead: null, cacheWrite: 0, observedAt: 't2' });
    expect(list.at(-1)!.providerSessionId).toBe(`uuid-${PREVIOUS_AGENTS_MAX}`);
  });

  it('throws for an unknown session', () => {
    expect(() => applyAgentSwitch(fixture(), 's-99', { provider: 'codex' }, binding(), 'rev-1')).toThrow('not found');
  });
});

describe('switchBlockers', () => {
  const target = { provider: 'codex' };

  it('allows a plain switch', () => {
    expect(switchBlockers(fixture(), 's-01', target)).toEqual([]);
  });

  it('refuses a missing session', () => {
    expect(switchBlockers(fixture(), 's-99', target)).toEqual(['session not found']);
  });

  it('refuses autonomous engine sessions', () => {
    const map = fixture();
    map.sessions[0]!.workspace = { kind: 'artifacts', path: '/tmp/x' } as never;
    expect(switchBlockers(map, 's-01', target)).toEqual(['autonomous engine sessions cannot change agent']);
  });

  it('refuses a closed session, archived work and the current provider', () => {
    const map = fixture();
    map.sessions[0]!.lifecycle = 'closed';
    map.work.status = 'archived';
    expect(switchBlockers(map, 's-01', { provider: 'claude' })).toEqual([
      'session is closed', 'work is archived', 'target is the current provider',
    ]);
  });
});

describe('agent fields in parseMap', () => {
  const read = (patch: Record<string, unknown>) => {
    const map = emptyMap();
    Object.assign(addSession(map, { provider: 'claude', label: 'a', task: 't' }), patch);
    return parseMap(JSON.stringify(map), 'map.json').sessions[0]!;
  };

  it('reads an old map without the fields as is', () => {
    const session = read({});
    expect(session).not.toHaveProperty('previousAgents');
    expect(session).not.toHaveProperty('switching');
    expect(session).not.toHaveProperty('agentRevision');
  });

  it('keeps valid values', () => {
    const switching = { id: 'sw-1', to: 'codex', since: '2026-10-30T12:00:00.000Z' };
    const session = read({ previousAgents: [{ ...binding(), reason: 'model', costUsd: 1.5 }], switching, agentRevision: 'rev' });
    expect(session.previousAgents).toEqual([{ ...binding(), reason: 'model', costUsd: 1.5 }]);
    expect(session.switching).toEqual(switching);
    expect(session.agentRevision).toBe('rev');
  });

  it('drops malformed values without rejecting the map', () => {
    const session = read({
      previousAgents: [binding(1), { provider: 5 }, null, { ...binding(2), usage: 'bad', model: 7, costUsd: -1 }],
      switching: { id: 1 },
      agentRevision: 5,
    });
    expect(session.previousAgents).toHaveLength(2);
    expect(session.previousAgents![1]).toMatchObject({ providerSessionId: 'uuid-2', model: null });
    expect(session.previousAgents![1]).not.toHaveProperty('usage');
    expect(session.previousAgents![1]).not.toHaveProperty('costUsd');
    expect(session).not.toHaveProperty('switching');
    expect(session).not.toHaveProperty('agentRevision');
    expect(read({ previousAgents: 'x' })).not.toHaveProperty('previousAgents');
  });

  it('trims an over-long history to the newest 20', () => {
    const session = read({ previousAgents: Array.from({ length: 25 }, (_, n) => binding(n)) });
    expect(session.previousAgents).toHaveLength(20);
    expect(session.previousAgents![0]!.providerSessionId).toBe('uuid-5');
  });
});
