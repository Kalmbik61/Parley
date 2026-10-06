/**
 * Фильтр ответа `whisper-cli` (спека 6.1, третий заслон): Whisper на тишине и шуме выдаёт служебные метки и
 * «субтитровые» фразы из обучающих данных. Выбрасывается только результат, который целиком из них состоит:
 * фраза, где эти слова — часть текста, остаётся.
 */

/** Нормализованные (нижний регистр, без точек, многоточий, ! и ?, с одиночными пробелами) галлюцинации целиком. */
const HALLUCINATIONS: ReadonlySet<string> = new Set([
  'продолжение следует', // cyrillic-ok: известная галлюцинация Whisper на тишине
  'субтитры сделал dimatorzok', // cyrillic-ok: известная галлюцинация Whisper на тишине
  'субтитры создавал dimatorzok', // cyrillic-ok: известная галлюцинация Whisper на тишине
  'редактор субтитров асинецкая корректор аегорова', // cyrillic-ok: известная галлюцинация Whisper на тишине
  'thank you for watching',
  'thanks for watching',
]);

/** Только метки в квадратных или круглых скобках: `[BLANK_AUDIO]`, `(music)` и такие же по-русски. */
const ONLY_TAGS = /^(\s*(\[[^\]]*\]|\([^)]*\))\s*)+$/;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.…!?«»"',]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Текст сегментов одной строкой; `null` — речи нет. */
export function cleanTranscript(stdout: string): string | null {
  const text = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ');
  if (text === '' || ONLY_TAGS.test(text)) return null;
  if (HALLUCINATIONS.has(normalize(text))) return null;
  return text;
}
