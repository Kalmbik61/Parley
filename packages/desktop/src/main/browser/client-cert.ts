/**
 * Клиентский сертификат гостей встроенного браузера (SSO с mTLS). Chromium присылает событие `select-client-certificate`;
 * без обработчика Electron отдал бы сайту первый сертификат из хранилища — личность человека без вопроса. Здесь событие
 * получает ответ по порядку (спека 2026-11-18-browser-client-certificate-design.md, раздел 3 и поправка 1 плана):
 * 1. не гость раздела браузера, нет окна-хозяина или не адрес — `callback()` без сертификата, окну ничего не шлётся;
 * 2. список пуст — `callback()` (событие с пустым списком Chromium не присылает, ветка защитная);
 * 3. для `хост:порт` запомнен отпечаток и он есть в списке — `callback(сертификат)` без вопроса; запомненного в списке нет
 *    (истёк, удалён) — запись снимается, дальше как без неё;
 * 4. иначе — запрос окну-хозяину (`browser:cert-request`): слой над вкладкой, ответ — `browser:cert-response`.
 *
 * Chromium помнит ответ — и сертификат, и отказ — на `хост:порт` до выхода из Parley и сбросить его нельзя (спайк
 * 2026-11-18). Поэтому «не сейчас» (кнопка, Escape, уход со страницы, закрытие вкладки) забывает запрос, НЕ вызывая `callback`,
 * и отпускает все ссылки на него: оставленный запрос кончается сам, следующий запрос спросит человека снова. `callback` зовётся
 * не больше одного раза; у забытого запроса — ни разу.
 *
 * Память Parley — только выбор с галочкой «Remember»: отпечаток по `хост:порт`, файл на диске. Выбор без галочки Parley не
 * хранит: до выхода его помнит сам Chromium. Закрытый ключ, имена субъектов и отпечатки в журнал не идут.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Certificate, WebContents } from 'electron';
import type { BrowserCertCancel, BrowserCertRequest, ClientCertInfo } from '../../shared/client-cert.js';
import { createFileQueue, writeAtomic } from '../atomic-file.js';
import type { BasicAuth } from './basic-auth.js';

/** Подсказка агенту, пока вкладка ждёт выбора сертификата человеком. */
export const CLIENT_CERT_HINT = 'The site asks for a client certificate: ask the human to choose it in the browser panel.';

export type CertOutcome = 'asked' | 'remembered' | 'denied-not-guest' | 'cancelled' | 'chosen';

/**
 * `хост:порт` запроса: из аргумента события (`127.0.0.1:18444`, без схемы) или из адреса `https://…` (порт по умолчанию
 * становится явным: `auth.example.com:443`). Не `https`, не адрес, порт вне 1–65535 — `null`.
 */
export function hostPortOf(value: string): string | null {
  if (value.includes('://')) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:' || parsed.hostname === '') return null;
      return `${parsed.hostname}:${parsed.port === '' ? '443' : parsed.port}`;
    } catch {
      return null;
    }
  }
  const match = /^(\[[0-9a-fA-F:.]+\]|[^\s/:?#@[\]]+):(\d{1,5})$/.exec(value);
  if (match === null) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return `${(match[1] ?? '').toLowerCase()}:${port}`;
}

export interface CertChoiceStore {
  /** Читает файл; битый (не JSON, не та форма) — пустая память без исключения, файл не трогается до первой записи. */
  load(): Promise<void>;
  get(hostPort: string): string | null;
  /** Только выбор с галочкой; всегда на диск. */
  set(hostPort: string, fingerprint: string): Promise<void>;
  delete(hostPort: string): Promise<void>;
  /** Память и файл. */
  clear(): Promise<void>;
}

interface ChoicesFile {
  version: 1;
  choices: Record<string, string>;
}

export function createCertChoiceStore(deps: { file: string }): CertChoiceStore {
  const choices = new Map<string, string>();
  const enqueue = createFileQueue();
  /** Файл уже прочитан в память: до этого запись затёрла бы чужие выборы, которых память ещё не знает. */
  let loaded = false;

  /** Заменяет память содержимым файла; битый или отсутствующий файл — пусто. Зовётся только внутри очереди. */
  const read = async (): Promise<void> => {
    loaded = true;
    choices.clear();
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(deps.file, 'utf8'));
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
    const raw = (parsed as { choices?: unknown }).choices;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
    for (const [hostPort, fingerprint] of Object.entries(raw)) {
      if (typeof fingerprint === 'string' && fingerprint !== '') choices.set(hostPort, fingerprint);
    }
  };

  const persist = (): Promise<void> => {
    const body: ChoicesFile = { version: 1, choices: Object.fromEntries(choices) };
    return writeAtomic(deps.file, `${JSON.stringify(body, null, 2)}\n`);
  };

  /**
   * Изменения идут через ту же очередь, что и `load`, и до первой записи читают файл: `set` или `delete` до окончания
   * `load` не теряются и не затирают выборы, записанные раньше. Память меняется в очереди, `get` видит результат после `await`.
   */
  const mutate = (change: () => void): Promise<void> =>
    enqueue(async () => {
      if (!loaded) await read();
      change();
      await persist();
    });

  return {
    load: () => enqueue(read),
    get: (hostPort) => choices.get(hostPort) ?? null,
    set: (hostPort, fingerprint) => mutate(() => void choices.set(hostPort, fingerprint)),
    delete: (hostPort) => mutate(() => void choices.delete(hostPort)),
    clear: () => mutate(() => choices.clear()),
  };
}

export interface ClientCert {
  /** Обработчик `select-client-certificate` (страж зовёт после `preventDefault`). Вызывает `callback` не больше одного раза. */
  select(contents: WebContents | null, url: string, list: Certificate[], callback: (certificate?: Certificate) => void): void;
  /** Подписывает гостя: уход со страницы и закрытие забывают его запросы. Зовёт страж на каждого гостя раздела. */
  attach(contents: WebContents): void;
  /** Вкладка ждёт выбора человека. */
  isPending(contentsId: number): boolean;
  /** Вызов, когда вкладка начинает ждать выбора; возвращает отписку. */
  onPending(contentsId: number, listener: () => void): () => void;
  /** Ответ окна (`browser:cert-response`): отпечаток или `null` («не сейчас»); чужой отправитель и неизвестный id игнорируются. */
  answer(requestId: string, fingerprint: string | null, remember: boolean, sender: WebContents): void;
  /** «Clear browsing data»: память и файл выборов с галочкой. */
  clear(): Promise<void>;
}

/** Запрос одного `хост:порт` на одной вкладке. `callbacks` — все события, ждущие этого же ответа. */
interface Request {
  hostPort: string;
  pageHost: string | null;
  list: Certificate[];
  callbacks: Array<(certificate?: Certificate) => void>;
  requestId: string | null;
}

interface Tab {
  host: WebContents;
  active: Request | null;
  queue: Request[];
}

export function createClientCert(deps: {
  isGuest(contents: WebContents): boolean;
  store: CertChoiceStore;
  newId?(): string;
  log?(line: { host: string; count: number; outcome: CertOutcome }): void;
}): ClientCert {
  const newId = deps.newId ?? randomUUID;
  const tabs = new Map<number, Tab>();
  const listeners = new Map<number, Set<() => void>>();

  const log = (host: string, count: number, outcome: CertOutcome): void => deps.log?.({ host, count, outcome });

  const infoOf = (cert: Certificate): ClientCertInfo => ({
    fingerprint: cert.fingerprint,
    subjectName: cert.subjectName,
    issuerName: cert.issuerName,
    serialNumber: cert.serialNumber,
    validExpiry: cert.validExpiry,
  });

  /** Хост страницы гостя, если его `хост:порт` не тот, что просит сертификат. */
  function pageHostOf(contents: WebContents, hostPort: string): string | null {
    const url = contents.getURL();
    const pagePort = hostPortOf(url);
    if (pagePort === null || pagePort === hostPort) return null;
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  }

  /** Показать окну следующий запрос вкладки, если слой свободен. */
  function showNext(contentsId: number): void {
    const tab = tabs.get(contentsId);
    if (tab === undefined || tab.active !== null) return;
    const next = tab.queue.shift();
    if (next === undefined) {
      tabs.delete(contentsId);
      return;
    }
    if (tab.host.isDestroyed()) {
      forgetAll(contentsId, false);
      return;
    }
    next.requestId = newId();
    tab.active = next;
    tab.host.send('browser:cert-request', {
      requestId: next.requestId,
      webContentsId: contentsId,
      host: next.hostPort,
      pageHost: next.pageHost,
      certificates: next.list.map(infoOf),
    } satisfies BrowserCertRequest);
    for (const listener of [...(listeners.get(contentsId) ?? [])]) listener();
  }

  /**
   * Забыть все запросы вкладки без `callback` (уход со страницы, закрытие): оставленный запрос Chromium кончает сам,
   * следующий спросит человека снова. Ссылки на `callback` отпускаются. Окну — убрать слой.
   */
  function forgetAll(contentsId: number, tellWindow: boolean): void {
    const tab = tabs.get(contentsId);
    if (tab === undefined) return;
    tabs.delete(contentsId);
    const shown = tab.active;
    for (const request of [...(shown === null ? [] : [shown]), ...tab.queue]) log(request.hostPort, request.list.length, 'cancelled');
    if (shown !== null && shown.requestId !== null && tellWindow && !tab.host.isDestroyed()) {
      tab.host.send('browser:cert-cancel', { requestId: shown.requestId, webContentsId: contentsId } satisfies BrowserCertCancel);
    }
  }

  return {
    select(contents, url, list, callback) {
      const hostPort = hostPortOf(url);
      const label = hostPort ?? 'unknown';
      if (contents === null || !deps.isGuest(contents)) {
        log(label, list.length, 'denied-not-guest');
        callback();
        return;
      }
      const host = contents.hostWebContents;
      if (hostPort === null || host === undefined || host === null || host.isDestroyed()) {
        log(label, list.length, 'denied-not-guest');
        callback();
        return;
      }
      if (list.length === 0) {
        callback();
        return;
      }
      const remembered = deps.store.get(hostPort);
      if (remembered !== null) {
        const cert = list.find((item) => item.fingerprint === remembered);
        if (cert !== undefined) {
          log(hostPort, list.length, 'remembered');
          callback(cert);
          return;
        }
        // Запомненный сертификат пропал (истёк, удалён): запись снимается, человека спрашиваем.
        void deps.store.delete(hostPort).catch(() => undefined);
      }
      log(hostPort, list.length, 'asked');
      const id = contents.id;
      const tab = tabs.get(id) ?? { host, active: null, queue: [] };
      tabs.set(id, tab);
      const same = [tab.active, ...tab.queue].find((request) => request?.hostPort === hostPort);
      if (same !== undefined && same !== null) {
        same.callbacks.push(callback);
        return;
      }
      tab.queue.push({ hostPort, pageHost: pageHostOf(contents, hostPort), list, callbacks: [callback], requestId: null });
      showNext(id);
    },
    attach(contents) {
      const id = contents.id;
      // Человек (или агент) ушёл с вкладки, пока шёл запрос: ждать ответа некому.
      contents.on('did-start-navigation', (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
        if (details.isMainFrame && !details.isSameDocument) forgetAll(id, true);
      });
      contents.once('destroyed', () => {
        forgetAll(id, false);
        listeners.delete(id);
      });
    },
    isPending: (id) => (tabs.get(id)?.active ?? null) !== null,
    onPending(id, listener) {
      const set = listeners.get(id) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(id, set);
      return () => set.delete(listener);
    },
    answer(requestId, fingerprint, remember, sender) {
      for (const [contentsId, tab] of tabs) {
        const request = tab.active;
        if (request === null || request.requestId !== requestId || tab.host !== sender) continue;
        tab.active = null;
        const chosen = fingerprint === null ? undefined : request.list.find((cert) => cert.fingerprint === fingerprint);
        if (chosen === undefined) {
          // «Не сейчас» или отпечаток не из списка запроса: запрос забывается без `callback`. Окно, приславшее чужой
          // отпечаток, слой могло не снять — шлём отмену.
          log(request.hostPort, request.list.length, 'cancelled');
          if (fingerprint !== null && !tab.host.isDestroyed()) {
            tab.host.send('browser:cert-cancel', { requestId, webContentsId: contentsId } satisfies BrowserCertCancel);
          }
        } else {
          log(request.hostPort, request.list.length, 'chosen');
          if (remember) void deps.store.set(request.hostPort, chosen.fingerprint).catch(() => undefined);
          for (const callback of request.callbacks) callback(chosen);
        }
        showNext(contentsId);
        return;
      }
    },
    clear: () => deps.store.clear(),
  };
}

/** Ожидание человека для `settleLoad`: basic-auth или сертификат. Оба `undefined` — `undefined`. */
export function humanWait(
  basicAuth?: Pick<BasicAuth, 'isPending' | 'onPending'>,
  clientCert?: Pick<ClientCert, 'isPending' | 'onPending'>,
): Pick<BasicAuth, 'isPending' | 'onPending'> | undefined {
  const parts = [basicAuth, clientCert].filter((part): part is Pick<BasicAuth, 'isPending' | 'onPending'> => part !== undefined);
  if (parts.length === 0) return undefined;
  return {
    isPending: (id) => parts.some((part) => part.isPending(id)),
    onPending(id, listener) {
      const offs = parts.map((part) => part.onPending(id, listener));
      return () => {
        for (const off of offs) off();
      };
    },
  };
}
