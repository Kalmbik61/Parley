import { describe, expect, it } from 'vitest';
import type { SeedReport, WorktreeInfo } from '@parley/core';
import type { EventData, EventName, SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';
import { createDepsSeeder } from './deps-seed.js';

const NOW = new Date('2026-11-11T10:00:00.000Z');
const INFO: WorktreeInfo = {
  path: '/копии/s-01',
  branch: 'parley/w-0001-s-01',
  base: 'master',
  createdAt: null,
};

function refOf(projectPath: string, sessionId: string): SessionRef {
  return { projectPath, workId: 'w-0001', sessionId };
}

function fakeHost() {
  const broadcasts: Array<{ event: EventName; data: unknown }> = [];
  const logs: Array<{ level: string; msg: string }> = [];
  const log = (level: string) => (msg: string) => {
    logs.push({ level, msg });
  };
  const host: HostContext = {
    version: '0.0.0',
    startedAt: NOW.toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: log('info'), warn: log('warn'), error: log('error') },
    clients: () => [],
    liveSessions: () => 0,
    broadcast: (event, data) => broadcasts.push({ event, data: data as EventData<EventName> }),
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
    hold: () => {},
  };
  const notices = (kind: string) =>
    broadcasts.filter((item) => item.event === 'host.notice' && (item.data as { kind: string }).kind === kind);
  return { host, broadcasts, logs, notices };
}

function report(patch: Partial<SeedReport> = {}): SeedReport {
  return {
    sourceRoot: '/проекты/магазин',
    cloned: ['node_modules'],
    skipped: [],
    lockMismatch: [],
    stale: false,
    unavailable: false,
    ...patch,
  };
}

describe('createDepsSeeder', () => {
  it('отчёт превращается в запись', async () => {
    const { host } = fakeHost();
    const seeder = createDepsSeeder(host, { seed: async () => report(), now: () => NOW });
    expect(await seeder.run(refOf('/p', 's-01'), INFO)).toEqual({
      at: '2026-11-11T10:00:00.000Z',
      cloned: 1,
      first: 'node_modules',
    });
  });

  it('нет списка — null, уведомлений нет', async () => {
    const { host, broadcasts } = fakeHost();
    const seeder = createDepsSeeder(host, { seed: async () => null, now: () => NOW });
    expect(await seeder.run(refOf('/p', 's-01'), INFO)).toBeNull();
    expect(broadcasts).toEqual([]);
  });

  it('seed бросил — null и запись в журнале, run не отклонён', async () => {
    const { host, logs, broadcasts } = fakeHost();
    const seeder = createDepsSeeder(host, {
      seed: async () => {
        throw new Error('сломалось');
      },
      now: () => NOW,
    });
    expect(await seeder.run(refOf('/p', 's-01'), INFO)).toBeNull();
    expect(logs.filter((item) => item.level === 'warn')).toHaveLength(1);
    expect(broadcasts).toEqual([]);
  });

  it('unavailable — одно уведомление на проект', async () => {
    const { host, notices } = fakeHost();
    const seeder = createDepsSeeder(host, {
      seed: async (project) =>
        report({ unavailable: true, cloned: [], sourceRoot: project }),
      now: () => NOW,
    });
    expect(await seeder.run(refOf('/p', 's-01'), INFO)).toBeNull();
    await seeder.run(refOf('/p', 's-02'), INFO);
    await seeder.run(refOf('/p', 's-01'), INFO);
    expect(notices('deps-clone-unavailable')).toHaveLength(1);
    expect((notices('deps-clone-unavailable')[0]?.data as { text: string; ref: SessionRef; at: string })).toEqual({
      kind: 'deps-clone-unavailable',
      ref: refOf('/p', 's-01'),
      text: 'Dependencies were not cloned into the worktree of S01: the worktree root is on another volume or not on APFS. Set the worktree root to a folder on the same volume as /p.',
      at: '2026-11-11T10:00:00.000Z',
    });
    await seeder.run(refOf('/q', 's-01'), INFO);
    expect(notices('deps-clone-unavailable')).toHaveLength(2);
  });

  it('расхождение — deps-clone-mismatch один раз', async () => {
    const { host, notices } = fakeHost();
    const seeder = createDepsSeeder(host, {
      seed: async (project) => report({ lockMismatch: ['pnpm-lock.yaml'], sourceRoot: project }),
      now: () => NOW,
    });
    await seeder.run(refOf('/p', 's-02'), INFO);
    await seeder.run(refOf('/p', 's-03'), INFO);
    expect(notices('deps-clone-mismatch')).toHaveLength(1);
    expect((notices('deps-clone-mismatch')[0]?.data as { text: string }).text).toBe(
      'Dependencies cloned from /p do not match the lock file of the worktree of S02; its agent has to run the install. If this repeats, update the dependencies in /p.',
    );
    expect(notices('deps-clone-unavailable')).toHaveLength(0);
  });

  it('не больше двух клонов сразу', async () => {
    const { host } = fakeHost();
    let running = 0;
    let peak = 0;
    let started = 0;
    const gates: Array<() => void> = [];
    const seeder = createDepsSeeder(host, {
      seed: async () => {
        started += 1;
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => gates.push(resolve));
        running -= 1;
        return report();
      },
      now: () => NOW,
    });
    const all = Promise.all(
      [1, 2, 3, 4, 5].map((n) => seeder.run(refOf('/p', `s-0${n}`), INFO)),
    );
    // Пока ворота закрыты, идут ровно два клона.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(2);
    while (gates.length > 0 || started < 5 || running > 0) {
      gates.shift()?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    const results = await all;
    expect(results).toHaveLength(5);
    expect(results.every((item) => item !== null)).toBe(true);
    expect(peak).toBe(2);
  });
});
