import { describe, expect, it, vi } from 'vitest';
import { createRemoteClient, sessionKey, type Clock, type Rpc } from '../src/index.js';
import { ref, textItem } from './fixtures.js';

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
const lost = () => Object.assign(new Error('lost'), { code: 'connection_lost' });
const R = ref('s-1');
const K = sessionKey(R);
const delta = (revision: number, upsert: unknown[] = [], removed: string[] = []) => ({ ref: R, revision, upsert, removed, mode: null });

function setup(handler: (method: string, params: unknown) => unknown = () => ({})) {
  const rpc: Rpc = { call: vi.fn(async (m: string, p?: unknown) => handler(m, p)) };
  const client = createRemoteClient({ rpc, clock });
  client.handleEvent('bridge.status', { host: 'online', epoch: 'e1' });
  const methods = () => (rpc.call as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
  return { rpc, client, methods };
}
const feedHandler = (revision = 5, items: unknown[] = [textItem('t1', 'hi')]) => (m: string) =>
  m === 'feed.snapshot' ? { items, revision, mode: null, schemaVersion: 1 } : m === 'consents.list' ? { items: [] } : {};

describe('лента сессии', () => {
  it('подписка, потом снимок; дельта r+1 применяется, старая отбрасывается', async () => {
    const { client, methods } = setup(feedHandler());
    client.setConnected(true);
    client.openFeed(R);
    await flush();
    expect(methods().filter((m) => m.startsWith('feed.'))).toEqual(['feed.subscribe', 'feed.snapshot']);
    expect(client.store.getState().feeds[K]).toMatchObject({ status: 'ready', revision: 5 });
    client.handleEvent('feed.changed', delta(6, [textItem('t2', 'two')]));
    client.handleEvent('feed.changed', delta(6, [textItem('t3', 'dup')]));
    client.handleEvent('feed.changed', delta(5, [textItem('t4', 'old')]));
    const feed = client.store.getState().feeds[K]!;
    expect(feed.items.map((i) => i.id)).toEqual(['t1', 't2']);
    expect(feed.revision).toBe(6);
  });

  it('дельта раньше снимка ждёт и ложится после него', async () => {
    let release: (v: unknown) => void = () => {};
    const { client } = setup((m) =>
      m === 'feed.snapshot' ? new Promise((r) => (release = r)) : m === 'consents.list' ? { items: [] } : {},
    );
    client.setConnected(true);
    client.openFeed(R);
    await flush();
    client.handleEvent('feed.changed', delta(6, [textItem('t2', 'two')]));
    expect(client.store.getState().feeds[K]!.items).toEqual([]);
    release({ items: [textItem('t1', 'hi')], revision: 5, mode: null });
    await flush();
    expect(client.store.getState().feeds[K]!.items.map((i) => i.id)).toEqual(['t1', 't2']);
  });

  it('пропуск ревизии → новый снимок', async () => {
    let revision = 5;
    const { client, methods } = setup((m) => (m === 'feed.snapshot' ? { items: [textItem('t1', 'hi')], revision, mode: null } : {}));
    client.setConnected(true);
    client.openFeed(R);
    await flush();
    revision = 8;
    client.handleEvent('feed.changed', delta(8, [textItem('t9', 'x')]));
    await flush();
    expect(methods().filter((m) => m === 'feed.snapshot')).toHaveLength(2);
    expect(client.store.getState().feeds[K]!.status).toBe('ready');
  });

  it('новая эпоха — новый снимок без повторной подписки; закрытие экрана — отписка', async () => {
    const { client, methods } = setup(feedHandler());
    client.setConnected(true);
    const close = client.openFeed(R);
    await flush();
    client.handleEvent('bridge.status', { host: 'online', epoch: 'e2' });
    await flush();
    expect(methods().filter((m) => m === 'feed.snapshot')).toHaveLength(2);
    expect(methods().filter((m) => m === 'feed.subscribe')).toHaveLength(1);
    close();
    await flush();
    expect(methods()).toContain('feed.unsubscribe');
    expect(client.store.getState().feeds[K]).toBeUndefined();
  });

  it('фон снимает подписку, возврат подписывает и читает снимок заново; потеря соединения тоже', async () => {
    const { client, methods } = setup(feedHandler());
    client.setConnected(true);
    client.openFeed(R);
    await flush();
    client.setForeground(false);
    await flush();
    expect(methods()).toContain('feed.unsubscribe');
    client.setForeground(true);
    await flush();
    expect(methods().filter((m) => m === 'feed.subscribe')).toHaveLength(2);
    expect(methods().filter((m) => m === 'feed.snapshot')).toHaveLength(2);
  });

  it('два экрана одной сессии — одна подписка, отписка при последнем закрытии', async () => {
    const { client, methods } = setup(feedHandler());
    client.setConnected(true);
    const a = client.openFeed(R);
    const b = client.openFeed(R);
    await flush();
    expect(methods().filter((m) => m === 'feed.subscribe')).toHaveLength(1);
    a();
    await flush();
    expect(methods()).not.toContain('feed.unsubscribe');
    b();
    await flush();
    expect(methods()).toContain('feed.unsubscribe');
  });

  it('ошибка снимка → error; reloadFeed читает снова', async () => {
    let fail = true;
    const { client } = setup((m) => {
      if (m === 'feed.snapshot') {
        if (fail) throw new Error('boom');
        return { items: [], revision: 1, mode: null };
      }
      return m === 'consents.list' ? { items: [] } : {};
    });
    client.setConnected(true);
    client.openFeed(R);
    await flush();
    expect(client.store.getState().feeds[K]!.status).toBe('error');
    fail = false;
    client.live.reloadFeed(R);
    await flush();
    expect(client.store.getState().feeds[K]!.status).toBe('ready');
  });
});

describe('sendMessage', () => {
  it('pty.send с clientMsgId; повтор после lost идёт с тем же ключом', async () => {
    let n = 0;
    const { client, rpc } = setup((m) => {
      if (m === 'pty.send' && n++ === 0) throw lost();
      return { inserted: true, submitted: true, reason: null };
    });
    const first = await client.sendMessage({ ref: R, text: 'go' });
    expect(first.outcome).toBe('lost');
    const again = await client.sendMessage({ ref: R, text: 'go', clientMsgId: first.clientMsgId });
    expect(again).toMatchObject({ outcome: 'sent', submitted: true, clientMsgId: first.clientMsgId });
    const sends = (rpc.call as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 'pty.send').map((c) => c[1] as Record<string, unknown>);
    expect(sends).toHaveLength(2);
    expect(sends[0]!.clientMsgId).toBe(sends[1]!.clientMsgId);
    expect(sends[0]).toMatchObject({ ref: R, text: 'go', submit: true });
    expect(first.clientMsgId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('параллельная отправка с тем же ключом — один вызов; отказ несёт код', async () => {
    const { client, rpc } = setup(() => ({ inserted: true, submitted: true }));
    const [a, b] = await Promise.all([
      client.sendMessage({ ref: R, text: 'x', clientMsgId: 'same-key-1' }),
      client.sendMessage({ ref: R, text: 'x', clientMsgId: 'same-key-1' }),
    ]);
    expect(a).toEqual(b);
    expect((rpc.call as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 'pty.send')).toHaveLength(1);
    const { client: c2 } = setup(() => {
      throw Object.assign(new Error('off'), { code: 'unknown_method' });
    });
    expect(await c2.sendMessage({ ref: R, text: 'x' })).toMatchObject({ outcome: 'rejected', code: 'unknown_method' });
  });
});

describe('согласия', () => {
  const card = (id: string) => ({ id, kind: 'folder-trust', state: 'pending' }) as never;

  it('consents.list при готовом соединении и consents.changed', async () => {
    const { client } = setup((m) => (m === 'consents.list' ? { items: [card('c1')] } : {}));
    client.setConnected(true);
    await flush();
    expect(client.store.getState().consents.items.map((c) => c.id)).toEqual(['c1']);
    client.handleEvent('consents.changed', { upsert: [card('c2')], removed: ['c1'] });
    expect(client.store.getState().consents.items.map((c) => c.id)).toEqual(['c2']);
  });

  it('новая эпоха перечитывает список', async () => {
    const { client, methods } = setup((m) => (m === 'consents.list' ? { items: [] } : {}));
    client.setConnected(true);
    await flush();
    client.handleEvent('bridge.status', { host: 'online', epoch: 'e2' });
    await flush();
    expect(methods().filter((m) => m === 'consents.list')).toHaveLength(2);
  });

  it('decideConsent: applied убирает карточку; lost — итог по перечитанному списку', async () => {
    let decideFails = false;
    const { client } = setup((m) => {
      if (m === 'consents.list') return { items: [card('c1')] };
      if (m === 'consents.decide') {
        if (decideFails) throw lost();
        return { applied: true, state: 'allowed' };
      }
      return {};
    });
    client.setConnected(true);
    await flush();
    expect(await client.decideConsent('c1', 'allow')).toEqual({ outcome: 'applied' });
    expect(client.store.getState().consents.items).toEqual([]);
    decideFails = true;
    expect(await client.decideConsent('c1', 'deny')).toEqual({ outcome: 'lost', stillPending: true });
  });
});

describe('повторы подписки', () => {
  const refuse = (code: string) => (m: string) => {
    if (m === 'feed.subscribe') throw Object.assign(new Error(code), { code });
    return m === 'consents.list' ? { items: [] } : {};
  };
  const subscribes = (rpc: Rpc) => (rpc.call as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 'feed.subscribe').length;

  it('unknown_method: один вызов, состояние error, без повторов; Try again вызывает снова', async () => {
    vi.useFakeTimers();
    try {
      const { client, rpc } = setup(refuse('unknown_method'));
      client.setConnected(true);
      client.openFeed(R);
      await flush();
      expect(subscribes(rpc)).toBe(1);
      expect(client.store.getState().feeds[K]!.status).toBe('error');
      // переподключения и время ничего не повторяют
      client.setConnected(false);
      client.setConnected(true);
      await vi.advanceTimersByTimeAsync(120_000);
      await flush();
      expect(subscribes(rpc)).toBe(1);
      expect(client.store.getState().feeds[K]!.status).toBe('error');
      client.live.reloadFeed(R);
      await flush();
      expect(subscribes(rpc)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('временная ошибка: 1 с, 2 с, 5 с, 10 с, потолок 30 с; один вызов за раз', async () => {
    vi.useFakeTimers();
    try {
      const { client, rpc } = setup(refuse('connection_lost'));
      client.setConnected(true);
      client.openFeed(R);
      client.openFeed(R); // второй экран той же сессии — не второй вызов
      await flush();
      expect(subscribes(rpc)).toBe(1);
      let calls = 1;
      for (const wait of [1000, 2000, 5000, 10_000, 30_000, 30_000]) {
        await vi.advanceTimersByTimeAsync(wait - 1);
        await flush();
        expect(subscribes(rpc), `до ${wait}`).toBe(calls);
        await vi.advanceTimersByTimeAsync(1);
        await flush();
        calls++;
        expect(subscribes(rpc), `после ${wait}`).toBe(calls);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('закрытие экрана останавливает повтор; успех сбрасывает счёт', async () => {
    vi.useFakeTimers();
    try {
      let fail = true;
      const { client, rpc } = setup((m) => {
        if (m === 'feed.subscribe' && fail) throw Object.assign(new Error('x'), { code: 'timeout' });
        return m === 'feed.snapshot' ? { items: [], revision: 1, mode: null } : m === 'consents.list' ? { items: [] } : {};
      });
      client.setConnected(true);
      const close = client.openFeed(R);
      await flush();
      close();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(subscribes(rpc)).toBe(1);
      fail = false;
      client.openFeed(R);
      await flush();
      expect(client.store.getState().feeds[K]!.status).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hello моста', () => {
  it('нет feed.subscribe или consents.list в hello — вызовов нет, лента в error', async () => {
    const { client, rpc, methods } = setup(feedHandler());
    client.setBridgeMethods(['works.list', 'host.info']);
    client.setConnected(true);
    client.openFeed(R);
    await flush();
    expect(methods().filter((m) => m === 'feed.subscribe' || m === 'consents.list')).toEqual([]);
    expect(client.store.getState().feeds[K]!.status).toBe('error');
    expect(rpc.call).not.toHaveBeenCalled();
  });

  it('hello пришёл позже подключения: consents.list уходит после него', async () => {
    const { client, methods } = setup(feedHandler());
    client.setBridgeMethods(null);
    client.setConnected(true);
    await flush();
    client.setBridgeMethods(['consents.list', 'feed.subscribe', 'feed.snapshot']);
    await flush();
    expect(methods()).toContain('consents.list');
  });
});

describe('resumeSession', () => {
  it('sessions.resume {ref}: ok; отказ несёт код и текст; connection_lost — lost, без повтора', async () => {
    const { client, rpc } = setup(() => ({}));
    expect(await client.resumeSession(R)).toEqual({ outcome: 'ok' });
    expect(rpc.call).toHaveBeenCalledWith('sessions.resume', { ref: R });
    const { client: c2 } = setup(() => {
      throw Object.assign(new Error('Archived work'), { code: 'conflict' });
    });
    expect(await c2.resumeSession(R)).toEqual({ outcome: 'rejected', code: 'conflict', message: 'Archived work' });
    const { client: c3, rpc: r3 } = setup(() => {
      throw lost();
    });
    expect(await c3.resumeSession(R)).toEqual({ outcome: 'lost' });
    expect((r3.call as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 'sessions.resume')).toHaveLength(1);
  });
});
