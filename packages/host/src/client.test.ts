import type { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { encodeLine } from '@parley/protocol';
import { createClient, remoteMayReceive } from './client.js';

/** Сокет-заглушка: всё записанное — в `written`. */
function fakeSocket(): { socket: Socket; written: string[] } {
  const written: string[] = [];
  const socket = {
    destroyed: false,
    writableLength: 0,
    write: vi.fn((line: string) => {
      written.push(line);
      return true;
    }),
    end: vi.fn(),
  } as unknown as Socket;
  return { socket, written };
}

describe('граница отправки клиента remote (спека мобильного приложения 4.1)', () => {
  it('send: ответы и события из REMOTE_EVENTS проходят, feed.changed и telegram.changed — нет', () => {
    const { socket, written } = fakeSocket();
    const client = createClient(socket, 'remote', [], 'remote');
    expect(client.role).toBe('remote');

    expect(client.send({ id: 1, result: { ok: true } })).toBe(true);
    expect(client.send({ id: 2, error: { code: 'not_found', message: 'нет' } })).toBe(true);
    expect(client.send({ event: 'works.changed', data: {} } as never)).toBe(true);
    // Отброшенный кадр — не переполнение: `true`, клиента не считают медленным.
    expect(client.send({ event: 'feed.changed', data: {} } as never)).toBe(true);
    expect(client.send({ event: 'telegram.changed', data: {} } as never)).toBe(true);
    expect(client.send({ event: 'pty.output', data: {} } as never)).toBe(true);

    expect(written.map((line) => JSON.parse(line) as unknown)).toEqual([
      { id: 1, result: { ok: true } },
      { id: 2, error: { code: 'not_found', message: 'нет' } },
      { event: 'works.changed', data: {} },
    ]);
  });

  it('sendLine решает по разобранному кадру: имя разрешённого события внутри данных запрещённого не помогает', () => {
    const { socket, written } = fakeSocket();
    const client = createClient(socket, 'remote', [], 'remote');
    const allowed = encodeLine({ event: 'works.changed', data: { n: 1 } } as never);
    const smuggled = encodeLine({ event: 'telegram.changed', data: { note: '"event":"works.changed"' } } as never);
    const feed = encodeLine({ event: 'feed.changed', data: { event: 'works.changed' } } as never);

    client.sendLine?.(smuggled);
    client.sendLine?.(feed);
    client.sendLine?.(allowed);
    client.sendLine?.(encodeLine({ id: 7, result: null }));

    expect(written).toEqual([allowed, encodeLine({ id: 7, result: null })]);
  });

  it('sendLine: несколько кадров в одной строке, перевод строки внутри, не JSON и не объект — не уходят', () => {
    const { socket, written } = fakeSocket();
    const client = createClient(socket, 'remote', [], 'remote');
    const forbidden = encodeLine({ event: 'telegram.changed', data: {} } as never);
    // Разрешённый ответ, внутри которого после разрезки по `\n` оказался бы целый запрещённый кадр.
    const split = `{"id":1,"result":\n${forbidden}}\n`;
    expect(JSON.parse(split)).toMatchObject({ id: 1 });

    for (const line of [
      split,
      `${encodeLine({ id: 1, result: null })}${forbidden}`,
      encodeLine({ id: 1, result: null }).slice(0, -1),
      'не json\n',
      '[{"id":1}]\n',
      'null\n',
      '{"result":1}\n',
      '{"id":"1","result":1}\n',
    ]) {
      expect(client.sendLine?.(line)).toBe(true);
    }
    expect(written).toEqual([]);
  });

  it('remoteMayReceive: кадр и с id, и с запрещённым event — событие, не ответ', () => {
    expect(remoteMayReceive({ id: 1, event: 'telegram.changed', data: {} })).toBe(false);
    expect(remoteMayReceive({ id: 1, event: 'works.changed', data: {} })).toBe(true);
    expect(remoteMayReceive({ event: 5 })).toBe(false);
  });

  it('клиент без роли — полный: все события и строки уходят как есть', () => {
    const { socket, written } = fakeSocket();
    const client = createClient(socket, 'desktop', ['compact-works']);
    expect(client.role).toBeUndefined();
    expect('role' in client).toBe(false);
    client.send({ event: 'telegram.changed', data: {} } as never);
    client.sendLine?.('произвольная строка\n');
    expect(written).toEqual([encodeLine({ event: 'telegram.changed', data: {} } as never), 'произвольная строка\n']);
  });
});
