import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Certificate, WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_CERT_HINT, createCertChoiceStore, createClientCert, hostPortOf, humanWait } from './client-cert.js';
import type { CertChoiceStore, CertOutcome } from './client-cert.js';

const URL_B = '127.0.0.1:18444';
const URL_C = '127.0.0.1:18445';

function cert(n: number): Certificate {
  return {
    data: `PEM-${n}`,
    issuer: {},
    issuerName: `Issuer ${n}`,
    subject: {},
    subjectName: `Subject ${n}`,
    serialNumber: `0${n}`,
    validStart: 1000 + n,
    validExpiry: 2000 + n,
    fingerprint: `sha256/fp-${n}`,
  } as unknown as Certificate;
}

interface FakeHost {
  isDestroyed(): boolean;
  send: ReturnType<typeof vi.fn>;
}

function fakeGuest(id = 5, pageUrl = 'https://example.com/login'): { contents: WebContents; emitter: EventEmitter; host: FakeHost } {
  const host: FakeHost = { isDestroyed: () => false, send: vi.fn() };
  const emitter = new EventEmitter() as EventEmitter & { id: number; hostWebContents: FakeHost; getURL(): string };
  emitter.id = id;
  emitter.hostWebContents = host;
  emitter.getURL = () => pageUrl;
  return { contents: emitter as unknown as WebContents, emitter, host };
}

function memoryStore(initial: Record<string, string> = {}): CertChoiceStore & { set: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } {
  const map = new Map(Object.entries(initial));
  return {
    load: async () => undefined,
    get: (hostPort: string) => map.get(hostPort) ?? null,
    set: vi.fn(async (hostPort: string, fingerprint: string) => {
      map.set(hostPort, fingerprint);
    }),
    delete: vi.fn(async (hostPort: string) => {
      map.delete(hostPort);
    }),
    clear: async () => {
      map.clear();
    },
  };
}

type Line = { host: string; count: number; outcome: CertOutcome };

function setup(options: { store?: ReturnType<typeof memoryStore>; isGuest?: (c: WebContents) => boolean } = {}) {
  const store = options.store ?? memoryStore();
  const lines: Line[] = [];
  let n = 0;
  const clientCert = createClientCert({
    isGuest: options.isGuest ?? (() => true),
    store,
    newId: () => `r${++n}`,
    log: (line) => lines.push(line),
  });
  return { clientCert, store, lines };
}

describe('hostPortOf', () => {
  it('оба вида: хост:порт как есть, https-адрес с явным портом; http и мусор — null', () => {
    expect(hostPortOf('127.0.0.1:18444')).toBe('127.0.0.1:18444');
    expect(hostPortOf('https://auth.example.com/x')).toBe('auth.example.com:443');
    expect(hostPortOf('https://a.b:6443/')).toBe('a.b:6443');
    expect(hostPortOf('http://a.b/')).toBeNull();
    expect(hostPortOf('nope')).toBeNull();
    expect(hostPortOf('a.b')).toBeNull();
    expect(hostPortOf('a.b:99999')).toBeNull();
    expect(hostPortOf('a.b:0')).toBeNull();
  });
});

describe('createClientCert: ветки select', () => {
  it('не гость и contents === null — отказ без вопроса, окну ничего не шлётся', () => {
    const { clientCert, lines } = setup({ isGuest: () => false });
    const { contents, host } = fakeGuest();
    const first = vi.fn();
    clientCert.select(contents, 'auth.example.com:6443', [cert(1)], first);
    expect(first).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0]).toEqual([]);

    const second = vi.fn();
    clientCert.select(null, 'auth.example.com:6443', [cert(1)], second);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0]).toEqual([]);
    expect(host.send).not.toHaveBeenCalled();
    expect(lines).toEqual([
      { host: 'auth.example.com:6443', count: 1, outcome: 'denied-not-guest' },
      { host: 'auth.example.com:6443', count: 1, outcome: 'denied-not-guest' },
    ]);
  });

  it('гость без окна-хозяина или не адрес в событии — отказ', () => {
    const { clientCert } = setup();
    const { contents, emitter } = fakeGuest();
    (emitter as unknown as { hostWebContents: unknown }).hostWebContents = null;
    const orphan = vi.fn();
    clientCert.select(contents, URL_B, [cert(1)], orphan);
    expect(orphan).toHaveBeenCalledTimes(1);
    expect(orphan.mock.calls[0]).toEqual([]);

    const guest = fakeGuest(6);
    const garbage = vi.fn();
    clientCert.select(guest.contents, 'not an address', [cert(1)], garbage);
    expect(garbage).toHaveBeenCalledTimes(1);
    expect(garbage.mock.calls[0]).toEqual([]);
    expect(guest.host.send).not.toHaveBeenCalled();
  });

  it('пустой список — защитный отказ без вопроса и без записи в журнал', () => {
    const { clientCert, lines } = setup();
    const { contents, host } = fakeGuest();
    const callback = vi.fn();
    clientCert.select(contents, 'auth.example.com:6443', [], callback);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]).toEqual([]);
    expect(host.send).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('запомненный отпечаток в списке — без вопроса, callback с тем же объектом из списка', () => {
    const store = memoryStore({ [URL_B]: 'sha256/fp-2' });
    const { clientCert, lines } = setup({ store });
    const { contents, host } = fakeGuest();
    const list = [cert(1), cert(2)];
    const callback = vi.fn();
    clientCert.select(contents, URL_B, list, callback);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]?.[0]).toBe(list[1]);
    expect(host.send).not.toHaveBeenCalled();
    expect(clientCert.isPending(5)).toBe(false);
    expect(lines).toEqual([{ host: URL_B, count: 2, outcome: 'remembered' }]);
  });

  it('запомненный отпечаток пропал — запись снята, вопрос задан', () => {
    const store = memoryStore({ [URL_B]: 'sha256/fp-gone' });
    const { clientCert } = setup({ store });
    const { contents, host } = fakeGuest();
    const callback = vi.fn();
    clientCert.select(contents, URL_B, [cert(1)], callback);
    expect(store.get(URL_B)).toBeNull();
    expect(store.delete).toHaveBeenCalledWith(URL_B);
    expect(callback).not.toHaveBeenCalled();
    expect(host.send).toHaveBeenCalledTimes(1);
    expect(host.send.mock.calls[0]?.[0]).toBe('browser:cert-request');
  });

  it('вопрос: пять полей сертификата, хост запроса и страницы, isPending и onPending', () => {
    const { clientCert, lines } = setup();
    const { contents, host } = fakeGuest(5, 'https://example.com/login');
    const listener = vi.fn();
    clientCert.onPending(5, listener);
    expect(clientCert.isPending(5)).toBe(false);
    clientCert.select(contents, 'auth.example.com:6443', [cert(1), cert(2)], vi.fn());
    expect(host.send).toHaveBeenCalledWith('browser:cert-request', {
      requestId: 'r1',
      webContentsId: 5,
      host: 'auth.example.com:6443',
      pageHost: 'example.com',
      certificates: [
        { fingerprint: 'sha256/fp-1', subjectName: 'Subject 1', issuerName: 'Issuer 1', serialNumber: '01', validExpiry: 2001 },
        { fingerprint: 'sha256/fp-2', subjectName: 'Subject 2', issuerName: 'Issuer 2', serialNumber: '02', validExpiry: 2002 },
      ],
    });
    expect(clientCert.isPending(5)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([{ host: 'auth.example.com:6443', count: 2, outcome: 'asked' }]);
  });

  it('pageHost — null, когда страница на том же хост:порт или без адреса', () => {
    const { clientCert } = setup();
    const same = fakeGuest(5, 'https://auth.example.com:6443/login');
    clientCert.select(same.contents, 'auth.example.com:6443', [cert(1)], vi.fn());
    expect((same.host.send.mock.calls[0]?.[1] as { pageHost: string | null }).pageHost).toBeNull();

    const blank = fakeGuest(6, 'about:blank');
    clientCert.select(blank.contents, 'auth.example.com:6443', [cert(1)], vi.fn());
    expect((blank.host.send.mock.calls[0]?.[1] as { pageHost: string | null }).pageHost).toBeNull();
  });
});

describe('createClientCert: ответ окна', () => {
  it('отпечаток из списка: callback(сертификат) один раз, без галочки в хранилище не пишется, с галочкой — пишется', () => {
    const { clientCert, store, lines } = setup();
    const { contents, host } = fakeGuest();
    const list = [cert(1), cert(2)];
    const callback = vi.fn();
    clientCert.select(contents, URL_B, list, callback);
    clientCert.answer('r1', 'sha256/fp-2', false, host as unknown as WebContents);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]?.[0]).toBe(list[1]);
    expect(store.set).not.toHaveBeenCalled();
    expect(clientCert.isPending(5)).toBe(false);
    expect(lines.at(-1)).toEqual({ host: URL_B, count: 2, outcome: 'chosen' });

    const other = fakeGuest(6);
    const callback2 = vi.fn();
    clientCert.select(other.contents, URL_C, list, callback2);
    clientCert.answer('r2', 'sha256/fp-1', true, other.host as unknown as WebContents);
    expect(callback2.mock.calls[0]?.[0]).toBe(list[0]);
    expect(store.set).toHaveBeenCalledTimes(1);
    expect(store.set).toHaveBeenCalledWith(URL_C, 'sha256/fp-1');
  });

  it('«не сейчас» (ответ null): callback не зовётся, ничего не запоминается, слою отмена не шлётся, журнал cancelled', () => {
    const { clientCert, store, lines } = setup();
    const { contents, host } = fakeGuest();
    const callback = vi.fn();
    clientCert.select(contents, URL_B, [cert(1)], callback);
    clientCert.answer('r1', null, true, host as unknown as WebContents);
    expect(callback).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
    expect(store.get(URL_B)).toBeNull();
    expect(clientCert.isPending(5)).toBe(false);
    expect(host.send).toHaveBeenCalledTimes(1);
    expect(lines.at(-1)).toEqual({ host: URL_B, count: 1, outcome: 'cancelled' });
  });

  it('отпечаток не из списка запроса — как «не сейчас», окну уходит отмена слоя', () => {
    const { clientCert, store } = setup();
    const { contents, host } = fakeGuest();
    const callback = vi.fn();
    clientCert.select(contents, URL_B, [cert(1)], callback);
    clientCert.answer('r1', 'sha256/not-in-list', true, host as unknown as WebContents);
    expect(callback).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
    expect(clientCert.isPending(5)).toBe(false);
    expect(host.send).toHaveBeenLastCalledWith('browser:cert-cancel', { requestId: 'r1', webContentsId: 5 });
  });

  it('чужой sender и неизвестный requestId — игнор, запрос висит; повторный ответ callback второй раз не зовёт', () => {
    const { clientCert } = setup();
    const { contents, host } = fakeGuest();
    const callback = vi.fn();
    clientCert.select(contents, URL_B, [cert(1)], callback);
    clientCert.answer('r1', 'sha256/fp-1', false, {} as WebContents);
    clientCert.answer('unknown', 'sha256/fp-1', false, host as unknown as WebContents);
    expect(callback).not.toHaveBeenCalled();
    expect(clientCert.isPending(5)).toBe(true);

    clientCert.answer('r1', 'sha256/fp-1', false, host as unknown as WebContents);
    clientCert.answer('r1', 'sha256/fp-1', false, host as unknown as WebContents);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('второй запрос к тому же хост:порт ждёт первого: окну один запрос, после ответа оба callback с одним сертификатом', () => {
    const { clientCert } = setup();
    const { contents, host } = fakeGuest();
    const list = [cert(1)];
    const first = vi.fn();
    const second = vi.fn();
    clientCert.select(contents, URL_B, list, first);
    clientCert.select(contents, URL_B, [cert(1)], second);
    expect(host.send).toHaveBeenCalledTimes(1);
    clientCert.answer('r1', 'sha256/fp-1', false, host as unknown as WebContents);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0]?.[0]).toBe(first.mock.calls[0]?.[0]);
  });

  it('запрос к другому хост:порт встаёт в очередь: второй browser:cert-request уходит только после ответа на первый', () => {
    const { clientCert } = setup();
    const { contents, host } = fakeGuest();
    const first = vi.fn();
    const second = vi.fn();
    const onPending = vi.fn();
    clientCert.onPending(5, onPending);
    clientCert.select(contents, URL_B, [cert(1)], first);
    clientCert.select(contents, URL_C, [cert(2)], second);
    expect(host.send).toHaveBeenCalledTimes(1);
    expect(onPending).toHaveBeenCalledTimes(1);

    // «Не сейчас» на первом: второй показывается, callback первого не зовётся.
    clientCert.answer('r1', null, false, host as unknown as WebContents);
    expect(first).not.toHaveBeenCalled();
    expect(host.send).toHaveBeenCalledTimes(2);
    expect(host.send.mock.calls[1]?.[1]).toMatchObject({ requestId: 'r2', host: URL_C });
    expect(clientCert.isPending(5)).toBe(true);
    expect(onPending).toHaveBeenCalledTimes(2);

    clientCert.answer('r2', 'sha256/fp-2', false, host as unknown as WebContents);
    expect(second).toHaveBeenCalledTimes(1);
    expect(clientCert.isPending(5)).toBe(false);
  });
});

describe('createClientCert: вкладка ушла', () => {
  it('уход главного фрейма забывает запросы без callback, окну — отмена слоя; очередь старой страницы тоже забыта', () => {
    const { clientCert, lines } = setup();
    const { contents, emitter, host } = fakeGuest();
    clientCert.attach(contents);
    const first = vi.fn();
    const waiting = vi.fn();
    const queued = vi.fn();
    clientCert.select(contents, URL_B, [cert(1)], first);
    clientCert.select(contents, URL_B, [cert(1)], waiting);
    clientCert.select(contents, URL_C, [cert(2)], queued);

    emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(first).not.toHaveBeenCalled();
    expect(waiting).not.toHaveBeenCalled();
    expect(queued).not.toHaveBeenCalled();
    expect(host.send).toHaveBeenCalledTimes(2);
    expect(host.send).toHaveBeenLastCalledWith('browser:cert-cancel', { requestId: 'r1', webContentsId: 5 });
    expect(clientCert.isPending(5)).toBe(false);
    expect(lines.filter((line) => line.outcome === 'cancelled')).toHaveLength(2);

    // Ответ на снятый запрос ничего не вызывает.
    clientCert.answer('r1', 'sha256/fp-1', false, host as unknown as WebContents);
    expect(first).not.toHaveBeenCalled();

    // Новая страница того же хост:порт спрашивает снова.
    const again = vi.fn();
    clientCert.select(contents, URL_B, [cert(1)], again);
    expect(host.send).toHaveBeenCalledTimes(3);
    expect(host.send.mock.calls[2]?.[0]).toBe('browser:cert-request');
  });

  it('закрытие вкладки — то же без события окну', () => {
    const { clientCert } = setup();
    const { contents, emitter, host } = fakeGuest();
    clientCert.attach(contents);
    const callback = vi.fn();
    clientCert.select(contents, URL_B, [cert(1)], callback);
    emitter.emit('destroyed');
    expect(callback).not.toHaveBeenCalled();
    expect(host.send).toHaveBeenCalledTimes(1);
    expect(clientCert.isPending(5)).toBe(false);
  });

  it('подкадр и переход в том же документе запрос не снимают', () => {
    const { clientCert } = setup();
    const { contents, emitter } = fakeGuest();
    clientCert.attach(contents);
    clientCert.select(contents, URL_B, [cert(1)], vi.fn());
    emitter.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(clientCert.isPending(5)).toBe(true);
  });

  it('очистка: clear стирает выборы хранилища', async () => {
    const store = memoryStore({ [URL_B]: 'sha256/fp-1' });
    const { clientCert } = setup({ store });
    await clientCert.clear();
    expect(store.get(URL_B)).toBeNull();
  });
});

describe('журнал', () => {
  it('у каждой записи ключи ровно host, count, outcome — без имён и отпечатков', () => {
    const store = memoryStore({ [URL_C]: 'sha256/fp-1' });
    const { clientCert, lines } = setup({ store });
    const { contents, host } = fakeGuest();
    clientCert.select(contents, URL_B, [cert(1)], vi.fn());
    clientCert.answer('r1', 'sha256/fp-1', true, host as unknown as WebContents);
    clientCert.select(contents, URL_C, [cert(1)], vi.fn());
    clientCert.select(null, URL_B, [cert(1)], vi.fn());
    expect(lines.map((line) => line.outcome)).toEqual(['asked', 'chosen', 'remembered', 'denied-not-guest']);
    for (const line of lines) expect(Object.keys(line).sort()).toEqual(['count', 'host', 'outcome']);
    const text = JSON.stringify(lines);
    expect(text).not.toContain('Subject');
    expect(text).not.toContain('sha256/');
  });
});

describe('humanWait', () => {
  it('оба undefined — undefined', () => {
    expect(humanWait(undefined, undefined)).toBeUndefined();
  });

  it('isPending истинен, если истинен любой; отписка onPending снимает обоих', () => {
    const offAuth = vi.fn();
    const offCert = vi.fn();
    const auth = { isPending: vi.fn(() => false), onPending: vi.fn(() => offAuth) };
    const certWait = { isPending: vi.fn(() => false), onPending: vi.fn(() => offCert) };
    const wait = humanWait(auth, certWait);
    expect(wait?.isPending(1)).toBe(false);
    certWait.isPending.mockReturnValue(true);
    expect(wait?.isPending(1)).toBe(true);
    certWait.isPending.mockReturnValue(false);
    auth.isPending.mockReturnValue(true);
    expect(wait?.isPending(1)).toBe(true);

    const listener = vi.fn();
    const off = wait?.onPending(1, listener);
    expect(auth.onPending).toHaveBeenCalledWith(1, listener);
    expect(certWait.onPending).toHaveBeenCalledWith(1, listener);
    off?.();
    expect(offAuth).toHaveBeenCalledTimes(1);
    expect(offCert).toHaveBeenCalledTimes(1);
  });

  it('один источник работает один', () => {
    const only = { isPending: vi.fn(() => true), onPending: vi.fn(() => () => undefined) };
    expect(humanWait(undefined, only)?.isPending(1)).toBe(true);
    expect(humanWait(only, undefined)?.isPending(1)).toBe(true);
  });
});

describe('CLIENT_CERT_HINT', () => {
  it('текст подсказки агенту', () => {
    expect(CLIENT_CERT_HINT).toBe('The site asks for a client certificate: ask the human to choose it in the browser panel.');
  });
});

describe('createCertChoiceStore: файл', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const fileIn = async (): Promise<string> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'parley-certs-'));
    dirs.push(dir);
    return path.join(dir, 'desktop', 'browser-client-certs.json');
  };

  it('set пишет version 1 и выбор; load на новом хранилище читает его обратно', async () => {
    const file = await fileIn();
    const store = createCertChoiceStore({ file });
    await store.set('a.b:6443', 'sha256/x');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, choices: { 'a.b:6443': 'sha256/x' } });
    expect(store.get('a.b:6443')).toBe('sha256/x');

    const again = createCertChoiceStore({ file });
    expect(again.get('a.b:6443')).toBeNull();
    await again.load();
    expect(again.get('a.b:6443')).toBe('sha256/x');
  });

  it('delete снимает запись и с диска; delete отсутствующего файл не создаёт', async () => {
    const file = await fileIn();
    const store = createCertChoiceStore({ file });
    await store.delete('none:443');
    await expect(readFile(file, 'utf8')).rejects.toThrow();
    await store.set('a.b:443', 'sha256/x');
    await store.delete('a.b:443');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, choices: {} });
    expect(store.get('a.b:443')).toBeNull();
  });

  it('битый файл (не JSON, массив, choices не объект) — пустая память без исключения, файл не затёрт', async () => {
    for (const text of ['{', '[]', '{ "choices": 5 }', '{ "choices": [] }', 'null']) {
      const file = await fileIn();
      const store = createCertChoiceStore({ file });
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
      await expect(store.load()).resolves.toBeUndefined();
      expect(store.get('a.b:443')).toBeNull();
      expect(await readFile(file, 'utf8')).toBe(text);
    }
  });

  it('load пропускает записи не-строки; нет файла — пусто', async () => {
    const file = await fileIn();
    const store = createCertChoiceStore({ file });
    await store.load();
    expect(store.get('a.b:443')).toBeNull();
    await mkdir(path.dirname(file), { recursive: true });
    const again = createCertChoiceStore({ file });
    await writeFile(file, JSON.stringify({ version: 1, choices: { 'keep:443': 'sha256/keep', 'bad:443': 5, 'empty:443': '' } }));
    await again.load();
    expect(again.get('keep:443')).toBe('sha256/keep');
    expect(again.get('bad:443')).toBeNull();
    expect(again.get('empty:443')).toBeNull();
  });

  it('clear стирает память и пишет пустые choices', async () => {
    const file = await fileIn();
    const store = createCertChoiceStore({ file });
    await store.set('a.b:443', 'sha256/x');
    await store.clear();
    expect(store.get('a.b:443')).toBeNull();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, choices: {} });
  });
});
