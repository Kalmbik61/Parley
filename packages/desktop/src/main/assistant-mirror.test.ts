import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_UI, type UiFile } from '../shared/ui-types.js';
import { assistantSettingsOf, createAssistantMirror, hostExtraEnv } from './assistant-mirror.js';

const voice = { downloaded: (model: string) => model === 'base', path: (model: string) => `/models/${model}.bin` };
const ui = (patch: Partial<Pick<UiFile, 'voice' | 'assistant'>>): UiFile => ({ ...DEFAULT_UI, ...patch }) as UiFile;

describe('assistantSettingsOf', () => {
  it('голос выключен: voiceModel null', () => {
    const settings = assistantSettingsOf(
      ui({ assistant: { ...DEFAULT_UI.assistant, enabled: true, provider: 'claude', model: 'm' }, voice: { enabled: false, model: 'base', language: 'auto' } }),
      voice,
      () => 'en',
    );
    expect(settings).toEqual({ enabled: true, provider: 'claude', model: 'm', language: 'en', voiceModel: null, voiceGender: 'female' });
  });

  it('голос включён, модель скачана: путь к модели', () => {
    const settings = assistantSettingsOf(ui({ voice: { enabled: true, model: 'base', language: 'auto' } }), voice, () => 'en');
    expect(settings.voiceModel).toBe('/models/base.bin');
  });

  it('модель не скачана: voiceModel null', () => {
    const settings = assistantSettingsOf(ui({ voice: { enabled: true, model: 'small', language: 'auto' } }), voice, () => 'en');
    expect(settings.voiceModel).toBeNull();
  });

  it('помощник выключен: enabled false', () => {
    expect(assistantSettingsOf(ui({}), voice, () => 'en').enabled).toBe(false);
  });

  it('род голоса (Р3): без выбора — serena, female; ryan и aiden — male', () => {
    expect(assistantSettingsOf(ui({}), voice, () => 'en').voiceGender).toBe('female');
    expect(assistantSettingsOf(ui({ assistant: { ...DEFAULT_UI.assistant, voice: 'qwen3-0.6b/aiden' } }), voice, () => 'en').voiceGender).toBe('male');
  });
});

describe('G1: зеркало после смены голоса', () => {
  it('смена assistant.voice на ryan шлёт assistant.configure с voiceGender: male', async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    const mirror = createAssistantMirror({ call, methods: () => ['assistant.configure'], log: vi.fn() });
    await mirror.push(assistantSettingsOf(ui({}), voice, () => 'ru'));
    await mirror.push(assistantSettingsOf(ui({ assistant: { ...DEFAULT_UI.assistant, voice: 'qwen3-0.6b/ryan' } }), voice, () => 'ru'));
    expect(call.mock.calls.map(([, settings]) => (settings as { voiceGender?: string }).voiceGender)).toEqual(['female', 'male']);
    expect(call).toHaveBeenLastCalledWith('assistant.configure', expect.objectContaining({ voiceGender: 'male' }));
  });
});

describe('createAssistantMirror', () => {
  const settings = { enabled: true, provider: null, model: null, language: 'en', voiceModel: null } as const;

  it('метода нет в списке или список null: call не вызван', async () => {
    const call = vi.fn();
    await createAssistantMirror({ call, methods: () => ['ping'], log: vi.fn() }).push(settings);
    await createAssistantMirror({ call, methods: () => null, log: vi.fn() }).push(settings);
    expect(call).not.toHaveBeenCalled();
  });

  it('метод есть: call вызван с настройками', async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    await createAssistantMirror({ call, methods: () => ['assistant.configure'], log: vi.fn() }).push(settings);
    expect(call).toHaveBeenCalledWith('assistant.configure', settings);
  });

  it('отказ вызова: одна строка в лог, без исключения', async () => {
    const log = vi.fn();
    const call = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(createAssistantMirror({ call, methods: () => ['assistant.configure'], log }).push(settings)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('hostExtraEnv', () => {
  it('без движка: только прокси', () => {
    expect(hostExtraEnv({ engine: null })).toEqual({ NODE_USE_ENV_PROXY: '1' });
  });

  it('с движком: добавляет PARLEY_WHISPER_BIN и PARLEY_WHISPER_VAD', () => {
    expect(hostExtraEnv({ engine: { bin: '/w/bin', vadModel: '/w/vad' } })).toEqual({
      NODE_USE_ENV_PROXY: '1',
      PARLEY_WHISPER_BIN: '/w/bin',
      PARLEY_WHISPER_VAD: '/w/vad',
    });
  });
});
