/**
 * Чистые функции помощника (спека 2026-10-14, разделы 6.4 и 7.3): метка эмоции в начале ответа, слова
 * подтверждения карточки, нормализация текста для сверки отправленного. Без node-зависимостей — их берёт и окно
 * через подпуть `@parley/core/assistant`.
 */

export type AssistantMood = 'calm' | 'joy' | 'sad' | 'surprise' | 'anger' | 'error';
export type AssistantLanguage = 'en' | 'ru';

/** Эмоции, которые ставит модель; `error` ставит только хост при сбое хода. */
export const MODEL_MOODS: readonly AssistantMood[] = ['calm', 'joy', 'sad', 'surprise', 'anger'];

/** Дольше метки не ждём: `[[surprise]]` — 12 знаков, остальное — запас на пробелы внутри. */
const MOOD_TAG_LIMIT = 24;

export interface MoodSplit {
  mood: AssistantMood;
  /** Ответ без метки и без пробелов и перевода строки сразу после неё. */
  text: string;
}

/**
 * Срезает метку `[[mood]]` с начала первого текста хода. `null` — по буферу ещё нельзя решить (метка не дописана);
 * `final` — ход кончился, решать по тому, что есть. Нет метки или она незнакома — `calm` и текст как есть.
 */
export function splitMood(buffer: string, final: boolean): MoodSplit | null {
  const head = buffer.trimStart();
  if (head === '' || head === '[') return final ? { mood: 'calm', text: head } : null;
  if (!head.startsWith('[[')) return { mood: 'calm', text: buffer };
  const close = head.indexOf(']]');
  if (close === -1) return !final && head.length < MOOD_TAG_LIMIT ? null : { mood: 'calm', text: buffer };
  const tag = head.slice(2, close).trim().toLowerCase();
  const mood = (MODEL_MOODS as readonly string[]).includes(tag) ? (tag as AssistantMood) : 'calm';
  return { mood, text: head.slice(close + 2).trimStart() };
}

export type ConfirmAnswer = 'send' | 'cancel';

const SEND_PHRASES = new Set([
  'да', 'ага', 'давай', 'отправь', 'отправляй', 'да отправь', 'да отправляй', 'да давай',
  'yes', 'yep', 'yeah', 'send', 'send it', 'go ahead', 'yes send', 'yes send it',
]);
const CANCEL_PHRASES = new Set([
  'нет', 'не надо', 'отмена', 'отмени', 'не отправляй', 'нет не надо',
  'no', 'nope', 'cancel', 'dont', 'dont send', 'no cancel',
]);

/** Нижний регистр, `ё` → `е`, без знаков препинания и лишних пробелов. */
export function normalizePhrase(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Короткий ответ на карточку подтверждения (спека 7.3): не длиннее трёх слов и из списка — `send` или `cancel`;
 * иначе `null`, и фраза уходит модели обычным вопросом. Оба языка принимаются всегда.
 */
export function matchConfirm(phrase: string): ConfirmAnswer | null {
  const normalized = normalizePhrase(phrase);
  if (normalized === '' || normalized.split(' ').length > 3) return null;
  if (SEND_PHRASES.has(normalized)) return 'send';
  if (CANCEL_PHRASES.has(normalized)) return 'cancel';
  return null;
}

/** Текст для сверки «это сообщение отправил помощник» (спека 7.4): пробелы схлопнуты, края обрезаны. */
export function normalizeSentText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
