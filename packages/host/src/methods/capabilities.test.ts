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


import { allow, contextFingerprint, deny } from '../capabilities/native-targets.js';
import type { ProviderSnapshotResult } from '../capabilities/snapshot.js';
import type { McpExecution, McpExecutor } from '../capabilities/actions.js';

it('all action RPCs share the snapshot singleton and its one shutdown queue without exposing native output', async () => {
 const broadcast = vi.fn(); const onShutdown = vi.fn(); const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
 const host = { broadcast, onShutdown, log } as unknown as HostContext; const request = { host } as RequestInfo;
 const context: SnapshotContext = { projectPath: '/fixture/project', homeDir: '/fixture/home', binaries: { claude: null, codex: '/fixture/codex' } };
 const nativeName = 'NATIVE_SELECTOR_SECRET';
 const reader = async (): Promise<ProviderSnapshotResult> => ({ entries: [{ kind: 'mcp', name: 'safe-display', presence: {
  id: 'opaque', scope: 'user', source: null, documentPath: null, description: null, installed: true, enabled: null, status: 'unknown', summary: null, modelAvailable: null, unavailableReason: null,
 } }], phase: 'ready', diagnostics: [], native: {
  contextFingerprint: contextFingerprint(context, 'codex'), signature: 'stable', names: [nativeName],
  targets: [{ id: 'opaque', provider: 'codex', name: nativeName, scope: 'user', fingerprint: 'stable', remove: allow(), check: deny('native-only') }],
  add: { user: allow(), project: deny('unsupported-scope'), local: deny('unsupported-scope') },
 } });
 let finish!: (value: McpExecution) => void; let signal: AbortSignal | undefined;
 const pending = new Promise<McpExecution>(resolve => { finish = resolve; });
 const execute = vi.fn<McpExecutor>(async (_binary, _args, _context, abort) => { signal = abort; return pending; });
 const handlers = createCapabilitiesHandlers({ context: async () => context, readers: { claude: async () => ({ entries: [], phase: 'ready', diagnostics: [] }), codex: reader }, executeMcp: execute });
 await handlers.capabilitiesGet({ projectPath: context.projectPath }, request);
 await vi.waitFor(() => expect(handlers.service.get(context.projectPath).columns.codex.phase).toBe('ready'));
 const params = { projectPath: context.projectPath, provider: 'codex' as const, presenceId: 'opaque', revision: handlers.service.get(context.projectPath).revision };
 expect(await handlers.capabilitiesMcpCheck(params, request)).toEqual({ outcome: 'unavailable', code: 'native-only', recovery: 'native-mcp' });
 expect(execute).not.toHaveBeenCalled();
 const removing = handlers.capabilitiesMcpRemove(params, request);
 const adding = handlers.capabilitiesMcpAdd({ projectPath: context.projectPath, provider: 'codex', revision: params.revision, scope: 'user', name: 'new-server', input: { kind: 'stdio', command: 'node' } }, request);
 await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
 expect(execute.mock.calls[0]?.[1]).toEqual(['mcp', 'remove', nativeName]); expect(onShutdown).toHaveBeenCalledTimes(1);
 const broadcastsBeforeShutdown = broadcast.mock.calls.length;
 await onShutdown.mock.calls[0]![0]();
 expect(signal?.aborted).toBe(true);
 expect(await removing).toEqual({ outcome: 'cancelled', code: 'shutdown' }); expect(await adding).toEqual({ outcome: 'cancelled', code: 'shutdown' });
 finish({ code: 'ok', stdout: Buffer.from('OUTPUT_SECRET') });
 await new Promise(resolve => setTimeout(resolve, 10));
 expect(execute).toHaveBeenCalledTimes(1); expect(broadcast).toHaveBeenCalledTimes(broadcastsBeforeShutdown);
 expect(JSON.stringify([broadcast.mock.calls, log])).not.toContain('SECRET'); expect(log.error).not.toHaveBeenCalled(); expect(log.warn).not.toHaveBeenCalled();
});
