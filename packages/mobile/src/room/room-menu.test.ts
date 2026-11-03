import { describe, expect, it } from 'vitest';
import type { SessionCommandOutcome } from '@parley/remote-client';
import { archiveSheet, archiveStops, AUTONOMOUS_REASON, deleteConfirm, membersWhere, NO_RUNNING, NO_SLEEPING, roomMenu, roomToast, runAll, runSummary, sleepConfirm, type RoomMenuFacts } from './room-menu';

const ALL = ['sessions.stop', 'sessions.resume', 'rooms.archive', 'rooms.delete'];
const facts = (over: Partial<RoomMenuFacts> = {}, room: Partial<RoomMenuFacts['room']> = {}): RoomMenuFacts => ({
  methods: ALL,
  room: { id: 'r1', title: 'iOS app', mode: 'verified', hasProposal: false, members: ['a', 'b', 'c', 'human', 'ghost'], ...room },
  sessions: [
    { id: 'a', label: 'Alpha', lifecycle: 'active' },
    { id: 'b', label: 'Beta', lifecycle: 'active' },
    { id: 'c', label: 'Gamma', lifecycle: 'sleeping' },
  ],
  otherRooms: [],
  ...over,
});
const ids = (m: ReturnType<typeof roomMenu>): string[] => m.items.map((i) => i.id);

describe('roomMenu', () => {
  it('D1 order, nothing disabled, no title for an ordinary room', () => {
    const m = roomMenu(facts());
    expect(m.items.map((i) => i.title)).toEqual(['Put all to sleep', 'Wake all', 'Copy room ID', 'Archive room…', 'Delete room…']);
    expect(m.items.find((i) => i.id === 'delete')?.destructive).toBe(true);
    expect(m.items.some((i) => i.disabled === true)).toBe(false);
    expect(m.title).toBeUndefined();
  });
  it('an item without its method is absent; switch off leaves only Copy room ID', () => {
    expect(ids(roomMenu(facts({ methods: [] })))).toEqual(['copy']);
    expect(ids(roomMenu(facts({ methods: null })))).toEqual(['copy']);
    expect(ids(roomMenu(facts({ methods: ['sessions.stop', 'rooms.delete'] })))).toEqual(['sleepAll', 'copy', 'delete']);
  });
  it('no candidates: the item is disabled and the title says why', () => {
    const none = facts({ sessions: [{ id: 'a', label: 'Alpha', lifecycle: 'closed' }] });
    const m = roomMenu(none);
    expect(m.items.filter((i) => i.disabled).map((i) => i.id)).toEqual(['sleepAll', 'wakeAll']);
    expect(m.title).toBe(`${NO_RUNNING} · ${NO_SLEEPING}`);
    expect(roomMenu(facts({ sessions: [{ id: 'c', label: 'Gamma', lifecycle: 'sleeping' }] })).title).toBe(NO_RUNNING);
    expect(roomMenu(facts({ sessions: [{ id: 'a', label: 'Alpha', lifecycle: 'active' }] })).title).toBe(NO_SLEEPING);
  });
  it('an autonomous room disables sleep, wake, archive, delete; Copy stays; the title is the engine reason', () => {
    const m = roomMenu(facts({}, { mode: 'autonomous' }));
    expect(m.items.filter((i) => i.disabled).map((i) => i.id)).toEqual(['sleepAll', 'wakeAll', 'archive', 'delete']);
    expect(m.items.find((i) => i.id === 'copy')?.disabled).toBeUndefined();
    expect(m.title).toBe(AUTONOMOUS_REASON);
  });
  it('autonomous room with the switch off: only Copy, no reason needed', () => {
    const m = roomMenu(facts({ methods: [] }, { mode: 'autonomous' }));
    expect(ids(m)).toEqual(['copy']);
    expect(m.title).toBeUndefined();
  });
});

describe('candidates', () => {
  it('active / sleeping members in room order; unknown ids and the human are skipped', () => {
    expect(membersWhere(facts(), 'active').map((s) => s.id)).toEqual(['a', 'b']);
    expect(membersWhere(facts(), 'sleeping').map((s) => s.id)).toEqual(['c']);
  });
});

describe('archive', () => {
  it('N counts active members that are in no other non-archived room', () => {
    const f = facts({
      otherRooms: [
        { id: 'r2', members: ['a'], archived: false },
        { id: 'r3', members: ['b'], archived: true },
        { id: 'r1', members: ['b'], archived: false },
      ],
    });
    expect(archiveStops(f).map((s) => s.id)).toEqual(['b']);
  });
  it('N > 0: two options, stop first; N = 0: one plain Archive', () => {
    expect(archiveSheet(facts()).options).toEqual([
      { title: 'Archive and stop 2 agents', stopSessions: true },
      { title: 'Archive, keep agents running', stopSessions: false },
    ]);
    const one = archiveSheet(facts({ otherRooms: [{ id: 'r2', members: ['a'], archived: false }] }));
    expect(one.options[0]).toEqual({ title: 'Archive and stop 1 agent', stopSessions: true });
    const zero = archiveSheet(facts({ sessions: [] }));
    expect(zero.options).toEqual([{ title: 'Archive', stopSessions: false }]);
  });
  it('title and description; the decision sentence only with a proposal', () => {
    const a = archiveSheet(facts());
    expect(a.title).toBe('Archive “iOS app”?');
    expect(a.message).toBe('The feed stays readable. Nobody can write here until you reopen it on your Mac.');
    expect(archiveSheet(facts({}, { hasProposal: true })).message).toBe(`${a.message} Its open decision and live plan are closed.`);
  });
});

describe('confirm texts', () => {
  it('sleep and delete', () => {
    expect(sleepConfirm(3).title).toBe('Put 3 agents to sleep?');
    expect(sleepConfirm(1).title).toBe('Put 1 agent to sleep?');
    const d = deleteConfirm(facts());
    expect(d.title).toBe('Delete “iOS app”?');
    expect(d.message).toBe('The feed, decision and plans of this room are deleted. Its 4 sessions stay in the work.');
    expect(d.button).toBe('Delete');
  });
});

describe('runAll', () => {
  const targets = [
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Beta' },
    { id: 'c', label: 'Gamma' },
    { id: 'd', label: 'Delta' },
  ];
  it('runs one call at a time, in order, and keeps going after a failure', async () => {
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const outcomes: Record<string, SessionCommandOutcome> = {
      a: { outcome: 'ok' },
      b: { outcome: 'rejected', code: 'conflict', message: 'session is run by the autonomous engine' },
      c: { outcome: 'lost' },
      d: { outcome: 'rejected', code: 'not_connected', message: 'not connected' },
    };
    const results = await runAll(targets, async (id) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      order.push(id);
      await new Promise((r) => setTimeout(r, 1));
      running--;
      return outcomes[id]!;
    });
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    expect(maxRunning).toBe(1);
    expect(results.map((r) => [r.id, r.status, r.text])).toEqual([
      ['a', 'ok', null],
      ['b', 'refused', 'session is run by the autonomous engine'],
      ['c', 'lost', "We couldn't confirm it — check your Mac"],
      ['d', 'not-sent', 'Not sent — reconnecting'],
    ]);
    expect(runSummary('sleep', results)).toEqual({ allOk: false, title: 'Put to sleep: 1 of 4' });
    expect(runSummary('wake', results).title).toBe('Woke 1 of 4');
  });
  it('all ok is a toast only; a throwing call counts as lost', async () => {
    const ok = await runAll(targets.slice(0, 2), async () => ({ outcome: 'ok' }));
    expect(runSummary('sleep', ok)).toEqual({ allOk: true, title: 'Put to sleep' });
    expect(runSummary('wake', ok).allOk).toBe(true);
    const thrown = await runAll(targets.slice(0, 1), async () => {
      throw new Error('boom');
    });
    expect(thrown[0]?.status).toBe('lost');
  });
});

describe('roomToast', () => {
  it('done words, host text, lost', () => {
    expect(roomToast('archive', { outcome: 'ok' })).toBe('Archived');
    expect(roomToast('delete', { outcome: 'ok' })).toBe('Deleted');
    expect(roomToast('delete', { outcome: 'rejected', code: 'conflict', message: 'no' })).toBe('no');
    expect(roomToast('archive', { outcome: 'lost' })).toBe("We couldn't confirm it — check your Mac");
  });
});
