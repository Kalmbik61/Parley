import { describe, expect, it } from 'vitest';
import { addMessage, addSession, parseMap, removeSession, transitionSession } from './map.js';
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
  it('роль агента берётся из init, без неё — null', () => {
    const map = emptyMap();
    const plain = addSession(map, { provider: 'claude', label: 'план', task: 'план' });
    const roled = addSession(map, {
      provider: 'claude',
      label: 'ревью',
      task: 'проверить',
      agent: 'reviewer',
    });

    expect(plain.agent).toBeNull();
    expect(roled.agent).toBe('reviewer');
  });

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
    // Процесса ещё нет: поля запуска заполняет тот, кто его поднимет.
    expect(first.pid).toBeNull();
    expect(first.startedAtProcess).toBeNull();
    expect(first.launchedBy).toBeNull();
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

  it('kind по умолчанию note, явный kind сохраняется', () => {
    const map = emptyMap();
    const plain = addMessage(map, { from: 's-01', to: 's-02', text: 'a' });
    const question = addMessage(map, {
      from: 's-01',
      to: 's-02',
      text: 'b',
      kind: 'question',
    });

    expect(plain.kind).toBe('note');
    expect(question.kind).toBe('question');
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
    ['active', 'exited'],
    ['exited', 'active'],
    ['done', 'active'],
    ['failed', 'active'],
    ['active', 'done'],
    ['active', 'failed'],
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
    ['pending', 'exited'],
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

  it('карта со статусом idle читается как active — и в history тоже', () => {
    const map = emptyMap();
    const session = addSession(map, { provider: 'claude', label: 'план', task: 't' });
    // Так карту писала версия до 2026-09-05: статус idle был частью цикла.
    const legacy = JSON.parse(JSON.stringify(map)) as {
      sessions: { status: string; history: { status: string; at: string }[] }[];
    };
    (legacy.sessions[0] as { status: string }).status = 'idle';
    legacy.sessions[0]?.history.push({ status: 'idle', at: '2026-09-02T11:00:00.000Z' });

    const parsed = parseMap(JSON.stringify(legacy), 'map.json');
    expect(parsed.sessions[0]?.status).toBe('active');
    expect(parsed.sessions[0]?.history.map((entry) => entry.status)).toEqual(['pending', 'active']);
    expect(session.id).toBe('s-01');
  });

  it('в старой карте без полей процесса они читаются как null', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'план', task: 't' });
    const legacy = JSON.parse(JSON.stringify(map)) as { sessions: Record<string, unknown>[] };
    delete legacy.sessions[0]?.['pid'];
    delete legacy.sessions[0]?.['startedAtProcess'];
    delete legacy.sessions[0]?.['launchedBy'];

    const parsed = parseMap(JSON.stringify(legacy), 'map.json');
    expect(parsed.sessions[0]?.pid).toBeNull();
    expect(parsed.sessions[0]?.startedAtProcess).toBeNull();
    expect(parsed.sessions[0]?.launchedBy).toBeNull();
  });

  it('35: карта без kind у письма читается как note, остальные поля не тронуты', () => {
    const raw = JSON.stringify({
      ...emptyMap(),
      messages: [
        {
          id: 'm-01',
          from: 's-01',
          to: 's-02',
          at: '2026-09-08T10:00:00.000Z',
          text: 'x',
          readAt: null,
        },
      ],
    });

    const map = parseMap(raw, 'map.json');
    expect(map.messages[0]).toMatchObject({
      id: 'm-01',
      from: 's-01',
      to: 's-02',
      at: '2026-09-08T10:00:00.000Z',
      text: 'x',
      kind: 'note',
      readAt: null,
    });
  });

  it('35: карта без agent у сессии читается как null, остальные поля не тронуты', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'план', task: 'план' });
    const legacy = JSON.parse(JSON.stringify(map)) as { sessions: Record<string, unknown>[] };
    delete legacy.sessions[0]?.['agent'];

    const parsed = parseMap(JSON.stringify(legacy), 'map.json');
    expect(parsed.sessions[0]?.agent).toBeNull();
    expect(parsed.sessions[0]?.label).toBe('план');
    expect(parsed.sessions[0]?.history).toHaveLength(1);
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

describe('removeSession', () => {
  /** Работа с деревом `s-01 → s-02 → s-03` и перепиской между ними. */
  const tree = (): WorkMap => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'план', task: 't' });
    addSession(map, { provider: 'claude', label: 'бэкенд', task: 't', parent: 's-01' });
    addSession(map, {
      provider: 'claude',
      label: 'ревью',
      task: 't',
      parent: 's-02',
      contextFrom: ['s-01', 's-02'],
    });
    return map;
  };

  it('20: дети поднимаются к родителю удалённой, contextFrom вычищен', () => {
    const map = tree();
    const removed = removeSession(map, 's-02');

    expect(removed.id).toBe('s-02');
    expect(map.sessions.map((session) => session.id)).toEqual(['s-01', 's-03']);
    expect(map.sessions[1]?.parent).toBe('s-01');
    expect(map.sessions[1]?.contextFrom).toEqual(['s-01']);
  });

  it('20: у детей сессии верхнего уровня родитель становится null', () => {
    const map = tree();
    removeSession(map, 's-01');

    expect(map.sessions[0]?.parent).toBeNull();
  });

  it('21: сообщения удалённой остаются в карте с пометкой deleted', () => {
    const map = tree();
    addMessage(map, { from: 's-02', to: 's-01', text: 'жду миграции' });
    addMessage(map, { from: 's-01', to: 's-03', text: 'не про неё' });
    removeSession(map, 's-02');

    expect(map.messages).toHaveLength(2);
    expect(map.messages[0]?.deleted).toBe(true);
    expect(map.messages[0]?.text).toBe('жду миграции');
    expect(map.messages[1]?.deleted).toBeUndefined();
  });

  it('22: id не переиспользуется — счётчик sessionSeq переживает удаление', () => {
    const map = tree();
    removeSession(map, 's-03');

    expect(map.work.sessionSeq).toBe(3);
    expect(addSession(map, { provider: 'claude', label: 'тесты', task: 't' }).id).toBe('s-04');
    expect(map.work.deletedSessions).toEqual(['s-03']);
    // След удаления — только id: данных сессии в карте не остаётся.
    expect(JSON.stringify(map)).not.toContain('ревью');
  });

  it('22: удаление всех сессий работы не начинает нумерацию заново', () => {
    const map = tree();
    for (const id of ['s-01', 's-02', 's-03']) removeSession(map, id);

    expect(map.sessions).toEqual([]);
    expect(map.work.deletedSessions).toEqual(['s-01', 's-02', 's-03']);
    expect(addSession(map, { provider: 'claude', label: 'ещё', task: 't' }).id).toBe('s-04');
  });

  it('23: карта без sessionSeq читается по максимуму списка', () => {
    const map = tree();
    const legacy = JSON.parse(JSON.stringify(map)) as WorkMap & {
      work: Record<string, unknown>;
    };
    delete legacy.work['sessionSeq'];

    const parsed = parseMap(JSON.stringify(legacy), 'map.json');
    expect(parsed.work.sessionSeq).toBeUndefined();
    expect(addSession(parsed, { provider: 'claude', label: 'ещё', task: 't' }).id).toBe('s-04');
  });

  it('24: удаление несуществующего id — ошибка, карта не меняется', () => {
    const map = tree();

    expect(() => removeSession(map, 's-99')).toThrow(/s-99/);
    expect(map.sessions).toHaveLength(3);
    expect(map.work.deletedSessions).toBeUndefined();
  });
});
