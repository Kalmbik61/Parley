import { describe, expect, it } from 'vitest';
import { isVoiceLanguage, isVoiceModelId, VOICE_MODELS, voiceModel, voiceModelUrl, WHISPER_LANGUAGES } from './voice-types.js';

describe('каталог моделей голоса (спека 3.1)', () => {
  it('три модели в порядке вкладки Voice', () => {
    expect(VOICE_MODELS.map((model) => model.id)).toEqual(['base', 'small', 'large-v3-turbo-q5_0']);
  });

  it('sha256 — 64 hex, размер больше 100 МБ, файл ggml-*.bin', () => {
    for (const model of VOICE_MODELS) {
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(model.bytes).toBeGreaterThan(100_000_000);
      expect(model.file).toMatch(/^ggml-[a-z0-9._-]+\.bin$/);
    }
  });

  it('адрес — Hugging Face ggerganov/whisper.cpp', () => {
    expect(voiceModelUrl(voiceModel('small'))).toBe('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin');
  });

  it('isVoiceModelId пускает только ids каталога', () => {
    expect(isVoiceModelId('base')).toBe(true);
    expect(isVoiceModelId('large')).toBe(false);
    expect(isVoiceModelId(42)).toBe(false);
  });
});

describe('языки Whisper', () => {
  it('100 языков, коды уникальны, есть en и ru', () => {
    const codes = WHISPER_LANGUAGES.map((language) => language.code);
    expect(codes).toHaveLength(100);
    expect(new Set(codes).size).toBe(100);
    expect(codes).toEqual(expect.arrayContaining(['en', 'ru']));
  });

  it('isVoiceLanguage: auto и коды списка — да, прочее — нет', () => {
    expect(isVoiceLanguage('auto')).toBe(true);
    expect(isVoiceLanguage('ru')).toBe(true);
    expect(isVoiceLanguage('xx')).toBe(false);
    expect(isVoiceLanguage('ru --model x')).toBe(false);
    expect(isVoiceLanguage(null)).toBe(false);
  });
});
