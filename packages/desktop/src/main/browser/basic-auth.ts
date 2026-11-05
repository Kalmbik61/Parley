/**
 * HTTP basic-auth гостей встроенного браузера. Chromium присылает событие `login` гостя `<webview>`; без обработчика Electron
 * отменяет вызов, и вкладка остаётся на 401. Здесь событие получает ответ из трёх мест, по порядку:
 * 1. учётные данные из адреса (`https://user:pass@host`): адрес очищен раньше (окно — адресная строка, `openableTarget` — агент),
 *    а пара лежит здесь, в памяти, на вкладку и origin — и отвечает на первый вызов этого origin;
 * 2. сервер их отклонил (вызов повторился, пока страница не догрузилась) — запись снимается, окну уходит запрос с `retry`;
 * 3. иначе — запрос окну-хозяину гостя (`browser:auth-request`): оверлей над вкладкой, ответ — `browser:auth-response`.
 *
 * Пароль не пишется на диск, в журналы, раскладку, историю и ответы агентам; он идёт только main ↔ окно своей вкладки.
 * Агенту видно лишь «вкладка ждёт вход» (`BASIC_AUTH_HINT`).
 *
 * Привязка «вкладка + origin» относится к данным, которыми ещё не отвечали. Ответив, Chromium кладёт пару в кэш HTTP-авторизации
 * сессии раздела — он общий для всех вкладок и живёт до перезапуска, как в обычном браузере (решение владельца 2026-11-05):
 * один вход на стенд для всех вкладок. Раздел и сессию мы не дробим.
 *
 * Пара из `browser_open` агента держится за логической страницей (`pageId`), а не за origin: main кладёт её после проверок
 * доступа и ответа окна, а гостю отдаёт, когда страница монтируется (`claimPage` — до первой загрузки). Чужая вкладка того же
 * origin её не получит, параллельные `open` друг друга не затирают, срока жизни у неё нет: она снимается при закрытии страницы.
 */
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import type { BasicCredentials, BrowserAuthCancel, BrowserAuthRequest } from '../../shared/basic-auth.js';

/** Подсказка агенту, пока вкладка ждёт логин и пароль человека (спека задачи, пункт D). */
export const BASIC_AUTH_HINT = 'The page asks for HTTP basic auth: pass user:pass@ in the URL or ask the human to sign in in the browser panel.';

export type AuthDecision = { kind: 'credentials'; credentials: BasicCredentials } | { kind: 'prompt'; retry: boolean };

export interface CredentialStore {
  /** Пара из адреса для вкладки и origin. */
  remember(contentsId: number, origin: string, credentials: BasicCredentials): void;
  /** Пара из `open` агента за логической страницей: гость ещё не смонтирован, `claimPage` отдаст её ему (и только ему). */
  holdForPage(pageId: string, origin: string, credentials: BasicCredentials): void;
  /** Гость страницы смонтирован: пара, ждавшая страницу, становится парой его вкладки (до первой загрузки). Нет пары — ничего. */
  claimPage(contentsId: number, pageId: string): void;
  /** Страница закрыта: пара, ждавшая её, снимается. */
  dropPage(pageId: string): void;
  /** Что ответить на вызов. Прокси и отклонённая пара — только запрос; пара используется один раз за загрузку. */
  decide(contentsId: number, origin: string): AuthDecision;
  /** Человек ввёл данные в ответ на запрос: следующий такой же вызов — повтор. */
  answered(contentsId: number, origin: string): void;
  /** Человек отменил запрос: вызов не считается неверным ответом. */
  cancelled(contentsId: number, origin: string): void;
  /** Загрузка кончилась (успех, 401-страница): «ответили, ждём вердикт» сбрасывается. */
  settle(contentsId: number): void;
  /** Гость закрыт. */
  forget(contentsId: number): void;
}

export function createCredentialStore(): CredentialStore {
  /** Вкладка → origin → пара из адреса. */
  const stored = new Map<number, Map<string, BasicCredentials>>();
  /** Вкладка → origins, на чей вызов уже отвечали и вердикта (конца загрузки) ещё нет. */
  const waiting = new Map<number, Set<string>>();
  /** Логическая страница → пара из `open` агента. */
  const held = new Map<string, { origin: string; credentials: BasicCredentials }>();

  const mark = (id: number, origin: string): void => {
    const set = waiting.get(id) ?? new Set<string>();
    set.add(origin);
    waiting.set(id, set);
  };

  const remember = (id: number, origin: string, credentials: BasicCredentials): void => {
    const map = stored.get(id) ?? new Map<string, BasicCredentials>();
    map.set(origin, credentials);
    stored.set(id, map);
  };

  return {
    remember,
    holdForPage(pageId, origin, credentials) {
      held.set(pageId, { origin, credentials });
    },
    claimPage(id, pageId) {
      const entry = held.get(pageId);
      if (entry === undefined) return;
      held.delete(pageId);
      remember(id, entry.origin, entry.credentials);
    },
    dropPage(pageId) {
      held.delete(pageId);
    },
    decide(id, origin) {
      if (waiting.get(id)?.has(origin) === true) {
        // Вызов повторился: пара, на которую ответили, неверна — вторично её не шлём.
        stored.get(id)?.delete(origin);
        return { kind: 'prompt', retry: true };
      }
      const credentials = stored.get(id)?.get(origin);
      if (credentials === undefined) return { kind: 'prompt', retry: false };
      mark(id, origin);
      return { kind: 'credentials', credentials };
    },
    answered: mark,
    cancelled(id, origin) {
      waiting.get(id)?.delete(origin);
    },
    settle(id) {
      waiting.delete(id);
    },
    forget(id) {
      stored.delete(id);
      waiting.delete(id);
    },
  };
}

/** Ответ окна на запрос: данные или отмена (`null`). */
export type AuthAnswer = BasicCredentials | null;

export interface BasicAuth {
  /** Подписывает гостя: `login`, уход со страницы, закрытие. Зовёт страж на каждого гостя раздела. */
  attach(contents: WebContents): void;
  /**
   * Пара для вкладки (переход человека, `navigate` агента, повторный `open` той же страницы). Если вкладка уже ждёт ответа
   * человека на вызов этого origin, этот вызов отвечается парой, а оверлей окна снимается.
   */
  remember(contentsId: number, origin: string, credentials: BasicCredentials): void;
  /** Пара из `open` агента за логической страницей (см. `CredentialStore.holdForPage`). */
  holdForPage(pageId: string, origin: string, credentials: BasicCredentials): void;
  /** Окно смонтировало гостя страницы: пара, ждавшая страницу, привязывается к гостю — до первой загрузки. */
  claimPage(contentsId: number, pageId: string): void;
  /** Страница закрыта: пара, ждавшая её, снимается. */
  dropPage(pageId: string): void;
  /** Вкладка ждёт ответа человека. */
  isPending(contentsId: number): boolean;
  /** Вызов, когда вкладка начинает ждать ответа; возвращает отписку. */
  onPending(contentsId: number, listener: () => void): () => void;
  /** Ответ окна (`browser:auth-response`); чужой отправитель или поздний id игнорируются. */
  answer(requestId: string, answer: AuthAnswer, sender: WebContents): void;
}

interface Prompt {
  requestId: string;
  host: WebContents;
  origin: string;
  callback(username?: string, password?: string): void;
}

export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function createBasicAuth(deps: { store?: CredentialStore; newId?(): string } = {}): BasicAuth {
  const store = deps.store ?? createCredentialStore();
  const newId = deps.newId ?? randomUUID;
  const prompts = new Map<number, Prompt>();
  const listeners = new Map<number, Set<() => void>>();

  /** Снять запрос: ответ Chromium, окну — убрать оверлей. */
  function finish(contentsId: number, answer: AuthAnswer, tellWindow: boolean): void {
    const prompt = prompts.get(contentsId);
    if (prompt === undefined) return;
    prompts.delete(contentsId);
    if (answer === null) {
      store.cancelled(contentsId, prompt.origin);
      prompt.callback();
    } else {
      store.answered(contentsId, prompt.origin);
      prompt.callback(answer.username, answer.password);
    }
    if (tellWindow && !prompt.host.isDestroyed()) {
      prompt.host.send('browser:auth-cancel', { requestId: prompt.requestId, webContentsId: contentsId } satisfies BrowserAuthCancel);
    }
  }

  return {
    attach(contents) {
      const id = contents.id;
      contents.on('login', (event, details, info, callback) => {
        // Другие схемы (digest, ntlm) окна не имеют — вызов отменяется Electron'ом по умолчанию.
        if (info.scheme !== 'basic') return;
        event.preventDefault();
        const host = contents.hostWebContents;
        if (host === undefined || host === null || host.isDestroyed() || prompts.has(id)) {
          callback();
          return;
        }
        const shown = originOf(details.url);
        const key = info.isProxy ? `proxy:${info.host}:${info.port}` : (shown ?? `${info.host}:${info.port}`);
        // Ключ прокси не совпадает ни с одним origin адреса: пары в хранилище у него нет, остаётся запрос (и его повтор).
        const decision = store.decide(id, key);
        if (decision.kind === 'credentials') {
          callback(decision.credentials.username, decision.credentials.password);
          return;
        }
        const requestId = newId();
        prompts.set(id, { requestId, host, origin: key, callback });
        const hostLabel = info.isProxy || shown === null ? `${info.host}:${info.port}` : new URL(shown).host;
        host.send('browser:auth-request', { requestId, webContentsId: id, host: hostLabel, realm: info.realm, isProxy: info.isProxy, retry: decision.retry } satisfies BrowserAuthRequest);
        for (const listener of [...(listeners.get(id) ?? [])]) listener();
      });
      // Человек (или агент) ушёл с вкладки, пока шёл запрос: ждать ответа некому.
      contents.on('did-start-navigation', (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
        if (details.isMainFrame && !details.isSameDocument) finish(id, null, true);
      });
      contents.on('did-stop-loading', () => store.settle(id));
      contents.once('destroyed', () => {
        finish(id, null, false);
        store.forget(id);
        listeners.delete(id);
      });
    },
    remember(id, origin, credentials) {
      store.remember(id, origin, credentials);
      // Вкладка ждёт человека на вызов этого origin: отвечаем ему данными из адреса (не-прокси), оверлей окна снимаем.
      if (prompts.get(id)?.origin === origin) finish(id, credentials, true);
    },
    holdForPage: (pageId, origin, credentials) => store.holdForPage(pageId, origin, credentials),
    claimPage: (id, pageId) => store.claimPage(id, pageId),
    dropPage: (pageId) => store.dropPage(pageId),
    isPending: (id) => prompts.has(id),
    onPending(id, listener) {
      const set = listeners.get(id) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(id, set);
      return () => set.delete(listener);
    },
    answer(requestId, answer, sender) {
      for (const [contentsId, prompt] of prompts) {
        if (prompt.requestId === requestId && prompt.host === sender) {
          finish(contentsId, answer, false);
          return;
        }
      }
    },
  };
}
