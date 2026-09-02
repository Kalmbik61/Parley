import { describe, expect, it } from 'vitest';
import { addMessage, addSession, parseMap, transitionSession } from './map.js';
import type { SessionStatus, WorkMap } from './types.js';

const emptyMap = (): WorkMap => ({
  schemaVersion: 1,
  work: {
    id: 'w-0001',
    title: 'Авторизация',
    goal: 'цель',
    status: 'active',
    createdAt: '2026-09-02T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
  },
  sessions: [],
  messages: [],
});

describe('addSession', () => {
  it('нумерует сессии s-NN по порядку и создаёт запись pending', () => {
    const map = emptyMap();
    const first = addSession(map, { provider: 'claude', label: 'план', task: 'составить план' });
    const second = addSession(map, {
      provider: 'codex',
      label: 'бэкенд',
      task: 'шаги 1–3',
      parent: 's-01',
      contextFrom: ['s-01'],
    });

    expect(first.id).toBe('s-01');
    expect(second.id).toBe('s-02');
    expect(first.status).toBe('pending');
    expect(first.history).toEqual([{ status: 'pending', at: first.history[0]?.at }]);
    expect(first.parent).toBeNull();
    expect(first.contextFrom).toEqual([]);
    expect(second.parent).toBe('s-01');
    expect(second.contextFrom).toEqual(['s-01']);
    expect(first.summary).toBeNull();
    expect(first.summarySource).toBeNull();
    expect(first.metrics).toBeNull();
    expect(map.sessions).toHaveLength(2);
  });

  it('нумерация продолжается от максимального id в карте', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: 't' });
    addSession(map, { provider: 'claude', label: 'b', task: 't' });
    map.sessions.splice(0, 1);

    expect(addSession(map, { provider: 'claude', label: 'c', task: 't' }).id).toBe('s-03');
  });

  it('провайдер не ограничен встроенным реестром: providers.json его дополняет', () => {
    const map = emptyMap();

    expect(addSession(map, { provider: 'my-cli', label: 'своя', task: 't' }).provider).toBe(
      'my-cli',
    );
  });
});

describe('addMessage', () => {
  it('нумерует сообщения m-NN и кладёт их непрочитанными', () => {
    const map = emptyMap();
    const message = addMessage(map, { from: 's-02', to: 's-01', text: 'жду миграции' });

    expect(message.id).toBe('m-01');
    expect(message.readAt).toBeNull();
    expect(addMessage(map, { from: 's-01', to: 's-02', text: 'ок' }).id).toBe('m-02');
  });
});

describe('transitionSession', () => {
  const withStatus = (status: SessionStatus): WorkMap => {
    const map = emptyMap();
    const session = addSession(map, { provider: 'claude', label: 'план', task: 't' });
    session.status = status;
    return map;
  };

  const allowed: Array<[SessionStatus, SessionStatus]> = [
    ['pending', 'active'],
    ['active', 'idle'],
    ['idle', 'active'],
    ['active', 'exited'],
    ['idle', 'exited'],
    ['exited', 'active'],
    ['done', 'active'],
    ['failed', 'active'],
    ['active', 'done'],
    ['idle', 'failed'],
    ['pending', 'done'],
    ['exited', 'done'],
    ['exited', 'failed'],
  ];

  it.each(allowed)('переход %s → %s разрешён', (from, to) => {
    const map = withStatus(from);
    const session = transitionSession(map, 's-01', to, { at: '2026-09-02T11:00:00.000Z' });

    expect(session.status).toBe(to);
    expect(session.history.at(-1)).toEqual({ status: to, at: '2026-09-02T11:00:00.000Z' });
  });

  const forbidden: Array<[SessionStatus, SessionStatus]> = [
    ['active', 'pending'],
    ['pending', 'idle'],
    ['pending', 'exited'],
    ['done', 'idle'],
    ['exited', 'idle'],
    ['active', 'active'],
    ['done', 'exited'],
  ];

  it.each(forbidden)('переход %s → %s запрещён', (from, to) => {
    const map = withStatus(from);

    expect(() => transitionSession(map, 's-01', to)).toThrow(/недопустимый переход/);
    expect(map.sessions[0]?.status).toBe(from);
    expect(map.sessions[0]?.history).toHaveLength(1);
  });

  it('код выхода пишется в последнюю запись history', () => {
    const map = withStatus('active');
    const session = transitionSession(map, 's-01', 'exited', {
      at: '2026-09-02T11:00:00.000Z',
      exitCode: 1,
    });

    expect(session.history.at(-1)).toEqual({
      status: 'exited',
      at: '2026-09-02T11:00:00.000Z',
      exitCode: 1,
    });
    expect(session.endedAt).toBe('2026-09-02T11:00:00.000Z');
  });

  it('сигнал завершения пишется рядом с кодом выхода', () => {
    const map = withStatus('active');
    const session = transitionSession(map, 's-01', 'exited', {
      at: '2026-09-02T11:00:00.000Z',
      exitCode: 137,
      signal: 9,
    });

    expect(session.history.at(-1)).toEqual({
      status: 'exited',
      at: '2026-09-02T11:00:00.000Z',
      exitCode: 137,
      signal: 9,
    });
  });

  it('startedAt ставится при первом переходе в active, endedAt снимается при возобновлении', () => {
    const map = withStatus('pending');
    transitionSession(map, 's-01', 'active', { at: '2026-09-02T11:00:00.000Z' });
    transitionSession(map, 's-01', 'exited', { at: '2026-09-02T11:30:00.000Z' });
    const resumed = transitionSession(map, 's-01', 'active', { at: '2026-09-02T12:00:00.000Z' });

    expect(resumed.startedAt).toBe('2026-09-02T11:00:00.000Z');
    expect(resumed.endedAt).toBeNull();
  });

  it('неизвестный id сессии — ошибка', () => {
    expect(() => transitionSession(emptyMap(), 's-99', 'active')).toThrow(/s-99/);
  });
});

describe('parseMap', () => {
  it('читает карту нужной формы', () => {
    const map = emptyMap();
    expect(parseMap(JSON.stringify(map), 'map.json')).toEqual(map);
  });

  it('битый json — ошибка', () => {
    expect(() => parseMap('{ сломано', 'map.json')).toThrow(/не парсится/);
  });

  it('чужая форма или другая версия схемы — ошибка', () => {
    expect(() =>
      parseMap('{"schemaVersion":2,"work":{},"sessions":[],"messages":[]}', 'map.json'),
    ).toThrow(/не парсится/);
    expect(() => parseMap('{"schemaVersion":1,"sessions":[]}', 'map.json')).toThrow(/не парсится/);
    expect(() => parseMap('[]', 'map.json')).toThrow(/не парсится/);
  });

  it('чужая форма записи внутри массивов — ошибка, а не TypeError при мутации', () => {
    const withSessions = (sessions: string): string =>
      `{"schemaVersion":1,"work":{"id":"w-0001"},"sessions":${sessions},"messages":[]}`;

    expect(() => parseMap(withSessions('[null]'), 'map.json')).toThrow(/не парсится/);
    expect(() =>
      parseMap(withSessions('[{"id":"s-01","status":"запущена","history":[]}]'), 'map.json'),
    ).toThrow(/не парсится/);
    expect(() => parseMap(withSessions('[{"id":"s-01","status":"active"}]'), 'map.json')).toThrow(
      /не парсится/,
    );
    expect(() =>
      parseMap(
        '{"schemaVersion":1,"work":{"id":"w-0001"},"sessions":[],"messages":[null]}',
        'map.json',
      ),
    ).toThrow(/не парсится/);
  });
});
