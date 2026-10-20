/**
 * Тонкий клиент Telegram Bot API (план B, задача 5) на глобальном `fetch`. Токен живёт только в URL запроса:
 * ни в сообщение ошибки, ни в stack он не попадает (всё идёт через `maskTelegramTokens`), URL в ошибки не кладётся.
 */

import { writeFile } from 'node:fs/promises';
import { maskTelegramTokens } from '@parley/core';

const DEFAULT_BASE_URL = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 20_000;

export class BotApiError extends Error {
  constructor(
    readonly method: string,
    /** HTTP/Telegram-код ошибки; 0 — сеть, таймаут или отмена. */
    readonly status: number,
    readonly description: string,
    readonly retryAfter: number | null,
  ) {
    super(maskTelegramTokens(`${method}: ${description}`));
    this.name = 'BotApiError';
    if (this.stack !== undefined) this.stack = maskTelegramTokens(this.stack);
  }
}

export interface BotApi {
  call<T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T>;
  /** Скачивает файл Telegram в `dest`; возвращает число записанных байт. Больше `maxBytes` — `BotApiError(status 0, 'file too large')`. */
  download(filePath: string, dest: string, maxBytes: number): Promise<number>;
}

interface ApiEnvelope {
  ok?: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/** Текст сетевой ошибки вместе с причиной (undici кладёт подробности в `cause`), без токена. */
const networkMessage = (error: unknown): string => {
  if (!(error instanceof Error)) return 'network error';
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : '';
  return maskTelegramTokens(`${error.message}${cause}`);
};

export function createBotApi(deps: { token: string; fetch?: typeof fetch; baseUrl?: string }): BotApi {
  const doFetch = deps.fetch ?? fetch;
  const baseUrl = (deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

  const call: BotApi['call'] = async <T>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> => {
    const timeout = AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = options?.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
    let response: Response;
    let envelope: ApiEnvelope;
    try {
      response = await doFetch(`${baseUrl}/bot${deps.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params ?? {}),
        signal,
      });
      envelope = (await response.json()) as ApiEnvelope;
    } catch (error) {
      throw new BotApiError(method, 0, networkMessage(error), null);
    }
    if (envelope.ok === true) return envelope.result as T;
    throw new BotApiError(
      method,
      envelope.error_code ?? response.status,
      maskTelegramTokens(envelope.description ?? 'unknown error'),
      envelope.parameters?.retry_after ?? null,
    );
  };

  const download: BotApi['download'] = async (filePath, dest, maxBytes) => {
    const tooLarge = (): BotApiError => new BotApiError('download', 0, 'file too large', null);
    try {
      const response = await doFetch(`${baseUrl}/file/bot${deps.token}/${filePath}`, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok || response.body === null) throw new BotApiError('download', response.status, 'download failed', null);
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw tooLarge();
        }
        chunks.push(value);
      }
      await writeFile(dest, Buffer.concat(chunks), { mode: 0o600 });
      return total;
    } catch (error) {
      if (error instanceof BotApiError) throw error;
      throw new BotApiError('download', 0, networkMessage(error), null);
    }
  };

  return { call, download };
}
