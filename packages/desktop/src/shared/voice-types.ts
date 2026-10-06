/**
 * Голосовой ввод (спека 2026-10-06-voice-input-design.md): каталог моделей Whisper, языки, ответы движка и мост
 * `ParleyBridge.voice`. Лежит в `shared/`: каталог читают и main (скачивание и проверка), и окно (вкладка Voice).
 */

export type VoiceModelId = 'base' | 'small' | 'large-v3-turbo-q5_0';

export interface VoiceModel {
  id: VoiceModelId;
  /** Имя файла на Hugging Face и на диске. */
  file: string;
  /** Точный размер в байтах: прогресс, проверка места и целостности. */
  bytes: number;
  /** sha256 файла (LFS oid Hugging Face) — сверяется после скачивания. */
  sha256: string;
}

export const VOICE_MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

/** Порядок — порядок строк вкладки Voice. Размеры и sha256 — API Hugging Face на 2026-10-06. */
export const VOICE_MODELS: readonly VoiceModel[] = [
  { id: 'base', file: 'ggml-base.bin', bytes: 147_951_465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe' },
  { id: 'small', file: 'ggml-small.bin', bytes: 487_601_967, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b' },
  {
    id: 'large-v3-turbo-q5_0',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    bytes: 574_041_195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
  },
];

export function isVoiceModelId(value: unknown): value is VoiceModelId {
  return VOICE_MODELS.some((model) => model.id === value);
}

export function voiceModel(id: VoiceModelId): VoiceModel {
  const found = VOICE_MODELS.find((model) => model.id === id);
  if (found === undefined) throw new Error(`unknown voice model: ${id}`);
  return found;
}

export function voiceModelUrl(model: VoiceModel): string {
  return `${VOICE_MODEL_BASE_URL}/${model.file}`;
}

export interface VoiceLanguage {
  code: string;
  name: string;
}

/** Языки Whisper — таблица `g_lang` из `src/whisper.cpp` v1.9.4, по алфавиту английских имён. */
export const WHISPER_LANGUAGES: readonly VoiceLanguage[] = [
  ['af', 'Afrikaans'], ['sq', 'Albanian'], ['am', 'Amharic'], ['ar', 'Arabic'], ['hy', 'Armenian'], ['as', 'Assamese'],
  ['az', 'Azerbaijani'], ['ba', 'Bashkir'], ['eu', 'Basque'], ['be', 'Belarusian'], ['bn', 'Bengali'], ['bs', 'Bosnian'],
  ['br', 'Breton'], ['bg', 'Bulgarian'], ['yue', 'Cantonese'], ['ca', 'Catalan'], ['zh', 'Chinese'], ['hr', 'Croatian'],
  ['cs', 'Czech'], ['da', 'Danish'], ['nl', 'Dutch'], ['en', 'English'], ['et', 'Estonian'], ['fo', 'Faroese'],
  ['fi', 'Finnish'], ['fr', 'French'], ['gl', 'Galician'], ['ka', 'Georgian'], ['de', 'German'], ['el', 'Greek'],
  ['gu', 'Gujarati'], ['ht', 'Haitian Creole'], ['ha', 'Hausa'], ['haw', 'Hawaiian'], ['he', 'Hebrew'], ['hi', 'Hindi'],
  ['hu', 'Hungarian'], ['is', 'Icelandic'], ['id', 'Indonesian'], ['it', 'Italian'], ['ja', 'Japanese'], ['jw', 'Javanese'],
  ['kn', 'Kannada'], ['kk', 'Kazakh'], ['km', 'Khmer'], ['ko', 'Korean'], ['lo', 'Lao'], ['la', 'Latin'],
  ['lv', 'Latvian'], ['ln', 'Lingala'], ['lt', 'Lithuanian'], ['lb', 'Luxembourgish'], ['mk', 'Macedonian'], ['mg', 'Malagasy'],
  ['ms', 'Malay'], ['ml', 'Malayalam'], ['mt', 'Maltese'], ['mi', 'Maori'], ['mr', 'Marathi'], ['mn', 'Mongolian'],
  ['my', 'Myanmar'], ['ne', 'Nepali'], ['no', 'Norwegian'], ['nn', 'Nynorsk'], ['oc', 'Occitan'], ['ps', 'Pashto'],
  ['fa', 'Persian'], ['pl', 'Polish'], ['pt', 'Portuguese'], ['pa', 'Punjabi'], ['ro', 'Romanian'], ['ru', 'Russian'],
  ['sa', 'Sanskrit'], ['sr', 'Serbian'], ['sn', 'Shona'], ['sd', 'Sindhi'], ['si', 'Sinhala'], ['sk', 'Slovak'],
  ['sl', 'Slovenian'], ['so', 'Somali'], ['es', 'Spanish'], ['su', 'Sundanese'], ['sw', 'Swahili'], ['sv', 'Swedish'],
  ['tl', 'Tagalog'], ['tg', 'Tajik'], ['ta', 'Tamil'], ['tt', 'Tatar'], ['te', 'Telugu'], ['th', 'Thai'],
  ['bo', 'Tibetan'], ['tr', 'Turkish'], ['tk', 'Turkmen'], ['uk', 'Ukrainian'], ['ur', 'Urdu'], ['uz', 'Uzbek'],
  ['vi', 'Vietnamese'], ['cy', 'Welsh'], ['yi', 'Yiddish'], ['yo', 'Yoruba'],
].map(([code, name]) => ({ code: code as string, name: name as string }));

/** `auto` или код из `WHISPER_LANGUAGES`: в argv движка уходит только такое значение. */
export function isVoiceLanguage(value: unknown): value is string {
  return value === 'auto' || WHISPER_LANGUAGES.some((language) => language.code === value);
}

/** `no_speech` — пусто, тишина или галлюцинация (спека 6.1). */
export type TranscribeError = 'no_speech' | 'engine_missing' | 'model_missing' | 'failed';
export type TranscribeResult = { text: string } | { error: TranscribeError };

/** PCM — Int16 little-endian, моно, 16 кГц (`renderer/voice/recorder.ts`). */
export interface TranscribeRequest {
  pcm: ArrayBuffer;
  language: string;
  model: VoiceModelId;
}

export type DownloadResult =
  | { ok: true }
  | { error: 'disk_full'; needBytes: number }
  | { error: 'network' | 'corrupted' | 'cancelled' };

export interface DownloadProgress {
  id: VoiceModelId;
  receivedBytes: number;
  totalBytes: number;
}

export type MicStatus = 'granted' | 'denied' | 'restricted' | 'not-determined';

/** Мост `ParleyBridge.voice`: каналы `voice:*` (`main/voice/ipc.ts`). */
export interface VoiceApi {
  /** Скачанные модели целиком: файл на месте и нужного размера. */
  listModels(): Promise<VoiceModelId[]>;
  /** Повторный вызов для той же модели, пока она качается, отдаёт тот же результат. */
  downloadModel(id: VoiceModelId): Promise<DownloadResult>;
  cancelDownload(id: VoiceModelId): Promise<void>;
  removeModel(id: VoiceModelId): Promise<void>;
  onProgress(listener: (progress: DownloadProgress) => void): () => void;
  transcribe(request: TranscribeRequest): Promise<TranscribeResult>;
  micStatus(): Promise<MicStatus>;
  /** Системный запрос доступа к микрофону; `true` — доступ есть. */
  requestMic(): Promise<boolean>;
  /** System Settings → Privacy & Security → Microphone. */
  openMicSettings(): Promise<void>;
}
