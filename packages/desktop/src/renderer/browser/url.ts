/**
 * Адресная строка встроенного браузера (кусок 9.1, таблица спеки 12.1). Поиска нет: ввод —
 * адрес или ошибка. Слова ошибок — `S.browser` (9.2a), здесь только коды.
 */

export type NormalizedUrl =
  | { ok: true; url: string }
  | { ok: false; error: 'not-an-address' | 'local-file' }; // слова — S.browser (9.2a)

/** Явная схема в начале ввода: `javascript:`, `mailto:`, `http:`… */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
/** `хост:порт` — не схема: после двоеточия цифры и конец или путь (`example.com:8080/x`). */
const HOST_PORT = /^[^:/?#\s]+:\d+(?:[/?#]|$)/;
/** Локальные адреса разработки идут по http: у dev-сервера сертификата нет. */
const LOCAL = /^(?:localhost|127\.0\.0\.1|\[::1\])(?=$|[:/?#])/i;

const NOT_AN_ADDRESS: NormalizedUrl = { ok: false, error: 'not-an-address' };

/** Итог проверяется `new URL`: наружу — только `http:` и `https:`. */
function checked(url: string): NormalizedUrl {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? { ok: true, url } : NOT_AN_ADDRESS;
  } catch {
    return NOT_AN_ADDRESS;
  }
}

export function normalizeUrl(input: string): NormalizedUrl {
  const text = input.trim();
  if (text === '') return NOT_AN_ADDRESS;

  const scheme = SCHEME.exec(text)?.[1]?.toLowerCase();
  if (scheme !== undefined && !HOST_PORT.test(text)) {
    if (scheme === 'http' || scheme === 'https') return checked(text);
    // `file:` не пускается вовсе (спека 12.2): у схемы в Electron лишние права на диск.
    if (scheme === 'file') return { ok: false, error: 'local-file' };
    // Прочая явная схема — не адрес: иначе правило «есть точка → https://» сделало бы
    // `https://`-мусор из `javascript:alert(document.domain)` и `mailto:a@b.c`.
    return NOT_AN_ADDRESS;
  }

  if (LOCAL.test(text)) return checked(`http://${text}`);
  if (!/\s/.test(text) && text.includes('.')) return checked(`https://${text}`);
  return NOT_AN_ADDRESS;
}
