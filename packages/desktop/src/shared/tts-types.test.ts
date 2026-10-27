import { describe, expect, it } from 'vitest';
import { DEFAULT_VOICE, isAssistantVoiceId, TTS_MODELS, TTS_VOICES, ttsModel } from './tts-types.js';

/** Лицензии, под которыми веса можно отдавать пользователю (спека #9 §6.8: других голосов Parley не предлагает). */
const DISTRIBUTABLE = ['Apache-2.0', 'MIT', 'CC0-1.0', 'CC-BY-4.0'];

describe('модель TTS (план 3b, B04)', () => {
  it('одна модель: Qwen3-TTS 0.6B Q8_0, точный размер и полный sha256', () => {
    expect(TTS_MODELS).toEqual([
      {
        id: 'qwen3-tts-0.6b-q8_0',
        file: 'Qwen3-TTS-12Hz-0.6B-CustomVoice-Q8_0.gguf',
        bytes: 1_213_534_464,
        sha256: 'f606ea3981aa42762b16db9a94826d2d560eb60f0b102001618f40d5a2f78cc6',
        url: 'https://huggingface.co/sakasegawa/Qwen3-TTS-12Hz-0.6B-CustomVoice-GGUF/resolve/fd9df9364613a92a86b4137074bc281204823033/Qwen3-TTS-12Hz-0.6B-CustomVoice-Q8_0.gguf',
      },
    ]);
  });

  it('адрес закреплён на коммит Hugging Face, а не на ветку', () => {
    for (const model of TTS_MODELS) {
      expect(model.url).toMatch(/^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//);
      expect(model.url.endsWith(`/${model.file}`)).toBe(true);
    }
  });

  it('ttsModel находит модель по id и падает на чужом', () => {
    expect(ttsModel('qwen3-tts-0.6b-q8_0').bytes).toBe(1_213_534_464);
    expect(() => ttsModel('q6' as never)).toThrow('unknown tts model: q6');
  });
});

describe('каталог голосов (спека #9 §6.8, G4)', () => {
  it('пять голосов в порядке выбора человека', () => {
    expect(TTS_VOICES.map((voice) => voice.id)).toEqual([
      'qwen3-0.6b/serena',
      'qwen3-0.6b/ryan',
      'qwen3-0.6b/aiden',
      'qwen3-0.6b/vivian',
      'qwen3-0.6b/ono_anna',
    ]);
  });

  it('G4: у всех голосов есть род, языки ru и en и лицензия', () => {
    for (const voice of TTS_VOICES) {
      expect(['female', 'male', 'neutral']).toContain(voice.gender);
      expect(voice.languages).toEqual(['ru', 'en']);
      expect(voice.licence).toBe('Apache-2.0');
      expect(voice.name).not.toBe('');
      expect(voice.engine).not.toBe('');
    }
  });

  it('G4: голосов без лицензии на распространение нет', () => {
    expect(TTS_VOICES.filter((voice) => !DISTRIBUTABLE.includes(voice.licence))).toEqual([]);
  });

  it('род — решение человека: serena, vivian, ono_anna — ж; ryan, aiden — м', () => {
    expect(Object.fromEntries(TTS_VOICES.map((voice) => [voice.id, voice.gender]))).toEqual({
      'qwen3-0.6b/serena': 'female',
      'qwen3-0.6b/ryan': 'male',
      'qwen3-0.6b/aiden': 'male',
      'qwen3-0.6b/vivian': 'female',
      'qwen3-0.6b/ono_anna': 'female',
    });
  });

  it('G4: serena — по умолчанию и есть в каталоге', () => {
    expect(DEFAULT_VOICE).toBe('qwen3-0.6b/serena');
    expect(TTS_VOICES.find((voice) => voice.id === DEFAULT_VOICE)?.gender).toBe('female');
  });

  it('Р4: усиление каждого голоса — замер B01', () => {
    expect(Object.fromEntries(TTS_VOICES.map((voice) => [voice.id, voice.gain]))).toEqual({
      'qwen3-0.6b/serena': 1.592,
      'qwen3-0.6b/ryan': 1.25,
      'qwen3-0.6b/aiden': 0.693,
      'qwen3-0.6b/vivian': 0.847,
      'qwen3-0.6b/ono_anna': 2.419,
    });
  });

  it('Р6: все голоса ссылаются на один файл весов, размер — его мегабайты', () => {
    for (const voice of TTS_VOICES) {
      expect(voice.modelId).toBe('qwen3-tts-0.6b-q8_0');
      expect(voice.sizeMb).toBe(Math.round(ttsModel(voice.modelId).bytes / 1_000_000));
    }
    expect(TTS_VOICES[0]?.sizeMb).toBe(1214);
  });

  it('isAssistantVoiceId пускает только ids каталога', () => {
    expect(isAssistantVoiceId('qwen3-0.6b/ryan')).toBe(true);
    expect(isAssistantVoiceId('qwen3-0.6b/sohee')).toBe(false);
    expect(isAssistantVoiceId('serena')).toBe(false);
    expect(isAssistantVoiceId(null)).toBe(false);
  });
});
