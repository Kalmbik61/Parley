import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRoomRuns, runKeyOf } from './room-runs';

const T = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
];

describe('room runs', () => {
  it('holds the slot while a run goes, shows progress, refuses a second action, frees it after', async () => {
    const runs = createRoomRuns();
    const seen: Array<[number, number | null] | null> = [];
    runs.subscribe(() => {
      const p = runs.get('r').pending;
      seen.push(p === null ? null : [p.done, p.total]);
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const first = runs.run('r', 'sleep', T, async () => {
      await gate;
      return { outcome: 'ok' };
    });
    expect(runs.get('r').pending).toEqual({ kind: 'sleep', done: 0, total: 2 });
    // A second action (a run or Archive) while the first is in flight does nothing.
    expect(await runs.run('r', 'wake', T, async () => ({ outcome: 'ok' }))).toBeNull();
    expect(await runs.hold('r', 'archive', async () => 1)).toEqual({ started: false });
    release();
    expect((await first)?.allOk).toBe(true);
    expect(runs.get('r').pending).toBeNull();
    expect(seen).toContainEqual([1, 2]);
    expect(seen.at(-1)).toBeNull();
  });
  it('rooms do not share a slot', async () => {
    const runs = createRoomRuns();
    runs.seedPending('r1', { kind: 'delete', done: 0, total: null });
    expect(await runs.hold('r2', 'archive', async () => 1)).toEqual({ started: true, value: 1 });
  });
  it('a result with failures stays unseen until seen; all ok leaves none', async () => {
    const runs = createRoomRuns();
    await runs.run('r', 'sleep', T, async () => ({ outcome: 'ok' }));
    expect(runs.get('r').unseen).toBeNull();
    await runs.run('r', 'sleep', T, async (id) => (id === 'a' ? { outcome: 'ok' } : { outcome: 'rejected', code: 'rate_limited', message: 'too many changes per minute' }));
    expect(runs.get('r').unseen).toMatchObject({ title: 'Put to sleep: 1 of 2' });
    expect(runs.get('r').unseen?.results[1]?.text).toBe('too many changes per minute');
    runs.seen('r');
    expect(runs.get('r').unseen).toBeNull();
  });
  it('the slot is freed when the work throws', async () => {
    const runs = createRoomRuns();
    await expect(runs.hold('r', 'delete', async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(runs.get('r').pending).toBeNull();
  });
});

describe('two Macs', () => {
  const room = { projectPath: '/Users/me/parley', workId: 'w-0001', roomId: 'r-01' };
  it('the same room id on two hosts shares neither the slot nor the result', async () => {
    const runs = createRoomRuns();
    const a = runKeyOf('host-a', room);
    const b = runKeyOf('host-b', room);
    expect(a).not.toBe(b);
    runs.seedPending(a, { kind: 'wake', done: 1, total: 4 });
    expect(runs.get(b).pending).toBeNull();
    expect(await runs.hold(b, 'archive', async () => 1)).toEqual({ started: true, value: 1 });
    await runs.run(a.replace('host-a', 'host-c'), 'sleep', T, async () => ({ outcome: 'lost' }));
    expect(runs.get(runKeyOf('host-c', room)).unseen).not.toBeNull();
    expect(runs.get(a).unseen).toBeNull();
    expect(runs.get(b).unseen).toBeNull();
  });
});

describe('the room screen', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/app/room.tsx'), 'utf8');
  it('confirms with confirmByOwner, not with the app lock (the Lock Parley setting must not matter)', () => {
    expect(source).toContain('confirmByOwner');
    expect(source).not.toMatch(/\.unlock\(/);
    expect(source).not.toContain('appLock');
  });
  it('sends archive and delete only through ownerGate', () => {
    expect(source).toContain('ownerGate(');
    expect(source.match(/client\.(archiveRoom|deleteRoom)\(/g)).toHaveLength(2);
  });
});
