// packages/desktop/src/main/browser/inspector.test.ts
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVTOOLS_LIMITS, type DevtoolsBatch } from '../../shared/browser-devtools.js';
import { CDP_ALLOWED, CDP_COMMAND_MS, createInspector, forwardBatches } from './inspector.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Часы теста: пачки и тайм-ауты команд идут по ним, без настоящего времени. */
function fakeClock() {
  let time = 0;
  const timers: Array<{ at: number; fn: () => void; alive: boolean }> = [];
  return {
    now: (): number => time,
    setTimer: (fn: () => void, ms: number): (() => void) => {
      const timer = { at: time + ms, fn, alive: true };
      timers.push(timer);
      return () => {
        timer.alive = false;
      };
    },
    /** Сдвинуть время, по пути исполнив сработавшие таймеры по порядку. */
    tick(ms: number): void {
      const end = time + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.alive && timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        time = due.at;
        due.alive = false;
        due.fn();
      }
      time = end;
    },
  };
}

/** Гость `<webview>`: EventEmitter, адрес и `debugger` с подставными attach и sendCommand. */
function fakeGuest(id: number, url = '') {
  const dbg = Object.assign(new EventEmitter(), {
    attach: vi.fn<(version: string) => void>(),
    detach: vi.fn<() => void>(),
    sendCommand: vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(async () => ({})),
  });
  const contents = Object.assign(new EventEmitter(), {
    id,
    debugger: dbg,
    getURL: vi.fn<() => string>(() => url),
    isDestroyed: vi.fn<() => boolean>(() => false),
  });
  return { contents, dbg };
}

/** Отказы подключения инспектор пишет в журнал main — в тесте он тихий. */
function quietWarnings(): void {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

/** Отказ команды CDP обрабатывается в микрозадаче. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** `gates` — ответы на команды CDP по одному: каждая команда кладёт сюда функцию, которая её разрешает. */
function setup(options: { url?: string; attachError?: boolean; hang?: boolean; gates?: Array<() => void> } = {}) {
  const clock = fakeClock();
  const guest = fakeGuest(7, options.url);
  if (options.attachError === true) {
    guest.dbg.attach.mockImplementationOnce(() => {
      throw new Error('Another debugger is already attached');
    });
  }
  if (options.hang === true) guest.dbg.sendCommand.mockImplementation(() => new Promise<unknown>(() => {}));
  if (options.gates !== undefined) {
    const gates = options.gates;
    guest.dbg.sendCommand.mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          gates.push(() => resolve({}));
        }),
    );
  }
  const inspector = createInspector({
    fromId: (id) => (id === 7 && !guest.contents.isDestroyed() ? (guest.contents as unknown as WebContents) : null),
    now: clock.now,
    setTimer: clock.setTimer,
  });
  const batches: DevtoolsBatch[] = [];
  inspector.onBatch((batch) => batches.push(batch));
  inspector.attach(guest.contents as unknown as WebContents);
  /** Событие CDP от гостя. */
  const cdp = (method: string, params: unknown): void => {
    guest.dbg.emit('message', {}, method, params);
  };
  return { ...guest, clock, inspector, batches, cdp };
}

const APP = 'http://localhost:5173/src/app.js';

function log(text: string, line = 9): Record<string, unknown> {
  return {
    type: 'log',
    args: [{ type: 'string', value: text }],
    stackTrace: { callFrames: [{ functionName: 'run', url: APP, lineNumber: line, columnNumber: 0 }] },
  };
}

function request(requestId: string, url: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { requestId, loaderId: 'L1', timestamp: 100, type: 'Fetch', request: { url, method: 'GET', headers: { Accept: '*/*' } }, ...extra };
}

function mainFrame(loaderId: string, url = 'http://localhost:5173/next', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'Navigation', frame: { id: 'F1', loaderId, url }, ...extra };
}

describe('подключение (спека 3.3, спайк 0.1 — вариант D: к пустому гостю, страницу открывает окно после ready)', () => {
  it('гость: debugger.attach(1.3), enable Runtime, Log, Page и Network с буферами раздела 8', () => {
    const { dbg, inspector } = setup();
    expect(dbg.attach).toHaveBeenCalledWith('1.3');
    expect(dbg.sendCommand.mock.calls).toEqual([
      ['Runtime.enable', undefined],
      ['Log.enable', undefined],
      ['Page.enable', undefined],
      [
        'Network.enable',
        {
          maxResourceBufferSize: DEVTOOLS_LIMITS.resourceBuffer,
          maxTotalBufferSize: DEVTOOLS_LIMITS.totalBuffer,
          maxPostDataSize: DEVTOOLS_LIMITS.postData,
        },
      ],
    ]);
    expect(inspector.snapshot(7)).toEqual({ epoch: 0, capture: 'on', console: [], network: [] });
  });

  it('attach бросил — unavailable; повтор только на навигации главного фрейма с новым документом; живая страница — late, но после ответа enable', async () => {
    quietWarnings();
    const { contents, dbg, inspector } = setup({ attachError: true, url: 'http://localhost:5173/' });
    expect(inspector.snapshot(7)?.capture).toBe('unavailable');
    contents.emit('did-start-navigation', { url: 'http://localhost:5173/#top', isMainFrame: true, isSameDocument: true });
    contents.emit('did-start-navigation', { url: 'http://ads.test/', isMainFrame: false, isSameDocument: false });
    expect(dbg.attach).toHaveBeenCalledTimes(1);
    contents.emit('did-start-navigation', { url: 'http://localhost:5173/next', isMainFrame: true, isSameDocument: false });
    expect(dbg.attach).toHaveBeenCalledTimes(2);
    // Повторное подключение показывает захват только после ответа всех enable.
    expect(inspector.snapshot(7)?.capture).toBe('unavailable');
    await settle();
    expect(inspector.snapshot(7)?.capture).toBe('late');
  });

  it('enable не ответил за 10 с — unavailable, отладчик отцеплен, команды гостю отказывают', async () => {
    quietWarnings();
    const { clock, dbg, inspector } = setup({ hang: true });
    clock.tick(CDP_COMMAND_MS - 1);
    await settle();
    expect(inspector.snapshot(7)?.capture).toBe('on');
    expect(dbg.detach).not.toHaveBeenCalled();
    clock.tick(1);
    await settle();
    expect(inspector.snapshot(7)?.capture).toBe('unavailable');
    // Четыре enable вышли по тайм-ауту разом, отцепили отладчик один раз.
    expect(dbg.detach).toHaveBeenCalledTimes(1);
    await expect(inspector.send(7, 'Page.enable')).rejects.toThrow('capture unavailable: 7');
    await expect(inspector.responseBody(7, 'r1', 1000)).resolves.toBeNull();
  });

  it('detach — unavailable; на следующей навигации главного фрейма — новое подключение', async () => {
    quietWarnings();
    const { contents, dbg, inspector } = setup();
    dbg.emit('detach', {}, 'target closed');
    expect(inspector.snapshot(7)?.capture).toBe('unavailable');
    contents.getURL.mockReturnValue('http://localhost:5173/');
    contents.emit('did-start-navigation', { url: 'http://localhost:5173/', isMainFrame: true, isSameDocument: false });
    expect(dbg.attach).toHaveBeenCalledTimes(2);
    await settle();
    expect(inspector.snapshot(7)?.capture).toBe('late');
  });

  it('повторный attach того же гостя — без второго отладчика; гость уничтожен — журнала нет', () => {
    const { contents, dbg, inspector } = setup();
    inspector.attach(contents as unknown as WebContents);
    expect(dbg.attach).toHaveBeenCalledTimes(1);
    contents.emit('destroyed');
    expect(inspector.snapshot(7)).toBeNull();
  });

  it('ready: не раньше ответа на все четыре enable', async () => {
    const gates: Array<() => void> = [];
    const { inspector } = setup({ gates });
    let ready = false;
    void inspector.ready(7).then(() => {
      ready = true;
    });
    expect(gates).toHaveLength(4);
    for (const open of gates.slice(0, 3)) open();
    await settle();
    expect(ready).toBe(false);
    gates[3]?.();
    await settle();
    expect(ready).toBe(true);
    expect(inspector.snapshot(7)?.capture).toBe('on');
  });

  it('ready: зависший enable отпускает по тайм-ауту CDP_COMMAND_MS, capture unavailable; журнала нет — готово сразу', async () => {
    quietWarnings();
    const { clock, inspector } = setup({ hang: true });
    let ready = false;
    void inspector.ready(7).then(() => {
      ready = true;
    });
    clock.tick(CDP_COMMAND_MS - 1);
    await settle();
    expect(ready).toBe(false);
    clock.tick(1);
    await settle();
    expect(ready).toBe(true);
    expect(inspector.snapshot(7)?.capture).toBe('unavailable');
    await expect(inspector.ready(8)).resolves.toBeUndefined();
  });

  it('вариант D: подключение к пустому гостю, потом первая загрузка — документ, стиль и картинка в одной эпохе, capture on', () => {
    const { cdp, inspector } = setup();
    // Гость ещё не грузился (getURL() === ''): захват не поздний.
    expect(inspector.snapshot(7)?.capture).toBe('on');
    cdp('Page.frameNavigated', mainFrame('LB', 'about:blank'));
    cdp('Network.requestWillBeSent', request('doc', 'http://localhost:5173/', { loaderId: 'L1', type: 'Document' }));
    cdp('Network.requestWillBeSent', request('css', 'http://localhost:5173/app.css', { loaderId: 'L1', type: 'Stylesheet' }));
    cdp('Network.requestWillBeSent', request('img', 'http://localhost:5173/logo.svg', { loaderId: 'L1', type: 'Image' }));
    cdp('Page.frameNavigated', mainFrame('L1', 'http://localhost:5173/'));
    const snapshot = inspector.snapshot(7);
    expect(snapshot?.network.map((entry) => [entry.id, entry.kind, entry.epoch])).toEqual([
      ['doc', 'document', 2],
      ['css', 'stylesheet', 2],
      ['img', 'image', 2],
    ]);
    expect(snapshot?.capture).toBe('on');
  });
});

const MAIN_NAVIGATION = { url: 'http://localhost:5173/next', isMainFrame: true, isSameDocument: false };

describe('повтор после отказа enable (спека 3.3, раздел 9: повторная попытка — на следующей навигации главного фрейма)', () => {
  it('тайм-аут enable: новая попытка только на навигации главного фрейма; on — после ответа enable, не раньше', async () => {
    quietWarnings();
    const { clock, contents, dbg, inspector } = setup({ hang: true });
    clock.tick(CDP_COMMAND_MS);
    await settle();
    expect(inspector.snapshot(7)?.capture).toBe('unavailable');
    dbg.sendCommand.mockImplementation(async () => ({}));
    contents.emit('did-start-navigation', { url: 'http://localhost:5173/#top', isMainFrame: true, isSameDocument: true });
    contents.emit('did-start-navigation', { url: 'http://ads.test/', isMainFrame: false, isSameDocument: false });
    expect(dbg.attach).toHaveBeenCalledTimes(1);
    contents.emit('did-start-navigation', MAIN_NAVIGATION);
    expect(dbg.attach).toHaveBeenCalledTimes(2);
    expect(inspector.snapshot(7)?.capture).toBe('unavailable');
    await settle();
    expect(inspector.snapshot(7)?.capture).toBe('on');
    // Новое подключение работает: события гостя идут в журнал.
    dbg.emit('message', {}, 'Runtime.consoleAPICalled', log('again'));
    expect(inspector.snapshot(7)?.console.map((entry) => entry.text)).toEqual(['again']);
  });

  it('Page.frameNavigated сам по себе unavailable не снимает, даже с увиденным документом', async () => {
    quietWarnings();
    const { cdp, clock, inspector } = setup({ hang: true });
    clock.tick(CDP_COMMAND_MS);
    await settle();
    cdp('Network.requestWillBeSent', request('doc', 'http://localhost:5173/', { loaderId: 'L1', type: 'Document' }));
    cdp('Page.frameNavigated', mainFrame('L1', 'http://localhost:5173/'));
    expect(inspector.snapshot(7)).toMatchObject({ capture: 'unavailable', epoch: 1 });
  });

  it('повторная попытка тоже отказала — снова unavailable и отцеплен; третья — на следующей навигации', async () => {
    quietWarnings();
    const { clock, contents, dbg, inspector } = setup({ hang: true });
    clock.tick(CDP_COMMAND_MS);
    await settle();
    contents.emit('did-start-navigation', MAIN_NAVIGATION);
    expect(dbg.attach).toHaveBeenCalledTimes(2);
    clock.tick(CDP_COMMAND_MS - 1);
    await settle();
    expect(inspector.snapshot(7)?.capture).toBe('unavailable');
    expect(dbg.detach).toHaveBeenCalledTimes(1);
    clock.tick(1);
    await settle();
    expect(inspector.snapshot(7)?.capture).toBe('unavailable');
    expect(dbg.detach).toHaveBeenCalledTimes(2);
    contents.emit('did-start-navigation', MAIN_NAVIGATION);
    expect(dbg.attach).toHaveBeenCalledTimes(3);
  });

  it('запоздалый тайм-аут enable прежней попытки новое подключение не отцепляет', async () => {
    quietWarnings();
    const { clock, contents, dbg } = setup({ hang: true });
    clock.tick(5000);
    dbg.emit('detach', {}, 'target closed');
    contents.emit('did-start-navigation', MAIN_NAVIGATION);
    expect(dbg.attach).toHaveBeenCalledTimes(2);
    // Enable первой попытки выходят по тайм-ауту раньше, чем enable второй.
    clock.tick(5000);
    await settle();
    expect(dbg.detach).not.toHaveBeenCalled();
    clock.tick(5000);
    await settle();
    expect(dbg.detach).toHaveBeenCalledTimes(1);
  });
});

describe('консоль: записи, повторы, кольцо (спека 3.3, раздел 8)', () => {
  it('сообщение — запись с id, эпохой, временем и count 1', () => {
    const { cdp, clock, inspector } = setup();
    clock.tick(5);
    cdp('Runtime.consoleAPICalled', log('hello'));
    expect(inspector.snapshot(7)?.console).toEqual([
      {
        id: 1,
        epoch: 0,
        ts: 5,
        level: 'info',
        origin: 'console',
        text: 'hello',
        location: { url: APP, line: 10, column: 1 },
        stack: [{ fn: 'run', url: APP, line: 10, column: 1 }],
        count: 1,
      },
    ]);
  });

  it('одинаковые подряд — одна запись с count; другое место или сообщение между ними — новые записи', () => {
    const { cdp, inspector } = setup();
    cdp('Runtime.consoleAPICalled', log('tick'));
    cdp('Runtime.consoleAPICalled', log('tick'));
    cdp('Runtime.consoleAPICalled', log('tick'));
    cdp('Runtime.consoleAPICalled', log('tick', 20));
    cdp('Runtime.consoleAPICalled', log('other'));
    cdp('Runtime.consoleAPICalled', log('tick', 20));
    expect(inspector.snapshot(7)?.console.map((entry) => [entry.text, entry.location?.line, entry.count])).toEqual([
      ['tick', 10, 3],
      ['tick', 21, 1],
      ['other', 10, 1],
      ['tick', 21, 1],
    ]);
  });

  it('кольцо — 1000 последних', () => {
    const { cdp, inspector } = setup();
    for (let n = 1; n <= DEVTOOLS_LIMITS.consoleEntries + 5; n += 1) cdp('Runtime.consoleAPICalled', log(`m${n}`));
    const entries = inspector.snapshot(7)?.console ?? [];
    expect(entries).toHaveLength(DEVTOOLS_LIMITS.consoleEntries);
    expect(entries[0]?.text).toBe('m6');
  });

  it('исключение и строка сети — записи; предупреждение Electron — нет', () => {
    const { cdp, inspector } = setup();
    cdp('Runtime.exceptionThrown', {
      exceptionDetails: { text: 'Uncaught', exception: { type: 'object', subtype: 'error', description: 'Error: boom\n    at x' } },
    });
    cdp('Log.entryAdded', {
      entry: { source: 'network', level: 'error', text: 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)' },
    });
    cdp('Runtime.consoleAPICalled', { type: 'warning', args: [{ type: 'string', value: '%cElectron Security Warning (Insecure CSP)' }] });
    // Служебные типы console.* — не записи: consoleFromApi отдаёт null, инспектор его пропускает.
    for (const type of ['endGroup', 'clear', 'profile', 'profileEnd']) cdp('Runtime.consoleAPICalled', { type, args: [] });
    expect(inspector.snapshot(7)?.console.map((entry) => [entry.origin, entry.level, entry.text])).toEqual([
      ['exception', 'error', 'Uncaught Error: boom'],
      ['network', 'error', 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)'],
    ]);
  });
});

describe('сеть: жизнь запроса (спека 3.3, 3.4)', () => {
  it('requestWillBeSent → responseReceived 500 → loadingFinished: статус, заголовки, тело запроса, размер, длительность', () => {
    const { cdp, inspector } = setup();
    cdp(
      'Network.requestWillBeSent',
      request('r1', 'http://localhost:5173/api/settings', {
        request: { url: 'http://localhost:5173/api/settings', method: 'POST', headers: { 'Content-Type': 'application/json' }, postData: '{"a":1}', hasPostData: true },
      }),
    );
    cdp('Network.responseReceived', {
      requestId: 'r1',
      type: 'Fetch',
      response: {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'content-type': 'application/json' },
        mimeType: 'application/json',
        remoteIPAddress: '127.0.0.1',
        remotePort: 5173,
      },
    });
    cdp('Network.loadingFinished', { requestId: 'r1', timestamp: 100.25, encodedDataLength: 321 });
    expect(inspector.snapshot(7)?.network).toEqual([
      {
        id: 'r1',
        epoch: 0,
        ts: 0,
        method: 'POST',
        url: 'http://localhost:5173/api/settings',
        kind: 'fetch',
        status: 500,
        statusText: 'Internal Server Error',
        failure: null,
        mimeType: 'application/json',
        encodedBytes: 321,
        durationMs: 250,
        fromCache: false,
        remoteAddress: '127.0.0.1:5173',
        requestHeaders: [['Content-Type', 'application/json']],
        responseHeaders: [['content-type', 'application/json']],
        hasPostData: true,
        postData: '{"a":1}',
      },
    ]);
  });

  it('loadingFailed: CORS и отмена; из кэша памяти — fromCache; WebSocket — вид websocket со статусом рукопожатия', () => {
    const { cdp, inspector } = setup();
    cdp('Network.requestWillBeSent', request('c', 'http://127.0.0.1:9/data'));
    cdp('Network.loadingFailed', {
      requestId: 'c',
      timestamp: 100.01,
      errorText: 'net::ERR_FAILED',
      corsErrorStatus: { corsError: 'MissingAllowOriginHeader', failedParameter: '' },
    });
    cdp('Network.requestWillBeSent', request('x', 'http://localhost:5173/abort'));
    cdp('Network.loadingFailed', { requestId: 'x', timestamp: 100.01, errorText: 'net::ERR_ABORTED', canceled: true });
    cdp('Network.requestWillBeSent', request('m', 'http://localhost:5173/logo.png', { type: 'Image' }));
    cdp('Network.requestServedFromCache', { requestId: 'm' });
    cdp('Network.webSocketCreated', { requestId: 'w', url: 'ws://localhost:5173/hmr' });
    cdp('Network.webSocketHandshakeResponseReceived', { requestId: 'w', timestamp: 1, response: { status: 101, statusText: 'Switching Protocols', headers: {} } });
    const byId = new Map((inspector.snapshot(7)?.network ?? []).map((entry) => [entry.id, entry]));
    expect(byId.get('c')).toMatchObject({ status: null, failure: { reason: 'cors', text: 'MissingAllowOriginHeader' }, durationMs: 10 });
    expect(byId.get('x')?.failure).toEqual({ reason: 'canceled', text: 'net::ERR_ABORTED' });
    expect(byId.get('m')).toMatchObject({ kind: 'image', fromCache: true });
    expect(byId.get('w')).toMatchObject({ kind: 'websocket', method: 'GET', url: 'ws://localhost:5173/hmr', status: 101 });
  });

  it('кольцо сети — 500 последних; ответ на вытесненный запрос не создаёт записи', () => {
    const { cdp, inspector } = setup();
    for (let n = 1; n <= DEVTOOLS_LIMITS.networkEntries + 3; n += 1) cdp('Network.requestWillBeSent', request(`r${n}`, `http://localhost:5173/${n}`));
    cdp('Network.responseReceived', { requestId: 'r1', response: { status: 200 } });
    const entries = inspector.snapshot(7)?.network ?? [];
    expect(entries).toHaveLength(DEVTOOLS_LIMITS.networkEntries);
    expect(entries[0]?.id).toBe('r4');
  });
});

describe('эпохи и поздний захват (спека 3.3; Фокус ревью 5)', () => {
  it('главный фрейм с новым документом — эпоха +1; подфрейм — нет', () => {
    const { cdp, inspector } = setup();
    cdp('Page.frameNavigated', { type: 'Navigation', frame: { id: 'S1', parentId: 'F1', loaderId: 'LS', url: 'http://ads.test/' } });
    expect(inspector.snapshot(7)?.epoch).toBe(0);
    cdp('Page.frameNavigated', mainFrame('L2'));
    expect(inspector.snapshot(7)?.epoch).toBe(1);
  });

  it('документ навигации и запросы его загрузки — в новой эпохе, хотя ушли до коммита; документ увиден — capture on', () => {
    const { cdp, inspector } = setup();
    cdp('Runtime.consoleAPICalled', log('old page'));
    cdp('Network.requestWillBeSent', request('old', 'http://localhost:5173/old.js', { loaderId: 'L1', type: 'Script' }));
    cdp('Network.requestWillBeSent', request('doc', 'http://localhost:5173/next', { loaderId: 'L2', type: 'Document' }));
    cdp('Page.frameNavigated', mainFrame('L2'));
    cdp('Runtime.consoleAPICalled', log('new page'));
    const snapshot = inspector.snapshot(7);
    expect(snapshot?.network.map((entry) => [entry.id, entry.epoch])).toEqual([
      ['old', 0],
      ['doc', 1],
    ]);
    expect(snapshot?.console.map((entry) => [entry.text, entry.epoch])).toEqual([
      ['old page', 0],
      ['new page', 1],
    ]);
    expect(snapshot?.capture).toBe('on');
  });

  it('документ не увиден — late; увиден — снова on; из bfcache и about:blank — capture прежний', () => {
    const { cdp, inspector } = setup();
    cdp('Page.frameNavigated', mainFrame('L9', 'http://localhost:5173/'));
    expect(inspector.snapshot(7)?.capture).toBe('late');
    cdp('Network.requestWillBeSent', request('doc', 'http://localhost:5173/', { loaderId: 'L10', type: 'Document' }));
    cdp('Page.frameNavigated', mainFrame('L10', 'http://localhost:5173/'));
    expect(inspector.snapshot(7)?.capture).toBe('on');
    cdp('Page.frameNavigated', mainFrame('L11', 'http://localhost:5173/back', { type: 'BackForwardCacheRestore' }));
    cdp('Page.frameNavigated', mainFrame('L12', 'about:blank'));
    expect(inspector.snapshot(7)).toMatchObject({ capture: 'on', epoch: 4 });
  });

  it('повтор сообщения в новой эпохе — новая запись, а не count', () => {
    const { cdp, inspector } = setup();
    cdp('Runtime.consoleAPICalled', log('x'));
    cdp('Page.frameNavigated', mainFrame('L2'));
    cdp('Runtime.consoleAPICalled', log('x'));
    expect(inspector.snapshot(7)?.console.map((entry) => [entry.epoch, entry.count])).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });
});

describe('данные страницы: кривые события и длинные поля', () => {
  it('кривое событие не бросает из слушателя отладчика и не мешает следующим; слушатели onEvent всё равно получают его', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { cdp, inspector } = setup();
    const listener = vi.fn<(params: unknown) => void>();
    inspector.onEvent(7, 'Runtime.consoleAPICalled', listener);
    expect(() => cdp('Runtime.consoleAPICalled', { type: 'log', args: null })).not.toThrow();
    // args: [null] валит перевод в консольную запись (разбор аргумента без проверки) — исключение глотает обёртка.
    expect(() => cdp('Runtime.consoleAPICalled', { type: 'log', args: [null] })).not.toThrow();
    expect(() => cdp('Network.requestWillBeSent', null)).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(2);
    cdp('Runtime.consoleAPICalled', log('after'));
    expect(inspector.snapshot(7)?.console.map((entry) => entry.text)).toContain('after');
  });

  it('исключение слушателя onEvent не бросает наружу и не мешает соседнему слушателю', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { cdp, inspector } = setup();
    const next = vi.fn<(params: unknown) => void>();
    inspector.onEvent(7, 'Page.frameNavigated', () => {
      throw new Error('listener failed');
    });
    inspector.onEvent(7, 'Page.frameNavigated', next);
    expect(() => cdp('Page.frameNavigated', mainFrame('L2'))).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('длинные поля записи сети режутся пределами: адрес — url, метод, statusText и mimeType — headerValue', () => {
    const { cdp, inspector } = setup();
    const long = (n: number): string => 'x'.repeat(n + 5000);
    cdp('Network.requestWillBeSent', request('big', `http://localhost:5173/${long(DEVTOOLS_LIMITS.url)}`, {
      request: { url: `http://localhost:5173/${long(DEVTOOLS_LIMITS.url)}`, method: long(DEVTOOLS_LIMITS.headerValue), headers: {} },
    }));
    cdp('Network.responseReceived', {
      requestId: 'big',
      response: { status: 200, statusText: long(DEVTOOLS_LIMITS.headerValue), mimeType: long(DEVTOOLS_LIMITS.headerValue), headers: {} },
    });
    const entry = inspector.snapshot(7)?.network[0];
    expect(entry?.url).toHaveLength(DEVTOOLS_LIMITS.url);
    expect(entry?.method).toHaveLength(DEVTOOLS_LIMITS.headerValue);
    expect(entry?.statusText).toHaveLength(DEVTOOLS_LIMITS.headerValue);
    expect(entry?.mimeType).toHaveLength(DEVTOOLS_LIMITS.headerValue);
  });

  it('адрес в 10 000 знаков — запись с url не длиннее предела; WebSocket тоже', () => {
    const { cdp, inspector } = setup();
    cdp('Network.requestWillBeSent', request('long', `http://localhost:5173/${'a'.repeat(10_000)}`));
    cdp('Network.webSocketCreated', { requestId: 'ws', url: `ws://localhost:5173/${'b'.repeat(10_000)}` });
    const urls = (inspector.snapshot(7)?.network ?? []).map((entry) => entry.url.length);
    expect(urls).toEqual([DEVTOOLS_LIMITS.url, DEVTOOLS_LIMITS.url]);
  });
});

describe('пачки окну (раздел 8; Фокус ревью 1)', () => {
  it('пачка — через 150 мс после первого изменения, не раньше; запрос, изменённый дважды, — одна запись', () => {
    const { cdp, clock, batches } = setup();
    cdp('Network.requestWillBeSent', request('r1', 'http://localhost:5173/api'));
    clock.tick(100);
    cdp('Network.responseReceived', { requestId: 'r1', type: 'Fetch', response: { status: 500, statusText: 'Internal Server Error', headers: {} } });
    expect(batches).toHaveLength(0);
    clock.tick(DEVTOOLS_LIMITS.batchMs - 100);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ webContentsId: 7, epoch: 0, capture: 'on', reset: false, console: [] });
    expect(batches[0]?.network.map((entry) => [entry.id, entry.status])).toEqual([['r1', 500]]);
  });

  it('Фокус ревью 1: 10 000 сообщений за 1 с → ≤ 7 пачек по ≤ 200 записей, в кольце 1000, у повторов count; остаток кольца доходит окну', () => {
    const { cdp, clock, inspector, batches } = setup();
    // Запись, ушедшая в пачке, в этот момент ещё в кольце: вытесненное до отправки не уходит.
    const stale: number[] = [];
    inspector.onBatch((batch) => {
      const ring = new Set((inspector.snapshot(7)?.console ?? []).map((entry) => entry.id));
      for (const entry of batch.console) if (!ring.has(entry.id)) stale.push(entry.id);
    });
    for (let ms = 0; ms < 1000; ms += 1) {
      for (let k = 0; k < 10; k += 1) {
        // Пары подряд одинаковые: 5000 разных сообщений, у каждого count 2.
        cdp('Runtime.consoleAPICalled', log(`message ${Math.floor((ms * 10 + k) / 2)}`));
      }
      clock.tick(1);
    }
    clock.tick(DEVTOOLS_LIMITS.batchMs);
    // Остаток переносится в следующие пачки, а не выбрасывается, но темп прежний — раз в 150 мс.
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.length).toBeLessThanOrEqual(7);
    clock.tick(DEVTOOLS_LIMITS.batchMs * 10);
    for (const batch of batches) expect(batch.console.length + batch.network.length).toBeLessThanOrEqual(DEVTOOLS_LIMITS.batchMax);
    expect(stale).toEqual([]);
    const entries = inspector.snapshot(7)?.console ?? [];
    expect(entries).toHaveLength(DEVTOOLS_LIMITS.consoleEntries);
    expect(entries.every((entry) => entry.count === 2)).toBe(true);
    expect(entries.at(-1)?.text).toBe('message 4999');
    // Каждая запись кольца дошла окну, последняя версия — с итоговым count.
    const delivered = new Map(batches.flatMap((batch) => batch.console).map((entry) => [entry.id, entry]));
    expect(entries.every((entry) => delivered.get(entry.id)?.count === 2)).toBe(true);
    // Порядок по изменениям: в последней пачке — свежая запись, в первой — не самая свежая.
    expect(batches.at(-1)?.console.at(-1)?.text).toBe('message 4999');
    expect(batches[0]?.console.at(-1)?.text).not.toBe('message 4999');
  });

  it('всплеск в 450 разных сообщений: пачки по ≤ 200 раз в 150 мс, остаток не теряется — все записи по порядку и по разу', () => {
    const { cdp, clock, inspector, batches } = setup();
    for (let n = 1; n <= 450; n += 1) cdp('Runtime.consoleAPICalled', log(`m${n}`));
    clock.tick(DEVTOOLS_LIMITS.batchMs);
    expect(batches.map((batch) => batch.console.length)).toEqual([200]);
    clock.tick(DEVTOOLS_LIMITS.batchMs);
    expect(batches.map((batch) => batch.console.length)).toEqual([200, 200]);
    clock.tick(DEVTOOLS_LIMITS.batchMs);
    expect(batches.map((batch) => batch.console.length)).toEqual([200, 200, 50]);
    expect(batches.flatMap((batch) => batch.console.map((entry) => entry.text))).toEqual(
      (inspector.snapshot(7)?.console ?? []).map((entry) => entry.text),
    );
    // Остатка нет — таймер больше не взводится.
    clock.tick(DEVTOOLS_LIMITS.batchMs * 10);
    expect(batches).toHaveLength(3);
  });

  it('всплеск больше кольца: вытесненное до отправки окну не уходит, остальное — по порядку и по разу', () => {
    const { cdp, clock, inspector, batches } = setup();
    const total = DEVTOOLS_LIMITS.consoleEntries + 200;
    for (let n = 1; n <= total; n += 1) cdp('Runtime.consoleAPICalled', log(`m${n}`));
    clock.tick(DEVTOOLS_LIMITS.batchMs * 10);
    const ring = (inspector.snapshot(7)?.console ?? []).map((entry) => entry.text);
    expect(ring).toHaveLength(DEVTOOLS_LIMITS.consoleEntries);
    expect(ring[0]).toBe('m201');
    expect(batches.map((batch) => batch.console.length)).toEqual([200, 200, 200, 200, 200]);
    expect(batches.flatMap((batch) => batch.console.map((entry) => entry.text))).toEqual(ring);
  });

  it('предел 200 общий для консоли и сети: 150 сообщений и 150 запросов — пачки 200 и 100, всё по разу и по порядку', () => {
    const { cdp, clock, inspector, batches } = setup();
    for (let n = 1; n <= 150; n += 1) cdp('Runtime.consoleAPICalled', log(`m${n}`));
    for (let n = 1; n <= 150; n += 1) cdp('Network.requestWillBeSent', request(`r${n}`, `http://localhost:5173/${n}`));
    clock.tick(DEVTOOLS_LIMITS.batchMs * 3);
    expect(batches.map((batch) => batch.console.length + batch.network.length)).toEqual([200, 100]);
    const snapshot = inspector.snapshot(7);
    expect(batches.flatMap((batch) => batch.console.map((entry) => entry.text))).toEqual(snapshot?.console.map((entry) => entry.text));
    expect(batches.flatMap((batch) => batch.network.map((entry) => entry.id))).toEqual(snapshot?.network.map((entry) => entry.id));
  });

  it('упавший запрос из прошлой пачки: ответ среди всплеска доходит окну, итоговое состояние каждого запроса совпадает с журналом', () => {
    const { cdp, clock, inspector, batches } = setup();
    cdp('Network.requestWillBeSent', request('first', 'http://localhost:5173/first'));
    clock.tick(DEVTOOLS_LIMITS.batchMs);
    expect(batches[0]?.network.map((entry) => entry.failure)).toEqual([null]);
    // Отказ первого — самое старое изменение всплеска: при усечении «свежих 200» оно бы пропало.
    cdp('Network.loadingFailed', { requestId: 'first', timestamp: 100.01, errorText: 'net::ERR_CONNECTION_REFUSED' });
    for (let n = 1; n <= 450; n += 1) {
      cdp('Network.requestWillBeSent', request(`r${n}`, `http://localhost:5173/api/${n}`));
      cdp('Network.responseReceived', { requestId: `r${n}`, type: 'Fetch', response: { status: 500, statusText: 'Internal Server Error', headers: {} } });
    }
    clock.tick(DEVTOOLS_LIMITS.batchMs * 10);
    for (const batch of batches) expect(batch.network.length).toBeLessThanOrEqual(DEVTOOLS_LIMITS.batchMax);
    const delivered = new Map(batches.flatMap((batch) => batch.network).map((entry) => [entry.id, entry]));
    expect(delivered.get('first')?.failure).toEqual({ reason: 'net', text: 'net::ERR_CONNECTION_REFUSED' });
    expect(delivered.size).toBe(1 + 450);
    for (const entry of inspector.snapshot(7)?.network ?? []) expect(delivered.get(entry.id)).toEqual(entry);
  });

  it('без изменений пачек нет; отцепился — пачка с capture unavailable и без записей', () => {
    quietWarnings();
    const { dbg, clock, batches } = setup();
    clock.tick(1000);
    expect(batches).toHaveLength(0);
    dbg.emit('detach', {}, 'target closed');
    clock.tick(DEVTOOLS_LIMITS.batchMs);
    expect(batches).toEqual([{ webContentsId: 7, epoch: 0, capture: 'unavailable', reset: false, console: [], network: [] }]);
  });

  it('clear — журнал пуст, следующая пачка с reset; дальше — снова без reset', () => {
    const { cdp, clock, inspector, batches } = setup();
    cdp('Runtime.consoleAPICalled', log('a'));
    clock.tick(DEVTOOLS_LIMITS.batchMs);
    inspector.clear(7);
    expect(inspector.snapshot(7)).toMatchObject({ console: [], network: [] });
    clock.tick(DEVTOOLS_LIMITS.batchMs);
    expect(batches.at(-1)).toMatchObject({ reset: true, console: [], network: [] });
    cdp('Runtime.consoleAPICalled', log('b'));
    clock.tick(DEVTOOLS_LIMITS.batchMs);
    expect(batches.at(-1)?.reset).toBe(false);
    expect(batches.at(-1)?.console.map((entry) => entry.text)).toEqual(['b']);
  });
});

describe('команды CDP (спека 3.3)', () => {
  it('закрытый список этапа A; Runtime.evaluate и callFunctionOn в нём нет', () => {
    expect([...CDP_ALLOWED].sort()).toEqual(
      [
        'Emulation.clearDeviceMetricsOverride',
        'Emulation.setDeviceMetricsOverride',
        'Emulation.setTouchEmulationEnabled',
        'Emulation.setUserAgentOverride',
        'Log.disable',
        'Log.enable',
        'Network.disable',
        'Network.enable',
        'Network.getResponseBody',
        'Page.disable',
        'Page.enable',
        'Runtime.disable',
        'Runtime.enable',
      ].sort(),
    );
    expect(CDP_ALLOWED.has('Runtime.evaluate')).toBe(false);
    expect(CDP_ALLOWED.has('Runtime.callFunctionOn')).toBe(false);
  });

  it('send: команда вне списка — отказ без sendCommand; из списка — sendCommand и ответ', async () => {
    const { dbg, inspector } = setup();
    dbg.sendCommand.mockClear();
    await expect(inspector.send(7, 'Runtime.evaluate', { expression: '1' })).rejects.toThrow('CDP method not allowed: Runtime.evaluate');
    expect(dbg.sendCommand).not.toHaveBeenCalled();
    dbg.sendCommand.mockResolvedValueOnce({ ok: true });
    await expect(inspector.send(7, 'Emulation.clearDeviceMetricsOverride')).resolves.toEqual({ ok: true });
  });

  it('send к чужому или отцепившемуся гостю — отказ', async () => {
    quietWarnings();
    const { dbg, inspector } = setup();
    await expect(inspector.send(8, 'Page.enable')).rejects.toThrow('no browser guest: 8');
    dbg.emit('detach', {}, 'target closed');
    await expect(inspector.send(7, 'Page.enable')).rejects.toThrow('capture unavailable: 7');
  });
});

describe('тело ответа (спека 4.4)', () => {
  it('текст — как есть; длиннее предела — обрезан с truncated', async () => {
    const { dbg, inspector } = setup();
    dbg.sendCommand.mockImplementation(async (method) => (method === 'Network.getResponseBody' ? { body: '{"error":"db down"}', base64Encoded: false } : {}));
    await expect(inspector.responseBody(7, 'r1', 1000)).resolves.toEqual({ text: '{"error":"db down"}', base64: false, truncated: false });
    await expect(inspector.responseBody(7, 'r1', 5)).resolves.toEqual({ text: '{"err', base64: false, truncated: true });
    expect(dbg.sendCommand).toHaveBeenCalledWith('Network.getResponseBody', { requestId: 'r1' });
  });

  it('base64 — предел в байтах: четыре знака на три байта', async () => {
    const { dbg, inspector } = setup();
    dbg.sendCommand.mockImplementation(async (method) => (method === 'Network.getResponseBody' ? { body: 'AAAAAAAAAAAA', base64Encoded: true } : {}));
    await expect(inspector.responseBody(7, 'img', 6)).resolves.toEqual({ text: 'AAAAAAAA', base64: true, truncated: true });
  });

  it('Chromium тело вытеснил, запрос неизвестен или гость чужой — null', async () => {
    const { dbg, inspector } = setup();
    dbg.sendCommand.mockImplementation(async (method) => {
      if (method === 'Network.getResponseBody') throw new Error('No resource with given identifier found');
      return {};
    });
    await expect(inspector.responseBody(7, 'gone', 1000)).resolves.toBeNull();
    await expect(inspector.responseBody(8, 'r1', 1000)).resolves.toBeNull();
  });
});

describe('события для этапов B и D', () => {
  it('onEvent: сырые params своего гостя и метода; отписка', () => {
    const { cdp, inspector } = setup();
    const listener = vi.fn<(params: unknown) => void>();
    const off = inspector.onEvent(7, 'Page.frameNavigated', listener);
    inspector.onEvent(8, 'Page.frameNavigated', vi.fn());
    cdp('Page.frameNavigated', mainFrame('L2'));
    cdp('Runtime.consoleAPICalled', log('x'));
    off();
    cdp('Page.frameNavigated', mainFrame('L3'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(mainFrame('L2'));
  });
});

describe('forwardBatches (пачки окну-хозяину гостя)', () => {
  it('пачка — событием browser:devtools окну-хозяину своего гостя; чужой и мёртвый гость — никуда', () => {
    const listeners: Array<(batch: DevtoolsBatch) => void> = [];
    const send = vi.fn<(channel: string, batch: DevtoolsBatch) => void>();
    const guest = { isDestroyed: vi.fn(() => false), hostWebContents: { send } };
    const off = forwardBatches(
      {
        onBatch: (listener) => {
          listeners.push(listener);
          return () => {};
        },
      },
      (id) => (id === 7 ? (guest as unknown as WebContents) : null),
    );
    const batch: DevtoolsBatch = { webContentsId: 7, epoch: 1, capture: 'on', reset: false, console: [], network: [] };
    listeners[0]?.(batch);
    expect(send).toHaveBeenCalledWith('browser:devtools', batch);
    listeners[0]?.({ ...batch, webContentsId: 8 });
    guest.isDestroyed.mockReturnValue(true);
    listeners[0]?.(batch);
    expect(send).toHaveBeenCalledTimes(1);
    expect(typeof off).toBe('function');
  });
});
