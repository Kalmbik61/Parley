// packages/desktop/src/main/browser/inspector.ts
/**
 * Инспектор вкладок браузера (спека 2026-10-07-browser-devtools-agent-design.md, 3.3; индекс плана, «Общие имена»).
 *
 * `webContents.debugger` подключается к каждому гостю-браузеру на `web-contents-created` (`guard.ts`), пока гость
 * пуст (спайк 0.1, вариант D: `<webview>` стартует с `about:blank`, окно открывает адрес вкладки после `ready`):
 * `Runtime`, `Log`, `Page` и `Network` с буферами раздела 8. События переводит `cdp-entries.ts`; журнал — кольца на
 * вкладку (1000 сообщений, 500 запросов), одинаковые сообщения подряд — одна запись с `count`. Эпоха — номер документа
 * главного фрейма: растёт на `Page.frameNavigated` без `parentId`, и запросы с `loaderId` нового документа (сам
 * документ уходит до коммита) переходят в неё.
 *
 * Окну журнал идёт пачками (`onBatch`) не чаще раза в 150 мс и не больше 200 записей — сверх них самые свежие
 * изменения; остальное отдаёт `snapshot`. Команды CDP — только из `CDP_ALLOWED`, у каждой тайм-аут: без страницы
 * `enable` висит (проба 1.4). `ready` отвечает, когда все четыре `enable` отработали — ответом, отказом или
 * тайм-аутом. Не подключился или отцепился — `capture: 'unavailable'` и новая попытка на следующей навигации
 * главного фрейма.
 *
 * События CDP — данные страницы: обработчик отладчика не бросает наружу (исключение в main — окно ошибки Electron),
 * сбой разбора одного события пишется в журнал main и не мешает следующим.
 */
import type { WebContents } from 'electron';
import {
  DEVTOOLS_LIMITS,
  type CaptureState,
  type ConsoleEntry,
  type DevtoolsBatch,
  type DevtoolsSnapshot,
  type NetworkEntry,
  type ResponseBody,
} from '../../shared/browser-devtools.js';
import {
  clip,
  consoleFromApi,
  consoleFromException,
  consoleFromLog,
  failureOf,
  headerPairs,
  networkKind,
  postDataOf,
  remoteAddress,
  type ConsoleApiParams,
  type ConsoleDraft,
  type ExceptionParams,
  type LogParams,
} from './cdp-entries.js';

export type CdpMethod = string;

/**
 * Закрытый список команд CDP (спека 3.3). Этап A — включение доменов, тело ответа и эмуляция размера. Этап B добавит
 * DOM, Accessibility, снимки и `Runtime.callFunctionOn` с `REACT_INFO_FN`, этап C — тело запроса. `Runtime.evaluate`
 * здесь не бывает никогда.
 */
export const CDP_ALLOWED: ReadonlySet<CdpMethod> = new Set<CdpMethod>([
  'Runtime.enable',
  'Runtime.disable',
  'Log.enable',
  'Log.disable',
  'Page.enable',
  'Page.disable',
  'Network.enable',
  'Network.disable',
  'Network.getResponseBody',
  'Emulation.setDeviceMetricsOverride',
  'Emulation.clearDeviceMetricsOverride',
  'Emulation.setTouchEmulationEnabled',
  'Emulation.setUserAgentOverride',
]);

/** Тайм-аут команды CDP (спайк 0.1): без страницы `enable` висит; дольше него `ready` страницу вкладки не держит. */
export const CDP_COMMAND_MS = 10_000;

export interface Inspector {
  attach(contents: WebContents): void;
  /**
   * Подключение закончено: все `enable` ответили, отказали или вышли по `CDP_COMMAND_MS` (спайк 0.1, вариант D).
   * Окно открывает адрес вкладки после этого. Журнала нет или гость уничтожен — готово сразу; не бросает.
   */
  ready(id: number): Promise<void>;
  snapshot(id: number): DevtoolsSnapshot | null;
  clear(id: number): void;
  responseBody(id: number, requestId: string, limit: number): Promise<ResponseBody | null>;
  send<T = unknown>(id: number, method: CdpMethod, params?: Record<string, unknown>): Promise<T>;
  onBatch(listener: (batch: DevtoolsBatch) => void): () => void;
  onEvent(id: number, method: string, listener: (params: unknown) => void): () => void;
}

interface NetRecord {
  entry: NetworkEntry;
  /** Документ запроса: по нему запрос переходит в эпоху нового документа. */
  loaderId: string;
  /** Монотонное время CDP начала, секунды: для длительности. */
  started: number;
}

interface Journal {
  id: number;
  attached: boolean;
  /** Все `enable` последнего подключения отработали; до подключения и после его отказа — уже готово. */
  ready: Promise<void>;
  epoch: number;
  capture: CaptureState;
  nextId: number;
  console: ConsoleEntry[];
  network: Map<string, NetRecord>;
  /** Изменённое с прошлой пачки: `c<id>` или `n<requestId>` → номер изменения. */
  pending: Map<string, number>;
  seq: number;
  reset: boolean;
  dirty: boolean;
  cancelFlush: (() => void) | null;
}

const ENABLE: ReadonlyArray<readonly [CdpMethod, Record<string, unknown>?]> = [
  ['Runtime.enable'],
  ['Log.enable'],
  ['Page.enable'],
  [
    'Network.enable',
    {
      maxResourceBufferSize: DEVTOOLS_LIMITS.resourceBuffer,
      maxTotalBufferSize: DEVTOOLS_LIMITS.totalBuffer,
      // Самое длинное тело запроса, которое Chromium кладёт в requestWillBeSent; сверх предела postData режет и cdp-entries.
      maxPostDataSize: DEVTOOLS_LIMITS.postData,
    },
  ],
];

const fields = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

function isHttp(url: string | undefined): boolean {
  return url !== undefined && /^https?:/i.test(url);
}

/** Данные страницы и слушатели чужого кода не должны ронять main: сбой — в журнал, дальше всё идёт как шло. */
function guarded(label: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    console.warn(`[parley] devtools ${label} failed`, error);
  }
}

function sameMessage(entry: ConsoleEntry, draft: ConsoleDraft): boolean {
  return (
    entry.level === draft.level &&
    entry.origin === draft.origin &&
    entry.text === draft.text &&
    entry.location?.url === draft.location?.url &&
    entry.location?.line === draft.location?.line &&
    entry.location?.column === draft.location?.column
  );
}

function durationOf(record: NetRecord, timestamp: unknown): number | null {
  const end = num(timestamp);
  return end === undefined || record.started <= 0 ? null : Math.max(0, Math.round((end - record.started) * 1000));
}

function respond(record: NetRecord, data: Record<string, unknown>): void {
  const response = fields(data.response);
  const entry = record.entry;
  entry.status = num(response.status) ?? null;
  entry.statusText = clip(str(response.statusText) ?? '', DEVTOOLS_LIMITS.headerValue);
  const mimeType = str(response.mimeType);
  entry.mimeType = mimeType === undefined ? null : clip(mimeType, DEVTOOLS_LIMITS.headerValue);
  entry.responseHeaders = headerPairs(response.headers);
  entry.remoteAddress = remoteAddress(response);
  entry.fromCache = entry.fromCache || response.fromDiskCache === true || response.fromPrefetchCache === true;
  const type = str(data.type);
  if (type !== undefined) entry.kind = networkKind(type);
}

export function createInspector(deps: {
  fromId(id: number): WebContents | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
}): Inspector {
  const now = deps.now ?? Date.now;
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number): (() => void) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
  const journals = new Map<number, Journal>();
  const batchListeners = new Set<(batch: DevtoolsBatch) => void>();
  const eventListeners = new Map<number, Map<string, Set<(params: unknown) => void>>>();

  function command<T>(contents: WebContents, method: CdpMethod, params?: Record<string, unknown>): Promise<T> {
    if (!CDP_ALLOWED.has(method)) return Promise.reject(new Error(`CDP method not allowed: ${method}`));
    return new Promise<T>((resolve, reject) => {
      const cancel = setTimer(() => reject(new Error(`CDP command timed out: ${method}`)), CDP_COMMAND_MS);
      contents.debugger.sendCommand(method, params).then(
        (result: unknown) => {
          cancel();
          resolve(result as T);
        },
        (error: unknown) => {
          cancel();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  function flush(journal: Journal): void {
    journal.cancelFlush = null;
    if (!journal.dirty) return;
    journal.dirty = false;
    // Сверх 200 — самые свежие изменения (Фокус ревью 1): окно не тонет в болтливой консоли, всё кольцо отдаёт snapshot.
    const keys = new Set(
      [...journal.pending.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(-DEVTOOLS_LIMITS.batchMax)
        .map(([key]) => key),
    );
    journal.pending.clear();
    const batch: DevtoolsBatch = {
      webContentsId: journal.id,
      epoch: journal.epoch,
      capture: journal.capture,
      reset: journal.reset,
      // Порядок колец: окно дописывает новые записи в конец.
      console: journal.console.filter((entry) => keys.has(`c${entry.id}`)).map((entry) => ({ ...entry })),
      network: [...journal.network.values()].filter((record) => keys.has(`n${record.entry.id}`)).map((record) => ({ ...record.entry })),
    };
    journal.reset = false;
    for (const listener of batchListeners) guarded('batch listener', () => listener(batch));
  }

  function schedule(journal: Journal): void {
    journal.dirty = true;
    if (journal.cancelFlush !== null) return;
    journal.cancelFlush = setTimer(() => flush(journal), DEVTOOLS_LIMITS.batchMs);
  }

  function touch(journal: Journal, key: string): void {
    journal.seq += 1;
    journal.pending.set(key, journal.seq);
    schedule(journal);
  }

  function setCapture(journal: Journal, capture: CaptureState): void {
    if (journal.capture === capture) return;
    journal.capture = capture;
    schedule(journal);
  }

  function addConsole(journal: Journal, draft: ConsoleDraft | null): void {
    if (draft === null) return;
    const last = journal.console.at(-1);
    if (last !== undefined && last.epoch === journal.epoch && sameMessage(last, draft)) {
      last.count += 1;
      touch(journal, `c${last.id}`);
      return;
    }
    const entry: ConsoleEntry = { id: journal.nextId, epoch: journal.epoch, ts: now(), ...draft, count: 1 };
    journal.nextId += 1;
    journal.console.push(entry);
    if (journal.console.length > DEVTOOLS_LIMITS.consoleEntries) {
      journal.console.splice(0, journal.console.length - DEVTOOLS_LIMITS.consoleEntries);
    }
    touch(journal, `c${entry.id}`);
  }

  function startRequest(journal: Journal, data: Record<string, unknown>): void {
    const id = str(data.requestId);
    if (id === undefined) return;
    const request = fields(data.request);
    const previous = journal.network.get(id);
    const entry: NetworkEntry = {
      id,
      epoch: previous?.entry.epoch ?? journal.epoch,
      ts: previous?.entry.ts ?? now(),
      method: clip(str(request.method) ?? 'GET', DEVTOOLS_LIMITS.headerValue),
      url: clip(str(request.url) ?? '', DEVTOOLS_LIMITS.url),
      kind: networkKind(data.type),
      status: null,
      statusText: '',
      failure: null,
      mimeType: null,
      encodedBytes: null,
      durationMs: null,
      fromCache: false,
      remoteAddress: null,
      requestHeaders: headerPairs(request.headers),
      responseHeaders: [],
      hasPostData: request.hasPostData === true || typeof request.postData === 'string',
      postData: postDataOf(request),
    };
    if (previous !== undefined) {
      // Редирект — тот же requestId: запись продолжается с новым адресом, ответ прежнего шага стирается.
      previous.entry = entry;
    } else {
      journal.network.set(id, { entry, loaderId: str(data.loaderId) ?? '', started: num(data.timestamp) ?? 0 });
      if (journal.network.size > DEVTOOLS_LIMITS.networkEntries) {
        const oldest = journal.network.keys().next();
        if (oldest.done !== true) journal.network.delete(oldest.value);
      }
    }
    touch(journal, `n${id}`);
  }

  function updateRequest(journal: Journal, data: Record<string, unknown>, change: (record: NetRecord) => void): void {
    const id = str(data.requestId);
    const record = id === undefined ? undefined : journal.network.get(id);
    if (record === undefined) return;
    change(record);
    touch(journal, `n${record.entry.id}`);
  }

  function navigated(journal: Journal, data: Record<string, unknown>): void {
    const frame = fields(data.frame);
    // Подфрейм эпоху не меняет; переход внутри документа сюда не приходит (Page.navigatedWithinDocument).
    if (data.frame === undefined || frame.parentId !== undefined) return;
    journal.epoch += 1;
    const loaderId = str(frame.loaderId);
    let sawDocument = false;
    for (const record of journal.network.values()) {
      if (loaderId === undefined || record.loaderId !== loaderId) continue;
      // Запрос документа уходит до коммита: он и запросы его загрузки — уже новая эпоха (Фокус ревью 5).
      record.entry.epoch = journal.epoch;
      if (record.entry.kind === 'document') sawDocument = true;
      touch(journal, `n${record.entry.id}`);
    }
    // Документ из bfcache приходит без запроса, about:blank — без сети: это не пропуск захвата.
    if (data.type !== 'BackForwardCacheRestore' && isHttp(str(frame.url))) setCapture(journal, sawDocument ? 'on' : 'late');
    schedule(journal);
  }

  function record(journal: Journal, method: string, data: Record<string, unknown>): void {
    switch (method) {
      case 'Runtime.consoleAPICalled':
        addConsole(journal, consoleFromApi(data as ConsoleApiParams));
        break;
      case 'Runtime.exceptionThrown':
        addConsole(journal, consoleFromException(data as ExceptionParams));
        break;
      case 'Log.entryAdded':
        addConsole(journal, consoleFromLog(data as LogParams));
        break;
      case 'Page.frameNavigated':
        navigated(journal, data);
        break;
      case 'Network.requestWillBeSent':
        startRequest(journal, data);
        break;
      case 'Network.webSocketCreated':
        // У WebSocket своя пара событий; в журнале он — запрос вида websocket.
        startRequest(journal, { ...data, type: 'WebSocket', request: { url: data.url, method: 'GET' } });
        break;
      case 'Network.responseReceived':
      case 'Network.webSocketHandshakeResponseReceived':
        updateRequest(journal, data, (record) => respond(record, data));
        break;
      case 'Network.requestServedFromCache':
        updateRequest(journal, data, (record) => {
          record.entry.fromCache = true;
        });
        break;
      case 'Network.loadingFinished':
        updateRequest(journal, data, (record) => {
          record.entry.encodedBytes = num(data.encodedDataLength) ?? record.entry.encodedBytes;
          record.entry.durationMs = durationOf(record, data.timestamp);
        });
        break;
      case 'Network.loadingFailed':
        updateRequest(journal, data, (record) => {
          record.entry.failure = failureOf(data);
          record.entry.durationMs = durationOf(record, data.timestamp);
        });
        break;
      default:
        break;
    }
  }

  function receive(journal: Journal, method: string, params: unknown): void {
    guarded(method, () => record(journal, method, fields(params)));
    // Слушатели этапов B и D получают событие, даже если журнал его не разобрал; сбой одного не трогает соседей.
    const listeners = eventListeners.get(journal.id)?.get(method);
    if (listeners !== undefined) for (const listener of listeners) guarded(`${method} listener`, () => listener(params));
  }

  function connect(journal: Journal, contents: WebContents): void {
    try {
      contents.debugger.attach('1.3');
    } catch (error) {
      console.warn('[parley] devtools attach failed', error);
      setCapture(journal, 'unavailable');
      return;
    }
    journal.attached = true;
    // Первое подключение — к пустому гостю (адрес '' или about:blank): страница ещё не грузилась. Повторное — к
    // живой странице: её запросы до этого прошли мимо.
    const url = contents.getURL();
    setCapture(journal, url === '' || url === 'about:blank' ? 'on' : 'late');
    // Отказ и тайм-аут `enable` не бросают, а ставят `unavailable`: ready не должен держать страницу вкладки.
    journal.ready = Promise.all(
      ENABLE.map(([method, params]) =>
        command(contents, method, params).then(
          () => undefined,
          (error: unknown) => {
            console.warn(`[parley] devtools ${method} failed`, error);
            setCapture(journal, 'unavailable');
          },
        ),
      ),
    ).then(() => undefined);
  }

  function attach(contents: WebContents): void {
    if (journals.has(contents.id)) return;
    const journal: Journal = {
      id: contents.id,
      attached: false,
      ready: Promise.resolve(),
      epoch: 0,
      capture: 'on',
      nextId: 1,
      console: [],
      network: new Map(),
      pending: new Map(),
      seq: 0,
      reset: false,
      dirty: false,
      cancelFlush: null,
    };
    journals.set(contents.id, journal);
    contents.debugger.on('message', (_event, method: string, params: unknown) => receive(journal, method, params));
    contents.debugger.on('detach', (_event, reason: string) => {
      journal.attached = false;
      console.warn('[parley] devtools detached', reason);
      setCapture(journal, 'unavailable');
    });
    // Не подключился или отцепился — новая попытка на следующей навигации главного фрейма (спека 3.3).
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument && !journal.attached && !contents.isDestroyed()) connect(journal, contents);
    });
    contents.once('destroyed', () => {
      journal.cancelFlush?.();
      journals.delete(journal.id);
      eventListeners.delete(journal.id);
    });
    connect(journal, contents);
  }

  function live(id: number): WebContents | null {
    const contents = deps.fromId(id);
    return contents === null || contents.isDestroyed() ? null : contents;
  }

  return {
    attach,
    async ready(id) {
      await journals.get(id)?.ready;
    },
    snapshot(id) {
      const journal = journals.get(id);
      if (journal === undefined) return null;
      return {
        epoch: journal.epoch,
        capture: journal.capture,
        console: journal.console.map((entry) => ({ ...entry })),
        network: [...journal.network.values()].map((record) => ({ ...record.entry })),
      };
    },
    clear(id) {
      const journal = journals.get(id);
      if (journal === undefined) return;
      journal.console = [];
      journal.network.clear();
      journal.pending.clear();
      journal.reset = true;
      schedule(journal);
    },
    async responseBody(id, requestId, limit) {
      const contents = live(id);
      if (contents === null || journals.get(id)?.attached !== true) return null;
      try {
        const result = fields(await command(contents, 'Network.getResponseBody', { requestId }));
        if (typeof result.body !== 'string') return null;
        const base64 = result.base64Encoded === true;
        // Предел — в байтах тела: у base64 четыре знака на три байта.
        const max = base64 ? Math.floor(limit / 3) * 4 : limit;
        if (result.body.length <= max) return { text: result.body, base64, truncated: false };
        return { text: base64 ? result.body.slice(0, max) : clip(result.body, max), base64, truncated: true };
      } catch {
        // Chromium уже вытеснил тело из буфера, запрос ещё идёт или страница ушла — тела нет.
        return null;
      }
    },
    send<T>(id: number, method: CdpMethod, params?: Record<string, unknown>): Promise<T> {
      if (!CDP_ALLOWED.has(method)) return Promise.reject(new Error(`CDP method not allowed: ${method}`));
      const contents = live(id);
      if (contents === null) return Promise.reject(new Error(`no browser guest: ${id}`));
      if (journals.get(id)?.attached !== true) return Promise.reject(new Error(`capture unavailable: ${id}`));
      return command<T>(contents, method, params);
    },
    onBatch(listener) {
      batchListeners.add(listener);
      return () => {
        batchListeners.delete(listener);
      };
    },
    onEvent(id, method, listener) {
      const byMethod = eventListeners.get(id) ?? new Map<string, Set<(params: unknown) => void>>();
      eventListeners.set(id, byMethod);
      const listeners = byMethod.get(method) ?? new Set<(params: unknown) => void>();
      byMethod.set(method, listeners);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
