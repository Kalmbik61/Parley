/**
 * Методы `voiceProvider.*`: ключ OpenAI для платного голоса. Ключ в результаты, ошибки и логи не попадает —
 * окно получает только `secretHint`.
 */

import { clearSecret, readSecret, SecretFormatError, secretHint, writeSecret } from '@parley/core';
import type { VoiceProviderCheck, VoiceProviderState } from '@parley/protocol';
import type { AnyHandler } from '../context.js';
import { HostError } from '../errors.js';

const SECRET = 'voice:openai' as const;
/** Модель, доступность которой проверяет `check`. */
export const VOICE_MODEL = 'gpt-live-1';
const CHECK_TIMEOUT_MS = 10_000;

async function state(): Promise<VoiceProviderState> {
  const key = await readSecret(SECRET);
  return { keySet: key !== null, secretHint: key === null ? null : secretHint(key) };
}

/** Один реальный запрос к OpenAI; из ответа берётся только код причины. */
async function check(fetchImpl: typeof fetch): Promise<VoiceProviderCheck> {
  const key = await readSecret(SECRET);
  if (key === null) return { ok: false, code: 'no_key' };
  try {
    const response = await fetchImpl(`https://api.openai.com/v1/models/${VOICE_MODEL}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (response.ok) return { ok: true, model: VOICE_MODEL };
    if (response.status === 401) return { ok: false, code: 'invalid_key' };
    if (response.status === 403 || response.status === 404) return { ok: false, code: 'model_unavailable' };
    if (response.status === 429) return { ok: false, code: 'rate_limited' };
    return { ok: false, code: 'unknown' };
  } catch {
    // Текст ошибки сети может нести заголовки запроса: наружу идёт только код.
    return { ok: false, code: 'network' };
  }
}

export function createVoiceProviderHandlers(fetchImpl: typeof fetch = fetch): Record<string, AnyHandler> {
  const handlers = {
    'voiceProvider.get': async () => state(),
    'voiceProvider.setKey': async (params: { key: string }) => {
      try {
        await writeSecret(SECRET, params.key);
      } catch (error) {
        if (error instanceof SecretFormatError) throw new HostError('bad_request', error.message);
        throw new HostError('internal', 'Unable to save voice provider key');
      }
      return state();
    },
    'voiceProvider.clearKey': async () => {
      try {
        await clearSecret(SECRET);
      } catch {
        throw new HostError('internal', 'Unable to clear voice provider key');
      }
      return state();
    },
    'voiceProvider.check': async () => check(fetchImpl),
  };
  return handlers as unknown as Record<string, AnyHandler>;
}
