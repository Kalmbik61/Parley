import { describe, expect, it } from 'vitest';
import { addSession, type WorkMap } from '@parley/core';
import { projectIslandWorks } from './works-projection.js';

describe('island works projection', () => {
  it('удаляет весь optional proof, сохраняет raw binding и не меняет source', () => {
    const map: WorkMap = { schemaVersion: 2, work: { id: 'w-0001', title: '', goal: '', status: 'active',
      createdAt: '', updatedAt: '' }, sessions: [], messages: [], rooms: [] };
    const proof = { launchRevision: 'private-launch', pid: 42, startedAtProcess: 'private-process', threadId: 'raw-thread' };
    Object.assign(addSession(map, { provider: 'codex', label: '', task: '' }),
      { codexThreadBinding: proof, providerSessionId: proof.threadId });
    const source = { entries: [{ projectPath: '/p', map }], branches: { '/p': 'main' }, revision: 5 };
    const before = JSON.stringify(source);
    const projected = projectIslandWorks(source);
    expect(projected.entries[0]?.map.sessions[0]).not.toHaveProperty('codexThreadBinding');
    expect(projected.entries[0]?.map.sessions[0]?.providerSessionId).toBe(proof.threadId);
    expect(projected.branches).toEqual(source.branches);
    expect(projected.revision).toBe(5);
    expect(JSON.stringify(source)).toBe(before);
    expect(source.entries[0]?.map.sessions[0]?.codexThreadBinding).toBe(proof);
  });
});
