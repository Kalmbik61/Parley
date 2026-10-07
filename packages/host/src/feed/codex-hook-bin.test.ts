import { describe, expect, it, vi } from 'vitest';
import { runCodexHook } from './codex-hook-bin.js';

const ENV = { PARLEY_HOOK_URL: 'http://127.0.0.1:5555/hooks', PARLEY_HOOK_TOKEN: 'tok', PARLEY_SESSION_ID: 's-01' };

describe('runCodexHook', () => {
  it('шлёт stdin в приёмник с токеном и сессией, печатает ответ', async () => {
    const answer = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }));
    const out = await runCodexHook('{"hook_event_name":"PermissionRequest"}', ENV, fetchImpl as unknown as typeof fetch);
    expect(JSON.parse(out)).toEqual(answer);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENV.PARLEY_HOOK_URL);
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok', 'x-parley-session': 's-01', 'content-type': 'application/json' });
  });
  it('пустой ответ {} — молчать', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(await runCodexHook('{}', ENV, fetchImpl as unknown as typeof fetch)).toBe('');
  });
  it('хост недоступен, не 200 или нет окружения — молчать (Codex покажет своё окно)', async () => {
    const failing = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await runCodexHook('{}', ENV, failing as unknown as typeof fetch)).toBe('');
    const denied = vi.fn(async () => new Response('no', { status: 401 }));
    expect(await runCodexHook('{}', ENV, denied as unknown as typeof fetch)).toBe('');
    expect(await runCodexHook('{}', {}, failing as unknown as typeof fetch)).toBe('');
  });
});
