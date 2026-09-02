import type { Message, WorkEntry, WorkSession } from '@harnas/core';
import { describe, expect, it } from 'vitest';
import { glyphs } from './glyphs.js';
import { worksEvents } from './work-events.js';

const g = glyphs({});

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 's-01',
    provider: 'claude',
    label: 'план',
    task: 'составить план',
    parent: null,
    contextFrom: [],
    status: 'active',
    history: [],
    startedAt: null,
    endedAt: null,
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    ...over,
  };
}

const entry = (sessions: WorkSession[], messages: Message[] = []): WorkEntry => ({
  projectPath: '/dev/shop',
  map: {
    schemaVersion: 1,
    work: {
      id: 'w-0001',
      title: 'Авторизация',
      goal: '',
      status: 'active',
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-02T10:00:00.000Z',
    },
    sessions,
    messages,
  },
});

const message = (over: Partial<Message> = {}): Message => ({
  id: 'm-01',
  from: 's-01',
  to: 's-02',
  at: '2026-09-02T09:41:00.000Z',
  text: 'жду миграции',
  readAt: null,
  ...over,
});

describe('worksEvents', () => {
  it('первое чтение событий не порождает', () => {
    expect(worksEvents([], [entry([session({ status: 'pending' })])], g)).toEqual([]);
  });

  it('без изменений событий нет', () => {
    const before = entry([session()], [message()]);
    expect(worksEvents([before], [entry([session()], [message()])], g)).toEqual([]);
  });

  it('новая pending-сессия зовёт запустить её', () => {
    const events = worksEvents(
      [entry([session()])],
      [
        entry([
          session(),
          session({ id: 's-04', label: 'тесты', provider: 'codex', status: 'pending' }),
        ]),
      ],
      g,
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.text).toBe('Cx: pending «тесты» в «Авторизация»');
    expect(events[0]?.hint).toBe('Enter на ◌ — запустить');
    expect(events[0]?.source).toEqual({
      projectPath: '/dev/shop',
      workId: 'w-0001',
      sessionId: 's-04',
    });
  });

  it('новая активная сессия событием не считается — её запустил сам пользователь', () => {
    const events = worksEvents(
      [entry([session()])],
      [entry([session(), session({ id: 's-02', status: 'active' })])],
      g,
    );
    expect(events).toEqual([]);
  });

  it('выход без отчёта зовёт возобновить или дозаказать резюме', () => {
    const events = worksEvents(
      [entry([session({ id: 's-02', label: 'бэкенд' })])],
      [entry([session({ id: 's-02', label: 'бэкенд', status: 'exited' })])],
      g,
    );

    expect(events[0]?.text).toBe('○ бэкенд вышла без отчёта');
    expect(events[0]?.hint).toBe('Enter — возобновить, s — резюме');
  });

  it('выход с отчётом молчит: смотреть не на что', () => {
    const events = worksEvents(
      [entry([session({ id: 's-02', label: 'бэкенд' })])],
      [entry([session({ id: 's-02', label: 'бэкенд', status: 'exited', summary: 'готово' })])],
      g,
    );
    expect(events).toEqual([]);
  });

  it('новое непрочитанное сообщение показывает отправителя, адресата и начало текста', () => {
    const sessions = [
      session({ id: 's-01', label: 'план' }),
      session({ id: 's-02', label: 'бэкенд' }),
    ];
    const events = worksEvents(
      [entry(sessions)],
      [entry(sessions, [message({ text: 'жду миграции, чтобы продолжить' })])],
      g,
    );

    expect(events[0]?.text).toBe('✉ план → бэкенд: «жду миграции, чтобы…»');
    expect(events[0]?.source?.sessionId).toBe('s-02');
  });

  it('уже прочитанное сообщение не всплывает', () => {
    const sessions = [session({ id: 's-01' }), session({ id: 's-02' })];
    const events = worksEvents(
      [entry(sessions)],
      [entry(sessions, [message({ readAt: '2026-09-02T09:43:00.000Z' })])],
      g,
    );
    expect(events).toEqual([]);
  });

  it('новая работа не всплывает: она и так видна в списке', () => {
    expect(worksEvents([], [entry([session({ status: 'pending' })])], g)).toEqual([]);
  });
});
