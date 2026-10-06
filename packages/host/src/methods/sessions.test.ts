import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPendingSession, createWork } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { fakeEffortScreen } from '../../test/fake-effort-screen.js';
import type { FakeEffortScreen } from '../../test/fake-effort-screen.js';
import type { RequestInfo } from '../context.js';
import { createSwitchLock } from '../sessions/sessions-service.js';
import type { SessionsService, SwitchLock } from '../sessions/sessions-service.js';
import { createSessionHandlers } from './sessions.js';
import type { SessionMethodDeps } from './sessions.js';

const request = { client: {}, host: {} } as unknown as RequestInfo;
const params = {
  projectPath: '/p',
  workId: 'w-1',
  provider: 'claude',
  label: '',
  task: '',
  parent: null,
} as const;
const ref = { projectPath: '/p', workId: 'w-1', sessionId: 's-01' };

/** Сервис-подмена: до настоящего claude и codex тут дело не доходит, важен только вызов `create`. */
function handlers(): {
  create: ReturnType<typeof vi.fn>;
  sessionsCreate: ReturnType<typeof createSessionHandlers>['sessionsCreate'];
} {
  const create = vi.fn(async () => ref);
  const { sessionsCreate } = createSessionHandlers({
    sessions: { create } as unknown as SessionsService,
    pty: {} as unknown as SessionMethodDeps['pty'],
  });
  return { create, sessionsCreate };
}

describe('sessions.create: модель и усилие из диалога (дизайн комнат, 3.2)', () => {
  it('model и effort доезжают до сервиса как есть; ответ — ref', async () => {
    const { create, sessionsCreate } = handlers();

    const response = await sessionsCreate({ ...params, model: 'opus', effort: 'high' }, request);

    expect(response).toEqual({ ref });
    expect(create).toHaveBeenCalledWith({ ...params, model: 'opus', effort: 'high' });
  });

  it('без выбора ключей model и effort в вызове сервиса нет вовсе, даже со значением undefined', async () => {
    const { create, sessionsCreate } = handlers();

    await sessionsCreate(
      { ...params, model: undefined, effort: undefined, worktree: undefined },
      request,
    );

    // `exactOptionalPropertyTypes`: `CreateSessionInput` явного `undefined` ключом не принимает.
    const [input] = create.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(input).sort()).toEqual([
      'label',
      'parent',
      'projectPath',
      'provider',
      'task',
      'workId',
    ]);
  });
});

describe('sessions.setMode (план 2026-10-01, решение 4)', () => {
  const footer = '  ⏸ plan mode on (shift+tab to cycle) · ← for agents';

  function setup(live: boolean, withFeed = true) {
    const noteMode = vi.fn();
    const write = vi.fn();
    const { sessionsSetMode } = createSessionHandlers({
      sessions: {} as unknown as SessionsService,
      pty: {
        get: () => (live ? ({ ref } as never) : undefined),
        write,
        screenText: () => [footer],
        on: () => () => {},
      } as unknown as SessionMethodDeps['pty'],
      ...(withFeed ? { feed: { noteMode } } : {}),
    });
    return { sessionsSetMode, noteMode, write };
  }

  it('режим уже стоит: ответ из подвала, лента узнаёт режим, ничего не нажато', async () => {
    vi.useFakeTimers();
    try {
      const { sessionsSetMode, noteMode, write } = setup(true);
      const response = sessionsSetMode({ ref, mode: 'plan' }, request);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(response).resolves.toEqual({ mode: 'plan', verified: true });
      expect(noteMode).toHaveBeenCalledWith(ref, 'plan');
      expect(write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('без ленты метод только отвечает', async () => {
    vi.useFakeTimers();
    try {
      const { sessionsSetMode } = setup(true, false);
      const response = sessionsSetMode({ ref, mode: 'plan' }, request);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(response).resolves.toEqual({ mode: 'plan', verified: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('нет живого PTY — not_found, лента не зовётся', async () => {
    const { sessionsSetMode, noteMode } = setup(false);
    await expect(sessionsSetMode({ ref, mode: 'plan' }, request)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(noteMode).not.toHaveBeenCalled();
  });
});


describe('sessions.create role and explicit clear wire delivery', () => {
  it('forwards source-qualified role and exact null choices without computed defaults', async () => {
    const { create, sessionsCreate } = handlers();
    const input = { ...params, role: { source: 'builtin' as const, name: 'planner' }, model: null, effort: null };
    await sessionsCreate(input, request);
    expect(create).toHaveBeenCalledWith(input);
  });
});

describe('sessions.setEffort (спека нормалайзера, 5.7)', () => {
  let project = '';

  beforeEach(async () => {
    project = await mkdtemp(path.join(tmpdir(), 'parley-set-effort-'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(project, { recursive: true, force: true });
  });

  /** Сессия в карте временного проекта: провайдер и сохранённая модель — то, по чему хост берёт уровни. */
  async function sessionOf(provider: string, model?: string): Promise<SessionRef> {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const sessionId = await createPendingSession(project, work.work.id, {
      provider,
      label: 'бэкенд',
      task: 'сделай штуку',
      ...(model === undefined ? {} : { model }),
    });
    return { projectPath: project, workId: work.work.id, sessionId };
  }

  /**
   * Обработчик поверх экрана-подмены; `activity` — состояние агента, которое видит хост. По умолчанию после старта
   * процесса (у экрана `startedAt: 0`) уже был хук, будильник молчит, замок свой.
   */
  function setup(
    screen: FakeEffortScreen,
    activity = 'idle',
    options: { lastEventAt?: string | null; wakeInFlight?: boolean; lock?: SwitchLock } = {},
  ) {
    const setChoice = vi.fn(async () => {});
    const lastEventAt = options.lastEventAt === undefined ? '2026-10-06T10:00:00.000Z' : options.lastEventAt;
    const { sessionsSetEffort } = createSessionHandlers({
      sessions: { setChoice, exclusive: options.lock ?? createSwitchLock() } as unknown as SessionsService,
      pty: screen.pty,
      activity: {
        get: () => ({ activity: { activity, tasks: [], lastEventAt }, metrics: null }),
      } as unknown as SessionMethodDeps['activity'],
      wake: { inFlight: () => options.wakeInFlight === true },
    });
    return { sessionsSetEffort, setChoice };
  }

  /** Фальшивые часы только для таймеров: `setImmediate` остаётся настоящим (им `settle` отдаёт ввод-вывод). */
  const fakeClock = (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  };

  /**
   * Ответ обработчика под фальшивыми часами: карта и реестр читаются с настоящего диска, поэтому часы крутятся
   * шагами, а между шагами настоящий цикл событий успевает отдать ввод-вывод.
   */
  async function settle<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    void promise.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    for (let step = 0; step < 2_000 && !done; step += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(50);
    }
    return promise;
  }

  it('Claude, GLM и модель «по умолчанию»: подвал подтвердил уровень — карта обновлена, ответ verified true', async () => {
    const cases = [
      ['claude', 'opus'],
      ['glm', 'glm-5.3[1m]'],
      ['claude', undefined],
    ] as const;
    for (const [provider, model] of cases) {
      const ref = await sessionOf(provider, model);
      const screen = fakeEffortScreen('medium');
      const { sessionsSetEffort, setChoice } = setup(screen);
      fakeClock();
      await expect(settle(sessionsSetEffort({ ref, effort: 'xhigh' }, request))).resolves.toEqual({
        effort: 'xhigh',
        verified: true,
      });
      vi.useRealTimers();
      expect(setChoice).toHaveBeenCalledWith(ref, { effort: 'xhigh' });
      expect(screen.writes.slice(0, 2)).toEqual(['/effort', '\r']);
      // Пока ползунок открыт, будильник не печатает: черновик хоста поставлен на время смены и снят.
      expect(screen.hostDrafts).toEqual([true, false]);
    }
  });

  it('ползунок не открылся — Esc, verified false, карта не тронута', async () => {
    const ref = await sessionOf('claude', 'opus');
    const screen = fakeEffortScreen(null);
    screen.opens = false;
    const { sessionsSetEffort, setChoice } = setup(screen);
    fakeClock();

    await expect(settle(sessionsSetEffort({ ref, effort: 'high' }, request))).resolves.toEqual({
      effort: null,
      verified: false,
    });
    expect(screen.writes.at(-1)).toBe('\x1b');
    expect(setChoice).not.toHaveBeenCalled();
  });

  it('подвал показал другой уровень (предел CLI) — verified false с увиденным, карта не тронута', async () => {
    const ref = await sessionOf('claude', 'opus');
    const screen = fakeEffortScreen('medium');
    screen.cap = 'high';
    const { sessionsSetEffort, setChoice } = setup(screen);
    fakeClock();

    await expect(settle(sessionsSetEffort({ ref, effort: 'max' }, request))).resolves.toEqual({
      effort: 'high',
      verified: false,
    });
    expect(setChoice).not.toHaveBeenCalled();
  });

  it('агент работает или ждёт ответа — conflict с причиной busy, в PTY ничего не напечатано', async () => {
    const ref = await sessionOf('claude', 'opus');
    for (const activity of ['working', 'blocked']) {
      const screen = fakeEffortScreen('medium');
      const { sessionsSetEffort, setChoice } = setup(screen, activity);
      await expect(sessionsSetEffort({ ref, effort: 'high' }, request)).rejects.toMatchObject({
        name: 'HostError',
        code: 'conflict',
        data: { reason: 'busy' },
      });
      expect(screen.writes).toEqual([]);
      expect(setChoice).not.toHaveBeenCalled();
    }
  });

  it('в поле ввода неотправленный текст — conflict busy: `/effort` и Enter ушли бы агенту вместе с ним', async () => {
    const ref = await sessionOf('claude', 'opus');
    const screen = fakeEffortScreen('medium');
    screen.draft = true;
    const { sessionsSetEffort } = setup(screen);

    await expect(sessionsSetEffort({ ref, effort: 'high' }, request)).rejects.toMatchObject({
      code: 'conflict',
      data: { reason: 'busy' },
    });
    expect(screen.writes).toEqual([]);
  });

  it('уровня нет у модели или сессия не Claude Code — bad_request, ничего не напечатано', async () => {
    const screen = fakeEffortScreen('medium');
    const { sessionsSetEffort } = setup(screen);

    await expect(
      sessionsSetEffort({ ref: await sessionOf('claude', 'haiku'), effort: 'high' }, request),
    ).rejects.toThrow(/haiku has no effort levels/);
    await expect(
      sessionsSetEffort({ ref: await sessionOf('claude', 'opus'), effort: 'ultra' }, request),
    ).rejects.toThrow(/ultra is not a level of opus/);
    await expect(
      sessionsSetEffort({ ref: await sessionOf('codex', 'gpt-6-sol'), effort: 'high' }, request),
    ).rejects.toMatchObject({ name: 'HostError', code: 'bad_request' });
    expect(screen.writes).toEqual([]);
  });

  it('нет живого PTY — not_found', async () => {
    const ref = await sessionOf('claude', 'opus');
    const screen = fakeEffortScreen('medium');
    screen.live = false;
    const { sessionsSetEffort } = setup(screen);

    await expect(sessionsSetEffort({ ref, effort: 'high' }, request)).rejects.toMatchObject({
      name: 'HostError',
      code: 'not_found',
    });
  });

  it('с запуска процесса не было ни одного хука — conflict busy, ничего не напечатано: Enter мог бы ответить на вопрос доверия к папке', async () => {
    const ref = await sessionOf('claude', 'opus');
    const screen = fakeEffortScreen('medium');
    const { sessionsSetEffort } = setup(screen, 'idle', { lastEventAt: null });

    await expect(sessionsSetEffort({ ref, effort: 'high' }, request)).rejects.toMatchObject({
      code: 'conflict',
      data: { reason: 'busy' },
    });
    expect(screen.writes).toEqual([]);
  });

  it('будильник печатает указатель на письма — conflict busy: клавиши указателя и ползунка не смешаются', async () => {
    const ref = await sessionOf('claude', 'opus');
    const screen = fakeEffortScreen('medium');
    const { sessionsSetEffort } = setup(screen, 'idle', { wakeInFlight: true });

    await expect(sessionsSetEffort({ ref, effort: 'high' }, request)).rejects.toMatchObject({
      code: 'conflict',
      data: { reason: 'busy' },
    });
    expect(screen.writes).toEqual([]);
    expect(screen.hostDrafts).toEqual([]);
  });

  it('два выбора подряд по одной сессии (двойной клик) — второй conflict busy, клавиши первого не перемешаны', async () => {
    const ref = await sessionOf('claude', 'opus');
    const screen = fakeEffortScreen('medium');
    const { sessionsSetEffort, setChoice } = setup(screen);
    fakeClock();

    const first = sessionsSetEffort({ ref, effort: 'high' }, request);
    await expect(sessionsSetEffort({ ref, effort: 'max' }, request)).rejects.toMatchObject({
      code: 'conflict',
      data: { reason: 'busy' },
    });
    await expect(settle(first)).resolves.toEqual({ effort: 'high', verified: true });
    vi.useRealTimers();

    // Одна последовательность клавиш: `/effort`, Enter, 6 × ←, 2 × →, `s`.
    expect(screen.writes).toEqual([
      '/effort',
      '\r',
      ...Array.from({ length: 6 }, () => '\x1b[D'),
      '\x1b[C',
      '\x1b[C',
      's',
    ]);
    expect(setChoice).toHaveBeenCalledTimes(1);
  });

  it('идёт смена модели той же сессии (общий замок с sessions.setModel) — conflict busy, ничего не напечатано', async () => {
    const ref = await sessionOf('claude', 'opus');
    const screen = fakeEffortScreen('medium');
    const lock = createSwitchLock();
    const { sessionsSetEffort } = setup(screen, 'idle', { lock });
    let release: () => void = () => {};
    const model = lock(ref, () => new Promise<void>((resolve) => {
      release = resolve;
    }));

    await expect(sessionsSetEffort({ ref, effort: 'high' }, request)).rejects.toMatchObject({
      code: 'conflict',
      data: { reason: 'busy' },
    });
    expect(screen.writes).toEqual([]);
    release();
    await model;
  });
});

describe('sessions.setModel (спека нормалайзера, 5.8)', () => {
  it('правила и порядок — в сервисе: обработчик отдаёт ему ref и модель и возвращает ответ как есть', async () => {
    const setModel = vi.fn(async () => ({ model: 'sonnet', effort: null, restarted: true }));
    const { sessionsSetModel } = createSessionHandlers({
      sessions: { setModel } as unknown as SessionsService,
      pty: {} as unknown as SessionMethodDeps['pty'],
      activity: {} as unknown as SessionMethodDeps['activity'],
      wake: {} as unknown as SessionMethodDeps['wake'],
    });

    await expect(sessionsSetModel({ ref, model: 'sonnet' }, request)).resolves.toEqual({
      model: 'sonnet',
      effort: null,
      restarted: true,
    });
    expect(setModel).toHaveBeenCalledWith(ref, 'sonnet');
  });
});
