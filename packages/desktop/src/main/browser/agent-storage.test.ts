import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { AGENT_LIMITS } from '@parley/protocol';
import { HTTPONLY_HIDDEN, createAgentStorage } from './agent-storage.js';

let contents: WebContents;

function setup(options: { url: string; items?: Array<[string, string] | string[]> }) {
  contents = { id: 7, getURL: () => options.url } as unknown as WebContents;
  const cookies = { get: vi.fn(async () => []), set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) };
  const send = vi.fn(async (_id: number, method: string) => (method === 'DOMStorage.getDOMStorageItems' ? { entries: options.items ?? [] } : {}));
  const inspector = { send };
  const storage = createAgentStorage({ cookies, inspector } as unknown as Parameters<typeof createAgentStorage>[0]);
  return { storage, cookies, inspector };
}

describe('куки текущей страницы агента (Фокус ревью 4)', () => {
  it('list — cookies.get({ url: адрес страницы }); значения скрыты; values: true — показаны, кроме httpOnly (решение владельца 6)', async () => {
    const { storage, cookies } = setup({ url: 'https://shop.example.test/cart?x=1' });
    cookies.get.mockResolvedValue([
      { name: 'sid', value: 'S3CR3T', domain: '.example.test', path: '/', secure: true, httpOnly: true, sameSite: 'lax', session: true },
      { name: 'theme', value: 'dark', domain: 'shop.example.test', path: '/', secure: false, httpOnly: false, sameSite: 'lax', session: true },
    ] as never);
    const hidden = await storage.cookiesOf(contents, 't1', { tab: 't1', action: 'list' });
    expect(cookies.get).toHaveBeenCalledWith({ url: 'https://shop.example.test/cart?x=1' });
    expect(hidden).toMatchObject({ cookies: [{ name: 'sid', domain: '.example.test', httpOnly: true, session: true, expires: null, size: 9 }, { name: 'theme' }] });
    expect(JSON.stringify(hidden)).not.toContain('S3CR3T');
    expect(JSON.stringify(hidden)).not.toContain('dark');
    const shown = await storage.cookiesOf(contents, 't1', { tab: 't1', action: 'list', values: true });
    if (!('cookies' in shown)) throw new Error('list');
    expect(shown.cookies.find((c) => c.name === 'theme')?.value).toBe('dark');
    expect(shown.cookies.find((c) => c.name === 'sid')?.value).toBe(HTTPONLY_HIDDEN);
    expect(JSON.stringify(shown)).not.toContain('S3CR3T');
  });

  it('set и delete httpOnly-имени — можно (решение владельца 6)', async () => {
    const { storage, cookies } = setup({ url: 'https://shop.example.test/cart' });
    await storage.cookiesOf(contents, 't1', { tab: 't1', action: 'set', name: 'sid', value: 'new', httpOnly: true });
    expect(cookies.set).toHaveBeenCalledWith(expect.objectContaining({ name: 'sid', httpOnly: true }));
    await storage.cookiesOf(contents, 't1', { tab: 't1', action: 'delete', name: 'sid' });
    expect(cookies.remove).toHaveBeenCalledWith('https://shop.example.test/cart', 'sid');
  });

  it('set — host-only кука адреса страницы; delete — remove(url, name); страница не http(s) — bad_request', async () => {
    const { storage, cookies } = setup({ url: 'http://localhost:5173/a' });
    await storage.cookiesOf(contents, 't1', { tab: 't1', action: 'set', name: 'theme', value: 'dark', sameSite: 'strict', expires: 1_900_000_000 });
    expect(cookies.set).toHaveBeenCalledWith({ url: 'http://localhost:5173/a', name: 'theme', value: 'dark', sameSite: 'strict', expirationDate: 1_900_000_000 });
    expect(cookies.set.mock.calls[0]?.[0]).not.toHaveProperty('domain');
    await storage.cookiesOf(contents, 't1', { tab: 't1', action: 'delete', name: 'theme' });
    expect(cookies.remove).toHaveBeenCalledWith('http://localhost:5173/a', 'theme');
    const blank = setup({ url: 'about:blank' });
    await expect(blank.storage.cookiesOf(contents, 't1', { tab: 't1', action: 'list' })).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('localStorage и sessionStorage origin страницы', () => {
  it('list — getDOMStorageItems по origin; значения в списке — превью с маской; не больше listEntries', async () => {
    const { storage, inspector } = setup({
      url: 'https://app.example.test/x',
      items: [['theme', 'dark'], ['access_token', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln'], ...Array.from({ length: 150 }, (_, i) => [`k${i}`, 'v'])],
    });
    const result = await storage.storageOf(contents, 't1', { tab: 't1', area: 'local', action: 'list' });
    expect(inspector.send).toHaveBeenCalledWith(7, 'DOMStorage.getDOMStorageItems', { storageId: { securityOrigin: 'https://app.example.test', isLocalStorage: true } });
    expect(result).toMatchObject({ origin: 'https://app.example.test', area: 'local', total: 152 });
    if (!('entries' in result)) throw new Error('list');
    expect(result.entries).toHaveLength(AGENT_LIMITS.listEntries);
    expect(result.entries[1]).toMatchObject({ key: 'access_token', value: '<redacted>' });
  });

  it('get — значение как есть до storageValue; set, delete, clear — свои методы; sessionStorage — isLocalStorage false', async () => {
    const { storage, inspector } = setup({ url: 'https://app.example.test/x', items: [['token', 'abc']] });
    expect(await storage.storageOf(contents, 't1', { tab: 't1', area: 'session', action: 'get', key: 'token' })).toMatchObject({ key: 'token', value: 'abc', truncated: false });
    await storage.storageOf(contents, 't1', { tab: 't1', area: 'local', action: 'set', key: 'theme', value: 'dark' });
    expect(inspector.send).toHaveBeenCalledWith(7, 'DOMStorage.setDOMStorageItem', { storageId: { securityOrigin: 'https://app.example.test', isLocalStorage: true }, key: 'theme', value: 'dark' });
    await storage.storageOf(contents, 't1', { tab: 't1', area: 'local', action: 'clear' });
    expect(inspector.send).toHaveBeenCalledWith(7, 'DOMStorage.clear', { storageId: { securityOrigin: 'https://app.example.test', isLocalStorage: true } });
    expect(inspector.send.mock.calls.some(([, , params]) => (params as { storageId?: { isLocalStorage: boolean } })?.storageId?.isLocalStorage === false)).toBe(true);
  });
});
