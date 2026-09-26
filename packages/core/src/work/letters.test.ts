import { describe, expect, it } from 'vitest';
import { isUnreadFor, recipientsOf, unreadFor } from './letters.js';
import { addMessage } from './map.js';
import { HUMAN, type WorkMap } from './types.js';

/** Работа с комнатой r-01: создатель s-01, участники s-02 и s-03; s-04 вне её. */
const mapWithRoom = (): WorkMap => ({
  schemaVersion: 2,
  work: {
    id: 'w-0001',
    title: 'комнаты',
    goal: '',
    status: 'active',
    createdAt: '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
  },
  sessions: [],
  messages: [],
  rooms: [
    {
      id: 'r-01',
      title: 'бэкенд',
      creator: 's-01',
      members: ['s-02', 's-03'],
      createdAt: '2026-09-26T10:00:00.000Z',
    },
  ],
});

describe('recipientsOf', () => {
  it('прямое письмо — адресаты из to', () => {
    const map = mapWithRoom();
    const letter = addMessage(map, { from: 's-01', to: ['s-04'], text: 'x' });

    expect(recipientsOf(letter, map)).toEqual(['s-04']);
  });

  it('адресное письмо в комнате — только адресаты', () => {
    const map = mapWithRoom();
    const letter = addMessage(map, { from: 's-02', to: ['s-03'], text: 'x', roomId: 'r-01' });

    expect(recipientsOf(letter, map)).toEqual(['s-03']);
  });

  it('рассылка комнаты — все участники без отправителя, создатель тоже участник', () => {
    const map = mapWithRoom();
    const letter = addMessage(map, { from: 's-02', to: [], text: 'x', roomId: 'r-01' });

    expect(recipientsOf(letter, map).sort()).toEqual(['s-01', 's-03']);
  });

  it('рассылка человека — всем участникам', () => {
    const map = mapWithRoom();
    const letter = addMessage(map, { from: HUMAN, to: [], text: 'x', roomId: 'r-01' });

    expect(recipientsOf(letter, map).sort()).toEqual(['s-01', 's-02', 's-03']);
  });

  it('комнаты нет в карте — адресатов у рассылки нет', () => {
    const map = mapWithRoom();
    const letter = addMessage(map, { from: 's-02', to: [], text: 'x', roomId: 'r-09' });

    expect(recipientsOf(letter, map)).toEqual([]);
  });
});

describe('unreadFor', () => {
  it('прочтение отмечается по адресату, а не по письму', () => {
    const map = mapWithRoom();
    const broadcast = addMessage(map, { from: 's-01', to: [], text: 'всем', roomId: 'r-01' });
    broadcast.readBy['s-02'] = '2026-09-26T10:05:00.000Z';

    expect(isUnreadFor(broadcast, 's-02', map)).toBe(false);
    expect(isUnreadFor(broadcast, 's-03', map)).toBe(true);
    expect(unreadFor(map, 's-02')).toEqual([]);
    expect(unreadFor(map, 's-03')).toEqual([broadcast]);
  });

  it('письмо не адресату непрочитанным у него не числится', () => {
    const map = mapWithRoom();
    addMessage(map, { from: 's-02', to: ['s-03'], text: 'лично', roomId: 'r-01' });
    const direct = addMessage(map, { from: 's-01', to: ['s-04'], text: 'x' });

    expect(unreadFor(map, 's-01')).toEqual([]);
    expect(unreadFor(map, 's-04')).toEqual([direct]);
    // Отправитель своё письмо не «читает».
    expect(unreadFor(map, 's-02')).toEqual([]);
  });
});
