/**
 * Нейроголос помощника (спека 2026-10-26-island-motion-sound-design.md §6.8, план 3b B04): веса Qwen3-TTS для
 * `speech worker` и каталог голосов. Лежит в `shared/`: каталог читают и main (скачивание, синтез), и окна (настройки,
 * остров).
 */

export type TtsModelId = 'qwen3-tts-0.6b-q8_0';

export interface TtsModel {
  id: TtsModelId;
  /** Имя файла на Hugging Face и на диске. */
  file: string;
  /** Точный размер в байтах: прогресс, проверка места и целостности. */
  bytes: number;
  /** sha256 файла (LFS oid Hugging Face) — сверяется после скачивания. */
  sha256: string;
  /** Адрес, закреплённый на коммит репозитория: файл по нему не меняется. */
  url: string;
}

const QWEN3_REPO = 'sakasegawa/Qwen3-TTS-12Hz-0.6B-CustomVoice-GGUF';
const QWEN3_REVISION = 'fd9df9364613a92a86b4137074bc281204823033';
const QWEN3_FILE = 'Qwen3-TTS-12Hz-0.6B-CustomVoice-Q8_0.gguf';

/**
 * Q8_0 — решение человека: и для разработки, и для релиза. Это собственный каталог speech.cpp
 * (`tools/catalog/catalog.json` v0.9.0); размер и sha256 — оттуда же, сверены спайком B01.
 */
export const TTS_MODELS: readonly TtsModel[] = [
  {
    id: 'qwen3-tts-0.6b-q8_0',
    file: QWEN3_FILE,
    bytes: 1_213_534_464,
    sha256: 'f606ea3981aa42762b16db9a94826d2d560eb60f0b102001618f40d5a2f78cc6',
    url: `https://huggingface.co/${QWEN3_REPO}/resolve/${QWEN3_REVISION}/${QWEN3_FILE}`,
  },
];

export function ttsModel(id: TtsModelId): TtsModel {
  const found = TTS_MODELS.find((model) => model.id === id);
  if (found === undefined) throw new Error(`unknown tts model: ${id}`);
  return found;
}

export type VoiceGender = 'female' | 'male' | 'neutral';

type Qwen3Speaker = 'serena' | 'ryan' | 'aiden' | 'vivian' | 'ono_anna';

export type AssistantVoiceId = `qwen3-0.6b/${Qwen3Speaker}`;

/** Голос помощника (спека §6.8) с моделью весов и усилением (план 3b, Р4, Р6). */
export interface AssistantVoice {
  /** `qwen3-0.6b/<speaker>`: после `/` — имя голоса в запросе к `speech worker`. */
  id: AssistantVoiceId;
  name: string;
  engine: string;
  /** Род, в котором помощник говорит о себе этим голосом. */
  gender: VoiceGender;
  /** Коды языков помощника, на которых голос говорит. */
  languages: string[];
  /** Лицензия весов; голоса, которые нельзя распространять, в каталог не попадают. */
  licence: string;
  /** Веса голоса скачаны целиком; знает только main. */
  downloaded: boolean;
  /** Размер скачивания в десятичных мегабайтах, как во вкладке Voice. */
  sizeMb: number;
  /** Файл весов: один на все голоса движка (Р6). */
  modelId: TtsModelId;
  /** Постоянное усиление голоса до ограничителя пика (Р4): RMS речи около 0,1. */
  gain: number;
}

/** Запись каталога: всё, кроме `downloaded`, — его добавляет main по хранилищу. */
export type TtsVoice = Omit<AssistantVoice, 'downloaded'>;

const qwen3 = (speaker: Qwen3Speaker, name: string, gender: VoiceGender, gain: number): TtsVoice => ({
  id: `qwen3-0.6b/${speaker}`,
  name,
  engine: 'qwen3-tts',
  gender,
  languages: ['ru', 'en'],
  licence: 'Apache-2.0',
  sizeMb: Math.round(ttsModel('qwen3-tts-0.6b-q8_0').bytes / 1_000_000),
  modelId: 'qwen3-tts-0.6b-q8_0',
  gain,
});

/** Пять голосов, выбранных человеком, в его порядке. Усиление — замер B01 (`gain.json`). */
export const TTS_VOICES: readonly TtsVoice[] = [
  qwen3('serena', 'Serena', 'female', 1.592),
  qwen3('ryan', 'Ryan', 'male', 1.25),
  qwen3('aiden', 'Aiden', 'male', 0.693),
  qwen3('vivian', 'Vivian', 'female', 0.847),
  qwen3('ono_anna', 'Ono Anna', 'female', 2.419),
];

/** Голос по умолчанию, пока человек не выбрал свой (спека §6.8). */
export const DEFAULT_VOICE: AssistantVoiceId = 'qwen3-0.6b/serena';

export function isAssistantVoiceId(value: unknown): value is AssistantVoiceId {
  return TTS_VOICES.some((voice) => voice.id === value);
}
