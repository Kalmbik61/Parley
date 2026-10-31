import { describe, expect, it, vi } from 'vitest';
import type { RemoteState } from '@parley/remote-client';
import type { Approve } from '../auth/approve';
import {
  MAY_BE_STARTING,
  NOT_CONFIRMED,
  OFF_ON_MAC,
  canShowNew,
  defaultWorkspace,
  hasDraft,
  launchRoom,
  launchSession,
  letterProblem,
  partialMessage,
  providerChoices,
  roomCandidates,
  roomProblem,
  sendFirstLetter,
  sessionName,
  sessionProblem,
  workspaces,
  type RoomForm,
  type SessionForm,
} from './launch-model';

const ok: Approve = vi.fn(async () => 'ok' as const);
const no: Approve = vi.fn(async () => 'cancelled' as const);

const snapshot = (works: unknown[]) => ({ snapshot: { revision: 1, works } }) as unknown as Pick<RemoteState, 'snapshot'>;
const work = (id: string, over: Record<string, unknown> = {}) => ({
  projectPath: '/Users/me/proj',
  id,
  title: `W ${id}`,
  status: 'active',
  sessions: [],
  rooms: [],
  swarms: [],
  ...over,
});
const providers = { providers: [
  { id: 'claude', label: 'Claude', available: true, models: [{ id: 'opus', label: 'Opus' }] },
  { id: 'codex', label: 'Codex', available: false, needs: 'sign-in' },
] } as unknown as RemoteState['providers'];
const choices = providerChoices({ providers });

const sessionForm = (over: Partial<SessionForm> = {}): SessionForm => ({
  projectPath: '/Users/me/proj', workId: 'w-1', provider: 'claude', model: null, role: null, name: '', task: 'do it', worktree: false, ...over,
});
const roomForm = (over: Partial<RoomForm> = {}): RoomForm => ({
  projectPath: '/Users/me/proj', workId: 'w-1', title: 'Release review', mode: 'verified', members: ['s-1'], agents: [], lead: null, ...over,
});

const created = (ref: unknown) => ({ outcome: 'created' as const, ref });
const client = (over: Record<string, unknown> = {}) => ({
  createSession: vi.fn(async () => created({ projectPath: '/Users/me/proj', workId: 'w-1', sessionId: 's-9' })),
  createRoom: vi.fn(async () => created({ projectPath: '/Users/me/proj', workId: 'w-1', roomId: 'r-9' })),
  sendRoomMessage: vi.fn(async () => ({ outcome: 'sent' as const, messageId: 'm-1' })),
  ...over,
}) as never as Parameters<typeof launchSession>[0] & { createSession: ReturnType<typeof vi.fn>; createRoom: ReturnType<typeof vi.fn>; sendRoomMessage: ReturnType<typeof vi.fn> };

describe('what the sheet offers', () => {
  it('the plus button needs a launch method in the bridge hello', () => {
    expect(canShowNew({ methods: null })).toBe(false);
    expect(canShowNew({ methods: ['works.list', 'feed.decide'] })).toBe(false);
    expect(canShowNew({ methods: ['sessions.create'] })).toBe(true);
    expect(canShowNew({ methods: ['rooms.create', 'rooms.send'] })).toBe(true);
  });

  it('workspaces: not archived, active first; the default is the one we came from, else the first active', () => {
    const list = workspaces(snapshot([work('w-1', { status: 'done' }), work('w-2', { status: 'archived' }), work('w-3'), work('w-4')]));
    expect(list.map((w) => w.workId)).toEqual(['w-3', 'w-4', 'w-1']);
    expect(list[0]).toMatchObject({ projectName: 'proj', title: 'W w-3' });
    expect(defaultWorkspace(list, null)?.workId).toBe('w-3');
    expect(defaultWorkspace(list, { projectPath: '/Users/me/proj', workId: 'w-1' })?.workId).toBe('w-1');
    expect(defaultWorkspace(list, { projectPath: '/x', workId: 'w-9' })?.workId).toBe('w-3');
    expect(defaultWorkspace([], null)).toBeNull();
  });

  it('room candidates: alive sessions that are not swarm members', () => {
    const w = work('w-1', {
      sessions: [{ id: 's-1', lifecycle: 'active' }, { id: 's-2', lifecycle: 'closed' }, { id: 's-3', lifecycle: 'sleeping' }, { id: 's-4', lifecycle: 'active' }],
      swarms: [{ members: [{ sessionId: 's-4' }] }],
    });
    expect(roomCandidates(w as never).map((s) => s.id)).toEqual(['s-1', 's-3']);
  });

  it('a provider that is not ready is off with the reason', () => {
    expect(choices[0]).toMatchObject({ id: 'claude', available: true, reason: null, models: [{ id: 'opus', label: 'Opus' }] });
    expect(choices[1]).toMatchObject({ id: 'codex', available: false, reason: "Codex isn't signed in on your Mac" });
  });
});

describe('forms', () => {
  it('session name: typed, else the role, else New session, never past 64', () => {
    expect(sessionName({ name: '  Fix  ', role: null })).toBe('Fix');
    expect(sessionName({ name: '', role: { source: 'builtin', name: 'executor' } })).toBe('executor');
    expect(sessionName({ name: '', role: null })).toBe('New session');
    expect(sessionName({ name: 'x'.repeat(100), role: null })).toHaveLength(64);
  });

  it('session problems: task, size, provider', () => {
    expect(sessionProblem(sessionForm(), choices)).toBeNull();
    expect(sessionProblem(sessionForm({ task: '   ' }), choices)).toMatch(/task|what the agent/i);
    expect(sessionProblem(sessionForm({ task: 'я'.repeat(8193) }), choices)).toBe('The task is too long'); // 16 386 bytes
    expect(sessionProblem(sessionForm({ task: 'я'.repeat(8192) }), choices)).toBeNull();
    expect(sessionProblem(sessionForm({ provider: 'codex' }), choices)).toBe("Codex isn't signed in on your Mac");
    expect(sessionProblem(sessionForm({ provider: 'nope' }), choices)).toBe('Choose an agent');
  });

  it('room problems: name, members (existing + new), 16 at most', () => {
    expect(roomProblem(roomForm(), choices)).toBeNull();
    expect(roomProblem(roomForm({ title: ' ' }), choices)).toBe('Name the room');
    expect(roomProblem(roomForm({ title: 'x'.repeat(129) }), choices)).toBe('The room name is too long');
    expect(roomProblem(roomForm({ members: [] }), choices)).toBe('Add at least one agent');
    expect(roomProblem(roomForm({ members: [], agents: [{ key: 'a', provider: 'claude', model: null, role: null }] }), choices)).toBeNull();
    expect(roomProblem(roomForm({ members: Array.from({ length: 17 }, (_, i) => `s-${i}`) }), choices)).toMatch(/at most 16/);
    expect(roomProblem(roomForm({ agents: [{ key: 'a', provider: 'codex', model: null, role: null }] }), choices)).toBe("Codex isn't signed in on your Mac");
  });

  it('the first message: required, 16 KiB', () => {
    expect(letterProblem('')).not.toBeNull();
    expect(letterProblem('go')).toBeNull();
    expect(letterProblem('a'.repeat(16385))).not.toBeNull();
  });

  it('a draft is worth asking about when something was typed', () => {
    const s = { task: '', name: '' };
    const r = { title: '', members: [], agents: [] };
    expect(hasDraft('session', s, r, '')).toBe(false);
    expect(hasDraft('session', { task: 'x', name: '' }, r, '')).toBe(true);
    expect(hasDraft('room', s, { ...r, title: 'T' }, '')).toBe(true);
    expect(hasDraft('room', s, r, 'first message')).toBe(true);
  });
});

describe('launchSession', () => {
  it('Face ID cancelled: nothing is sent', async () => {
    const c = client();
    expect(await launchSession(c, no, sessionForm())).toEqual({ kind: 'cancelled' });
    expect(c.createSession).not.toHaveBeenCalled();
  });

  it('created: the call carries the schema fields only, and Face ID asked as a launch', async () => {
    const c = client();
    const approve = vi.fn(async () => 'ok' as const);
    const res = await launchSession(c, approve, sessionForm({ model: 'opus', role: { source: 'builtin', name: 'executor' }, worktree: true, name: 'Fix lint' }));
    expect(res).toEqual({ kind: 'created', ref: { projectPath: '/Users/me/proj', workId: 'w-1', sessionId: 's-9' } });
    expect(approve).toHaveBeenCalledWith('launch');
    expect(c.createSession).toHaveBeenCalledWith({
      projectPath: '/Users/me/proj', workId: 'w-1', provider: 'claude', label: 'Fix lint', task: 'do it', model: 'opus', role: { source: 'builtin', name: 'executor' }, worktree: true,
    });
    await launchSession(c, ok, sessionForm());
    expect(c.createSession).toHaveBeenLastCalledWith({ projectPath: '/Users/me/proj', workId: 'w-1', provider: 'claude', label: 'New session', task: 'do it' });
  });

  it('unknown_method: the Mac switch is off; a host limit keeps the host text', async () => {
    const off = client({ createSession: vi.fn(async () => ({ outcome: 'rejected', code: 'unknown_method', message: 'unknown method: sessions.create' })) });
    expect(await launchSession(off, ok, sessionForm())).toEqual({ kind: 'refused', code: 'unknown_method', message: OFF_ON_MAC });
    const limit = client({ createSession: vi.fn(async () => ({ outcome: 'rejected', code: 'conflict', message: 'Session limit reached (12)' })) });
    expect(await launchSession(limit, ok, sessionForm())).toEqual({ kind: 'refused', code: 'conflict', message: 'Session limit reached (12)' });
  });

  it('lost → not confirmed; the re-read found nothing → it may still be starting', async () => {
    const lost = client({ createSession: vi.fn(async () => ({ outcome: 'lost' })) });
    expect(await launchSession(lost, ok, sessionForm())).toEqual({ kind: 'unconfirmed', message: NOT_CONFIRMED });
    const unknown = client({ createSession: vi.fn(async () => ({ outcome: 'unknown' })) });
    expect(await launchSession(unknown, ok, sessionForm())).toEqual({ kind: 'unknown', message: MAY_BE_STARTING });
  });
});

describe('launchRoom', () => {
  it('Face ID cancelled: nothing is started', async () => {
    const c = client();
    expect(await launchRoom(c, no, roomForm({ agents: [{ key: 'a', provider: 'claude', model: null, role: null }] }))).toEqual({ kind: 'cancelled' });
    expect(c.createSession).not.toHaveBeenCalled();
    expect(c.createRoom).not.toHaveBeenCalled();
  });

  it('existing members only: a quiet room with the chosen mode and lead', async () => {
    const c = client();
    const approve = vi.fn(async () => 'ok' as const);
    const res = await launchRoom(c, approve, roomForm({ members: ['s-1', 's-2'], lead: 's-2', title: '  Release review  ' }));
    expect(res).toEqual({ kind: 'created', ref: { projectPath: '/Users/me/proj', workId: 'w-1', roomId: 'r-9' }, agents: 2 });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(c.createSession).not.toHaveBeenCalled();
    expect(c.createRoom).toHaveBeenCalledWith({ projectPath: '/Users/me/proj', workId: 'w-1', title: 'Release review', members: ['s-1', 's-2'], quiet: true, mode: 'verified', lead: 's-2' });
  });

  it('new agents start quietly with an empty task; the lead can be a new agent', async () => {
    const c = client();
    const res = await launchRoom(
      c,
      ok,
      roomForm({ members: ['s-1'], agents: [{ key: 'n1', provider: 'claude', model: 'opus', role: { source: 'builtin', name: 'writer' } }], lead: 'n1' }),
    );
    expect(res).toMatchObject({ kind: 'created', agents: 2 });
    expect(c.createSession).toHaveBeenCalledWith({
      projectPath: '/Users/me/proj', workId: 'w-1', provider: 'claude', label: 'writer', task: '', model: 'opus', role: { source: 'builtin', name: 'writer' },
    });
    expect(c.createRoom).toHaveBeenCalledWith(expect.objectContaining({ members: ['s-1', 's-9'], lead: 's-9', quiet: true }));
  });

  it('a lead that is not a member is dropped (the host takes the first)', async () => {
    const c = client();
    await launchRoom(c, ok, roomForm({ lead: 's-77' }));
    expect(c.createRoom.mock.calls[0]![0]).not.toHaveProperty('lead');
  });

  it('an agent that fails to start stops the room; earlier agents stay and are counted', async () => {
    let n = 0;
    const c = client({
      createSession: vi.fn(async () => {
        n++;
        return n === 1 ? created({ projectPath: '/Users/me/proj', workId: 'w-1', sessionId: 's-8' }) : { outcome: 'rejected', code: 'conflict', message: 'Session limit reached' };
      }),
    });
    const res = await launchRoom(
      c,
      ok,
      roomForm({ members: [], agents: [{ key: 'a', provider: 'claude', model: null, role: null }, { key: 'b', provider: 'claude', model: null, role: null }] }),
    );
    expect(res).toMatchObject({ kind: 'partial', started: 1, message: '1 agent started, the room was not created: Session limit reached' });
    expect(c.createRoom).not.toHaveBeenCalled();
  });

  it('the room itself refused after agents started: they are counted in the message', async () => {
    const c = client({ createRoom: vi.fn(async () => ({ outcome: 'rejected', code: 'bad_request', message: 'unknown lead' })) });
    const res = await launchRoom(c, ok, roomForm({ members: [], agents: [{ key: 'a', provider: 'claude', model: null, role: null }, { key: 'b', provider: 'claude', model: null, role: null }] }));
    expect(res).toMatchObject({ kind: 'partial', started: 2, message: '2 agents started, the room was not created: unknown lead' });
    expect(partialMessage(0, 'x')).toBe('x');
  });

  it('the Mac switch turned off during the launch: the fixed sentence', async () => {
    const c = client({ createRoom: vi.fn(async () => ({ outcome: 'rejected', code: 'unknown_method', message: 'x' })) });
    const res = await launchRoom(c, ok, roomForm());
    expect(res).toMatchObject({ kind: 'partial', started: 0, message: OFF_ON_MAC });
  });
});

describe('sendFirstLetter', () => {
  const room = { projectPath: '/Users/me/proj', workId: 'w-1', roomId: 'r-9' };

  it('Face ID cancelled: nothing is sent (the draft stays on the sheet)', async () => {
    const c = client();
    expect(await sendFirstLetter(c, no, room, 'go')).toEqual({ kind: 'cancelled' });
    expect(c.sendRoomMessage).not.toHaveBeenCalled();
  });

  it('sent after a second Face ID, as a note', async () => {
    const c = client();
    const approve = vi.fn(async () => 'ok' as const);
    expect(await sendFirstLetter(c, approve, room, 'go')).toEqual({ kind: 'sent' });
    expect(approve).toHaveBeenCalledWith('letter');
    expect(c.sendRoomMessage).toHaveBeenCalledWith({ ...room, text: 'go', kind: 'note' });
  });

  it('refused and lost give words, not exceptions', async () => {
    const off = client({ sendRoomMessage: vi.fn(async () => ({ outcome: 'rejected', code: 'unknown_method', message: 'x' })) });
    expect(await sendFirstLetter(off, ok, room, 'go')).toEqual({ kind: 'refused', code: 'unknown_method', message: OFF_ON_MAC });
    const lost = client({ sendRoomMessage: vi.fn(async () => ({ outcome: 'lost' })) });
    expect(await sendFirstLetter(lost, ok, room, 'go')).toEqual({ kind: 'unconfirmed', message: NOT_CONFIRMED });
  });
});
