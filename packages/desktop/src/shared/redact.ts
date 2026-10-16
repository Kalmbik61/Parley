/**
 * Маска секретов (спека браузера, раздел 6): одна функция на файлы-контексты (этап B) и ответы агенту
 * (этапы C и D). В панели Console | Network маски нет — там браузер и данные самого человека.
 *
 * Секретное имя (заголовка, параметра query, фрагмента или формы, ключа JSON): `Authorization`,
 * `Proxy-Authorization`, `Cookie`, `Set-Cookie`; имя, где есть `token`, `secret`, `password`, `passwd`, `pwd`,
 * `api-key` (`apikey`, `api_key`), `session`, `sessid`, `csrf`, `xsrf`, `auth`, `signature`, `credential`, `jwt`,
 * `bearer` или `private`; имя со словом `key`, `sid`, `sig`, `pass` или `otp` (`private_key`, `privateKey`, `userPass`,
 * но не `keyboard` и не `passenger`). В параметрах адреса секретен ещё `code` (OAuth). Значение такого имени заменяется
 * на `<redacted>`. Текст вида значения (консоль, строки JSON) маскирует `redactSecretsInText`: схемы `Bearer`, JWT и
 * пары `имя=значение` с секретным именем.
 *
 * Заголовки-адреса (`Referer`, `Location`, `Content-Location`) идут через `redactUrl`: страница `/reset?token=…` кладёт
 * свой адрес в `Referer` каждого запроса, редирект OAuth — токен в `Location`. Текст сообщения консоли, цитирующий адрес
 * (CORS называет адрес запроса целиком), — через `redactUrlsInText`.
 *
 * Тело `multipart/form-data` (`FormData`, форма с файлом) маскируется по частям: значение части, чьё имя секретное, —
 * `<redacted>` (`redactBody`).
 */

import { cutCodePoints } from './code-points.js';
import { S } from './strings.js';

export const REDACTED = '<redacted>';

const SECRET_HEADERS: ReadonlySet<string> = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);
const SECRET_PARTS: readonly string[] = [
  'token', 'secret', 'password', 'passwd', 'api-key', 'apikey', 'session', 'csrf', 'auth',
  'signature', 'credential', 'jwt', 'bearer', 'xsrf', 'pwd', 'private', 'sessid',
];
/** Слова целиком: подстрокой они давали бы `passenger`, `signal`, `sidebar`. */
const SECRET_WORDS: readonly string[] = ['key', 'sid', 'sig', 'pass', 'otp'];

export function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SECRET_HEADERS.has(lower)) return true;
  const dashed = lower.replace(/_/g, '-');
  if (SECRET_PARTS.some((part) => dashed.includes(part))) return true;
  // Слова `key`, `sid`, `sig`, `pass`, `otp` — отдельно: границы — не буквы и не цифры, у camelCase — смена регистра.
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return SECRET_WORDS.some((word) => words.includes(word));
}

/** Параметр адреса: к секретным именам добавляется `code` (код авторизации OAuth); в JSON и формах `code` — обычное поле. */
const isSecretParam = (name: string): boolean => isSecretName(name) || name.toLowerCase() === 'code';

/** Заголовки, чьё значение — адрес: query и фрагмент в нём несут те же секреты, что и в самом адресе. */
const URL_HEADERS: ReadonlySet<string> = new Set(['referer', 'location', 'content-location']);

export function redactHeaders(headers: ReadonlyArray<[string, string]>): Array<[string, string]> {
  return headers.map(([name, value]) => {
    if (isSecretName(name)) return [name, REDACTED];
    return [name, URL_HEADERS.has(name.toLowerCase()) ? redactUrl(value) : value];
  });
}

/**
 * `a=1&token=x` → `a=1&token=<redacted>`: остальные пары остаются как были, без перекодирования. Пары делят `&` и `;`.
 * `urlParams` — параметры адреса (там секретен и `code`), иначе тело формы.
 */
function redactParams(params: string, urlParams = false): string {
  return params
    .split(/([&;])/)
    .map((pair, index) => {
      if (index % 2 === 1) return pair;
      const at = pair.indexOf('=');
      if (at === -1) return pair;
      const rawName = pair.slice(0, at);
      let name = rawName;
      try {
        name = decodeURIComponent(rawName.replace(/\+/g, ' '));
      } catch {
        // Битая кодировка — имя проверяется как есть.
      }
      return (urlParams ? isSecretParam(name) : isSecretName(name)) ? `${rawName}=${REDACTED}` : pair;
    })
    .join('');
}

/**
 * URL с маской: `user:pass@` убран, значения секретных параметров query и фрагмента (`#access_token=…` неявного
 * OAuth) — `<redacted>`. Адрес разбирается как текст, а не `new URL`: остальные символы не перекодируются, а битый
 * адрес тоже маскируется. Вход убирается по последнюю `@` до пути — так делит адрес браузер, и пароль с `@`
 * (`user:p@ss@host`) не оставляет хвоста.
 */
export function redactUrl(url: string): string {
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? null : url.slice(hashAt + 1);
  const queryAt = beforeHash.indexOf('?');
  const base = (queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt)).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1');
  const query = queryAt === -1 ? null : beforeHash.slice(queryAt + 1);
  const maskedHash = hash === null ? '' : `#${hash.includes('=') ? redactParams(hash, true) : hash}`;
  return `${base}${query === null ? '' : `?${redactParams(query, true)}`}${maskedHash}`;
}

/**
 * Текст, цитирующий адреса (сообщение консоли): каждый адрес `http(s)://` и `ws(s)://` идёт через `redactUrl`, остальной
 * текст не меняется — масок по виду значения нет (спека 6). Сообщение CORS называет адрес запроса целиком, с `?token=…`.
 * Адрес кончается на пробеле, кавычке, обратной кавычке или `<>`; готовая метка `<redacted>` внутри адреса — его часть, повторная маска ничего не меняет. Схема — только эти четыре, от границы слова: образец
 * любой схемы (`[a-z][a-z0-9+.-]*://`) на длинной серии вроде «a.a.a.» перебирает квадратично, а текст задаёт страница.
 */
export function redactUrlsInText(text: string): string {
  return text.replace(/\b(?:https?|wss?):\/\/(?:<redacted>|[^\s'"`<>])+/gi, (url) => redactUrl(url));
}

/** Схема `Bearer|Basic|Token <значение>`; значение `Basic` и `Token` похоже на секрет (цифра, знак или заглавная не в начале), чтобы «Basic usage» не терялось. */
const AUTH_SCHEME = /\b(Bearer|Basic|Token)([ \t]+)([A-Za-z0-9\-._~+/]+=*)/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
/** `имя[:=]значение` и `"имя": "значение"`: значение — строка в кавычках или слово до пробела, запятой, `;`, `&`, скобки. Имя ограничено, перебор линейный. */
const NAMED_VALUE = /(["']?)([A-Za-z_][\w.-]{0,63})\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?:(?:Bearer|Basic|Token)[ \t]+)?[^\s,;&)}\]"']+)/g;
/** Относительный адрес с query: начало строки или пробел/кавычка/скобка, затем `/путь?query`. */
const RELATIVE_URL = /(^|[\s'"`(])(\/[^\s'"`<>?#]*\?[^\s'"`<>]+)/g;

const looksSecret = (value: string): boolean => value.length >= 8 && /[0-9\-._~+/=]|[A-Z]/.test(value.slice(1));

/**
 * Текст, в котором секрет узнаётся по виду значения (сообщение консоли, строка внутри JSON): схемы `Bearer|Basic|Token
 * <значение>`, JWT (`eyJ….….…`), пары `имя[:=]значение` и `"имя": "значение"` с секретным именем (`isSecretName`),
 * относительные адреса с query (`/reset?token=…`) — через `redactUrl`. Маскируется только значение: имя и разделитель
 * остаются. Абсолютные адреса `http(s)://`, `ws(s)://` идут через `redactUrlsInText`.
 */
export function redactSecretsInText(text: string): string {
  return redactUrlsInText(text)
    .replace(RELATIVE_URL, (_, before: string, url: string) => `${before}${redactUrl(url)}`)
    .replace(NAMED_VALUE, (whole, quote: string, name: string, separator: string, value: string) => {
      if (!isSecretName(name)) return whole;
      const wrap = value.startsWith('"') || value.startsWith("'") ? value[0] : '';
      return `${quote}${name}${quote}${separator}${wrap}${REDACTED}${wrap}`;
    })
    .replace(AUTH_SCHEME, (whole, scheme: string, space: string, value: string) => {
      const strict = scheme.toLowerCase() !== 'bearer';
      return strict && !looksSecret(value) ? whole : `${scheme}${space}${REDACTED}`;
    })
    .replace(JWT, REDACTED);
}

/** JSON.rawJSON есть в V8 11.4+ (Node 22, Electron 44); lib TypeScript его не знает. */
type RawJson = { rawJSON?: (text: string) => unknown; isRawJSON?: (value: unknown) => boolean };
const rawJson = JSON as unknown as RawJson;

/** JSON.parse, который хранит целые вне безопасного диапазона точно: `JSON.rawJSON(исходный текст)` при записи обратно. */
function parseExact(text: string): unknown {
  if (rawJson.rawJSON === undefined) return JSON.parse(text);
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' && !Number.isSafeInteger(value) && context?.source !== undefined && /^-?\d+$/.test(context.source) ? rawJson.rawJSON?.(context.source) : value,
  );
}

function maskJson(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretsInText(value);
  if (Array.isArray(value)) return value.map(maskJson);
  if (value !== null && typeof value === 'object') {
    if (rawJson.isRawJSON?.(value) === true) return value;
    const record = value as Record<string, unknown>;
    // `{"name":"password","value":"x"}` и `{"key":"api_key","value":"x"}`: секрет прячет соседнее `value`, а не имя.
    const named = ['name', 'key'].some((field) => typeof record[field] === 'string' && isSecretName(record[field] as string));
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, isSecretName(key) || (named && key === 'value') ? REDACTED : maskJson(item)]));
  }
  return value;
}

/** Тело вида формы: `имя=значение&имя=значение`. Пробелов в закодированной форме нет, поэтому «password=p1 in plain text» — текст. */
const FORM_BODY = /^[^=&\s]+=[^&\s]*(&[^=&\s]+=[^&\s]*)*$/;

/** Тело начинается со скобки — по виду это JSON, какой бы тип ни стоял в заголовке. */
function startsWithBracket(text: string): boolean {
  return /^\s*[[{]/.test(text);
}

/** JSON по типу или по виду: тело с типом text/plain, но в фигурных скобках, тоже маскируется (как в плане C). */
function isJson(text: string, mimeType: string | null): boolean {
  return (mimeType !== null && /json/i.test(mimeType)) || startsWithBracket(text);
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Тип `multipart/*`: границы частей лежат в его параметре `boundary`. */
const MULTIPART_TYPE = /^\s*multipart\//i;

/**
 * JSON, который не разбирается (обрезан источником или битый): маска его не видит — значение у края могло быть
 * отрезано посередине. Такое тело не кладут ни в файл-контекст, ни в ответ агенту.
 */
export function unmaskableJson(text: string, mimeType: string | null): boolean {
  // multipart разбирается по частям (`redactBody`): слово «json» в его границе, а она случайная, JSON его не делает.
  if (mimeType !== null && MULTIPART_TYPE.test(mimeType)) return false;
  return text.trim() !== '' && isJson(text, mimeType) && !parses(text);
}

/** Первые `limit` кодовых точек и пометка обрезки; короче предела — как есть. Тело задаёт страница: строка не раскладывается целиком. */
function cut(text: string, limit: number): string {
  const head = cutCodePoints(text, limit);
  return head.cut ? `${head.text}${S.contextFile.truncated}` : head.text;
}

/** Граница из полного значения Content-Type: `boundary=x` или `boundary="x y"`; нет или пусто — `null`. */
function multipartBoundary(contentType: string): string | null {
  const match = /;\s*boundary\s*=\s*(?:"([^"]*)"|([^\s;]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2] ?? '';
  return boundary === '' ? null : boundary;
}

/** Имя поля из заголовка Content-Disposition части (`name="password"`, `name=password`); заголовка или имени нет — `null`. */
function partName(headerLines: readonly string[]): string | null {
  const disposition = headerLines.find((line) => /^\s*content-disposition\s*:/i.test(line));
  if (disposition === undefined) return null;
  // Параметры разбираются подряд, значение в кавычках съедается целиком: `name=` внутри `filename="a name=b"` — не имя поля.
  // Начало параметра — только `;` или `:`: пробел в стартовом классе даёт квадратичный перебор на длинной серии пробелов.
  for (const [, key, quoted, bare] of disposition.matchAll(/[;:]\s*([^\s;:=]+)\s*=\s*(?:"([^"]*)"|([^\s;]*))/g)) {
    if (key?.toLowerCase() === 'name') return quoted ?? bare ?? '';
  }
  return null;
}

/** Часть multipart после строки её разделителя: заголовки, пустая строка, значение. Значение секретного поля — `<redacted>`. */
function maskPart(lines: readonly string[]): readonly string[] {
  const blank = lines.findIndex((line) => line === '' || line === '\r');
  if (blank === -1) return lines;
  const name = partName(lines.slice(0, blank));
  if (name === null || !isSecretName(name)) return lines;
  // Перевод строки перед следующим разделителем принадлежит разделителю: «\r» на конце последней строки значения остаётся.
  return [...lines.slice(0, blank + 1), lines[lines.length - 1]?.endsWith('\r') === true ? `${REDACTED}\r` : REDACTED];
}

/**
 * Тело `multipart/*`: границу берёт заголовок типа, разделитель — строка, что начинается с `--граница` (RFC 2046, 5.1.1).
 * Строки между разделителями — части, значение части с секретным `name` — `<redacted>`. Преамбулу до первого разделителя и
 * эпилог за закрывающим `--граница--` разбирает тот же `maskPart`: у обычного тела в них нет заголовка части, и они остаются
 * как были. Нет границы в типе или разделителя в теле — тело разобрать нечем, оно целиком `<redacted>`. Тело оборвано на
 * пределе — последняя часть всё равно разбирается.
 */
function redactMultipart(text: string, contentType: string): string {
  const boundary = multipartBoundary(contentType);
  if (boundary === null) return REDACTED;
  const delimiter = `--${boundary}`;
  const out: string[] = [];
  let part: string[] = [];
  let seen = false;
  const flush = (): void => {
    // Цикл, а не `push(...строки)`: на сотнях тысяч строк значения спред роняет стек.
    for (const line of maskPart(part)) out.push(line);
    part = [];
  };
  for (const line of text.split('\n')) {
    if (line.startsWith(delimiter)) {
      flush();
      out.push(line);
      seen = true;
    } else {
      part.push(line);
    }
  }
  flush();
  return seen ? out.join('\n') : REDACTED;
}

/**
 * Тело запроса или ответа с маской: JSON — ключи на любой глубине, форма — параметры, multipart — части с секретным
 * именем, прочее — как есть. Для multipart `mimeType` — значение заголовка Content-Type целиком, с `boundary=`: у запроса
 * оно в его заголовках, а `mimeType` ответа у Chromium без параметров, и такое тело — целиком `<redacted>`. Битый JSON
 * возвращается без изменений — его отсеивает вызывающий (`unmaskableJson`). Разобранный JSON, на который маска не
 * легла, — `<redacted>` целиком. `limit` — в кодовых точках, с пометкой обрезки; режется уже замаскированное.
 * Тело в скобках под типом формы — JSON с неверным заголовком (jQuery со строкой в `data`, старый axios): он идёт
 * как JSON. Как форма он вернулся бы с паролем на месте, а `unmaskableJson` его не отсеял бы — тело разбирается.
 */
export function redactBody(text: string, mimeType: string | null, limit: number = Number.POSITIVE_INFINITY): string {
  let masked = text;
  if (mimeType !== null && MULTIPART_TYPE.test(mimeType)) {
    masked = redactMultipart(text, mimeType);
  } else if (mimeType !== null && /^application\/x-www-form-urlencoded/i.test(mimeType) && !startsWithBracket(text)) {
    masked = redactParams(text);
  } else if (isJson(text, mimeType)) {
    if (!parses(text)) {
      // Битый или обрезанный JSON маской не закрыть: он остаётся как есть, его отсеивает вызывающий (`unmaskableJson`).
      return cut(text, limit);
    }
    try {
      masked = JSON.stringify(maskJson(parseExact(text)), null, 2);
    } catch {
      // Разобрался, но маска не легла (вложенность глубже стека, RangeError): unmaskableJson такое тело не отсеет, поэтому
      // как есть его не отдаём — целиком <redacted>.
      masked = REDACTED;
    }
  } else if (FORM_BODY.test(text) && (mimeType === null || /^\s*text\/plain/i.test(mimeType))) {
    // Форма без своего типа (fetch со строкой в body, text/plain): вид тела — `имя=значение&…`.
    masked = redactParams(text);
  }
  return cut(masked, limit);
}
