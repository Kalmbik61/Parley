import { describe, expect, it, vi } from 'vitest';
import type { RequestInfo } from '../context.js';
import { HostError } from '../errors.js';
import type { TelegramService } from '../telegram/service.js';
import { createTelegramHandlers } from './telegram.js';

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const request = {} as RequestInfo;
const STATUS = {
  enabled: true,
  token: 'set',
  botUsername: 'parley_bot',
  hint: '••••AAAA',
  owner: null,
  pendingLink: null,
  polling: 'ok',
  error: null,
  lastUpdateAt: null,
} as const;

const fakeService = (): { [K in keyof TelegramService]: ReturnType<typeof vi.fn> } => ({
  start: vi.fn(),
  stop: vi.fn(),
  status: vi.fn(() => STATUS),
  setToken: vi.fn(async () => ({ botUsername: 'parley_bot', hint: '••••AAAA' })),
  clearToken: vi.fn(async () => undefined),
  link: vi.fn(async () => ({ code: 'ABCD', expiresAt: '2026-10-20T10:00:00Z', deepLink: 'https://t.me/parley_bot?start=ABCD' })),
  unlink: vi.fn(async () => undefined),
  takeOver: vi.fn(async () => undefined),
  configChanged: vi.fn(),
  reminderWhileOff: vi.fn(),
});

const call = (handlers: ReturnType<typeof createTelegramHandlers>, name: string, params: unknown = {}): Promise<unknown> =>
  (handlers[name] as unknown as (params: unknown, request: RequestInfo) => Promise<unknown>)(params, request);

describe('createTelegramHandlers', () => {
  it('шесть методов зовут сервис и отвечают его результатом', async () => {
    const service = fakeService();
    const handlers = createTelegramHandlers(service as unknown as TelegramService);

    expect(await call(handlers, 'telegram.setToken', { token: TOKEN })).toEqual({ botUsername: 'parley_bot', hint: '••••AAAA' });
    expect(service.setToken).toHaveBeenCalledWith(TOKEN);
    expect(await call(handlers, 'telegram.clearToken')).toEqual({ ok: true });
    expect(await call(handlers, 'telegram.link')).toMatchObject({ code: 'ABCD' });
    expect(await call(handlers, 'telegram.unlink')).toEqual({ ok: true });
    expect(await call(handlers, 'telegram.takeOver')).toEqual({ ok: true });
    expect(await call(handlers, 'telegram.status')).toEqual(STATUS);
    expect(service.clearToken).toHaveBeenCalledTimes(1);
    expect(service.unlink).toHaveBeenCalledTimes(1);
    expect(service.takeOver).toHaveBeenCalledTimes(1);
    expect(Object.keys(handlers).sort()).toEqual(
      ['telegram.clearToken', 'telegram.link', 'telegram.setToken', 'telegram.status', 'telegram.takeOver', 'telegram.unlink'],
    );
  });

  it('HostError сервиса уходит как есть', async () => {
    const service = fakeService();
    service.link.mockRejectedValue(new HostError('conflict', 'Set the bot token first'));
    const handlers = createTelegramHandlers(service as unknown as TelegramService);

    await expect(call(handlers, 'telegram.link')).rejects.toMatchObject({ code: 'conflict', message: 'Set the bot token first' });
  });

  it('прочий сбой — internal без токена в тексте', async () => {
    const service = fakeService();
    service.setToken.mockRejectedValue(new Error(`boom https://api.telegram.org/bot${TOKEN}/getMe`));
    const handlers = createTelegramHandlers(service as unknown as TelegramService);

    const error = (await call(handlers, 'telegram.setToken', { token: TOKEN }).catch((e: unknown) => e)) as HostError;
    expect(error).toBeInstanceOf(HostError);
    expect(error.code).toBe('internal');
    expect(error.message).not.toContain('AAAAAAAAAAAAAAAA');
  });
});
