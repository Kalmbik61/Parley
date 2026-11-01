import { describe, expect, it, vi } from 'vitest';
import { createRemoteClient, type Clock, type Rpc } from '../src/index.js';
import { PROJECT, permissionCard, proposal, ref, room, session, snap, textItem, work } from './fixtures.js';

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (h) => clearTimeout(h as never),
  setInterval: (f, ms) => setInterval(f, ms),
  clearInterval: (h) => clearInterval(h as never),
};

const lostError = () => Object.assign(new Error('lost'), { code: 'connection_lost' });

function setup(handler: (method: string, params: unknown) => Promise<unknown>) {
  const rpc: Rpc = { call: vi.fn(handler) };
  const client = createRemoteClient({ rpc, clock });
  client.handleEvent('bridge.status', { host: 'online', epoch: 'e1' });
  client.handleEvent('works.changed', snap(1, [work('w-1', { sessions: [session('s-1')], rooms: [room('r-1', { proposal: proposal('p-1', 1, 'old text') })] })]));
  client.store.dispatch({ t: 'cards.loaded', ref: ref('s-1'), epoch: 'e1', at: 1, items: [permissionCard('c-1', 'ls')] });
  return { rpc, client };
}

const allow = { kind: 'permission', behavior: 'allow' } as const;
const resolveParams = { projectPath: PROJECT, workId: 'w-1', roomId: 'r-1', proposalId: 'p-1', rev: 1, action: 'accept' } as const;

describe('decide', () => {
  it('applied: карточка уходит без «answered elsewhere»', async () => {
    const { client } = setup(async () => ({ applied: true, state: 'allowed' }));
    expect(await client.decide(ref('s-1'), 'c-1', allow)).toEqual({ outcome: 'applied' });
    const s = client.store.getState();
    expect(Object.values(s.cards)[0]?.cards).toEqual([]);
    expect(s.gone).toEqual({});
  });

  it('applied:false → stale, лента перечитана и карточка ушла', async () => {
    const { client, rpc } = setup(async (method) => (method === 'feed.decide' ? { applied: false, state: 'allowed' } : { items: [] }));
    expect(await client.decide(ref('s-1'), 'c-1', allow)).toEqual({ outcome: 'stale' });
    expect(rpc.call).toHaveBeenCalledWith('feed.snapshot', { ref: ref('s-1'), scope: 'attention' });
    expect(Object.values(client.store.getState().cards)[0]?.cards).toEqual([]);
  });

  it('lost после connection_lost: вызов не повторяется, итог — по feed.snapshot (карточка ещё ждёт / ушла)', async () => {
    let items = [permissionCard('c-1', 'ls')];
    const { client, rpc } = setup(async (method) => {
      if (method === 'feed.decide') throw lostError();
      return { items };
    });
    expect(await client.decide(ref('s-1'), 'c-1', allow)).toEqual({ outcome: 'lost', stillPending: true });
    items = [];
    expect(await client.decide(ref('s-1'), 'c-1', allow)).toEqual({ outcome: 'lost', stillPending: false });
    const decides = (rpc.call as ReturnType<typeof vi.fn>).mock.calls.filter(([m]) => m === 'feed.decide');
    expect(decides).toHaveLength(2); // по одному на каждый вызов человека, без автоповтора
  });

  it('lost, когда ответ пришёл уже в другой эпохе; перечитывание — в новой', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { client } = setup(async (method) => {
      if (method === 'feed.decide') {
        await gate;
        return { applied: true, state: 'allowed' };
      }
      return { items: [] };
    });
    const pending = client.decide(ref('s-1'), 'c-1', allow);
    client.handleEvent('bridge.status', { host: 'online', epoch: 'e2' });
    release();
    expect(await pending).toEqual({ outcome: 'lost', stillPending: false });
    expect(client.store.getState().epoch).toBe('e2');
  });

  it('если перечитать не удалось — lost с stillPending:null', async () => {
    const { client } = setup(async () => {
      throw lostError();
    });
    expect(await client.decide(ref('s-1'), 'c-1', allow)).toEqual({ outcome: 'lost', stillPending: null });
  });

  it('прочие ошибки хоста пробрасываются', async () => {
    const { client } = setup(async () => {
      throw Object.assign(new Error('x'), { code: 'internal' });
    });
    await expect(client.decide(ref('s-1'), 'c-1', allow)).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('resolveProposal', () => {
  it('applied', async () => {
    const { client } = setup(async () => ({ messageId: 'm-1' }));
    expect(await client.resolveProposal(resolveParams)).toEqual({ outcome: 'applied' });
  });

  it('conflict: новый текст решения берётся из снимка (works.list вернул проекцию)', async () => {
    const fresh = snap(2, [work('w-1', { sessions: [session('s-1')], rooms: [room('r-1', { proposal: proposal('p-1', 2, 'new text') })] })]);
    const { client } = setup(async (method) => {
      if (method === 'rooms.resolveProposal') throw Object.assign(new Error('revised'), { code: 'conflict' });
      return fresh;
    });
    const res = await client.resolveProposal(resolveParams);
    expect(res).toEqual({ outcome: 'conflict', proposal: expect.objectContaining({ rev: 2, text: 'new text' }) });
  });

  it('conflict: works.list вернул не проекцию — берётся то, что уже в сторе (пришло works.changed)', async () => {
    const { client } = setup(async (method) => {
      if (method === 'rooms.resolveProposal') throw Object.assign(new Error('revised'), { code: 'conflict' });
      return { entries: [] };
    });
    client.handleEvent('works.changed', snap(3, [work('w-1', { rooms: [room('r-1', { proposal: proposal('p-1', 3, 'from event') })] })]));
    const res = await client.resolveProposal(resolveParams);
    expect(res.outcome === 'conflict' && res.proposal?.text).toBe('from event');
  });

  it('lost: после connection_lost снимок говорит, что решение уже не то (stillPending false)', async () => {
    const fresh = snap(2, [work('w-1', { rooms: [room('r-1', { proposal: null })] })]);
    const { client } = setup(async (method) => {
      if (method === 'rooms.resolveProposal') throw lostError();
      return fresh;
    });
    expect(await client.resolveProposal(resolveParams)).toEqual({ outcome: 'lost', stillPending: false });
  });
});

describe('readCards', () => {
  it('ответ прошлой эпохи не применяется', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { client } = setup(async () => {
      await gate;
      return { items: [textItem('t-1', 'hello')] };
    });
    const p = client.readCards(ref('s-1'));
    client.handleEvent('bridge.status', { host: 'online', epoch: 'e2' });
    release();
    expect((await p).ok).toBe(false);
    expect(client.store.getState().cards).toEqual({});
  });
});

describe('wave 3: timeout and stale reads', () => {
  it('W1: timeout on feed.decide is a lost answer: re-read, lost with stillPending, no throw', async () => {
    const { client } = setup(async (method) => {
      if (method === 'feed.decide') throw Object.assign(new Error('t'), { code: 'timeout' });
      return { items: [permissionCard('c-1', 'ls')] };
    });
    expect(await client.decide(ref('s-1'), 'c-1', allow)).toEqual({ outcome: 'lost', stillPending: true });
  });

  it('W1: timeout on rooms.resolveProposal is lost, not a throw', async () => {
    const { client } = setup(async (method) => {
      if (method === 'rooms.resolveProposal') throw Object.assign(new Error('t'), { code: 'timeout' });
      return snap(2, [work('w-1', { rooms: [room('r-1', { proposal: null })] })]);
    });
    expect(await client.resolveProposal(resolveParams)).toEqual({ outcome: 'lost', stillPending: false });
  });

  it('W2: a feed.snapshot read started before the phone decision does not resurrect the card nor mark it gone', async () => {
    let releaseRead!: () => void;
    const gate = new Promise<void>((r) => (releaseRead = r));
    let first = true;
    const { client } = setup(async (method) => {
      if (method === 'feed.snapshot' && first) {
        first = false;
        await gate;
        return { items: [permissionCard('c-1', 'ls')] };
      }
      if (method === 'feed.decide') return { applied: true, state: 'allowed' };
      return { items: [] };
    });
    vi.useFakeTimers();
    try {
      const stale = client.readCards(ref('s-1')); // начато до решения
      await vi.advanceTimersByTimeAsync(5);
      await client.decide(ref('s-1'), 'c-1', allow);
      releaseRead();
      await stale;
      let s = client.store.getState();
      expect(Object.values(s.cards)[0]?.cards).toEqual([]);
      await vi.advanceTimersByTimeAsync(5);
      await client.readCards(ref('s-1')); // чтение позже решения: карточки нет, метки нет
      s = client.store.getState();
      expect(s.gone).toEqual({});
      expect(s.resolved).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });
});
