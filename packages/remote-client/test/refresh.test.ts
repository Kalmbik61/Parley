import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PARALLEL_READS, createRemoteClient, sessionKey, type Clock, type RemoteClient, type Rpc, type SessionRef } from '../src/index.js';
import { activityItem, live, permissionCard, ref, session, snap, textItem, work } from './fixtures.js';

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (h) => clearTimeout(h as never),
  setInterval: (f, ms) => setInterval(f, ms),
  clearInterval: (h) => clearInterval(h as never),
};

interface Call {
  at: number;
  sessionId: string;
}

/** Хост-заглушка: `feed.snapshot` отдаёт то, что лежит в `feeds`; каждый вызов записывается. */
function setup(ids: string[], blocked: string[] = ids) {
  const feeds = new Map<string, unknown[]>();
  const calls: Call[] = [];
  const rpc: Rpc = {
    call: async (method, params) => {
      if (method !== 'feed.snapshot') throw new Error(`unexpected ${method}`);
      const r = (params as { ref: SessionRef }).ref;
      calls.push({ at: Date.now(), sessionId: r.sessionId });
      return { items: feeds.get(r.sessionId) ?? [] };
    },
  };
  const client = createRemoteClient({ rpc, clock });
  client.handleEvent('bridge.status', { host: 'online', epoch: 'e1' });
  client.handleEvent('works.changed', snap(1, [work('w-1', { sessions: ids.map((id) => session(id)) })]));
  client.handleEvent('activity.snapshot', {
    epoch: 'e1',
    items: ids.map((id) => activityItem(ref(id), blocked.includes(id) ? 'blocked' : 'working')),
  });
  client.refresher.setConnected(true);
  return { client, feeds, calls };
}

const readsOf = (calls: Call[], id: string): number => calls.filter((c) => c.sessionId === id).length;
const since = (calls: Call[], from: number): Call[] => calls.filter((c) => c.at >= from);

describe('перечитывание карточек (§10.3)', () => {
  let client: RemoteClient | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    client?.dispose();
    vi.useRealTimers();
  });

  it('карточка пропала в ответе → «answered elsewhere», затем её убирают', async () => {
    const t = setup(['s-1']);
    client = t.client;
    t.feeds.set('s-1', [permissionCard('c-1', 'ls')]);
    client.refresher.setScreen({ kind: 'session', ref: ref('s-1') });
    await vi.advanceTimersByTimeAsync(0);
    expect(Object.values(client.store.getState().cards)[0]?.cards).toHaveLength(1);
    t.feeds.set('s-1', []);
    await vi.advanceTimersByTimeAsync(3000);
    const state = client.store.getState();
    expect(Object.values(state.cards)[0]?.cards).toEqual([]);
    const [gone] = Object.entries(state.gone);
    expect(gone?.[1].cardId).toBe('c-1');
    client.store.dispatch({ t: 'gone.dismiss', key: gone![0] });
    expect(client.store.getState().gone).toEqual({});
  });

  it('новая карточка той же сессии видна через ≤ 3 с без переподключения', async () => {
    const t = setup(['s-1']);
    client = t.client;
    t.feeds.set('s-1', [permissionCard('c-1', 'ls')]);
    client.refresher.setScreen({ kind: 'session', ref: ref('s-1') });
    await vi.advanceTimersByTimeAsync(0);
    t.feeds.set('s-1', [permissionCard('c-1', 'ls'), permissionCard('c-2', 'pwd')]);
    await vi.advanceTimersByTimeAsync(2999);
    expect(Object.values(client.store.getState().cards)[0]?.cards).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(Object.values(client.store.getState().cards)[0]?.cards.map((c) => c.cardId)).toEqual(['c-1', 'c-2']);
  });

  it('экран сессии в working: новый ответ модели виден через ≤ 3 с', async () => {
    const t = setup(['s-1'], []);
    client = t.client;
    t.feeds.set('s-1', [textItem('t-1', 'first')]);
    client.refresher.setScreen({ kind: 'session', ref: ref('s-1') });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.store.getState().cards[sessionKey(ref('s-1'))]?.lastReply?.text).toBe('first');
    t.feeds.set('s-1', [textItem('t-1', 'first'), textItem('t-2', 'second')]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(client.store.getState().cards[sessionKey(ref('s-1'))]?.lastReply?.text).toBe('second');
  });

  it('30 ждущих, 9 видимых: каждая невидимая перечитана за ≤ 30 с, видимые — каждые 10 с, ≤ 20 запросов за тик', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `s-${String(i + 1).padStart(2, '0')}`);
    const t = setup(ids);
    client = t.client;
    const visible = ids.slice(0, 9);
    const invisible = ids.slice(9);
    const start = Date.now();
    client.refresher.setScreen({ kind: 'inbox', visible: visible.map((id) => ref(id)) });
    await vi.advanceTimersByTimeAsync(29_999);
    for (const id of invisible) expect(readsOf(t.calls, id), id).toBeGreaterThanOrEqual(1);
    for (const id of visible) expect(readsOf(t.calls, id), id).toBeGreaterThanOrEqual(3);
    for (let k = 0; k < 3; k++) {
      const window = t.calls.filter((c) => c.at >= start + k * 10_000 && c.at < start + (k + 1) * 10_000);
      expect(window.length).toBeLessThanOrEqual(20);
    }
    // Круг идёт от самой давней: пока не прочитаны все 21 (тики 0, 10, 20 с), повторов нет, потом остаток бюджета берут самые давние.
    const firstThree = t.calls.filter((c) => c.at < start + 20_000 && invisible.includes(c.sessionId));
    expect(new Set(firstThree.map((c) => c.sessionId)).size).toBe(20);
    expect(firstThree).toHaveLength(20);
  });

  it('10 постоянно видимых и 5 невидимых: невидимые перечитываются каждые 10 с', async () => {
    const ids = Array.from({ length: 15 }, (_, i) => `s-${String(i + 1).padStart(2, '0')}`);
    const t = setup(ids);
    client = t.client;
    client.refresher.setScreen({ kind: 'inbox', visible: ids.slice(0, 10).map((id) => ref(id)) });
    await vi.advanceTimersByTimeAsync(25_000);
    for (const id of ids.slice(10)) expect(readsOf(t.calls, id), id).toBe(3); // t = 0, 10, 20
    for (const id of ids.slice(0, 10)) expect(readsOf(t.calls, id), id).toBe(3);
  });

  it('видимых больше 10: сверх бюджета их берёт круг', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `s-${String(i + 1).padStart(2, '0')}`);
    const t = setup(ids);
    client = t.client;
    client.refresher.setScreen({ kind: 'inbox', visible: ids.map((id) => ref(id)) });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toHaveLength(12); // 10 видимых + 2 из круга
    expect(new Set(t.calls.map((c) => c.sessionId)).size).toBe(12);
  });

  it('в background запросов нет; на возврат — перечитывание', async () => {
    const t = setup(['s-1']);
    client = t.client;
    client.refresher.setScreen({ kind: 'session', ref: ref('s-1') });
    await vi.advanceTimersByTimeAsync(0);
    client.refresher.setForeground(false);
    const before = t.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    client.refresher.request(ref('s-1'));
    client.handleEvent('activity.changed', { ref: ref('s-1'), activity: live('idle'), metrics: null });
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.calls).toHaveLength(before);
    client.refresher.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toHaveLength(before + 1);
  });

  it('без соединения запросов нет', async () => {
    const t = setup(['s-1']);
    client = t.client;
    client.refresher.setConnected(false);
    client.refresher.setScreen({ kind: 'session', ref: ref('s-1') });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.calls).toHaveLength(0);
  });

  it('две причины в пределах 300 мс — один запрос', async () => {
    const t = setup(['s-1']);
    client = t.client;
    client.refresher.request(ref('s-1'));
    await vi.advanceTimersByTimeAsync(100);
    client.refresher.request(ref('s-1'));
    await vi.advanceTimersByTimeAsync(150);
    expect(t.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(t.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.calls).toHaveLength(1);
  });

  it('activity.changed сессии на экране перечитывает её со склейкой; чужая сессия — нет', async () => {
    const t = setup(['s-1', 's-2'], []);
    client = t.client;
    client.refresher.setScreen({ kind: 'session', ref: ref('s-1') });
    await vi.advanceTimersByTimeAsync(0);
    const base = t.calls.length;
    client.handleEvent('activity.changed', { ref: ref('s-2'), activity: live('blocked'), metrics: null });
    client.handleEvent('activity.changed', { ref: ref('s-1'), activity: live('blocked'), metrics: null });
    client.handleEvent('activity.changed', { ref: ref('s-1'), activity: live('working'), metrics: null });
    await vi.advanceTimersByTimeAsync(299);
    expect(t.calls).toHaveLength(base);
    await vi.advanceTimersByTimeAsync(1);
    expect(since(t.calls, Date.now())).toHaveLength(1);
    expect(t.calls.slice(base).map((c) => c.sessionId)).toEqual(['s-1']);
  });

  it('одна заявка на сессию: пока запрос в пути, второй не уходит, а после ответа догоняет один', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const rpc: Rpc = {
      call: async () => {
        n++;
        if (n === 1) await gate;
        return { items: [] };
      },
    };
    client = createRemoteClient({ rpc, clock });
    client.handleEvent('bridge.status', { host: 'online', epoch: 'e1' });
    client.refresher.setConnected(true);
    client.refresher.setScreen({ kind: 'session', ref: ref('s-1') });
    await vi.advanceTimersByTimeAsync(9000); // три тика таймера при зависшем первом запросе
    expect(n).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(2);
  });

  it('никогда не больше MAX_PARALLEL_READS запросов в полёте: Inbox с 30 ждущими не упирается в предел моста (16)', async () => {
    let inFlight = 0;
    let peak = 0;
    const rpc: Rpc = {
      call: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 50));
        inFlight--;
        return { items: [] };
      },
    };
    client = createRemoteClient({ rpc, clock });
    const ids = Array.from({ length: 30 }, (_, i) => `s-${String(i + 1).padStart(2, '0')}`);
    client.handleEvent('bridge.status', { host: 'online', epoch: 'e1' });
    client.handleEvent('works.changed', snap(1, [work('w-1', { sessions: ids.map((id) => session(id)) })]));
    client.handleEvent('activity.snapshot', { epoch: 'e1', items: ids.map((id) => activityItem(ref(id), 'blocked')) });
    client.refresher.setConnected(true);
    client.refresher.setScreen({ kind: 'inbox', visible: ids.slice(0, 9).map((id) => ref(id)) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(peak).toBeLessThanOrEqual(MAX_PARALLEL_READS);
    // Очередь не теряет заявки: за тик прочитаны все 19 (9 видимых + круг из 10).
    const loaded = Object.values(client.store.getState().cards).length;
    expect(loaded).toBe(19);
  });
});
