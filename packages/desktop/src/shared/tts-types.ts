/**
 * Типы озвучки помощника. Голоса — OpenAI (`gpt-4o-mini-tts`); выбор хранится в `assistant.apiVoice`. Лежит в
 * `shared/`: типы читают и main, и окна (настройки, остров).
 */

export type VoiceGender = 'female' | 'male' | 'neutral';

/** Id голоса OpenAI в запросе на озвучку. */
export type AssistantVoiceId = string;

/** Голоса OpenAI для `/v1/audio/speech`; порядок — порядок списка в настройках. */
export const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'marin', 'cedar', 'nova', 'onyx', 'sage', 'shimmer', 'verse'] as const;

export const isOpenAiVoice = (value: unknown): value is AssistantVoiceId => OPENAI_VOICES.includes(value as (typeof OPENAI_VOICES)[number]);

/** Голос до выбора человеком. */
export const DEFAULT_VOICE: AssistantVoiceId = 'alloy';
