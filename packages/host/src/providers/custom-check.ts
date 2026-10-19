/**
 * Проверка адреса своего провайдера тестовым сообщением (спека своих провайдеров 2026-10-17, раздел 5.5):
 * одно сообщение `max_tokens: 1` в Anthropic-совместимый эндпоинт человека, по образцу `limits/zai-check.ts`.
 * Только по явному действию (сохранение, ключ, Check again); без редиректов, чтобы ключ не ушёл на чужой
 * адрес. Исход закрытый: HTTP-статус и причина из списка протокола; текст ответа, заголовки и ключ в него
 * не попадают. Функция не отказывает: любой сбой — тоже исход.
 */

import { createHash } from 'node:crypto';
import type { ProviderEntry } from '@parley/core';
import type { ProviderCheck } from '@parley/protocol';
import type { HostContext } from '../context.js';
import { reasonOfStatus } from '../limits/zai-check.js';

export const CUSTOM_CHECK_TIMEOUT_MS = 20_000;
export const CUSTOM_CHECK_MAX_BYTES = 256 * 1024;

type Outcome = Omit<ProviderCheck, 'at'>;

export interface CustomCheckTarget {
  baseUrl: string;
  auth: 'bearer' | 'api-key';
  model: string;
}

export interface CustomCheckOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** Адрес сообщений: хвостовые косые убираются, добавляется `/v1/messages`. */
export function messagesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}/v1/messages`;
}

/** Ключ уходит в заголовок: символ вне печатного ASCII `fetch` отвергнет до отправки — беда ключа, не сети. */
const HEADER_SAFE = /^[\x21-\x7e]+$/u;

/** Тело как JSON не больше `CUSTOM_CHECK_MAX_BYTES`; больше, пусто или не JSON — `undefined`. */
async function readBody(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > CUSTOM_CHECK_MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    return undefined;
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > CUSTOM_CHECK_MAX_BYTES) {
        void reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(chunk.value);
    }
  } catch {
    // Обрыв после заголовков: исход решает уже известный HTTP-статус.
    return undefined;
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Тестовое сообщение; `key === null` — без заголовка ключа (loopback, спека 5.1). Никогда не отказывает. */
export async function checkAnthropicEndpoint(
  target: CustomCheckTarget,
  key: string | null,
  options: CustomCheckOptions = {},
): Promise<Outcome> {
  if (key !== null && !HEADER_SAFE.test(key)) return { state: 'failed', reason: 'authentication' };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => {
      // Сначала исход, потом обрыв: отказ оборванного запроса не должен опередить таймаут.
      resolve({ state: 'failed', reason: 'timeout' });
      controller.abort();
    }, options.timeoutMs ?? CUSTOM_CHECK_TIMEOUT_MS);
  });
  const request = async (): Promise<Outcome> => {
    const headers: Record<string, string> = {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (key !== null) {
      if (target.auth === 'bearer') headers['Authorization'] = `Bearer ${key}`;
      else headers['x-api-key'] = key;
    }
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(messagesUrl(target.baseUrl), {
        method: 'POST',
        headers,
        // Маркер контекста `[1m]` — пометка Claude Code, до API он не доходит (как у `zai-check`).
        body: JSON.stringify({ model: target.model.replace(/\[1m\]$/u, ''), max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      return { state: 'failed', reason: 'network' };
    }
    const body = await readBody(response);
    const ok = response.status >= 200 && response.status < 300;
    if (ok && typeof body === 'object' && body !== null && (body as Record<string, unknown>)['type'] === 'message') {
      return { state: 'ok' };
    }
    return {
      state: 'failed',
      reason: ok ? 'unsupported_response' : reasonOfStatus(response.status),
      httpStatus: response.status,
    };
  };
  try {
    return await Promise.race([request(), timeout]);
  } catch {
    return { state: 'failed', reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

export interface CustomCheckService {
  /** Исход последней проверки этого ключа; `null` — не проверяли или ключ сменился. Без сети. */
  current(id: string, key: string | null): ProviderCheck | null;
  /** Проверка; параллельные запуски одного провайдера и ключа делят один запрос. Не отказывает. */
  run(entry: ProviderEntry, key: string | null): Promise<ProviderCheck>;
  /** Запись сохранена заново или удалена: прежний исход забывается, идущая проверка его уже не запишет. */
  forget(id: string): void;
}

const fingerprint = (key: string | null): string => createHash('sha256').update(key ?? '').digest('hex');
const sameOutcome = (a: ProviderCheck | null, b: ProviderCheck): boolean =>
  a !== null && a.state === b.state && a.reason === b.reason && a.httpStatus === b.httpStatus && a.code === b.code;

/** Службы в памяти: исход по id и отпечатку ключа; `providers.changed` только при смене исхода. */
export function createCustomCheckService(
  host: Pick<HostContext, 'broadcast'>,
  options: CustomCheckOptions = {},
): CustomCheckService {
  const stored = new Map<string, { check: ProviderCheck; fingerprint: string }>();
  const running = new Map<string, Promise<ProviderCheck>>();
  const generations = new Map<string, number>();
  const generation = (id: string): number => generations.get(id) ?? 0;

  return {
    current(id, key) {
      const record = stored.get(id);
      return record !== undefined && record.fingerprint === fingerprint(key) ? record.check : null;
    },
    run(entry, key) {
      const id = entry.id;
      const identity = fingerprint(key);
      const slot = `${id}\n${identity}`;
      const pending = running.get(slot);
      if (pending !== undefined) return pending;
      const started = generation(id);
      const promise = (async (): Promise<ProviderCheck> => {
        const custom = entry.custom;
        const outcome: Outcome =
          custom === undefined
            ? { state: 'failed', reason: 'unsupported_response' }
            : await checkAnthropicEndpoint(
                { baseUrl: custom.baseUrl, auth: custom.auth, model: custom.models.sonnet },
                key,
                options,
              );
        const result: ProviderCheck = { ...outcome, at: new Date().toISOString() };
        // Запись забыли или ключ сменили, пока шла проверка: исход уже не о нынешнем состоянии.
        if (started !== generation(id)) return result;
        const previous = stored.get(id);
        const before = previous !== undefined && previous.fingerprint === identity ? previous.check : null;
        stored.set(id, { check: result, fingerprint: identity });
        if (!sameOutcome(before, result)) host.broadcast('providers.changed', { provider: id });
        return result;
      })().finally(() => {
        if (running.get(slot) === promise) running.delete(slot);
      });
      running.set(slot, promise);
      return promise;
    },
    forget(id) {
      generations.set(id, generation(id) + 1);
      stored.delete(id);
      for (const slot of [...running.keys()]) if (slot.startsWith(`${id}\n`)) running.delete(slot);
    },
  };
}
