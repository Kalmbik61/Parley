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
