/**
 * Явная проверка ключа Z.ai (Check again в карточке GLM и сохранение ключа): одно тестовое сообщение в
 * Anthropic-совместимый эндпоинт GLM Coding Plan — тот же, куда ходит официальный `claude` GLM-сессий.
 * Пользователь разрешил этот запрос 2026-10-05 (исключение рамки в `core/test/frame-scan.ts`): только по
 * явному действию человека, `max_tokens: 1`, без редиректов. Ответ сводится к закрытому исходу — HTTP-статус
 * и цифровой код Z.ai (таблица кодов: docs.z.ai/api-reference/api-code); текст ответа, заголовки и ключ
 * не сохраняются и в исход не попадают. Функция не отказывает: любой сбой — тоже исход.
 */

import type { ProviderCheck, ProviderCheckReason } from '@parley/protocol';

// Адрес не экспортируется: исключение рамки снимает правило только с этой строки, а импорт константы
// в другом модуле сканер не увидел бы — так запрос к Z.ai остаётся только у этой функции.
const ZAI_MESSAGES_URL = 'https://api.z.ai/api/anthropic/v1/messages';
/**
 * Модель новых GLM-сессий (`settingsModel` встроенной записи `glm`) без пометки контекста `[1m]`: эту
 * пометку Claude Code снимает сам, в API уходит голое имя. Расхождение с реестром ловит тест.
 */
export const ZAI_CHECK_MODEL = 'glm-5.3';
/** Сообщение Z.ai отвечает дольше квоты: ответ модели, хоть и в одну лексему. */
export const ZAI_CHECK_TIMEOUT_MS = 20_000;
export const ZAI_CHECK_MAX_BYTES = 256 * 1024;

/** Исход без времени: время ставит служба проверки. */
export type ZaiCheckOutcome = Omit<ProviderCheck, 'at'>;

export interface ZaiCheckOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Цифровой код Z.ai: `error.code`, а у ответа вида `{ success: false, code }` (так отвечает monitor API
 * Z.ai) — верхний `code`. Буквы, дроби и длинные строки кодом не считаются.
 */
function zaiCode(body: unknown): string | undefined {
  const top = record(body);
  const code = record(top?.['error'])?.['code'] ?? (top?.['success'] === false ? top['code'] : undefined);
  if (typeof code === 'number' && Number.isSafeInteger(code) && code >= 0 && code < 1e8) return String(code);
  if (typeof code === 'string' && /^\d{1,8}$/u.test(code)) return code;
  return undefined;
}

/** Причина по коду Z.ai; `null` — код незнаком, решает HTTP-статус. */
function reasonOfCode(code: number): ProviderCheckReason | null {
  if (code >= 1000 && code <= 1005) return 'authentication';
  if (code === 1309 || code === 1314) return 'plan_expired';
  if (code === 1113) return 'no_plan';
  if (code === 1308 || code === 1310 || (code >= 1316 && code <= 1321)) return 'limit_reached';
  if (code === 1311) return 'model_unavailable';
  if (code === 1220 || code === 1313 || code === 1315) return 'key_restricted';
  if (code === 1302 || code === 1305) return 'rate_limited';
  if (code === 1200 || code === 1230 || code === 1234) return 'server_error';
  // Неверный запрос, неизвестная модель или способ вызова (1211, 1212: Z.ai переименовал или снял
  // модель запроса), снятый или несуществующий API, слишком длинный промпт, фильтр содержимого: наш
  // запрос Z.ai больше не понимает — для человека это «незнакомый ответ», а не беда с ключом или тарифом.
  if (code === 1210 || (code >= 1211 && code <= 1215) || code === 1221 || code === 1222 || code === 1261 || code === 1301) {
    return 'unsupported_response';
  }
  return null;
}

function reasonOfStatus(status: number): ProviderCheckReason {
  if (status === 401) return 'authentication';
  if (status === 403) return 'key_restricted';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'unsupported_response';
}

/** Причина по коду ответа: код Z.ai, а код вида HTTP (`{ success: false, code: 401 }`) — как статус. */
function reasonOfAnyCode(code: number): ProviderCheckReason | null {
  return reasonOfCode(code) ?? (code >= 400 && code <= 599 ? reasonOfStatus(code) : null);
}

/** Успех — только ответ-сообщение без ошибки; Z.ai бывает присылает ошибку и со статусом 200. */
function outcomeOf(status: number, body: unknown): ZaiCheckOutcome {
  const code = zaiCode(body);
  const success = status >= 200 && status < 300;
  if (success && code === undefined && record(body)?.['type'] === 'message') return { state: 'ok' };
  const reason =
    (code === undefined ? null : reasonOfAnyCode(Number(code))) ??
    (success ? 'unsupported_response' : reasonOfStatus(status));
  return { state: 'failed', reason, httpStatus: status, ...(code === undefined ? {} : { code }) };
}

/** Тело ответа как JSON, не больше `ZAI_CHECK_MAX_BYTES`; больше, пусто или не JSON — `undefined`. */
async function readBody(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > ZAI_CHECK_MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    return undefined;
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > ZAI_CHECK_MAX_BYTES) {
        void reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(chunk.value);
    }
  } catch {
    // Тело оборвалось после заголовков (сброс соединения): исход решает уже известный HTTP-статус.
    // Обрыв по таймауту сюда тоже приходит, но таймаут к этому времени уже дал свой исход.
    return undefined;
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Ключ уходит в заголовок `Authorization`: символ вне печатного ASCII (вставленные «умные» кавычки,
 * тире) `fetch` отвергнет ещё до отправки — это беда ключа, а не сети.
 */
const HEADER_SAFE = /^[\x21-\x7e]+$/u;

/** Тестовое сообщение ключом `key`; никогда не отказывает — сбой сети и таймаут тоже исходы. */
export async function checkZaiKey(key: string, options: ZaiCheckOptions = {}): Promise<ZaiCheckOutcome> {
  if (!HEADER_SAFE.test(key)) return { state: 'failed', reason: 'authentication' };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ZaiCheckOutcome>((resolve) => {
    timer = setTimeout(() => {
      // Сначала исход, потом обрыв: отказ оборванного запроса не должен опередить таймаут.
      resolve({ state: 'failed', reason: 'timeout' });
      controller.abort();
    }, options.timeoutMs ?? ZAI_CHECK_TIMEOUT_MS);
  });
  const request = async (): Promise<ZaiCheckOutcome> => {
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(ZAI_MESSAGES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ model: ZAI_CHECK_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
        // Ключ не уходит на чужой адрес: редирект — отказ, а не переход.
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      return { state: 'failed', reason: 'network' };
    }
    return outcomeOf(response.status, await readBody(response));
  };
  try {
    return await Promise.race([request(), timeout]);
  } catch {
    // Страховка обещания «не отказывает»: ошибки запроса и чтения тела уже сведены к исходу выше.
    return { state: 'failed', reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}
