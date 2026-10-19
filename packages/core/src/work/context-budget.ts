import { createHash } from 'node:crypto';

/**
 * Бюджеты стартового контекста агента (P34). Единица — байты: токенайзер у каждого провайдера свой, поэтому
 * токены из них не выводятся, а попадание в кеш из стабильности префикса не следует.
 *
 * Правило одно для всех полей: влезло — стоит в тексте как есть; не влезло — вместо текста ограниченная ссылка
 * с размером и хешем, и агент обязан прочитать полный текст сам. Молча обрезанная задача хуже отказа: человек
 * не узнает, что хвост с его ограничением до агента не дошёл. Где ссылки нет (нечем читать), работает отказ —
 * `ContextBudgetError`.
 */

/** Потолки отдельных полей: название, цель и задача пишет человек (или агент), и длина у них любая. */
export const CONTEXT_LIMITS = {
  title: 256,
  label: 128,
  goal: 4096,
  task: 8192,
  summary: 1024,
  decision: 512,
  path: 256,
  /** Запрос `find_skill`: слова задачи, не её пересказ. */
  query: 512,
  /** Описание навыка в ответе `find_skill`: полный текст агент всё равно прочитает по пути навыка. */
  skillDescription: 400,
} as const;

/**
 * Письмо агента: жёсткий потолок и мягкий порог. Письма копятся в общей карте и читаются каждым участником,
 * поэтому длинный текст дорог всем; документы передают файлом и путём. Выше потолка письмо не пишется (отказ
 * с текстом, а не обрезка), выше порога — пишется с предупреждением. Письма человека из окна не ограничены.
 */
export const LETTER_MAX_CHARS = 4096;
export const LETTER_SOFT_CHARS = 1200;

/** Стабильная политика вставки: не зависит от id сессии и данных работы. */
export const STABLE_POLICY_MAX_BYTES = 4096;
/**
 * Вся системная вставка: стабильная политика и строка сессии с названием и целью. Потолок не меньше потолка политики
 * (4096) плюс цель на пределе (4096) и строка сессии: иначе правка политики в десятки байт ломала бы вставку с целью на пределе.
 */
export const GUIDANCE_MAX_BYTES = 8448;
/** Бриф сессии целиком. Общий потолок аргумента (98304) проверяет сборка слоя, этот — только бриф. */
export const BRIEF_MAX_BYTES = 32768;
/** Ответ `read_guide`: весь гид сегодня около 33 КиБ, потолок вдвое выше — для роста, а не для отсечения. */
export const READ_GUIDE_MAX_BYTES = 65536;
/** Ответ `find_skill` целиком. */
export const FIND_SKILL_MAX_BYTES = 8192;
/** Блок открытых заданий комнаты в слое сессии (`assignmentsBlock`): напоминание, а не список — за списком идут в `plan_tasks`. */
export const ASSIGNMENTS_BLOCK_MAX_BYTES = 1024;

/**
 * Размер текста в бюджете: байты UTF-8 после JSON-экранирования. Codex получает слой строкой TOML через
 * `JSON.stringify` (`developerInstructions`), и управляющий знак там весит шесть байт, а не один: счёт по
 * сырому UTF-8 недооценил бы такой текст. Кавычки обёртки не считаются.
 */
export function contextBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
}

/** Короткий хеш полного текста: по нему видно, что это за текст, не вставляя его. */
export function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Текст как есть, если он в пределах `maxBytes`, иначе ограниченная ссылка. `what` и `where` — слова Parley
 * (поле и способ прочитать его), данные в них не попадают.
 */
export function inlineOrRef(what: string, text: string, maxBytes: number, where: string): string {
  const bytes = contextBytes(text);
  if (bytes <= maxBytes) return text;
  return `[${what} is ${bytes} bytes (limit ${maxBytes}), sha256 ${textHash(text)}; not inlined: read the full text via ${where} before acting on it]`;
}

/**
 * Начало текста в пределах `maxBytes` для описания, полный текст которого лежит рядом (файл навыка): обрыв
 * помечен и называет полный размер. Режет по границе символа, а не байта.
 */
export function markedExcerpt(text: string, maxBytes: number): { text: string; cut: boolean } {
  const total = contextBytes(text);
  if (total <= maxBytes) return { text, cut: false };
  let used = 0;
  let kept = '';
  for (const char of text) {
    const next = contextBytes(char);
    if (used + next > maxBytes) break;
    used += next;
    kept += char;
  }
  return { text: `${kept}… [cut: ${total} bytes in full]`, cut: true };
}

export class ContextBudgetError extends Error {
  readonly code = 'context-budget-exceeded';
  constructor(
    readonly block: string,
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`context-budget-exceeded: ${block} is ${bytes} bytes, the limit is ${limit}; shorten it before launching.`);
    this.name = 'ContextBudgetError';
  }
}

/** Отказ вместо обрезания там, где ссылки нет: блок целиком или ошибка. */
export function assertWithinBudget(block: string, text: string, limit: number): void {
  const bytes = contextBytes(text);
  if (bytes > limit) throw new ContextBudgetError(block, bytes, limit);
}

/**
 * Ответ инструмента в пределах `maxBytes`: влез — отдаётся как есть, не влез — `fallback()`, короткий ответ,
 * который называет размер и куда идти дальше. Обрезанного текста не бывает.
 */
export function boundResponse(text: string, maxBytes: number, fallback: (bytes: number) => string): string {
  const bytes = contextBytes(text);
  return bytes <= maxBytes ? text : fallback(bytes);
}
