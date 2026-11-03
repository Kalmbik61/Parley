/**
 * Платный голосовой провайдер (OpenAI): ключ хранит хост, наружу идёт только `secretHint`. Методы окна; телефону
 * закрыты (`voiceProvider.*` в `REMOTE_FORBIDDEN`).
 */

import { z } from 'zod';

export const voiceProviderMethodSchemas = {
  'voiceProvider.get': z.object({}),
  'voiceProvider.setKey': z.object({ key: z.string().min(1).max(512) }),
  'voiceProvider.clearKey': z.object({}),
  'voiceProvider.check': z.object({}),
} as const;

/** Причина неудачной проверки: код без текста ключа. */
export type VoiceProviderCheckCode = 'no_key' | 'invalid_key' | 'model_unavailable' | 'rate_limited' | 'network' | 'unknown';

export interface VoiceProviderState {
  keySet: boolean;
  secretHint: string | null;
}

export type VoiceProviderCheck = { ok: true; model: string } | { ok: false; code: VoiceProviderCheckCode };

export interface VoiceProviderMethodResults {
  'voiceProvider.get': VoiceProviderState;
  'voiceProvider.setKey': VoiceProviderState;
  'voiceProvider.clearKey': VoiceProviderState;
  'voiceProvider.check': VoiceProviderCheck;
}
