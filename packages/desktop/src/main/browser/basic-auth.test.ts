import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { createBasicAuth, createCredentialStore, originOf } from './basic-auth.js';

const ORIGIN = 'http://127.0.0.1:8080';
const CREDS = { username: 'admin', password: 'pw' };

describe('createCredentialStore', () => {
  it('пара из адреса отвечает на первый вызов origin, повтор — запрос с retry и без пары', () => {
    const store = createCredentialStore();
    store.remember(1, ORIGIN, CREDS);
    expect(store.decide(1, ORIGIN)).toEqual({ kind: 'credentials', credentials: CREDS });
    // Сервер отклонил: вызов повторился до конца загрузки.
    expect(store.decide(1, ORIGIN)).toEqual({ kind: 'prompt', retry: true });
    store.settle(1);
    // Пару, которую отклонили, не пробуем снова.
    expect(store.decide(1, ORIGIN)).toEqual({ kind: 'prompt', retry: false });
  });

  it('удачный вход: после конца загрузки пара снова годится для нового перехода', () => {
    const store = createCredentialStore();
    store.remember(1, ORIGIN, CREDS);
    store.decide(1, ORIGIN);
    store.settle(1);
    expect(store.decide(1, ORIGIN)).toEqual({ kind: 'credentials', credentials: CREDS });
  });

  it('пара привязана к вкладке и origin', () => {
    const store = createCredentialStore();
    store.remember(1, ORIGIN, CREDS);
    expect(store.decide(2, ORIGIN)).toEqual({ kind: 'prompt', retry: false });
    expect(store.decide(1, 'http://127.0.0.1:9090')).toEqual({ kind: 'prompt', retry: false });
  });

  it('введённое человеком: повторный вызов — retry; отмена — не retry', () => {
    const store = createCredentialStore();
    expect(store.decide(1, ORIGIN)).toEqual({ kind: 'prompt', retry: false });
    store.answered(1, ORIGIN);
    expect(store.decide(1, ORIGIN)).toEqual({ kind: 'prompt', retry: true });
    store.cancelled(1, ORIGIN);
    expect(store.decide(1, ORIGIN)).toEqual({ kind: 'prompt', retry: false });
  });

  it('пара агента из open держится за страницей и достаётся только её гостю; чужой гость того же origin ничего не получает', () => {
    const store = createCredentialStore();
    store.holdForPage('browser:aaaaaa', ORIGIN, CREDS);
    // Чужая вкладка того же origin, чьё обращение пришло первым.
    expect(store.decide(8, ORIGIN)).toEqual({ kind: 'prompt', retry: false });
    store.claimPage(7, 'browser:aaaaaa');
    expect(store.decide(7, ORIGIN)).toEqual({ kind: 'credentials', credentials: CREDS });
    expect(store.decide(9, ORIGIN)).toEqual({ kind: 'prompt', retry: false });
  });

  it('параллельные open одного origin за разными страницами не затирают друг друга', () => {
    const store = createCredentialStore();
    store.holdForPage('p1', ORIGIN, CREDS);
    store.holdForPage('p2', ORIGIN, { username: 'other', password: 'x' });
    store.claimPage(1, 'p1');
    store.claimPage(2, 'p2');
    expect(store.decide(1, ORIGIN)).toEqual({ kind: 'credentials', credentials: CREDS });
    expect(store.decide(2, ORIGIN)).toEqual({ kind: 'credentials', credentials: { username: 'other', password: 'x' } });
  });

  it('пара ждёт страницу без срока; dropPage (закрытие или отказ) её снимает, повторный claim ничего не даёт', () => {
    const store = createCredentialStore();
    store.holdForPage('p1', ORIGIN, CREDS);
    store.dropPage('p1');
    store.claimPage(1, 'p1');
    expect(store.decide(1, ORIGIN)).toEqual({ kind: 'prompt', retry: false });
    store.holdForPage('p2', ORIGIN, CREDS);
    store.claimPage(2, 'p2');
    store.claimPage(3, 'p2');
    expect(store.decide(3, ORIGIN)).toEqual({ kind: 'prompt', retry: false });
  });

  it('forget снимает все пары вкладки', () => {
    const store = createCredentialStore();
    store.remember(1, ORIGIN, CREDS);
    store.forget(1);
    expect(store.decide(1, ORIGIN)).toEqual({ kind: 'prompt', retry: false });
  });
});

describe('originOf', () => {
  it('http(s) — origin; иное — null', () => {
    expect(originOf('http://127.0.0.1:8080/a?b')).toBe(ORIGIN);
    expect(originOf('file:///x')).toBeNull();
    expect(originOf('nope')).toBeNull();
  });
});

interface FakeHost {
  isDestroyed(): boolean;
  send: ReturnType<typeof vi.fn>;
}

function fake(): { contents: WebContents; host: FakeHost; login(info?: Partial<{ scheme: string; isProxy: boolean; host: string; port: number; realm: string }>, url?: string): ReturnType<typeof vi.fn> } {
  const host: FakeHost = { isDestroyed: () => false, send: vi.fn() };
  const emitter = new EventEmitter() as EventEmitter & { id: number; hostWebContents: FakeHost };
  emitter.id = 5;
  emitter.hostWebContents = host;
  return {
    contents: emitter as unknown as WebContents,
    host,
    login(info = {}, url = `${ORIGIN}/secret`) {
      const callback = vi.fn();
      const event = { preventDefault: vi.fn() };
      emitter.emit('login', event, { url }, { scheme: 'basic', isProxy: false, host: '127.0.0.1', port: 8080, realm: 'Stand', ...info }, callback);
      return callback;
    },
  };
}

describe('createBasicAuth', () => {
  it('без пары спрашивает окно; ответ отдаётся Chromium', () => {
    const auth = createBasicAuth({ newId: () => 'r1' });
    const { contents, host, login } = fake();
    auth.attach(contents);
    const callback = login();
    expect(host.send).toHaveBeenCalledWith('browser:auth-request', { requestId: 'r1', webContentsId: 5, host: '127.0.0.1:8080', realm: 'Stand', isProxy: false, retry: false });
    expect(auth.isPending(5)).toBe(true);
    auth.answer('r1', CREDS, host as unknown as WebContents);
    expect(callback).toHaveBeenCalledWith('admin', 'pw');
    expect(auth.isPending(5)).toBe(false);
  });

  it('пара из адреса отвечает без вопроса; отклонённая — вопрос с retry', () => {
    const auth = createBasicAuth({ newId: () => 'r2' });
    const { contents, host, login } = fake();
    auth.attach(contents);
    auth.remember(5, ORIGIN, CREDS);
    expect(login()).toHaveBeenCalledWith('admin', 'pw');
    expect(host.send).not.toHaveBeenCalled();
    login();
    expect(host.send).toHaveBeenCalledWith('browser:auth-request', expect.objectContaining({ retry: true }));
  });

  it('отмена — callback() без аргументов', () => {
    const auth = createBasicAuth({ newId: () => 'r3' });
    const { contents, host, login } = fake();
    auth.attach(contents);
    const callback = login();
    auth.answer('r3', null, host as unknown as WebContents);
    expect(callback).toHaveBeenCalledWith();
  });

  it('чужой отправитель ответ не принимает', () => {
    const auth = createBasicAuth({ newId: () => 'r4' });
    const { contents, login } = fake();
    auth.attach(contents);
    const callback = login();
    auth.answer('r4', CREDS, {} as WebContents);
    expect(callback).not.toHaveBeenCalled();
    expect(auth.isPending(5)).toBe(true);
  });

  it('уход со страницы и закрытие вкладки отменяют ожидающий запрос', () => {
    const auth = createBasicAuth({ newId: () => 'r5' });
    const first = fake();
    auth.attach(first.contents);
    const callback = first.login();
    (first.contents as unknown as EventEmitter).emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(callback).toHaveBeenCalledWith();
    expect(first.host.send).toHaveBeenCalledWith('browser:auth-cancel', { requestId: 'r5', webContentsId: 5 });
    expect(auth.isPending(5)).toBe(false);

    const second = fake();
    auth.attach(second.contents);
    const callback2 = second.login();
    (second.contents as unknown as EventEmitter).emit('destroyed');
    expect(callback2).toHaveBeenCalledWith();
  });

  it('подкадр и переход в том же документе запрос не отменяют', () => {
    const auth = createBasicAuth({ newId: () => 'r6' });
    const { contents, login } = fake();
    auth.attach(contents);
    const callback = login();
    (contents as unknown as EventEmitter).emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    (contents as unknown as EventEmitter).emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(callback).not.toHaveBeenCalled();
  });

  it('прокси — запрос с пометкой; не-basic схема не перехватывается; второй вызов при ожидании отменяется', () => {
    const auth = createBasicAuth({ newId: () => 'r7' });
    const { contents, host, login } = fake();
    auth.attach(contents);
    const digest = login({ scheme: 'digest' });
    expect(digest).not.toHaveBeenCalled();
    expect(host.send).not.toHaveBeenCalled();
    login({ isProxy: true, host: 'proxy.test', port: 3128 }, 'http://proxy.test:3128/');
    expect(host.send).toHaveBeenCalledWith('browser:auth-request', expect.objectContaining({ isProxy: true, host: 'proxy.test:3128' }));
    const second = login();
    expect(second).toHaveBeenCalledWith();
  });

  it('remember для вкладки, ждущей человека на вызов этого origin, отвечает этому вызову и снимает оверлей', () => {
    const auth = createBasicAuth({ newId: () => 'r9' });
    const { contents, host, login } = fake();
    auth.attach(contents);
    const callback = login();
    auth.remember(5, ORIGIN, CREDS);
    expect(callback).toHaveBeenCalledWith('admin', 'pw');
    expect(auth.isPending(5)).toBe(false);
    expect(host.send).toHaveBeenCalledWith('browser:auth-cancel', { requestId: 'r9', webContentsId: 5 });
  });

  it('remember для другого origin ожидающий вызов не трогает', () => {
    const auth = createBasicAuth({ newId: () => 'r10' });
    const { contents, login } = fake();
    auth.attach(contents);
    const callback = login();
    auth.remember(5, 'http://other.test', CREDS);
    expect(callback).not.toHaveBeenCalled();
    expect(auth.isPending(5)).toBe(true);
  });

  it('прокси-запрос парой из адреса не отвечается', () => {
    const auth = createBasicAuth({ newId: () => 'r11' });
    const { contents, login } = fake();
    auth.attach(contents);
    const callback = login({ isProxy: true, host: '127.0.0.1', port: 8080 }, `${ORIGIN}/`);
    auth.remember(5, ORIGIN, CREDS);
    expect(callback).not.toHaveBeenCalled();
    expect(auth.isPending(5)).toBe(true);
  });

  it('onPending сообщает, что вкладка начала ждать', () => {
    const auth = createBasicAuth({ newId: () => 'r8' });
    const { contents, login } = fake();
    auth.attach(contents);
    const seen = vi.fn();
    const off = auth.onPending(5, seen);
    login();
    expect(seen).toHaveBeenCalledOnce();
    off();
  });

  it('нет окна-хозяина — вызов отменяется сразу', () => {
    const auth = createBasicAuth();
    const { contents, login } = fake();
    (contents as unknown as { hostWebContents: unknown }).hostWebContents = null;
    auth.attach(contents);
    expect(login()).toHaveBeenCalledWith();
  });
});
