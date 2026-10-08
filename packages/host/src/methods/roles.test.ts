import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addSession, buildRoleCatalog, createWork, updateMap } from '@parley/core';
import type { RequestInfo } from '../context.js';
import { createRolesList } from './roles.js';
let project = '';
beforeEach(async () => { project = await mkdtemp(path.join(tmpdir(), 'parley-role-method-')); });
afterEach(async () => { await rm(project, { recursive: true, force: true }); });
// This handler does not inspect the request/host; pass only its required typed slot.
const request = {} as RequestInfo;
describe('roles.list participant context and safe projection', () => {
  it('resolves the current participant worktree and projects no native paths or prompt', async () => {
    const { work } = await createWork(project, { title: 'Roles', goal: '' });
    await updateMap(project, work.id, map => {
      const session = addSession(map, { provider: 'codex', label: 'Review', task: 'Review' });
      session.worktree = { path: '/participant/current', branch: 'b', base: 'main', createdAt: null };
    });
    let cwd = '';
    const handler = createRolesList(async current => {
      cwd = current;
      return buildRoleCatalog({ roles: [{ id: 'codex:exact', source: 'codex', provider: 'codex', name: 'exact', description: 'Current role', path: '/secret/role.toml', prompt: 'PRIVATE_PROMPT', model: 'custom', effort: 'xhigh', sandboxMode: 'read-only', readOnly: true }], diagnostics: [], partial: false });
    });
    const result = await handler({ projectPath: project, ref: { projectPath: project, workId: work.id, sessionId: 's-01' } }, request);
    expect(cwd).toBe('/participant/current');
    expect(result.roles.find(role => role.id === 'codex:exact')).toMatchObject({ readOnly: true, effort: 'xhigh' });
    expect(JSON.stringify(result)).not.toContain('/secret');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PROMPT');
  });
  it('rejects relative/mismatched scope and absent participants before discovery', async () => {
    let calls = 0;
    const handler = createRolesList(async () => { calls++; return buildRoleCatalog(); });
    await expect(handler({ projectPath: 'relative' }, request)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handler({ projectPath: project, ref: { projectPath: '/other', workId: 'w-1', sessionId: 's-1' } }, request)).rejects.toMatchObject({ code: 'bad_request' });
    const { work } = await createWork(project, { title: 'Roles', goal: '' });
    await expect(handler({ projectPath: project, ref: { projectPath: project, workId: work.id, sessionId: 's-missing' } }, request)).rejects.toMatchObject({ code: 'not_found' });
    expect(calls).toBe(0);
  });
});
