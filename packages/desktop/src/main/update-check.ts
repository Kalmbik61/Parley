/**
 * Проверка новой версии (V6 плана релиза 0.1.0). Без подписи Apple автообновления на macOS нет, поэтому окно только
 * сообщает: main при старте и раз в сутки спрашивает GitHub о последнем релизе, а окно показывает тост со ссылкой
 * на страницу релиза (`renderer/update/update-notice.ts`). Ничего не скачивается и не ставится.
 *
 * Сеть — один запрос `GET releases/latest` без токенов и куки. Черновики и prerelease этот адрес не отдаёт, а
 * разбор отвергает их ещё раз. Любая беда (нет сети, 403 от лимита GitHub, 404 до первого релиза, чужой JSON,
 * ответ больше предела, таймаут 10 с) — «нового нет» и тишина: человек про неё не узнаёт.
 *
 * Выключается переключателем «Check for updates» (`ui.json`) и `PARLEY_UPDATE_CHECK=off` (тесты, E2E, закрытая
 * сеть); оба читаются перед каждой проверкой, так что выключение действует сразу.
 */

import { envValue, type Env } from '@parley/core';
import type { UpdateInfo } from '../shared/bridge.js';

export const RELEASES_LATEST_URL = 'https://api.github.com/repos/Kalmbik61/Parley/releases/latest';
export const CHECK_TIMEOUT_MS = 10_000;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Ответ GitHub — JSON в десятки килобайт (заметки релиза — до 125 000 знаков); больше мегабайта — не наш ответ. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** `PARLEY_UPDATE_CHECK=off`: проверки нет вовсе. Прочие значения (и пустое) её не трогают. */
export function updateCheckOff(env: Env): boolean {
  return envValue(env, 'UPDATE_CHECK')?.trim().toLowerCase() === 'off';
}

interface ParsedVersion {
  core: [number, number, number];
  /** Части после `-` (`rc.1` → `['rc', '1']`); пусто — стабильный релиз. Метаданные сборки после `+` не учитываются. */
  pre: string[];
}

const VERSION =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** `v1.2.3`, `1.2.3`, `1.2.3-rc.1`; всё прочее и числа за пределами точного целого — `null`. */
function parseVersion(text: string): ParsedVersion | null {
  const match = VERSION.exec(text.trim());
  if (match === null) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  if (!core.every((part) => Number.isSafeInteger(part))) return null;
  return { core, pre: match[4] === undefined ? [] : match[4].split('.') };
}

const NUMERIC = /^\d+$/;

/** Старшинство частей prerelease по semver 2.0.0, п. 11: числа меньше строк, числа — по значению, строки — по ASCII. */
function comparePre(a: string[], b: string[]): number {
  // Стабильный релиз старше любого prerelease той же версии.
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const left = a[index] as string;
    const right = b[index] as string;
    if (left === right) continue;
    const leftNumeric = NUMERIC.test(left);
    const rightNumeric = NUMERIC.test(right);
    if (leftNumeric && rightNumeric) {
      // BigInt: часть из сотни цифр точным числом не станет, а порядок у неё всё равно есть.
      const difference = BigInt(left) - BigInt(right);
      if (difference !== 0n) return difference > 0n ? 1 : -1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return Math.sign(a.length - b.length);
}

/** −1, 0, 1 — как у `sort`; `null`, если хоть одна из строк не версия. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return null;
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.core[index] as number) - (right.core[index] as number);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return comparePre(left.pre, right.pre) as -1 | 0 | 1;
}

/** `candidate` строго новее `current`. Не версия — не новее: незнакомый ответ тоста не даёт. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1;
}

/** Адрес из `html_url`: только `https://github.com/…` без логина, пароля и порта — открывается в браузере человека. */
function isReleasePage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.host === 'github.com' &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

/**
 * Разбор ответа `releases/latest`: стабильный релиз с версией `X.Y.Z` в `tag_name` и страницей на GitHub в
 * `html_url`. Черновик, prerelease, тег с суффиксом (`v1.0.0-rc.1`), чужой адрес и любая другая форма — `null`.
 */
export function parseLatestRelease(body: unknown): UpdateInfo | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const release = body as Record<string, unknown>;
  if (release.draft === true || release.prerelease === true) return null;
  if (typeof release.tag_name !== 'string' || typeof release.html_url !== 'string') return null;
  const version = parseVersion(release.tag_name);
  if (version === null || version.pre.length > 0) return null;
  if (!isReleasePage(release.html_url)) return null;
  return { version: version.core.join('.'), url: release.html_url };
}

/**
 * Запрос к GitHub: `net.fetch` Electron в `main/index.ts` (стек Chromium, системный прокси), в тестах — подставной.
 * `credentials: 'omit'` — куки не уходят; токена нет вовсе.
 */
export type UpdateFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; credentials: 'omit' },
) => Promise<Response>;

/** Тело потоком до предела; больше — `null` и обрыв чтения, а не `text()` целиком. */
async function readLimitedText(response: Response): Promise<string | null> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function download(fetch: UpdateFetch, signal: AbortSignal): Promise<UpdateInfo | null> {
  const response = await fetch(RELEASES_LATEST_URL, {
    // GitHub требует `User-Agent`: константа без версии окна и без Chromium. `Accept-Language` стек Chromium дописал бы
    // по системной локали человека, а языка GitHub не нужно — запрос его не выдаёт.
    headers: {
      Accept: 'application/vnd.github+json',
      'Accept-Language': 'en',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Parley',
    },
    signal,
    credentials: 'omit',
  });
  if (!response.ok) {
    // Тело не читается вовсе: соединение отпускаем сразу.
    void response.body?.cancel().catch(() => {});
    return null;
  }
  const text = await readLimitedText(response);
  return text === null ? null : parseLatestRelease(JSON.parse(text));
}

/**
 * Последний стабильный релиз; `null` — любая неудача, исключений нет. За `timeoutMs` — гонка с таймером, а не только
 * `AbortSignal`: `fetch`, который сигнал не слушает, всё равно не держит проверку дольше предела.
 */
export async function fetchLatestRelease(
  fetch: UpdateFetch,
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<UpdateInfo | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([download(fetch, controller.signal).catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface UpdateChecker {
  /** Первая проверка — сразу, дальше раз в сутки. Повторный вызов ничего не меняет. */
  start(): void;
  stop(): void;
  /** Релиз новее запущенной версии из последней удачной проверки; `null` — его нет, проверка выключена или ещё не ответила. */
  latest(): Promise<UpdateInfo | null>;
}

export interface UpdateCheckerOptions {
  /** Версия запущенного окна (`app.getVersion()`). */
  currentVersion: string;
  fetch: UpdateFetch;
  /** Проверка включена: переменная окружения и переключатель в настройках. Читается перед каждой проверкой и ответом `latest`. */
  isEnabled: () => boolean | Promise<boolean>;
  /** Найден релиз новее запущенной версии: окно получит его событием; позже — по запросу (`latest`). */
  onUpdate: (info: UpdateInfo) => void;
  intervalMs?: number;
}

export function createUpdateChecker(options: UpdateCheckerOptions): UpdateChecker {
  const { currentVersion, fetch, isEnabled, onUpdate, intervalMs = CHECK_INTERVAL_MS } = options;
  let found: UpdateInfo | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  // Отказ чтения настройки — «выключено»: лучше не спросить, чем спросить против воли человека.
  const enabled = async (): Promise<boolean> => {
    try {
      return await isEnabled();
    } catch {
      return false;
    }
  };

  // Не бросает никогда: отказавший промис без обработчика в main показал бы человеку окно с ошибкой JavaScript.
  const check = async (): Promise<void> => {
    try {
      if (!(await enabled())) return;
      const release = await fetchLatestRelease(fetch);
      // Неудача проверки прежний ответ не отменяет: найденный релиз остаётся найденным.
      if (release === null) return;
      found = isNewerVersion(release.version, currentVersion) ? release : null;
      if (found !== null) onUpdate(found);
    } catch {
      // Молчим.
    }
  };

  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(() => void check(), intervalMs);
      void check();
    },
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
    latest: async () => ((await enabled()) ? found : null),
  };
}
