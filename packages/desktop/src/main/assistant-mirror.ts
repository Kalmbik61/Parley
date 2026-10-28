/**
 * Зеркало настроек помощника для хоста (план B, задача 11): хост отвечает из Telegram и сам настроек окна не видит,
 * поэтому main отправляет их методом `assistant.configure` при каждом подключении и сохранении ui.json. Род голоса
 * (план 3b, Р3) — из выбранного голоса каталога: им помощник говорит о себе на всех путях разговора.
 */
import type { AssistantLanguage } from '@parley/core/assistant';
import type { AssistantSettings } from '@parley/protocol';
import { assistantVoice, type UiFile } from '../shared/ui-types.js';
import type { VoiceModelId } from '../shared/voice-types.js';

export function assistantSettingsOf(
  ui: UiFile,
  voice: { downloaded(model: VoiceModelId): boolean; path(model: VoiceModelId): string },
  language: (ui: UiFile) => AssistantLanguage,
): AssistantSettings {
  const model = ui.voice.model;
  return {
    enabled: ui.assistant.enabled,
    provider: ui.assistant.provider,
    model: ui.assistant.model,
    language: language(ui),
    voiceModel: ui.voice.enabled && model !== null && voice.downloaded(model) ? voice.path(model) : null,
    voiceGender: assistantVoice(ui.assistant).gender,
    // Провайдер последней новой работы — умолчание для агентов, которых помощник создаёт сам.
    defaultProvider: ui.lastProvider,
  };
}

export function createAssistantMirror(deps: {
  call(method: 'assistant.configure', params: AssistantSettings): Promise<unknown>;
  methods(): readonly string[] | null;
  log(line: string): void;
}): { push(settings: AssistantSettings): Promise<void> } {
  return {
    async push(settings) {
      // Старый хост без метода — тихо ничего.
      if (!deps.methods()?.includes('assistant.configure')) return;
      try {
        await deps.call('assistant.configure', settings);
      } catch (error) {
        deps.log(`assistant.configure failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

/** Прокси для fetch хоста и пути движка Whisper (бинарник и модель VAD), которые нашло окно. */
export function hostExtraEnv(input: { engine: { bin: string; vadModel: string } | null }): Record<string, string> {
  return {
    NODE_USE_ENV_PROXY: '1',
    ...(input.engine ? { PARLEY_WHISPER_BIN: input.engine.bin, PARLEY_WHISPER_VAD: input.engine.vadModel } : {}),
  };
}
