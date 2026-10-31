import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRemoteClient, roomKey, selectLaunchCapabilities, type Clock, type Rpc } from '../src/index.js';
import { PROJECT, room, session, snap, work } from './fixtures.js';

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (h) => clearTimeout(h as never),
  setInterval: (f, ms) => setInterval(f, ms),
  clearInterval: (h) => clearInterval(h as never),
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-10-31T12:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

const err = (code: string) => Object.assign(new Error(code), { code });

function setup(handler: (method: string, params: unknown) => Promise<unknown>) {
  const rpc: Rpc = { call: vi.fn(handler) };
  const client = createRemoteClient({ rpc, clock });
  client.handleEvent('bridge.status', { host: 'online', epoch: 'e1' });
  client.handleEvent('works.changed', snap(1, [work('w-1', { sessions: [session('s-1')], rooms: [room('r-1')] })]));
  return { rpc, client };
}
const calls = (rpc: Rpc, method: string) => (rpc.call as ReturnType<typeof vi.fn>).mock.calls.filter(([m]) => m === method);

const sessionParams = { projectPath: PROJECT, workId: 'w-1', provider: 'claude', label: 'New one', task: 'do it' };
const roomParams = { projectPath: PROJECT, workId: 'w-1', title: 'Fresh room', members: ['s-1'] };
const msg = { projectPath: PROJECT, workId: 'w-1', roomId: 'r-1', kind: 'note' as const, text: 'hello room' };

describe('capabilities from the bridge hello', () => {
  it('without hello nothing is allowed; methods switch each capability', () => {
    const { client } = setup(async () => ({}));
    expect(selectLaunchCapabilities(client.store.getState())).toEqual({
      canCreateSession: false, canCreateRoom: false, canSendRoomMessage: false, canListProviders: false, canListRoles: false,
    });
    client.setBridgeMethods(['works.list', 'sessions.create', 'rooms.send', 'providers.list']);
    expect(selectLaunchCapabilities(client.store.getState())).toEqual({
      canCreateSession: true, canCreateRoom: false, canSendRoomMessage: true, canListProviders: true, canListRoles: false,
    });
    client.setBridgeMethods(null);
    expect(selectLaunchCapabilities(client.store.getState()).canCreateSession).toBe(false);
  });

  it('methods and drafts survive a new epoch; catalogs do not', async () => {
    const { client } = setup(async (method) => (method === 'providers.list' ? { providers: [] } : {}));
    client.setBridgeMethods(['sessions.create']);
    client.store.dispatch({ t: 'draft', key: 'k', text: 'keep me' });
    expect(await client.loadProviders()).toBe(true);
    expect(client.store.getState().providers).not.toBeNull();
    client.handleEvent('bridge.status', { host: 'online', epoch: 'e2' });
    const s = client.store.getState();
    expect(s.methods).toEqual(['sessions.create']);
    expect(s.drafts).toEqual({ k: 'keep me' });
    expect(s.providers).toBeNull();
  });

  it('catalogs come from providers.list and roles.list; failure leaves them unset', async () => {
    const roles = { roles: [] };
    const { client } = setup(async (method) => {
      if (method === 'providers.list') return { providers: [{ id: 'claude', label: 'Claude', available: true }] };
      if (method === 'roles.list') return roles;
      throw err('internal');
    });
    expect(await client.loadProviders()).toBe(true);
    expect(await client.loadRoles(PROJECT)).toBe(true);
    expect(client.store.getState().providers?.providers[0]?.id).toBe('claude');
    expect(client.store.getState().roles[PROJECT]).toBe(roles);
    const broken = setup(async () => {
      throw err('unknown_method');
    });
    expect(await broken.client.loadProviders()).toBe(false);
    expect(broken.client.store.getState().providers).toBeNull();
  });
});

describe('createSession', () => {
  it('answer from the host → created with the ref; parent is always null', async () => {
    const ref = { projectPath: PROJECT, workId: 'w-1', sessionId: 's-9' };
    const { client, rpc } = setup(async () => ({ ref }));
    expect(await client.createSession(sessionParams)).toEqual({ outcome: 'created', ref });
    expect(calls(rpc, 'sessions.create')[0]?.[1]).toMatchObject({ parent: null, label: 'New one' });
  });

  it('unknown_method → rejected with the code, no re-read', async () => {
    const { client, rpc } = setup(async () => {
      throw err('unknown_method');
    });
    expect(await client.createSession(sessionParams)).toMatchObject({ outcome: 'rejected', code: 'unknown_method' });
    expect(calls(rpc, 'works.list')).toHaveLength(0);
  });

  it('connection_lost: no retry, snapshot re-read, new session found → created', async () => {
    const after = snap(2, [work('w-1', { sessions: [session('s-1'), session('s-2', { label: 'New one' })], rooms: [room('r-1')] })]);
    const { client, rpc } = setup(async (method) => {
      if (method === 'sessions.create') throw err('connection_lost');
      return after;
    });
    expect(await client.createSession(sessionParams)).toEqual({
      outcome: 'created',
      ref: { projectPath: PROJECT, workId: 'w-1', sessionId: 's-2' },
    });
    expect(calls(rpc, 'sessions.create')).toHaveLength(1);
    expect(calls(rpc, 'works.list')).toHaveLength(1);
  });

  it('connection_lost and no new session in the snapshot → unknown; re-read failed → lost; a session that existed before is not taken', async () => {
    const same = snap(2, [work('w-1', { sessions: [session('s-1', { label: 'New one' })] })]);
    const unknown = setup(async (m) => {
      if (m === 'sessions.create') throw err('timeout');
      return same;
    });
    unknown.client.handleEvent('works.changed', snap(1, [work('w-1', { sessions: [session('s-1', { label: 'New one' })] })]));
    const pendingUnknown = unknown.client.createSession(sessionParams);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pendingUnknown).toEqual({ outcome: 'unknown' });
    const lost = setup(async () => {
      throw err('connection_lost');
    });
    const pendingLost = lost.client.createSession(sessionParams);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pendingLost).toEqual({ outcome: 'lost' });
  });

  it('an answer that arrives in another epoch is not trusted: re-read decides', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { client } = setup(async (method) => {
      if (method === 'sessions.create') {
        await gate;
        return { ref: { projectPath: PROJECT, workId: 'w-1', sessionId: 's-7' } };
      }
      return snap(5, [work('w-1', { sessions: [] })]);
    });
    const pending = client.createSession(sessionParams);
    client.handleEvent('bridge.status', { host: 'online', epoch: 'e2' });
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toEqual({ outcome: 'unknown' });
  });
});

describe('createRoom', () => {
  it('created / rejected / lost → re-read finds the room by title', async () => {
    const ok = setup(async () => ({ roomId: 'r-5' }));
    expect(await ok.client.createRoom(roomParams)).toEqual({ outcome: 'created', ref: { projectPath: PROJECT, workId: 'w-1', roomId: 'r-5' } });
    const bad = setup(async () => {
      throw err('bad_request');
    });
    expect(await bad.client.createRoom(roomParams)).toMatchObject({ outcome: 'rejected', code: 'bad_request' });
    const after = snap(2, [work('w-1', { sessions: [session('s-1')], rooms: [room('r-1'), room('r-6', { title: 'Fresh room', members: ['s-1'] })] })]);
    const lost = setup(async (m) => {
      if (m === 'rooms.create') throw err('connection_lost');
      return after;
    });
    expect(await lost.client.createRoom(roomParams)).toEqual({ outcome: 'created', ref: { projectPath: PROJECT, workId: 'w-1', roomId: 'r-6' } });
    expect(calls(lost.rpc, 'rooms.create')).toHaveLength(1);
    const nothing = setup(async (m) => {
      if (m === 'rooms.create') throw err('connection_lost');
      return snap(2, [work('w-1', { rooms: [room('r-1')] })]);
    });
    const pendingNothing = nothing.client.createRoom(roomParams);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pendingNothing).toEqual({ outcome: 'unknown' });
  });
});

describe('sendRoomMessage', () => {
  const key = roomKey({ projectPath: PROJECT, workId: 'w-1', roomId: 'r-1' });

  it('sent: the draft is cleared; body carries to:[] and the room', async () => {
    const { client, rpc } = setup(async () => ({ messageId: 'm-1' }));
    expect(await client.sendRoomMessage(msg)).toEqual({ outcome: 'sent', messageId: 'm-1' });
    expect(client.store.getState().drafts[key]).toBeUndefined();
    expect(calls(rpc, 'rooms.send')[0]?.[1]).toEqual({ projectPath: PROJECT, workId: 'w-1', roomId: 'r-1', to: [], text: 'hello room', kind: 'note' });
  });

  it('connection_lost: no retry, draft stays; rejected keeps the draft too', async () => {
    const lost = setup(async () => {
      throw err('connection_lost');
    });
    expect(await lost.client.sendRoomMessage(msg)).toEqual({ outcome: 'lost' });
    expect(lost.client.store.getState().drafts[key]).toBe('hello room');
    expect(calls(lost.rpc, 'rooms.send')).toHaveLength(1);
    const bad = setup(async () => {
      throw err('unknown_method');
    });
    expect(await bad.client.sendRoomMessage(msg)).toMatchObject({ outcome: 'rejected', code: 'unknown_method' });
    expect(bad.client.store.getState().drafts[key]).toBe('hello room');
  });

  it('a non-RPC failure is thrown, not turned into an outcome', async () => {
    const { client } = setup(async () => {
      throw new Error('boom');
    });
    await expect(client.sendRoomMessage(msg)).rejects.toThrow('boom');
  });
});

describe('wave 3 fixes', () => {
  it('W1: after connection_lost the snapshot is re-read with backoff until the bridge call deadline; the session that appears at 20 s is found', async () => {
    let created = false;
    let revision = 1;
    const { client, rpc } = setup(async (method) => {
      if (method === 'sessions.create') throw err('connection_lost');
      return snap(++revision, [work('w-1', { sessions: [session('s-1'), ...(created ? [session('s-2', { label: 'New one', startedAt: new Date().toISOString() })] : [])] })]);
    });
    const pending = client.createSession(sessionParams);
    await vi.advanceTimersByTimeAsync(19_000);
    created = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ outcome: 'created', ref: { projectPath: PROJECT, workId: 'w-1', sessionId: 's-2' } });
    expect(calls(rpc, 'sessions.create')).toHaveLength(1);
    expect(calls(rpc, 'works.list').length).toBeGreaterThan(3);
    expect(calls(rpc, 'works.list').length).toBeLessThan(15);
  });

  it('W9: a same-name session of another provider, or one started long before the call, is not taken for ours', async () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const { client } = setup(async (method) => {
      if (method === 'sessions.create') throw err('connection_lost');
      return snap(2, [
        work('w-1', {
          sessions: [
            session('s-1'),
            session('s-2', { label: 'New one', provider: 'codex' }),
            session('s-3', { label: 'New one', provider: 'claude', startedAt: old }),
          ],
        }),
      ]);
    });
    const pending = client.createSession(sessionParams);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toEqual({ outcome: 'unknown' });
  });

  it('W9: a room with the same title but another mode or members is not ours', async () => {
    const { client } = setup(async (method) => {
      if (method === 'rooms.create') throw err('timeout');
      return snap(2, [work('w-1', { rooms: [room('r-1'), room('r-2', { title: 'Fresh room', members: ['s-9'], mode: 'free' })] })]);
    });
    const pending = client.createRoom(roomParams);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toEqual({ outcome: 'unknown' });
  });

  it('W8: after a lost rooms.send the room feed is checked: the human letter is there → sent, draft cleared', async () => {
    const letter = { id: 'm-9', roomId: 'r-1', from: 'human', to: [], at: new Date().toISOString(), text: 'hello room', kind: 'note', readBy: {} };
    const { client } = setup(async (method) => {
      if (method === 'rooms.send') throw err('connection_lost');
      return { messages: [{ ...letter, id: 'm-1', text: 'other' }, letter], page: {} };
    });
    expect(await client.sendRoomMessage(msg)).toEqual({ outcome: 'sent', messageId: 'm-9' });
    expect(client.store.getState().drafts[roomKey({ projectPath: PROJECT, workId: 'w-1', roomId: 'r-1' })]).toBeUndefined();
  });

  it('W8: an older identical letter does not count; feed unreadable → lost, draft stays', async () => {
    const stale = { id: 'm-3', roomId: 'r-1', from: 'human', to: [], at: new Date(Date.now() - 3600_000).toISOString(), text: 'hello room', kind: 'note', readBy: {} };
    const { client } = setup(async (method) => {
      if (method === 'rooms.send') throw err('timeout');
      return { messages: [stale], page: {} };
    });
    expect(await client.sendRoomMessage(msg)).toEqual({ outcome: 'lost' });
    expect(client.store.getState().drafts[roomKey({ projectPath: PROJECT, workId: 'w-1', roomId: 'r-1' })]).toBe('hello room');
  });
});
