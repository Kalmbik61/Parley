import { describe, expect, it } from 'vitest';
import { openMemoryDb } from '@parley/core';
import { createConversationStore } from './conversation-store.js';

describe('conversation-store', () => {
  it('история общая для каналов и переживает новый стор на той же базе', () => {
    const db = openMemoryDb();
    const store = createConversationStore(db);
    store.write({ turnKey: 'a:1', role: 'user', channel: 'island', text: 'hi' }, 1);
    store.write({ turnKey: 'a:1', role: 'assistant', channel: 'island', text: 'hello' }, 2);
    store.write({ turnKey: 'a:2', role: 'user', channel: 'telegram', text: 'and?' }, 3);

    const reopened = createConversationStore(db); // рестарт хоста: тот же файл, новый стор
    expect(reopened.history(10).map((m) => [m.channel, m.role, m.text])).toEqual([
      ['island', 'user', 'hi'],
      ['island', 'assistant', 'hello'],
      ['telegram', 'user', 'and?'],
    ]);
  });

  it('повтор записи с тем же ключом и ролью не плодит строк', () => {
    const store = createConversationStore(openMemoryDb());
    store.write({ turnKey: 'a:1', role: 'assistant', channel: 'island', text: 'part' }, 1);
    store.write({ turnKey: 'a:1', role: 'assistant', channel: 'island', text: 'part' }, 2);
    store.write({ turnKey: 'a:1', role: 'assistant', channel: 'island', text: 'full' }, 3);
    expect(store.history(10)).toHaveLength(1);
    expect(store.history(10)[0]?.text).toBe('full');
  });

  it('startNew открывает новый разговор: история прошлого не мешается, но остаётся в базе', () => {
    const db = openMemoryDb();
    const store = createConversationStore(db);
    store.write({ turnKey: 'a:1', role: 'user', channel: 'island', text: 'old' }, 1);
    store.startNew(2);
    expect(store.history(10)).toEqual([]);
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM assistant_messages').get() as { n: number }).n)).toBe(1);
  });

  it('history отдаёт последние limit сообщений, старые первыми', () => {
    const store = createConversationStore(openMemoryDb());
    for (let i = 1; i <= 5; i += 1) store.write({ turnKey: `a:${i}`, role: 'user', channel: 'island', text: `m${i}` }, i);
    expect(store.history(2).map((m) => m.text)).toEqual(['m4', 'm5']);
  });
});
