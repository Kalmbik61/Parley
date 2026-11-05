/**
 * HTTP basic-auth во встроенном браузере: общие для main и рендерера форма запроса пароля и разбор `user:pass@` в адресе.
 * Пароль живёт только в памяти: в раскладку, историю, журналы и ответы агентам он не попадает (см. `main/browser/basic-auth.ts`).
 */

/** Логин и пароль, как их ввёл человек или задал адрес (уже без процентного кодирования). */
export interface BasicCredentials {
  username: string;
  password: string;
}

/**
 * Запрос окну: страница вкладки просит логин и пароль (событие `browser:auth-request`). Идёт только окну-хозяину гостя.
 * `retry` — прошлые данные сервер отклонил: окно показывает строку ошибки.
 */
export interface BrowserAuthRequest {
  requestId: string;
  webContentsId: number;
  /** `host` или `host:port` источника (или прокси). */
  host: string;
  realm: string;
  isProxy: boolean;
  retry: boolean;
}

/** Отмена запроса main'ом (вкладка ушла со страницы или закрыта): окно убирает оверлей (`browser:auth-cancel`). */
export interface BrowserAuthCancel {
  requestId: string;
  webContentsId: number;
}

/**
 * Адрес без `user:pass@` и данные из него. Нет учётных данных (или не http(s), или не адрес) — адрес как есть и `null`:
 * `href` дописал бы `/` к `http://localhost:5173`, и введённое разошлось бы с загружаемым.
 */
export function splitUrlCredentials(raw: string): { url: string; credentials: BasicCredentials | null } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { url: raw, credentials: null };
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || (parsed.username === '' && parsed.password === '')) {
    return { url: raw, credentials: null };
  }
  const credentials = { username: decode(parsed.username), password: decode(parsed.password) };
  parsed.username = '';
  parsed.password = '';
  return { url: parsed.href, credentials };
}

/** Битая последовательность `%…` — строка как есть, а не исключение. */
function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}
