import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetChatUiStoreForTests, useChatUiStore } from './ui-store.js';

beforeEach(() => {
  resetChatUiStoreForTests();
});

describe('ui-store: вложения поля ввода', () => {
  it('списки путей — по сессии, сброс для тестов их стирает', () => {
    const { setAttachments } = useChatUiStore.getState();
    setAttachments('a', ['/x.png']);
    setAttachments('b', ['/y.txt', '/z.txt']);
    expect(useChatUiStore.getState().attachments).toEqual({ a: ['/x.png'], b: ['/y.txt', '/z.txt'] });
    resetChatUiStoreForTests();
    expect(useChatUiStore.getState().attachments).toEqual({});
  });

  it('тот же массив — стор не трогается: подписчики не вызываются', () => {
    const paths = ['/x.png'];
    useChatUiStore.getState().setAttachments('a', paths);
    const listener = vi.fn();
    const off = useChatUiStore.subscribe(listener);
    useChatUiStore.getState().setAttachments('a', paths);
    expect(listener).not.toHaveBeenCalled();
    useChatUiStore.getState().setAttachments('a', ['/x.png']);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});
