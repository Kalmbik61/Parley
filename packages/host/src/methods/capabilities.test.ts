import { homedir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { Capabilities } from '@parley/core';
import type { RequestInfo } from '../context.js';
import { createCapabilitiesList } from './capabilities.js';

const request = {} as RequestInfo;
const caps: Capabilities = {
  commands: [{ name: 'clear', description: 'x', terminal: false }],
  skills: [{ name: 's', description: null, source: 'user', path: '/p' }],
  agents: [],
};

describe('capabilities.list', () => {
  it('claude: сканер получает домашнюю папку и путь проекта', async () => {
    const scan = vi.fn().mockResolvedValue(caps);
    const result = await createCapabilitiesList(scan)({ projectPath: '/work/p', provider: 'claude' }, request);
    expect(result).toBe(caps);
    expect(scan).toHaveBeenCalledWith({ home: homedir(), projectPath: '/work/p' });
  });

  it('другой провайдер — пустые списки, сканер не зовётся', async () => {
    const scan = vi.fn();
    const result = await createCapabilitiesList(scan)({ projectPath: '/work/p', provider: 'codex' }, request);
    expect(result).toEqual({ commands: [], skills: [], agents: [] });
    expect(scan).not.toHaveBeenCalled();
  });

  it('относительный projectPath — bad_request', async () => {
    const scan = vi.fn();
    await expect(createCapabilitiesList(scan)({ projectPath: 'rel/p', provider: 'claude' }, request)).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(scan).not.toHaveBeenCalled();
  });
});

import { createCapabilitiesHandlers } from './capabilities.js';
import type { HostContext } from '../context.js';
import type { SnapshotContext } from '../capabilities/snapshot.js';

it('snapshot get/refresh bind one service, broadcast safe independent columns and preserve legacy list', async () => {
 const broadcast = vi.fn(); const onShutdown = vi.fn(); const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
 const host = { broadcast, onShutdown, log } as unknown as HostContext;
 const request = { host } as RequestInfo;
 const context: SnapshotContext = { projectPath: '/fixture/project', homeDir: '/fixture/home', binaries: { claude: null, codex: null } };
 const handlers = createCapabilitiesHandlers({ context: async () => context, readers: {
  claude: async () => ({ entries: [], diagnostics: [], phase: 'ready' }),
  codex: async () => { throw new Error('FIXTURE_SECRET'); },
 } });
 await expect(handlers.capabilitiesGet({ projectPath: 'relative' }, request)).rejects.toMatchObject({ code: 'bad_request' });
 const first = await handlers.capabilitiesGet({ projectPath: '/fixture/project' }, request);
 expect(first.columns.claude.phase).toBe('loading');
 await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(2));
 expect(onShutdown).toHaveBeenCalledTimes(1);
 const cached = await handlers.capabilitiesGet({ projectPath: '/fixture/project' }, request);
 expect(cached.columns.codex.phase).toBe('error');
 const refresh = await handlers.capabilitiesRefresh({ projectPath: '/fixture/project' }, request);
 expect(refresh.revision).toBeGreaterThan(cached.revision); expect(refresh.columns.claude.phase).toBe('loading');
 await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(4));
 expect(JSON.stringify([cached, broadcast.mock.calls, log])).not.toContain('FIXTURE_SECRET');
 expect(log.error).not.toHaveBeenCalled(); expect(log.warn).not.toHaveBeenCalled();
 handlers.service.dispose();
});
