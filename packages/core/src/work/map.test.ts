import { describe, expect, it } from 'vitest';
import {
  addMessage,
  addSession,
  canTransition,
  parseMap,
  removeSession,
  setResult,
  transitionSession,
} from './map.js';
import { roomLead } from './rooms.js';
import type { Room, SessionLifecycle, WorkMap } from './types.js';

const emptyMap = (): WorkMap => ({
  schemaVersion: 2,
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
  rooms: [],
});

/** Пустая карта v1 — как её писали до комнат. */
const emptyV1 = (): Record<string, unknown> => {
  const map: Record<string, unknown> = { ...emptyMap(), schemaVersion: 1 };
  delete map['rooms'];
  return map;
};

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

    expect(plain.role).toBeNull();
    expect(Object.hasOwn(plain, 'agent')).toBe(false);
    expect(roled.role).toEqual({ source: 'claude', name: 'reviewer' });
    expect(Object.hasOwn(roled, 'agent')).toBe(false);
  });

  it('модель и усилие запуска (spawn_session) пишутся, когда заданы; без них ключей в записи нет', () => {
    const map = emptyMap();
    const plain = addSession(map, { provider: 'claude', label: 'план', task: 'план' });
    const chosen = addSession(map, {
      provider: 'claude',
      label: 'ревью',
      task: 'проверить',
      model: 'opus',
      effort: 'high',
    });

    expect('model' in plain).toBe(false);
    expect('effort' in plain).toBe(false);
    expect(chosen).toMatchObject({ model: 'opus', effort: 'high' });
    // Через JSON — как на диске: запись с выбором читается парсером карты без правок.
    const again = parseMap(JSON.stringify(map), 'map.json');
    expect(again.sessions[1]).toMatchObject({ model: 'opus', effort: 'high' });
    expect('model' in (again.sessions[0] ?? {})).toBe(false);
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
    expect(first.lifecycle).toBe('pending');
    expect(first.result).toBeNull();
    expect(first.resultAt).toBeNull();
    expect(first.closedAt).toBeNull();
    expect(first.history).toEqual([{ event: 'pending', at: first.history[0]?.at }]);
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
    const message = addMessage(map, { from: 's-02', to: ['s-01'], text: 'жду миграции' });

    expect(message.id).toBe('m-01');
    expect(message.readBy).toEqual({});
    expect(message.roomId).toBeNull();
    expect(message.to).toEqual(['s-01']);
    expect(addMessage(map, { from: 's-01', to: ['s-02'], text: 'ок' }).id).toBe('m-02');
  });

  it('kind по умолчанию note, явный kind сохраняется', () => {
    const map = emptyMap();
    const plain = addMessage(map, { from: 's-01', to: ['s-02'], text: 'a' });
    const question = addMessage(map, {
      from: 's-01',
      to: ['s-02'],
      text: 'b',
      kind: 'question',
    });

    expect(plain.kind).toBe('note');
    expect(question.kind).toBe('question');
  });

  it('replyTo (Parley 0.3.0) пишется, когда задан; без него ключа в письме нет', () => {
    const map = emptyMap();
    const plain = addMessage(map, { from: 's-01', to: [], text: 'вопрос', roomId: 'r-01' });
    const reply = addMessage(map, {
      from: 's-02',
      to: [],
      text: 'ответ',
      roomId: 'r-01',
      replyTo: plain.id,
    });

    expect('replyTo' in plain).toBe(false);
    expect(reply.replyTo).toBe('m-01');
    // Через JSON — как на диске: `parseMap` поле не теряет, а у обычного письма ключа не появляется.
    const again = parseMap(JSON.stringify(map), 'map.json');
    expect(again.messages[1]?.replyTo).toBe('m-01');
    expect('replyTo' in (again.messages[0] ?? {})).toBe(false);
  });
});

describe('transitionSession', () => {
  const withLifecycle = (lifecycle: SessionLifecycle): WorkMap => {
    const map = emptyMap();
    const session = addSession(map, { provider: 'claude', label: 'план', task: 't' });
    session.lifecycle = lifecycle;
    return map;
  };

  const LIFECYCLES: readonly SessionLifecycle[] = ['pending', 'active', 'sleeping', 'closed'];
  const ALLOWED = new Set([
    'pending→active',
    'pending→closed',
    'active→sleeping',
    'active→closed',
    'sleeping→active',
    'sleeping→closed',
  ]);
  const pairs = LIFECYCLES.flatMap((from) => LIFECYCLES.map((to) => [from, to] as const));

  it('переходы — инвариантом по всем 16 парам', () => {
    expect(pairs).toHaveLength(16);
    for (const [from, to] of pairs) {
      const map = withLifecycle(from);
      const allowed = ALLOWED.has(`${from}→${to}`);
      expect(canTransition(from, to), `${from} → ${to}`).toBe(allowed);
      if (allowed) {
        const session = transitionSession(map, 's-01', to, { at: '2026-09-02T11:00:00.000Z' });
        expect(session.lifecycle).toBe(to);
        expect(session.history.at(-1)).toEqual({ event: to, at: '2026-09-02T11:00:00.000Z' });
      } else {
        expect(() => transitionSession(map, 's-01', to), `${from} → ${to}`).toThrow(
          /invalid transition/,
        );
        expect(map.sessions[0]?.lifecycle).toBe(from);
        expect(map.sessions[0]?.history).toHaveLength(1);
      }
    }
  });

  it('closed ставит closedAt', () => {
    const map = withLifecycle('sleeping');
    const session = transitionSession(map, 's-01', 'closed', { at: '2026-09-02T11:00:00.000Z' });

    expect(session.closedAt).toBe('2026-09-02T11:00:00.000Z');
  });

  it('итог ставится из любого состояния, кроме closed, и процесс не меняет', () => {
    for (const lifecycle of ['pending', 'active', 'sleeping'] as const) {
      const map = withLifecycle(lifecycle);
      const session = setResult(map, 's-01', 'done', '2026-09-02T11:00:00.000Z');
      expect(session.lifecycle).toBe(lifecycle);
      expect(session.result).toBe('done');
      expect(session.resultAt).toBe('2026-09-02T11:00:00.000Z');
      expect(session.history.at(-1)).toEqual({ event: 'done', at: '2026-09-02T11:00:00.000Z' });
    }

    const closed = withLifecycle('closed');
    expect(() => setResult(closed, 's-01', 'failed')).toThrow(/is closed/);
    expect(closed.sessions[0]?.result).toBeNull();
    expect(closed.sessions[0]?.history).toHaveLength(1);
  });

  it('код выхода пишется в последнюю запись history', () => {
    const map = withLifecycle('active');
    const session = transitionSession(map, 's-01', 'sleeping', {
      at: '2026-09-02T11:00:00.000Z',
      exitCode: 1,
    });

    expect(session.history.at(-1)).toEqual({
      event: 'sleeping',
      at: '2026-09-02T11:00:00.000Z',
      exitCode: 1,
    });
    expect(session.endedAt).toBe('2026-09-02T11:00:00.000Z');
  });

  it('сигнал завершения пишется рядом с кодом выхода', () => {
    const map = withLifecycle('active');
    const session = transitionSession(map, 's-01', 'sleeping', {
      at: '2026-09-02T11:00:00.000Z',
      exitCode: 137,
      signal: 9,
    });

    expect(session.history.at(-1)).toEqual({
      event: 'sleeping',
      at: '2026-09-02T11:00:00.000Z',
      exitCode: 137,
      signal: 9,
    });
  });

  it('startedAt ставится при первом переходе в active, endedAt снимается при возобновлении', () => {
    const map = withLifecycle('pending');
    transitionSession(map, 's-01', 'active', { at: '2026-09-02T11:00:00.000Z' });
    transitionSession(map, 's-01', 'sleeping', { at: '2026-09-02T11:30:00.000Z' });
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
    expect(parseMap(JSON.stringify(map), 'map.json')).toEqual({ ...map, plans: [] });
  });

  it('карта v1 поднимается до v2 поле в поле (три сессии и пять писем, как в w-0010)', () => {
    const v1 = {
      ...emptyV1(),
      work: { ...emptyMap().work, id: 'w-0010', sessionSeq: 3 },
      sessions: [
        {
          id: 's-01',
          provider: 'claude',
          label: 'план',
          task: 'составить план',
          parent: null,
          contextFrom: [],
          status: 'done',
          history: [
            { status: 'pending', at: '2026-09-20T10:00:00.000Z' },
            { status: 'active', at: '2026-09-20T10:01:00.000Z' },
            { status: 'done', at: '2026-09-20T10:30:00.000Z' },
            { status: 'active', at: '2026-09-20T11:00:00.000Z' },
            { status: 'done', at: '2026-09-20T11:40:00.000Z' },
          ],
          startedAt: '2026-09-20T10:01:00.000Z',
          endedAt: '2026-09-20T11:40:00.000Z',
          pid: 4242,
          startedAtProcess: '2026-09-20T10:01:00.000Z',
          launchedBy: 'tui',
          providerSessionId: 'uuid-1',
          metrics: null,
          summary: 'план готов',
          summarySource: 'agent',
          artifacts: [{ kind: 'plan', path: 'docs/plan.md' }],
          agent: null,
        },
        {
          id: 's-02',
          provider: 'codex',
          label: 'бэкенд',
          task: 'шаги 1–3',
          parent: 's-01',
          contextFrom: ['s-01'],
          status: 'exited',
          history: [
            { status: 'pending', at: '2026-09-20T10:05:00.000Z' },
            { status: 'active', at: '2026-09-20T10:06:00.000Z' },
            { status: 'exited', at: '2026-09-20T10:50:00.000Z', exitCode: 0 },
          ],
          startedAt: '2026-09-20T10:06:00.000Z',
          endedAt: '2026-09-20T10:50:00.000Z',
          pid: null,
          startedAtProcess: null,
          launchedBy: 'tui',
          providerSessionId: null,
          metrics: null,
          summary: null,
          summarySource: null,
          artifacts: [],
          agent: null,
        },
        {
          id: 's-03',
          provider: 'claude',
          label: 'ревью',
          task: 'проверить',
          parent: 's-01',
          contextFrom: [],
          status: 'active',
          history: [
            { status: 'pending', at: '2026-09-20T10:10:00.000Z' },
            { status: 'active', at: '2026-09-20T10:11:00.000Z' },
          ],
          startedAt: '2026-09-20T10:11:00.000Z',
          endedAt: null,
          pid: 777,
          startedAtProcess: '2026-09-20T10:11:00.000Z',
          launchedBy: 'host',
          providerSessionId: 'uuid-3',
          metrics: null,
          summary: null,
          summarySource: null,
          artifacts: [],
          agent: 'reviewer',
        },
      ],
      messages: [
        {
          id: 'm-01',
          from: 's-01',
          to: 's-02',
          at: '2026-09-20T10:07:00.000Z',
          text: 'начни с миграции',
          kind: 'note',
          readAt: '2026-09-20T10:08:00.000Z',
        },
        {
          id: 'm-02',
          from: 's-02',
          to: 's-01',
          at: '2026-09-20T10:20:00.000Z',
          text: 'схема ок?',
          kind: 'question',
          readAt: '2026-09-20T10:21:00.000Z',
        },
        {
          id: 'm-03',
          from: 's-01',
          to: 's-02',
          at: '2026-09-20T10:22:00.000Z',
          text: 'да',
          kind: 'decision',
          readAt: null,
        },
        {
          id: 'm-04',
          from: 's-03',
          to: 's-01',
          at: '2026-09-20T10:40:00.000Z',
          text: 'замечания',
          readAt: null,
        },
        {
          id: 'm-05',
          from: 's-01',
          to: 's-03',
          at: '2026-09-20T10:45:00.000Z',
          text: 'поправил',
          kind: 'note',
          readAt: null,
          deleted: true,
        },
      ],
    };

    const parsed = parseMap(JSON.stringify(v1), 'map.json');

    const [s1, s2, s3] = v1.sessions as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    // Поля v1, которых в v2 нет: статус и история прежней формы.
    const strip = (session: Record<string, unknown>): Record<string, unknown> => {
      const rest = { ...session };
      delete rest['status'];
      delete rest['history'];
      rest['role'] = typeof rest['agent'] === 'string' ? { source: 'claude', name: rest['agent'] } : null;
      delete rest['agent'];
      return rest;
    };
    expect(parsed).toEqual({
      schemaVersion: 2,
      work: v1.work,
      rooms: [],
      plans: [],
      sessions: [
        {
          ...strip(s1),
          lifecycle: 'sleeping',
          result: 'done',
          resultAt: '2026-09-20T11:40:00.000Z',
          closedAt: null,
          worktree: null,
          history: [
            { event: 'pending', at: '2026-09-20T10:00:00.000Z' },
            { event: 'active', at: '2026-09-20T10:01:00.000Z' },
            { event: 'done', at: '2026-09-20T10:30:00.000Z' },
            { event: 'active', at: '2026-09-20T11:00:00.000Z' },
            { event: 'done', at: '2026-09-20T11:40:00.000Z' },
          ],
        },
        {
          ...strip(s2),
          lifecycle: 'sleeping',
          result: null,
          resultAt: null,
          closedAt: null,
          worktree: null,
          history: [
            { event: 'pending', at: '2026-09-20T10:05:00.000Z' },
            { event: 'active', at: '2026-09-20T10:06:00.000Z' },
            { event: 'sleeping', at: '2026-09-20T10:50:00.000Z', exitCode: 0 },
          ],
        },
        {
          ...strip(s3),
          lifecycle: 'active',
          result: null,
          resultAt: null,
          closedAt: null,
          worktree: null,
          history: [
            { event: 'pending', at: '2026-09-20T10:10:00.000Z' },
            { event: 'active', at: '2026-09-20T10:11:00.000Z' },
          ],
        },
      ],
      messages: [
        {
          id: 'm-01',
          roomId: null,
          from: 's-01',
          to: ['s-02'],
          at: '2026-09-20T10:07:00.000Z',
          text: 'начни с миграции',
          kind: 'note',
          readBy: { 's-02': '2026-09-20T10:08:00.000Z' },
        },
        {
          id: 'm-02',
          roomId: null,
          from: 's-02',
          to: ['s-01'],
          at: '2026-09-20T10:20:00.000Z',
          text: 'схема ок?',
          kind: 'question',
          readBy: { 's-01': '2026-09-20T10:21:00.000Z' },
        },
        {
          id: 'm-03',
          roomId: null,
          from: 's-01',
          to: ['s-02'],
          at: '2026-09-20T10:22:00.000Z',
          text: 'да',
          kind: 'decision',
          readBy: {},
        },
        {
          id: 'm-04',
          roomId: null,
          from: 's-03',
          to: ['s-01'],
          at: '2026-09-20T10:40:00.000Z',
          text: 'замечания',
          kind: 'note',
          readBy: {},
        },
        {
          id: 'm-05',
          roomId: null,
          from: 's-01',
          to: ['s-03'],
          at: '2026-09-20T10:45:00.000Z',
          text: 'поправил',
          kind: 'note',
          readBy: {},
          deleted: true,
        },
      ],
    });
  });

  it('разобранная v1 пишется как v2 и читается обратно без потерь', () => {
    const v1 = {
      ...emptyV1(),
      sessions: [
        {
          id: 's-01',
          status: 'failed',
          history: [{ status: 'failed', at: '2026-09-02T11:00:00.000Z' }],
        },
      ],
      messages: [{ id: 'm-01', from: 's-01', to: 's-02', at: 'x', text: 't', readAt: null }],
    };
    const once = parseMap(JSON.stringify(v1), 'map.json');
    const twice = parseMap(JSON.stringify(once), 'map.json');

    expect(once.schemaVersion).toBe(2);
    expect(JSON.parse(JSON.stringify(once))).toMatchObject({ schemaVersion: 2, rooms: [] });
    expect(twice).toEqual(once);
  });

  it('карта v1 со статусом idle читается как active — и в history тоже', () => {
    const legacy = {
      ...emptyV1(),
      sessions: [
        {
          id: 's-01',
          status: 'idle',
          history: [
            { status: 'pending', at: '2026-09-02T10:00:00.000Z' },
            { status: 'idle', at: '2026-09-02T11:00:00.000Z' },
          ],
        },
      ],
    };

    const parsed = parseMap(JSON.stringify(legacy), 'map.json');
    expect(parsed.sessions[0]?.lifecycle).toBe('active');
    expect(parsed.sessions[0]?.history.map((entry) => entry.event)).toEqual(['pending', 'active']);
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

  it('испорченный effort читается как «нет выбора»: ключа нет, сессия и модель на месте', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'план', task: 't', model: 'opus', effort: 'xhigh' });
    const raw = JSON.parse(JSON.stringify(map)) as { sessions: Record<string, unknown>[] };
    for (const effort of ['hi gh', 'x"', '"x', 'HIGH', '', 'a'.repeat(33), 3, ['low']]) {
      raw.sessions[0]!['effort'] = effort;

      const parsed = parseMap(JSON.stringify(raw), 'map.json');
      expect(parsed.sessions, JSON.stringify(effort)).toHaveLength(1);
      expect('effort' in (parsed.sessions[0] ?? {}), JSON.stringify(effort)).toBe(false);
      expect(parsed.sessions[0]?.model).toBe('opus');
    }
  });

  it('effort: null — явный «Default» (снимает умолчание роли): при чтении карты остаётся', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'план', task: 't', model: 'opus', effort: 'xhigh' });
    const raw = JSON.parse(JSON.stringify(map)) as { sessions: Record<string, unknown>[] };
    raw.sessions[0]!['effort'] = null;

    const parsed = parseMap(JSON.stringify(raw), 'map.json');
    expect(parsed.sessions[0]?.effort).toBeNull();
    expect(parsed.sessions[0]?.model).toBe('opus');
  });

  it('уровни каталогов в карте читаются как есть: xhigh, max, ultra', () => {
    const map = emptyMap();
    for (const effort of ['xhigh', 'max', 'ultra']) {
      addSession(map, { provider: 'codex', label: effort, task: 't', effort });
    }

    expect(parseMap(JSON.stringify(map), 'map.json').sessions.map((session) => session.effort)).toEqual([
      'xhigh',
      'max',
      'ultra',
    ]);
  });

  it('35: карта без kind у письма читается как note, остальные поля не тронуты', () => {
    const raw = JSON.stringify({
      ...emptyV1(),
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
      to: ['s-02'],
      at: '2026-09-08T10:00:00.000Z',
      text: 'x',
      kind: 'note',
      readBy: {},
    });
  });

  describe('ведущий и решение комнаты (дизайн комнат, 3.1)', () => {
    /** Комната как её писали до 2026-09-29: без `lead` и `proposal`. */
    const oldRoom = {
      id: 'r-01',
      title: 'Возвраты',
      creator: 'human',
      members: ['s-02', 's-03'],
      createdAt: '2026-09-20T10:00:00.000Z',
    };
    const withRooms = (rooms: unknown[]): string =>
      JSON.stringify({ ...emptyMap(), rooms, work: { ...emptyMap().work, roomSeq: rooms.length } });

    it('в старой карте lead и proposal читаются как null, остальное не тронуто', () => {
      const parsed = parseMap(withRooms([oldRoom]), 'map.json');

      expect(parsed.rooms[0]).toEqual({ ...oldRoom, lead: null, proposal: null, mode: 'free', recipe: null });
    });

    it('ведущий старой комнаты — первый из members (lead: null не переписывается в id)', () => {
      const parsed = parseMap(withRooms([oldRoom]), 'map.json');

      expect(parsed.rooms[0]?.lead).toBeNull();
      expect(roomLead(parsed.rooms[0] as Room)).toBe('s-02');
    });

    it('карта v1 без комнат по-прежнему даёт пустой список', () => {
      expect(parseMap(JSON.stringify(emptyV1()), 'map.json').rooms).toEqual([]);
    });

    it('явные lead и proposal читаются как записаны и переживают круг запись → чтение', () => {
      const proposal = { id: 'p-01', from: 's-03', text: 'решение @s02', rev: 2, at: '2026-09-29T12:00:00.000Z' };
      const written = { ...oldRoom, lead: 's-03', proposal };

      const parsed = parseMap(withRooms([written]), 'map.json');
      expect(parsed.rooms[0]).toEqual({ ...written, mode: 'free', recipe: null, proposal: { ...proposal, kind: 'decision' } });
      expect(parseMap(JSON.stringify(parsed), 'map.json')).toEqual(parsed);
    });

    it('запись комнаты не объект — как и раньше, читается без TypeError на миграции', () => {
      expect(() => parseMap(withRooms([null]), 'map.json')).not.toThrow();
    });
  });

  it('битый json — ошибка', () => {
    expect(() => parseMap('{ сломано', 'map.json')).toThrow(/^map map\.json cannot be parsed: /);
  });

  it('чужая форма или другая версия схемы — ошибка', () => {
    expect(() =>
      parseMap('{"schemaVersion":2,"work":{},"sessions":[],"messages":[],"rooms":[]}', 'map.json'),
    ).toThrow(/cannot be parsed: unexpected shape/);
    expect(() =>
      parseMap(
        '{"schemaVersion":3,"work":{"id":"w-0001"},"sessions":[],"messages":[],"rooms":[]}',
        'map.json',
      ),
    ).toThrow(/cannot be parsed: unexpected shape/);
    // v2 без комнат — не наша карта: v2 пишется только с ними.
    expect(() =>
      parseMap(
        '{"schemaVersion":2,"work":{"id":"w-0001"},"sessions":[],"messages":[]}',
        'map.json',
      ),
    ).toThrow(/cannot be parsed: unexpected shape/);
    expect(() => parseMap('{"schemaVersion":1,"sessions":[]}', 'map.json')).toThrow(/cannot be parsed: unexpected shape/);
    expect(() => parseMap('[]', 'map.json')).toThrow(/cannot be parsed: unexpected shape/);
  });

  it('чужая форма записи внутри массивов — ошибка, а не TypeError при мутации', () => {
    const withSessions = (sessions: string): string =>
      `{"schemaVersion":1,"work":{"id":"w-0001"},"sessions":${sessions},"messages":[]}`;

    expect(() => parseMap(withSessions('[null]'), 'map.json')).toThrow(/cannot be parsed: unexpected shape/);
    expect(() =>
      parseMap(withSessions('[{"id":"s-01","status":"запущена","history":[]}]'), 'map.json'),
    ).toThrow(/cannot be parsed: unexpected shape/);
    expect(() => parseMap(withSessions('[{"id":"s-01","status":"active"}]'), 'map.json')).toThrow(
      /cannot be parsed: unexpected shape/,
    );
    expect(() =>
      parseMap(
        '{"schemaVersion":1,"work":{"id":"w-0001"},"sessions":[],"messages":[null]}',
        'map.json',
      ),
    ).toThrow(/cannot be parsed: unexpected shape/);
    // v2: статус v1 вместо оси процесса и один адресат строкой — чужая форма.
    const v2 = (sessions: string, messages: string): string =>
      `{"schemaVersion":2,"work":{"id":"w-0001"},"sessions":${sessions},"messages":${messages},"rooms":[]}`;
    expect(() =>
      parseMap(v2('[{"id":"s-01","status":"active","history":[]}]', '[]'), 'map.json'),
    ).toThrow(/cannot be parsed: unexpected shape/);
    expect(() => parseMap(v2('[]', '[{"id":"m-01","to":"s-01"}]'), 'map.json')).toThrow(
      /cannot be parsed: unexpected shape/,
    );
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
    addMessage(map, { from: 's-02', to: ['s-01'], text: 'жду миграции' });
    addMessage(map, { from: 's-01', to: ['s-03'], text: 'не про неё' });
    addMessage(map, { from: 's-01', to: ['s-03', 's-02'], text: 'обоим' });
    removeSession(map, 's-02');

    expect(map.messages).toHaveLength(3);
    expect(map.messages[0]?.deleted).toBe(true);
    expect(map.messages[0]?.text).toBe('жду миграции');
    expect(map.messages[1]?.deleted).toBeUndefined();
    // Удалённая — один из адресатов: `to.includes`, а не сравнение строки с массивом.
    expect(map.messages[2]?.deleted).toBe(true);
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

describe('role-only normalized records', () => {
  it('rejects agent plus role before mutation and never persists computed defaults', () => {
    const map = emptyMap();
    expect(() => addSession(map, { provider: 'claude', label: '', task: '', agent: 'legacy', role: null })).toThrow('agent-and-role-conflict');
    expect(map.sessions).toHaveLength(0);
    const session = addSession(map, { provider: 'codex', label: '', task: '', role: { source: 'builtin', name: 'planner' } });
    expect(session).toMatchObject({ role: { source: 'builtin', name: 'planner' } });
    expect(Object.hasOwn(session, 'model')).toBe(false); expect(Object.hasOwn(session, 'effort')).toBe(false);
  });
  it('migrates exact legacy identity once and removes agent on read', () => {
    const map = emptyMap();
    const session = addSession(map, { provider: 'claude', label: '', task: '' });
    delete session.role; session.agent = 'two words';
    const migrated = parseMap(JSON.stringify(map), 'map.json');
    expect(migrated.sessions[0]?.role).toEqual({ source: 'claude', name: 'two words' });
    expect(JSON.stringify(migrated)).not.toContain('"agent"');
  });
});
