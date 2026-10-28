import { describe, expect, it } from 'vitest';
import { activeTtsModel, DEFAULT_VOICE, isAssistantVoiceId, isTtsModelId, TTS_MODELS, TTS_VOICES, ttsModel } from './tts-types.js';

/** Лицензии, под которыми веса можно отдавать пользователю (спека #9 §6.8: других голосов Parley не предлагает). */
const DISTRIBUTABLE = ['Apache-2.0', 'MIT', 'CC0-1.0', 'CC-BY-4.0'];

describe('модель TTS (план 3b, B04)', () => {
  it('две модели в порядке «меньшая, большая»: Qwen3-TTS 0.6B и 1.7B Q8_0, точный размер и полный sha256', () => {
    expect(TTS_MODELS).toEqual([
      {
        id: 'qwen3-tts-0.6b-q8_0',
        file: 'Qwen3-TTS-12Hz-0.6B-CustomVoice-Q8_0.gguf',
        bytes: 1_213_534_464,
        sha256: 'f606ea3981aa42762b16db9a94826d2d560eb60f0b102001618f40d5a2f78cc6',
        url: 'https://huggingface.co/sakasegawa/Qwen3-TTS-12Hz-0.6B-CustomVoice-GGUF/resolve/fd9df9364613a92a86b4137074bc281204823033/Qwen3-TTS-12Hz-0.6B-CustomVoice-Q8_0.gguf',
      },
      {
        id: 'qwen3-tts-1.7b-q8_0',
        file: 'Qwen3-TTS-12Hz-1.7B-CustomVoice-Q8_0.gguf',
        bytes: 2_287_780_352,
        sha256: '1bc0ef69547c003507b6536639a6080c8856382f4d0963b15d4475528330592d',
        url: 'https://huggingface.co/sakasegawa/Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF/resolve/a72e6c6575d67652488cdffc1c863215a9899978/Qwen3-TTS-12Hz-1.7B-CustomVoice-Q8_0.gguf',
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
    expect(ttsModel('qwen3-tts-1.7b-q8_0').bytes).toBe(2_287_780_352);
    expect(() => ttsModel('q6' as never)).toThrow('unknown tts model: q6');
  });

  it('файлы моделей на диске не совпадают: скачанная 0.6B не подменяет 1.7B', () => {
    expect(new Set(TTS_MODELS.map((model) => model.file)).size).toBe(TTS_MODELS.length);
  });

  it('isTtsModelId пускает только id каталога', () => {
    expect(isTtsModelId('qwen3-tts-0.6b-q8_0')).toBe(true);
    expect(isTtsModelId('qwen3-tts-1.7b-q8_0')).toBe(true);
    expect(isTtsModelId('qwen3-tts-1.7b-q4_0')).toBe(false);
    expect(isTtsModelId('base')).toBe(false);
    expect(isTtsModelId(null)).toBe(false);
    expect(isTtsModelId(undefined)).toBe(false);
    expect(isTtsModelId(7)).toBe(false);
  });
});

describe('activeTtsModel: говорит самая большая из скачанных', () => {
  it('ни одной скачанной — null', () => {
    expect(activeTtsModel([])).toBeNull();
  });

  it('скачана одна — она', () => {
    expect(activeTtsModel(['qwen3-tts-0.6b-q8_0'])).toBe('qwen3-tts-0.6b-q8_0');
    expect(activeTtsModel(['qwen3-tts-1.7b-q8_0'])).toBe('qwen3-tts-1.7b-q8_0');
  });

  it('скачаны обе, в любом порядке, — 1.7B', () => {
    expect(activeTtsModel(['qwen3-tts-0.6b-q8_0', 'qwen3-tts-1.7b-q8_0'])).toBe('qwen3-tts-1.7b-q8_0');
    expect(activeTtsModel(['qwen3-tts-1.7b-q8_0', 'qwen3-tts-0.6b-q8_0'])).toBe('qwen3-tts-1.7b-q8_0');
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

  it('голос не привязан к файлу весов: ни modelId, ни sizeMb (модель — по скачанному, размер — у модели)', () => {
    for (const voice of TTS_VOICES) {
      expect(voice).not.toHaveProperty('modelId');
      expect(voice).not.toHaveProperty('sizeMb');
    }
  });

  it('isAssistantVoiceId пускает только ids каталога', () => {
    expect(isAssistantVoiceId('qwen3-0.6b/ryan')).toBe(true);
    expect(isAssistantVoiceId('qwen3-0.6b/sohee')).toBe(false);
    expect(isAssistantVoiceId('serena')).toBe(false);
    expect(isAssistantVoiceId(null)).toBe(false);
  });
});
