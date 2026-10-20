/** Методы канала Telegram (план B, задача 10): тонкая обвязка над сервисом, токен в ответы и ошибки не попадает. */

import { maskTelegramTokens } from '@parley/core';
import type { AnyHandler } from '../context.js';
import { HostError } from '../errors.js';
import type { TelegramService } from '../telegram/service.js';

/** Ошибки сервиса (`HostError`) уходят как есть, остальное — `internal` без токена в тексте. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw new HostError('internal', maskTelegramTokens(error instanceof Error ? error.message : String(error)));
  }
}

export function createTelegramHandlers(service: TelegramService): Record<string, AnyHandler> {
  const handlers = {
    'telegram.setToken': async (params: { token: string }) => guarded(() => service.setToken(params.token)),
    'telegram.clearToken': async () =>
      guarded(async () => {
        await service.clearToken();
        return { ok: true as const };
      }),
    'telegram.link': async () => guarded(() => service.link()),
    'telegram.unlink': async () =>
      guarded(async () => {
        await service.unlink();
        return { ok: true as const };
      }),
    'telegram.takeOver': async () =>
      guarded(async () => {
        await service.takeOver();
        return { ok: true as const };
      }),
    'telegram.status': async () => service.status(),
  };
  return handlers as unknown as Record<string, AnyHandler>;
}
