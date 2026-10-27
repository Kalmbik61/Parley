/**
 * Чистые функции помощника (спека 2026-10-14, разделы 6.4 и 7.3): метка эмоции в начале ответа и по предложениям
 * (#9 §6.7 L3), текст для озвучки, слова подтверждения карточки, нормализация текста для сверки отправленного. Без node-зависимостей — их берёт и окно
 * через подпуть `@parley/core/assistant`.
 */

export type AssistantMood = 'calm' | 'joy' | 'sad' | 'surprise' | 'anger' | 'error';
/**
 * Код языка из списка Whisper (`en`, `ru`, `uk`, `zh`, `yue`, …): две-три латинские строчные буквы. Проверяет окно
 * (`isVoiceLanguage`) и протокол (regex), поэтому тип — просто строка.
 */
export type AssistantLanguage = string;

/** Род, в котором помощник говорит о себе; берётся из метаданных выбранного голоса (#9 §6.8). */
export type AssistantGender = 'female' | 'male' | 'neutral';

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

/** Отметка эмоции предложения: `at` — позиция в очищенном тексте, с которой начинается предложение. */
export interface MoodMark {
  at: number;
  mood: AssistantMood;
}

/** Готовая часть потока: текст без меток и отметки, которые попали в эту часть. */
export interface MoodStrip {
  text: string;
  marks: MoodMark[];
}

export interface MoodStripper {
  /** Очередная дельта ответа. Возможная метка в хвосте держится в буфере до `MOOD_TAG_LIMIT` знаков. */
  push(delta: string): MoodStrip;
  /** Конец текста: недописанная метка уходит текстом как есть. */
  end(): MoodStrip;
}

/**
 * Потоковая срезка всех меток `[[mood]]` (#9 §6.7 L3): метка в начале каждого предложения. Позиции отметок — в
 * склейке всех `text`, которые отдал этот срезатель. Пробелы и переводы строк сразу после метки и в самом начале
 * отбрасываются, как у `splitMood`. Незнакомая метка (и `error` от модели) срезается, но отметки не даёт; скобка
 * длиннее `MOOD_TAG_LIMIT` — не метка, а текст.
 */
export function createMoodStripper(): MoodStripper {
  let pending = '';
  let emitted = 0;
  let skipSpace = true;

  function run(buffer: string, final: boolean): MoodStrip {
    let text = '';
    const marks: MoodMark[] = [];
    let index = 0;
    pending = '';
    while (index < buffer.length) {
      if (skipSpace) {
        while (index < buffer.length && /\s/.test(buffer[index] ?? '')) index += 1;
        if (index === buffer.length) break;
        skipSpace = false;
      }
      const open = buffer.indexOf('[', index);
      if (open === -1) {
        text += buffer.slice(index);
        break;
      }
      text += buffer.slice(index, open);
      const rest = buffer.slice(open);
      const close = rest.indexOf(']]');
      const waiting = !final && close === -1 && rest.length < MOOD_TAG_LIMIT;
      if (waiting && (rest.length === 1 || rest[1] === '[')) {
        pending = rest;
        break;
      }
      if (rest[1] !== '[' || close === -1 || close + 2 > MOOD_TAG_LIMIT) {
        // Не метка: отдаём одну скобку, вторая может начинать настоящую метку.
        text += '[';
        index = open + 1;
        continue;
      }
      const tag = rest.slice(2, close).trim().toLowerCase();
      if ((MODEL_MOODS as readonly string[]).includes(tag)) {
        marks.push({ at: emitted + text.length, mood: tag as AssistantMood });
      }
      index = open + close + 2;
      skipSpace = true;
    }
    emitted += text.length;
    return { text, marks };
  }

  return {
    push: (delta) => run(pending + delta, false),
    end: () => run(pending, true),
  };
}

/**
 * Текст ответа для озвучки (план 3, Task 1): без меток `[[…]]` (любых, не только первой), блоков кода, URL,
 * абсолютных путей, id в скобках и `session:…`/`room:…`, разметки Markdown; пробелы свёрнуты. Пусто — `''`.
 */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/(?<![\p{L}\p{N}_.~/])~?\/[\w@+~-]+(?:\.[\w@+~-]+)*(?:\/[\w@+~-]+(?:\.[\w@+~-]+)*)+\/?/gu, ' ')
    .replace(/[[(][^\])\s]*(?:session:|room:|\b[ws]-\d+\b)[^\])\s]*[\])]/g, ' ')
    .replace(/\b(?:session|room):\S+/g, ' ')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, ' ')
    .replace(/[*`#]+/g, '')
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export type ConfirmAnswer = 'send' | 'cancel';

const SEND_PHRASES = new Set([
  'да', 'ага', 'давай', 'отправь', 'отправляй', 'да отправь', 'да отправляй', 'да давай', // cyrillic-ok: слова подтверждения человека (спека 7.3)
  'yes', 'yep', 'yeah', 'send', 'send it', 'go ahead', 'yes send', 'yes send it',
]);
const CANCEL_PHRASES = new Set([
  'нет', 'не надо', 'отмена', 'отмени', 'не отправляй', 'нет не надо', // cyrillic-ok: слова отмены человека (спека 7.3)
  'no', 'nope', 'cancel', 'dont', 'dont send', 'no cancel',
]);

/** Нижний регистр, `ё` → `е`, без знаков препинания и лишних пробелов. */
export function normalizePhrase(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/ё/g, 'е') // cyrillic-ok: ё → е во вводе человека
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
