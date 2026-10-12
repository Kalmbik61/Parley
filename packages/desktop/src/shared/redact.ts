/**
 * Маска секретов (спека браузера, раздел 6): одна функция на файлы-контексты (этап B) и ответы агенту
 * (этапы C и D). В панели Console | Network маски нет — там браузер и данные самого человека.
 *
 * Секретное имя (заголовка, параметра query, фрагмента или формы, ключа JSON): `Authorization`,
 * `Proxy-Authorization`, `Cookie`, `Set-Cookie`; имя, где есть `token`, `secret`, `password`, `passwd`,
 * `api-key` (`apikey`, `api_key`), `session`, `csrf` или `auth`; имя со словом `key` (`private_key`,
 * `privateKey`, но не `keyboard`). Значение такого имени заменяется на `<redacted>`.
 */

import { S } from './strings.js';

export const REDACTED = '<redacted>';

const SECRET_HEADERS: ReadonlySet<string> = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);
const SECRET_PARTS: readonly string[] = ['token', 'secret', 'password', 'passwd', 'api-key', 'apikey', 'session', 'csrf', 'auth'];

export function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SECRET_HEADERS.has(lower)) return true;
  const dashed = lower.replace(/_/g, '-');
  if (SECRET_PARTS.some((part) => dashed.includes(part))) return true;
  // Слово `key` — отдельно: границы — не буквы и не цифры, у camelCase — смена регистра.
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .includes('key');
}

export function redactHeaders(headers: ReadonlyArray<[string, string]>): Array<[string, string]> {
  return headers.map(([name, value]) => [name, isSecretName(name) ? REDACTED : value]);
}

/** `a=1&token=x` → `a=1&token=<redacted>`: остальные пары остаются как были, без перекодирования. */
function redactParams(params: string): string {
  return params
    .split('&')
    .map((pair) => {
      const at = pair.indexOf('=');
      if (at === -1) return pair;
      const rawName = pair.slice(0, at);
      let name = rawName;
      try {
        name = decodeURIComponent(rawName.replace(/\+/g, ' '));
      } catch {
        // Битая кодировка — имя проверяется как есть.
      }
      return isSecretName(name) ? `${rawName}=${REDACTED}` : pair;
    })
    .join('&');
}

/**
 * URL с маской: `user:pass@` убран, значения секретных параметров query и фрагмента (`#access_token=…` неявного
 * OAuth) — `<redacted>`. Адрес разбирается как текст, а не `new URL`: остальные символы не перекодируются, а битый
 * адрес тоже маскируется.
 */
export function redactUrl(url: string): string {
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? null : url.slice(hashAt + 1);
  const queryAt = beforeHash.indexOf('?');
  const base = (queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt)).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1');
  const query = queryAt === -1 ? null : beforeHash.slice(queryAt + 1);
  const maskedHash = hash === null ? '' : `#${hash.includes('=') ? redactParams(hash) : hash}`;
  return `${base}${query === null ? '' : `?${redactParams(query)}`}${maskedHash}`;
}

function maskJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, isSecretName(key) ? REDACTED : maskJson(item)]));
  }
  return value;
}

/** JSON по типу или по виду: тело с типом text/plain, но в фигурных скобках, тоже маскируется (как в плане C). */
function isJson(text: string, mimeType: string | null): boolean {
  return (mimeType !== null && /json/i.test(mimeType)) || /^\s*[[{]/.test(text);
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * JSON, который не разбирается (обрезан источником или битый): маска его не видит — значение у края могло быть
 * отрезано посередине. Такое тело не кладут ни в файл-контекст, ни в ответ агенту.
 */
export function unmaskableJson(text: string, mimeType: string | null): boolean {
  return text.trim() !== '' && isJson(text, mimeType) && !parses(text);
}

/** Первые `limit` кодовых точек и пометка обрезки; короче предела — как есть. */
function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const points = Array.from(text);
  return points.length <= limit ? text : `${points.slice(0, limit).join('')}${S.contextFile.truncated}`;
}

/**
 * Тело запроса или ответа с маской: JSON — ключи на любой глубине, форма — параметры, прочее — как есть. Битый JSON
 * возвращается без изменений — его отсеивает вызывающий (`unmaskableJson`). `limit` — в кодовых точках, с пометкой
 * обрезки; режется уже замаскированное.
 */
export function redactBody(text: string, mimeType: string | null, limit: number = Number.POSITIVE_INFINITY): string {
  let masked = text;
  if (mimeType !== null && /^application\/x-www-form-urlencoded/i.test(mimeType)) {
    masked = redactParams(text);
  } else if (isJson(text, mimeType)) {
    try {
      masked = JSON.stringify(maskJson(JSON.parse(text)), null, 2);
    } catch {
      // Битый или обрезанный JSON маской не закрыть: он остаётся как есть, его отсеивает вызывающий (`unmaskableJson`).
    }
  }
  return cut(masked, limit);
}
