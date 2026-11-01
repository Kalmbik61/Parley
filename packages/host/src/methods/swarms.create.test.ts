import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addSession, createWork, updateMap } from '@parley/core';
import type { CreateSessionInput } from '../sessions/sessions-service.js';
import { createSwarmsCreate } from './swarms.js';

let project = '';
beforeEach(async () => { project = await mkdtemp(path.join(tmpdir(), 'parley-swarms-create-')); });
afterEach(async () => { await rm(project, { recursive: true, force: true }); });

/** Сервис сессий-заглушка: пишет то, что записал бы настоящий (сессию и рой), чтобы метод нашёл рой по карте. */
const fakeSessions = () => ({
  create: vi.fn(async (input: CreateSessionInput) => {
    let sessionId = '';
    await updateMap(input.projectPath, input.workId!, (map) => {
      sessionId = addSession(map, { provider: input.provider, label: 'Queen sw-01', task: input.task }).id;
      map.swarms = [{
        id: 'sw-01', tag: 'Audit', creator: { kind: 'human' }, objective: input.task, queen: sessionId,
        members: [{ sessionId, role: 'queen', n: 1, addedAt: new Date().toISOString(), handedAt: null }],
        status: 'running', createdAt: new Date().toISOString(), endedAt: null, expiredAt: null, result: null, failure: null, seenAt: null,
      }];
    });
    return { projectPath: input.projectPath, workId: input.workId!, sessionId };
  }),
});

describe('swarms.create', () => {
  it('человек: sessions.create без requestedBy и с полем swarm; ответ — рой и королева', async () => {
    const work = await createWork(project, { title: 'Swarm', goal: '' });
    const sessions = fakeSessions();
    const result = await createSwarmsCreate(sessions)(
      { projectPath: project, workId: work.work.id, tag: 'Audit', objective: 'Check everything', provider: 'claude', model: 'opus', role: { source: 'builtin', name: 'researcher' } },
      {} as never,
    );
    expect(result).toEqual({ swarmId: 'sw-01', queenSessionId: 's-01' });
    const input = sessions.create.mock.calls[0]![0];
    expect(input).toMatchObject({
      projectPath: project, workId: work.work.id, provider: 'claude', label: '', task: 'Check everything', parent: null,
      swarm: { kind: 'create', tag: 'Audit', objective: 'Check everything' }, model: 'opus', role: { source: 'builtin', name: 'researcher' },
    });
    expect(input).not.toHaveProperty('requestedBy');
    expect(input).not.toHaveProperty('effort');
  });

  it('королева роя: sessions.create получает lean: true', async () => {
    const work = await createWork(project, { title: 'Swarm', goal: '' });
    const sessions = fakeSessions();
    await createSwarmsCreate(sessions)({ projectPath: project, workId: work.work.id, tag: 'Audit', objective: 'Check', provider: 'claude' }, {} as never);
    expect(sessions.create.mock.calls[0]![0]).toMatchObject({ lean: true });
  });

  it('работы нет — not_found, сессия не создаётся', async () => {
    const sessions = fakeSessions();
    await expect(createSwarmsCreate(sessions)({ projectPath: project, workId: 'w-nope', tag: 'T', objective: 'o', provider: 'claude' }, {} as never))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(sessions.create).not.toHaveBeenCalled();
  });
});
