import { release } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { HealthSample, ProfileStatus, SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext, RequestInfo } from '../context.js';
import type { HealthService } from '../health/health-service.js';
import type { Profiler } from '../diagnostics/profiler.js';
import type { PtyHandle } from '../pty/pty-manager.js';
import { createDiagnosticsHandlers } from './diagnostics.js';

const ref: SessionRef = { projectPath: '/p', workId: 'w-01', sessionId: 's-01' };

const SAMPLE: HealthSample = {
  cpuPct: 12.5,
  rssMb: 490,
  heapMb: 200,
  extMb: 30,
  loop: { maxMs: 120, p99Ms: 40, meanMs: 3 },
  ptys: 15,
  attached: 3,
  feedSubs: 2,
  works: 4,
  rooms: 2,
  clients: 1,
};

function fakeHost(): HostContext {
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    clients: () => [],
    liveSessions: () => 0,
    broadcast: () => {},
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
  };
}

const request: RequestInfo = { host: fakeHost(), client: undefined as never };

function handlersOf(profiler: Partial<Profiler>, extra: { pty?: PtyHandle[]; activity?: ActivityService['get']; isAttached?: boolean } = {}) {
  return createDiagnosticsHandlers({
    health: { sample: () => SAMPLE } as HealthService,
    profiler: profiler as Profiler,
    pty: { list: () => extra.pty ?? [] },
    activity: { get: extra.activity ?? (() => undefined) },
    isAttached: () => extra.isAttached ?? false,
  });
}

describe('host.diagnostics (спека A2)', () => {
  it('host.diagnostics отдаёт версии, состояние, сессии и профили', async () => {
    const handlers = createDiagnosticsHandlers({
      health: { sample: () => SAMPLE } as HealthService,
      profiler: {
        status: () => ({ state: 'idle' }),
        files: async () => ['/h/diagnostics/host-1.cpuprofile'],
      } as unknown as Profiler,
      pty: { list: () => [{ ref, pid: 42, startedAt: 1_700_000_000_000, provider: 'claude' } as PtyHandle] },
      activity: { get: () => ({ activity: { activity: 'working' } }) } as never,
      isAttached: () => true,
    });
    const result = await handlers.hostDiagnostics({}, request);
    expect(result).toMatchObject({
      hostVersion: '0.0.0',
      node: process.version,
      platform: process.platform,
      release: release(),
      arch: process.arch,
      pid: process.pid,
      health: SAMPLE,
      sessions: [{ ref, provider: 'claude', activity: 'working', pid: 42, startedAt: '2023-11-14T22:13:20.000Z', attached: true }],
      profiles: ['/h/diagnostics/host-1.cpuprofile'],
      profile: { state: 'idle' },
    });
    expect(result.startedAt).toBe(request.host.startedAt);
    expect(typeof result.uptimeSec).toBe('number');
  });

  it('сессия без провайдера и без активности отдаётся с null, а отсутствие подписчиков — attached: false', async () => {
    const handlers = handlersOf(
      { status: () => ({ state: 'idle' }), files: async () => [] },
      { pty: [{ ref, pid: 7, startedAt: 0, provider: null } as PtyHandle] },
    );
    const result = await handlers.hostDiagnostics({}, request);
    expect(result.sessions).toEqual([
      { ref, provider: null, activity: null, pid: 7, startedAt: '1970-01-01T00:00:00.000Z', attached: false },
    ]);
    expect(result.profiles).toEqual([]);
  });
});

describe('host.profile.* (спека A5)', () => {
  it('host.profile.start без seconds зовёт profiler.start(20), с seconds — как есть', async () => {
    const running: ProfileStatus = { state: 'running', startedAt: '2026-10-16T10:00:00.000Z', seconds: 20 };
    const start = vi.fn((_seconds?: number): ProfileStatus => running);
    const handlers = handlersOf({ start });
    await expect(handlers.profileStart({}, undefined as never)).resolves.toEqual(running);
    expect(start).toHaveBeenLastCalledWith(20);
    await handlers.profileStart({ seconds: 35 }, undefined as never);
    expect(start).toHaveBeenLastCalledWith(35);
  });

  it('host.profile.status отдаёт profiler.status()', async () => {
    const done: ProfileStatus = { state: 'done', file: '/h/diagnostics/host-1.cpuprofile', finishedAt: '2026-10-16T10:00:20.000Z' };
    const handlers = handlersOf({ status: () => done });
    await expect(handlers.profileStatus({}, undefined as never)).resolves.toEqual(done);
  });
});
