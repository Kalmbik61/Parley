import { describe, expect, it, vi } from 'vitest';
import { createRemoteClient, roomKey, type Clock, type Rpc } from '../src/index.js';
import { PROJECT } from './fixtures.js';

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (h) => clearTimeout(h as never),
  setInterval: (f, ms) => setInterval(f, ms),
  clearInterval: (h) => clearInterval(h as never),
};
const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const R = { projectPath: PROJECT, workId: 'w-1', roomId: 'r-1' };
const K = roomKey(R);
const msg = (n: number, text = `m${n}`, over: Record<string, unknown> = {}) => ({ id: `m-${n}`, roomId: 'r-1', from: 's-1', to: [], at: `2026-11-01T10:0${n}:00.000Z`, text, kind: 'note', readBy: {}, ...over }) as never;
const mail = (letters: unknown[], extra: Record<string, unknown> = {}) => ({
  projectPath: PROJECT, workId: 'w-1', version: 2, prevVersion: 1, updatedAt: 'x', droppedRooms: [], mentionCandidates: [],
  unread: { letters: 0, rooms: {} },
  rooms: [{ roomId: 'r-1', prevTop: 1, top: 2, total: 2, lastAt: null, letters, reads: [], deleted: [], ...extra }],
});

function setup(handler: (m: string, p: unknown) => unknown) {
  const rpc: Rpc = { call: vi.fn(async (m: string, p?: unknown) => handler(m, p)) };
  const client = createRemoteClient({ rpc, clock });
  client.handleEvent('bridge.status', { host: 'online', epoch: 'e1' });
  const calls = (name: string) => (rpc.call as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === name).map((c) => c[1]);
  return { rpc, client, calls };
}
const page = (messages: unknown[], next: string | null = null) => ({ messages, page: { total: null, returned: messages.length, complete: next === null, next, bytes: 0, cut: 0 } });

describe('room chat', () => {
  it('reads the newest page, then live letters, read marks and deletions arrive by rooms.mail', async () => {
    const { client, calls } = setup((m) => (m === 'context.messages' ? page([msg(1), msg(2)], 'before:1') : {}));
    client.setConnected(true);
    client.openRoom(R);
    await flush();
    expect(calls('context.messages')).toEqual([{ projectPath: PROJECT, workId: 'w-1', roomId: 'r-1' }]);
    expect(client.store.getState().roomChats[K]).toMatchObject({ status: 'ready', older: 'before:1' });
    client.handleEvent('rooms.mail', mail([msg(3)]));
    expect(client.store.getState().roomChats[K]!.messages.map((m) => m.id)).toEqual(['m-1', 'm-2', 'm-3']);
    client.handleEvent('rooms.mail', mail([], { reads: [{ id: 'm-2', reader: 'human', at: 'T' }], deleted: ['m-1'] }));
    const s = client.store.getState().roomChats[K]!.messages;
    expect(s[1]!.readBy).toEqual({ human: 'T' });
    expect(s[0]!.deleted).toBe(true);
  });

  it('a letter that arrives twice is one letter; letters of rooms that are not open are ignored', async () => {
    const { client } = setup((m) => (m === 'context.messages' ? page([msg(1)]) : {}));
    client.setConnected(true);
    client.openRoom(R);
    await flush();
    client.handleEvent('rooms.mail', mail([msg(1), msg(2)]));
    client.handleEvent('rooms.mail', mail([msg(2)]));
    expect(client.store.getState().roomChats[K]!.messages).toHaveLength(2);
    const other = mail([msg(9)]);
    (other.rooms[0] as { roomId: string }).roomId = 'r-7';
    client.handleEvent('rooms.mail', other);
    expect(Object.keys(client.store.getState().roomChats)).toEqual([K]);
  });

  it('older pages go with the cursor and stop at the end; an error leaves the history and says so', async () => {
    let fail = false;
    const { client, calls } = setup((m, p) => {
      if (m !== 'context.messages') return {};
      const cursor = (p as { cursor?: string }).cursor;
      if (cursor === undefined) return page([msg(5), msg(6)], 'before:5');
      if (fail) throw Object.assign(new Error('x'), { code: 'timeout' });
      return page([msg(3), msg(4)], null);
    });
    client.setConnected(true);
    client.openRoom(R);
    await flush();
    fail = true;
    client.loadOlder(R);
    await flush();
    expect(client.store.getState().roomChats[K]).toMatchObject({ more: 'error', older: 'before:5' });
    fail = false;
    client.loadOlder(R);
    await flush();
    expect(client.store.getState().roomChats[K]!.messages.map((m) => m.id)).toEqual(['m-3', 'm-4', 'm-5', 'm-6']);
    expect(client.store.getState().roomChats[K]).toMatchObject({ older: null, more: 'idle' });
    client.loadOlder(R);
    await flush();
    expect(calls('context.messages').filter((p) => (p as { cursor?: string }).cursor !== undefined)).toHaveLength(2);
  });

  it('reread from the bridge, a new epoch and a reconnect read the newest page again; closing forgets the room', async () => {
    const { client, calls } = setup((m) => (m === 'context.messages' ? page([msg(1)]) : {}));
    client.setConnected(true);
    const close = client.openRoom(R);
    await flush();
    client.handleEvent('rooms.mail', mail([], { reread: true }));
    await flush();
    expect(calls('context.messages')).toHaveLength(2);
    client.handleEvent('bridge.status', { host: 'online', epoch: 'e2' });
    await flush();
    expect(calls('context.messages')).toHaveLength(3);
    client.setConnected(false);
    client.setConnected(true);
    await flush();
    expect(calls('context.messages')).toHaveLength(4);
    close();
    expect(client.store.getState().roomChats[K]).toBeUndefined();
  });

  it('no context.messages in the hello: no call', async () => {
    const { client, calls } = setup(() => ({}));
    client.setBridgeMethods(['works.list']);
    client.setConnected(true);
    client.openRoom(R);
    await flush();
    expect(calls('context.messages')).toEqual([]);
  });
});
