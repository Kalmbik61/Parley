/**
 * Чек-лист приёмки TUI v2, пункты 1–10: таблица переходов 4.2 и страховка 4.3.
 * По одному `it` на строку таблицы — свёртка чистая, никакого диска здесь нет.
 * Субагенты по id, снимок фоновых задач и ожидание `wait_for` — в конце файла (Parley 0.2.0).
 */

import { describe, expect, it } from 'vitest';
import { activityOf, hookedSince, type Activity, type ActivityLog } from './activity.js';
import {
  PARLEY_STARTUP_NOTIFICATION,
  TERMINAL_WORKING_EVENT,
  bareEvent,
  type BackgroundTask,
  type EventRecord,
} from './events.js';
import { NEED_DETAIL_MAX, type NeedKind, type SessionNeed } from './stuck.js';

const AT = '2026-09-05T10:00:00.000Z';
const NOW = Date.parse('2026-09-05T10:00:10.000Z');

const event = (name: string, notificationType: string | null = null, at = AT): EventRecord => ({
  ...bareEvent(at, name),
  notificationType,
});

const activity = (events: EventRecord[], seen = false): ReturnType<typeof activityOf> =>
  activityOf({ events, seen, now: NOW });

describe('activityOf: таблица переходов 4.2', () => {
  // Пункт 1.
  it('UserPromptSubmit → working', () => {
    expect(activity([event('UserPromptSubmit')]).activity).toBe('working');
  });

  it('SessionStart(startup) ход не открывает → idle', () => {
    const result = activity([hook('SessionStart', { source: 'startup' })]);
    expect(result.activity).toBe('idle');
    expect(result.turnEndedAt).toBeNull();
    expect(result.lastEventAt).toBe(AT);
  });

  it('SessionStart(startup), затем UserPromptSubmit → working', () => {
    expect(
      activity([hook('SessionStart', { source: 'startup' }), event('UserPromptSubmit')]).activity,
    ).toBe('working');
  });

  it('смена модели: ход просмотрен, SessionEnd и SessionStart(resume) → то же, что до перезапуска', () => {
    const turn = [event('UserPromptSubmit'), event('Stop')];
    const before = activity(turn, true);
    const after = activity(
      [...turn, event('SessionEnd'), hook('SessionStart', { source: 'resume' })],
      true,
    );
    expect(before.activity).toBe('idle');
    expect(after.activity).toBe('idle');
    expect(after.turnEndedAt).toBe(before.turnEndedAt);
  });

  it('смена модели: перезапуск не создаёт нового unseen и не гасит старый', () => {
    const turn = [event('UserPromptSubmit'), event('Stop')];
    const restarted = [...turn, event('SessionEnd'), hook('SessionStart', { source: 'resume' })];
    expect(activity(restarted, false).activity).toBe('unseen');
    expect(activity(restarted, true).activity).toBe('idle');
    // Сессия, у которой хода не было, после перезапуска тоже без unseen.
    expect(activity([hook('SessionStart', { source: 'resume' })], false).activity).toBe('idle');
  });

  it('SessionStart(resume) после хода без Stop: прежний процесс умер посреди хода — ход окончен', () => {
    const afterStop = activity([event('UserPromptSubmit'), event('Stop')]);
    const restarted = activity([event('UserPromptSubmit'), hook('SessionStart', { source: 'resume' })]);
    expect(restarted.activity).toBe('unseen');
    expect(restarted.activity).toBe(afterStop.activity);
    expect(restarted.turnEndedAt).toBe(AT);
    expect(restarted.source).toBe('hooks');
  });

  it('SessionStart(resume) посреди вопроса к человеку: ход окончен', () => {
    const result = activity([
      event('UserPromptSubmit'),
      event('PermissionRequest'),
      hook('SessionStart', { source: 'resume' }),
    ]);
    expect(result.activity).toBe('unseen');
  });

  it('SessionStart(compact) посреди хода: working не меняется', () => {
    const result = activity([event('UserPromptSubmit'), hook('SessionStart', { source: 'compact' })]);
    expect(result.activity).toBe('working');
    expect(result.turnEndedAt).toBeNull();
  });

  it('SessionStart с незнакомым source посреди хода: фаза не меняется, как у compact', () => {
    const result = activity([event('UserPromptSubmit'), hook('SessionStart', { source: 'something-new' })]);
    expect(result.activity).toBe('working');
    expect(result.turnEndedAt).toBeNull();
  });

  it('SessionStart(compact) после хода: новый ход не открывается', () => {
    const turn = [event('UserPromptSubmit'), event('Stop')];
    const result = activity([...turn, hook('SessionStart', { source: 'compact' })], true);
    expect(result.activity).toBe('idle');
    expect(activity([hook('SessionStart', { source: 'compact' })]).activity).toBe('idle');
  });

  it('SessionStart(clear) после хода — как после Stop', () => {
    const turn = [event('UserPromptSubmit'), event('Stop')];
    const cleared = [...turn, hook('SessionStart', { source: 'clear' })];
    expect(activity(cleared).activity).toBe(activity(turn).activity);
    expect(activity(cleared, true).activity).toBe('idle');
    expect(activity(cleared).turnEndedAt).toBe(activity(turn).turnEndedAt);
  });

  it('SessionStart без поля source читается как запуск: ход не открывает', () => {
    expect(activity([event('SessionStart')]).activity).toBe('idle');
    expect(activity([event('UserPromptSubmit'), event('SessionStart')]).activity).toBe('unseen');
  });

  // Пункт 2.
  it('Notification с вопросом к пользователю → blocked', () => {
    for (const type of [
      'permission_prompt',
      'agent_needs_input',
      'elicitation_dialog',
      'elicitation_url_dialog',
    ]) {
      expect(activity([event('UserPromptSubmit'), event('Notification', type)]).activity).toBe(
        'blocked',
      );
    }
  });

  it('PermissionRequest → blocked', () => {
    expect(activity([event('UserPromptSubmit'), event('PermissionRequest')]).activity).toBe(
      'blocked',
    );
  });

  // Пункт 3.
  it('elicitation_complete и elicitation_response снимают blocked обратно в working', () => {
    for (const type of ['elicitation_complete', 'elicitation_response']) {
      const events = [
        event('UserPromptSubmit'),
        event('Notification', 'elicitation_dialog'),
        event('Notification', type),
      ];
      expect(activity(events).activity).toBe('working');
    }
  });

  // Пункт 4.
  it('Stop заканчивает ход: unseen без seen, idle с seen', () => {
    const events = [event('UserPromptSubmit'), event('Stop', null, '2026-09-05T10:00:05.000Z')];

    expect(activity(events).activity).toBe('unseen');
    expect(activity(events).turnEndedAt).toBe('2026-09-05T10:00:05.000Z');
    expect(activity(events, true).activity).toBe('idle');
  });

  it('idle_prompt заканчивает ход так же, но не снимает blocked', () => {
    const ended = [event('UserPromptSubmit'), event('Notification', 'idle_prompt')];
    expect(activity(ended).activity).toBe('unseen');
    expect(activity(ended, true).activity).toBe('idle');

    const blocked = [
      event('UserPromptSubmit'),
      event('PermissionRequest'),
      event('Notification', 'idle_prompt'),
    ];
    expect(activity(blocked).activity).toBe('blocked');
    expect(activity(blocked).turnEndedAt).toBeNull();
  });

  // Пункт 5, первая половина: «с отчётом статус не меняется» решает вызывающий,
  // у свёртки входа про отчёт нет.
  it('SessionEnd поднимает флаг exited, не трогая activity', () => {
    const result = activity([event('UserPromptSubmit'), event('SessionEnd')]);

    // Жизненный цикл (`exited` или отчёт агента) меняет вызывающий, не свёртка.
    expect(result.exited).toBe(true);
    expect(result.activity).toBe('working');
    expect(activity([event('UserPromptSubmit')]).exited).toBe(false);
  });

  // Пункт 6: счёт по id, подробности — в блоке про субагентов ниже.
  it('SubagentStart и SubagentStop считают живых субагентов по id', () => {
    const start = (id: string): EventRecord => ({ ...event('SubagentStart'), agentId: id });
    const stop = (id: string): EventRecord => ({ ...event('SubagentStop'), agentId: id });

    expect(activity([start('a'), start('b')]).subagents).toBe(2);
    expect(activity([start('a'), stop('a')]).subagents).toBe(0);
    expect(activity([stop('a')]).subagents).toBe(0);
    // Без id ни старт, ни остановку не сопоставить: событие пропускается.
    expect(activity([event('SubagentStart'), event('SubagentStart')]).subagents).toBe(0);
  });

  // Пункт 7.
  it('неизвестное событие пропускается', () => {
    const result = activity([event('UserPromptSubmit'), event('PreToolUse')]);

    expect(result.activity).toBe('working');
    // Последнее событие журнала — всё равно последняя строка файла.
    expect(result.lastEventAt).toBe(AT);
  });

  // Пункт 8.
  it('порядок переходов — порядок файла, а не timestamps', () => {
    const events = [
      event('Stop', null, '2026-09-05T10:00:09.000Z'),
      event('UserPromptSubmit', null, '2026-09-05T10:00:01.000Z'),
    ];

    expect(activity(events).activity).toBe('working');
    expect(activity(events).lastEventAt).toBe('2026-09-05T10:00:01.000Z');
  });

  it('без событий и без лога состояние тусклое, источника нет', () => {
    const result = activityOf({ events: [], now: NOW });

    expect(result).toEqual({
      activity: 'idle',
      subagents: 0,
      tasks: [],
      waitingFor: null,
      heldByBackground: false,
      turnEndedAt: null,
      lastEventAt: null,
      source: 'none',
      exited: false,
      hooksMissing: false,
      need: null,
    });
  });
});

describe('activityOf: страховка по логу (4.3)', () => {
  // Пункт 9.
  it('запись лога новее последнего события → working', () => {
    const result = activityOf({
      events: [event('Stop', null, '2026-09-05T10:00:01.000Z')],
      log: { lastRecordAt: '2026-09-05T10:00:05.000Z', lastUserRecordAt: null },
      now: NOW,
      silenceThresholdMs: 30_000,
    });

    expect(result.activity).toBe('working');
    expect(result.source).toBe('log');
    expect(result.turnEndedAt).toBeNull();
  });

  it('тишина дольше порога заканчивает ход', () => {
    const result = activityOf({
      events: [event('UserPromptSubmit', null, '2026-09-05T09:59:00.000Z')],
      log: { lastRecordAt: '2026-09-05T09:59:30.000Z', lastUserRecordAt: null },
      now: NOW,
      silenceThresholdMs: 30_000,
    });

    expect(result.activity).toBe('unseen');
    expect(result.turnEndedAt).toBe('2026-09-05T09:59:30.000Z');
    expect(result.source).toBe('log');
  });

  it('свежее событие хука держит working, пока лог молчит дольше порога', () => {
    const result = activityOf({
      events: [event('UserPromptSubmit', null, '2026-09-05T10:00:09.000Z')],
      log: { lastRecordAt: '2026-09-05T09:59:00.000Z', lastUserRecordAt: null },
      now: NOW,
      silenceThresholdMs: 30_000,
    });

    expect(result.activity).toBe('working');
    expect(result.source).toBe('hooks');
    expect(result.turnEndedAt).toBeNull();
  });

  it('живой субагент без записей в лог — тоже working', () => {
    const result = activityOf({
      events: [
        event('UserPromptSubmit', null, '2026-09-05T09:59:20.000Z'),
        { ...event('SubagentStart', null, '2026-09-05T10:00:09.000Z'), agentId: 'a1' },
      ],
      log: { lastRecordAt: '2026-09-05T09:59:00.000Z', lastUserRecordAt: null },
      now: NOW,
      silenceThresholdMs: 30_000,
    });

    expect(result.activity).toBe('working');
    expect(result.subagents).toBe(1);
    expect(result.source).toBe('hooks');
  });

  it('страховка не снимает blocked', () => {
    const result = activityOf({
      events: [event('PermissionRequest', null, '2026-09-05T10:00:01.000Z')],
      log: { lastRecordAt: '2026-09-05T10:00:05.000Z', lastUserRecordAt: null },
      now: NOW,
      silenceThresholdMs: 30_000,
    });

    expect(result.activity).toBe('blocked');
    expect(result.source).toBe('hooks');
  });

  it('новая запись пользователя снимает blocked: разрешение выдано, ход идёт дальше', () => {
    const events = [event('PermissionRequest', null, '2026-09-05T10:00:01.000Z')];
    const log = (lastUserRecordAt: string): ActivityLog => ({
      lastRecordAt: '2026-09-05T10:00:05.000Z',
      lastUserRecordAt,
    });

    // Запись пользователя старше вопроса — это та самая реплика, после которой
    // разрешение и спросили: `blocked` держится.
    expect(
      activityOf({
        events,
        log: log('2026-09-05T10:00:00.000Z'),
        now: NOW,
        silenceThresholdMs: 30_000,
      }).activity,
    ).toBe('blocked');

    const resumed = activityOf({
      events,
      log: log('2026-09-05T10:00:05.000Z'),
      now: NOW,
      silenceThresholdMs: 30_000,
    });

    expect(resumed.activity).toBe('working');
    expect(resumed.source).toBe('log');
    expect(resumed.turnEndedAt).toBeNull();
  });

  it('журнал замолчал, а записей лога нет вовсе — ход всё равно закончен по тишине', () => {
    // Агента убили без `SessionEnd`, транскрипт к сессии не привязан: без этого
    // правила точка осталась бы `working` навсегда.
    const result = activityOf({
      events: [event('UserPromptSubmit', null, '2026-09-05T09:59:00.000Z')],
      log: { lastRecordAt: null, lastUserRecordAt: null },
      now: NOW,
      silenceThresholdMs: 30_000,
    });

    expect(result.activity).toBe('unseen');
    expect(result.turnEndedAt).toBe('2026-09-05T09:59:00.000Z');
    // Решило время хука, а не лога, — источник остаётся журналом.
    expect(result.source).toBe('hooks');
  });

  // Пункт 10.
  it('журнала событий нет → работает только страховка и поднят флаг предупреждения', () => {
    const result = activityOf({
      events: null,
      log: { lastRecordAt: '2026-09-05T10:00:05.000Z', lastUserRecordAt: null },
      now: NOW,
    });

    expect(result.hooksMissing).toBe(true);
    expect(result.source).toBe('log');
    expect(result.activity).toBe('working');
  });

  it('лог пуст → страховке не от чего считать', () => {
    const result = activityOf({
      events: null,
      log: { lastRecordAt: null, lastUserRecordAt: null },
      now: NOW,
    });

    expect(result.hooksMissing).toBe(true);
    expect(result.source).toBe('none');
    expect(result.activity).toBe('idle');
  });
});

describe('hookedSince: события хуков с запуска процесса (fix-final-b)', () => {
  const START = Date.parse(AT);

  it('событий нет — false', () => {
    expect(hookedSince(activity([]), START)).toBe(false);
    expect(hookedSince(null, START)).toBe(false);
    expect(hookedSince(undefined, START)).toBe(false);
  });

  it('последнее событие раньше запуска (журнал прошлого процесса) — false', () => {
    expect(hookedSince(activity([event('Stop', null, '2026-09-05T09:59:59.999Z')]), START)).toBe(false);
  });

  it('событие в момент запуска или позже — true', () => {
    expect(hookedSince(activity([event('SessionStart', null, AT)]), START)).toBe(true);
    expect(hookedSince(activity([event('Stop', null, '2026-09-05T10:00:05.000Z')]), START)).toBe(true);
  });
});

/** Событие хука с полями агента, снимком фоновых задач и прочим сверх имени. */
const hook = (name: string, extra: Partial<EventRecord> = {}, at = AT): EventRecord => ({
  ...bareEvent(at, name),
  ...extra,
});

const task = (id: string, extra: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id,
  type: 'subagent',
  status: 'running',
  agentType: 'general-purpose',
  description: `исследование ${id}`,
  ...extra,
});

const TRANSCRIPT = '/home/u/.claude/projects/p/sess.jsonl';

const startOf = (id: string, extra: Partial<EventRecord> = {}, at = AT): EventRecord =>
  hook(
    'SubagentStart',
    { agentId: id, agentType: 'general-purpose', transcriptPath: TRANSCRIPT, ...extra },
    at,
  );

const stopOf = (id: string, extra: Partial<EventRecord> = {}, at = AT): EventRecord =>
  hook('SubagentStop', { agentId: id, ...extra }, at);

describe('activityOf: субагенты по id и фоновые задачи (Parley 0.2.0)', () => {
  // Пункт 1 задания: Claude прислал Stop, а три субагента ещё работают.
  it('Stop при работающей фоновой задаче в снимке — working, ход не окончен, описание в tasks', () => {
    const result = activity([
      event('UserPromptSubmit', null, '2026-09-05T09:59:50.000Z'),
      startOf('a', {}, '2026-09-05T09:59:55.000Z'),
      hook('Stop', { backgroundTasks: [task('a')] }, '2026-09-05T10:00:05.000Z'),
    ]);

    expect(result.activity).toBe('working');
    expect(result.turnEndedAt).toBeNull();
    expect(result.source).toBe('hooks');
    expect(result.subagents).toBe(1);
    expect(result.tasks).toEqual([
      {
        id: 'a',
        agentType: 'general-purpose',
        description: 'исследование a',
        background: true,
        transcriptPath: TRANSCRIPT,
      },
    ]);
  });

  // Пункт 2.
  it('снимок опустел — ход окончен: unseen, а при seen — idle', () => {
    const events = [
      event('UserPromptSubmit', null, '2026-09-05T09:59:50.000Z'),
      startOf('a', {}, '2026-09-05T09:59:55.000Z'),
      hook('Stop', { backgroundTasks: [task('a')] }, '2026-09-05T10:00:05.000Z'),
      stopOf('a', { backgroundTasks: [] }, '2026-09-05T10:00:08.000Z'),
    ];

    const result = activity(events);
    expect(result.activity).toBe('unseen');
    // Ход окончен, когда снялось удержание: время события, а не прежнего Stop.
    expect(result.turnEndedAt).toBe('2026-09-05T10:00:08.000Z');
    expect(result.tasks).toEqual([]);
    expect(result.subagents).toBe(0);
    expect(activity(events, true).activity).toBe('idle');
  });

  // Пункт 3: служебные помощники Claude Code шлют десятки SubagentStop без SubagentStart.
  it('47 посторонних SubagentStop не снимают стартовавшего и работающего субагента', () => {
    const outsiders = Array.from({ length: 47 }, (_, index) =>
      stopOf(`helper-${index}`, { backgroundTasks: [task('a')] }),
    );

    const midTurn = activity([event('UserPromptSubmit'), startOf('a'), ...outsiders]);
    expect(midTurn.activity).toBe('working');
    expect(midTurn.subagents).toBe(1);
    expect(midTurn.tasks.map((item) => item.id)).toEqual(['a']);

    // То же после конца хода: субагент фоновый, и посторонние остановки его не трогают.
    const afterStop = activity([
      event('UserPromptSubmit'),
      startOf('a'),
      hook('Stop', { backgroundTasks: [task('a')] }),
      ...outsiders,
    ]);
    expect(afterStop.activity).toBe('working');
    expect(afterStop.subagents).toBe(1);
  });

  it('SubagentStop с незнакомым id и без снимка ничего не снимает', () => {
    const result = activity([event('UserPromptSubmit'), startOf('a'), stopOf('чужой')]);

    expect(result.subagents).toBe(1);
    expect(result.tasks.map((item) => item.id)).toEqual(['a']);
  });

  it('SubagentStop своего id снимает субагента; повторный старт того же id — один субагент', () => {
    expect(activity([event('UserPromptSubmit'), startOf('a'), stopOf('a')]).subagents).toBe(0);
    expect(activity([event('UserPromptSubmit'), startOf('a'), startOf('a')]).subagents).toBe(1);
  });

  // Пункт 4.
  it('тишина дольше порога при работающей фоновой задаче — всё ещё working; без неё — окончен', () => {
    const quiet = '2026-09-05T09:58:00.000Z';
    const held = activityOf({
      events: [
        event('UserPromptSubmit', null, quiet),
        startOf('a', { backgroundTasks: [task('a')] }, quiet),
      ],
      now: NOW,
      silenceThresholdMs: 30_000,
    });

    expect(held.activity).toBe('working');
    expect(held.turnEndedAt).toBeNull();
    expect(held.tasks.map((item) => item.id)).toEqual(['a']);

    // Тот же журнал, но снимок пуст: тишина действует, как раньше.
    const released = activityOf({
      events: [
        event('UserPromptSubmit', null, quiet),
        startOf('a', { backgroundTasks: [] }, quiet),
      ],
      now: NOW,
      silenceThresholdMs: 30_000,
    });
    expect(released.activity).toBe('unseen');
    expect(released.turnEndedAt).toBe(quiet);
    // Ход окончен — обычные субагенты в списке не остаются.
    expect(released.tasks).toEqual([]);
  });

  it('обычный субагент (не фоновый) тишину не отменяет: держит только снимок', () => {
    const quiet = '2026-09-05T09:58:00.000Z';
    const result = activityOf({
      events: [event('UserPromptSubmit', null, quiet), startOf('a', {}, quiet)],
      now: NOW,
      silenceThresholdMs: 30_000,
    });

    expect(result.activity).toBe('unseen');
  });

  it('Stop оставляет только фоновых: обычные субагенты ход не переживают', () => {
    const result = activity([
      event('UserPromptSubmit'),
      startOf('a'),
      startOf('b'),
      hook('Stop', { backgroundTasks: [task('b')] }),
    ]);

    expect(result.activity).toBe('working');
    expect(result.tasks.map((item) => [item.id, item.background])).toEqual([['b', true]]);

    // Не пережил ход и тогда, когда id позже встретится снова: список не воскресает.
    const later = activity([
      event('UserPromptSubmit'),
      startOf('a'),
      hook('Stop', { backgroundTasks: [] }),
      event('UserPromptSubmit'),
    ]);
    expect(later.subagents).toBe(0);
  });

  it('Stop без снимка вовсе: стартовавшие субагенты уходят, ход окончен', () => {
    const result = activity([event('UserPromptSubmit'), startOf('a'), event('Stop')]);

    expect(result.activity).toBe('unseen');
    expect(result.tasks).toEqual([]);
  });

  it('idle_prompt заканчивает ход, но работающая фоновая задача удерживает working', () => {
    const result = activity([
      event('UserPromptSubmit'),
      hook('Notification', { notificationType: 'idle_prompt', backgroundTasks: [task('a')] }),
    ]);

    expect(result.activity).toBe('working');
    expect(result.turnEndedAt).toBeNull();
  });

  it('blocked не снимается фоновыми задачами: вопрос человеку важнее', () => {
    const result = activity([
      event('UserPromptSubmit'),
      hook('PermissionRequest', { backgroundTasks: [task('a')] }),
    ]);

    expect(result.activity).toBe('blocked');
    expect(result.tasks.map((item) => item.id)).toEqual(['a']);
  });

  it('держат только работающие субагенты: завершённые и фоновые команды — нет', () => {
    const result = activity([
      event('UserPromptSubmit'),
      hook('Stop', {
        backgroundTasks: [
          task('done', { status: 'completed' }),
          task('dev-server', { type: 'shell', agentType: null, description: 'npm run dev' }),
        ],
      }),
    ]);

    expect(result.activity).toBe('unseen');
    expect(result.tasks).toEqual([]);
  });

  it('описание и тип берутся из снимка; без него — тип из SubagentStart, описания нет', () => {
    const result = activity([
      event('UserPromptSubmit'),
      startOf('a', { agentType: 'explorer' }),
      startOf('b', { agentType: 'claude-code-guide' }),
      hook('Notification', {
        backgroundTasks: [
          task('a', { agentType: 'general-purpose', description: 'Orca research' }),
        ],
      }),
    ]);

    expect(result.tasks).toEqual([
      {
        id: 'a',
        agentType: 'general-purpose',
        description: 'Orca research',
        background: true,
        transcriptPath: TRANSCRIPT,
      },
      {
        id: 'b',
        agentType: 'claude-code-guide',
        description: null,
        background: false,
        transcriptPath: TRANSCRIPT,
      },
    ]);
  });

  it('задача только из снимка (старта не видели) тоже в списке: сначала стартовавшие', () => {
    const result = activity([
      event('UserPromptSubmit'),
      startOf('b'),
      hook('Stop', { backgroundTasks: [task('c'), task('b')] }),
    ]);

    expect(result.tasks.map((item) => [item.id, item.background, item.transcriptPath])).toEqual([
      ['b', true, TRANSCRIPT],
      ['c', true, null],
    ]);
    expect(result.subagents).toBe(2);
  });

  it('SubagentStop снимает свой id и из отставшего снимка того же события', () => {
    const result = activity([
      event('UserPromptSubmit'),
      startOf('a'),
      hook('Stop', { backgroundTasks: [task('a')] }),
      // Claude Code успел положить в снимок остановленную задачу как running.
      stopOf('a', { backgroundTasks: [task('a')] }),
    ]);

    expect(result.activity).toBe('unseen');
    expect(result.tasks).toEqual([]);
  });

  it('снимок живёт до следующего снимка: событие без поля его не трогает, пустой список стирает', () => {
    const events = [
      event('UserPromptSubmit'),
      hook('Stop', { backgroundTasks: [task('a')] }),
      hook('Notification', { notificationType: 'idle_prompt' }),
    ];
    expect(activity(events).activity).toBe('working');

    expect(activity([...events, hook('Notification', { backgroundTasks: [] })]).activity).toBe(
      'unseen',
    );
  });

  it('новый UserPromptSubmit не сбрасывает фоновые задачи прошлого хода', () => {
    const result = activity([
      event('UserPromptSubmit'),
      hook('Stop', { backgroundTasks: [task('a')] }),
      event('UserPromptSubmit'),
    ]);

    expect(result.activity).toBe('working');
    expect(result.tasks.map((item) => item.id)).toEqual(['a']);
  });

  // Пункт 6.
  it('SessionStart сбрасывает субагентов, снимок и ожидание; свой снимок события остаётся', () => {
    const before = [
      event('UserPromptSubmit'),
      startOf('a'),
      hook('ParleyWaitStart', { waitTarget: 's-03' }),
      hook('Notification', { backgroundTasks: [task('a')] }),
    ];
    expect(activity(before).tasks).toHaveLength(1);
    expect(activity(before).waitingFor).toBe('s-03');

    const reset = activity([...before, event('SessionStart')]);
    // Процесс перезапущен посреди хода — ход окончен, сессия у приглашения.
    expect(reset.activity).toBe('unseen');
    expect(reset.tasks).toEqual([]);
    expect(reset.subagents).toBe(0);
    expect(reset.waitingFor).toBeNull();

    const withOwn = activity([...before, hook('SessionStart', { backgroundTasks: [task('b')] })]);
    expect(withOwn.tasks.map((item) => item.id)).toEqual(['b']);
  });

  it('перезапуск сессии, которую держали фоновые, не даёт нового конца хода: просмотренная остаётся idle', () => {
    const stopAt = '2026-09-05T10:00:05.000Z';
    const restartAt = '2026-09-05T10:00:08.000Z';
    const held = [
      event('UserPromptSubmit', null, '2026-09-05T09:59:50.000Z'),
      hook('Stop', { backgroundTasks: [task('a')] }, stopAt),
    ];
    // Контроль: пока фоновый держит, ход не окончен; освобождение снимком даёт конец хода «сейчас».
    expect(activity(held, true).activity).toBe('working');
    const released = activity([...held, hook('Notification', { backgroundTasks: [] }, restartAt)], true);
    expect(released.turnEndedAt).toBe(restartAt);

    const restarted = activity(
      [...held, hook('SessionStart', { source: 'resume', backgroundTasks: [] }, restartAt)],
      true,
    );
    expect(restarted.activity).toBe('idle');
    expect(restarted.turnEndedAt).toBe(stopAt);
    expect(restarted.heldByBackground).toBe(false);
  });

  it('без журнала событий задач и ожидания нет', () => {
    const result = activityOf({ events: null, now: NOW });

    expect(result.tasks).toEqual([]);
    expect(result.waitingFor).toBeNull();
    expect(result.subagents).toBe(0);
  });

  it('страховка по логу и работающая фоновая задача не мешают друг другу', () => {
    const result = activityOf({
      events: [hook('Stop', { backgroundTasks: [task('a')] }, '2026-09-05T10:00:01.000Z')],
      log: { lastRecordAt: '2026-09-05T10:00:05.000Z', lastUserRecordAt: null },
      now: NOW,
      silenceThresholdMs: 30_000,
    });

    expect(result.activity).toBe('working');
    expect(result.turnEndedAt).toBeNull();
  });
});

describe('activityOf: ожидание wait_for (Parley 0.2.0)', () => {
  // Пункт 5.
  it('ParleyWaitStart ставит waitingFor, ParleyWaitEnd снимает', () => {
    const waiting = [event('UserPromptSubmit'), hook('ParleyWaitStart', { waitTarget: 's-03' })];
    expect(activity(waiting).waitingFor).toBe('s-03');
    expect(activity(waiting).activity).toBe('working');

    expect(activity([...waiting, hook('ParleyWaitEnd')]).waitingFor).toBeNull();
  });

  it('ожидание inbox показывается как есть', () => {
    const result = activity([
      event('UserPromptSubmit'),
      hook('ParleyWaitStart', { waitTarget: 'inbox' }),
    ]);

    expect(result.waitingFor).toBe('inbox');
  });

  it('Stop, UserPromptSubmit, SessionStart и конец хода по idle_prompt снимают ожидание', () => {
    const waiting = [event('UserPromptSubmit'), hook('ParleyWaitStart', { waitTarget: 's-03' })];

    for (const closing of [
      event('Stop'),
      event('UserPromptSubmit'),
      event('SessionStart'),
      event('Notification', 'idle_prompt'),
    ]) {
      expect(activity([...waiting, closing]).waitingFor, closing.name).toBeNull();
    }
  });

  it('ParleyWaitStart после конца хода (запоздалая строка) ожидания не показывает', () => {
    const result = activity([
      event('UserPromptSubmit'),
      event('Stop'),
      hook('ParleyWaitStart', { waitTarget: 's-03' }),
    ]);

    expect(result.activity).toBe('unseen');
    expect(result.waitingFor).toBeNull();
  });

  it('ParleyWaitStart без цели игнорируется', () => {
    const result = activity([event('UserPromptSubmit'), hook('ParleyWaitStart')]);

    expect(result.waitingFor).toBeNull();
  });

  it('тишина не понижает ждущую сессию; конец ожидания возвращает правило тишины', () => {
    const waiting = [
      event('UserPromptSubmit', null, '2026-09-05T09:58:00.000Z'),
      hook('ParleyWaitStart', { waitTarget: 's-03' }, '2026-09-05T09:58:01.000Z'),
    ];
    const read = (events: EventRecord[]): ReturnType<typeof activityOf> =>
      activityOf({ events, now: NOW, silenceThresholdMs: 30_000 });

    const held = read(waiting);
    expect(held.activity).toBe('working');
    expect(held.waitingFor).toBe('s-03');

    // Ожидание кончилось, а новых событий нет полминуты: агент молчит — ход окончен.
    const ended = read([...waiting, hook('ParleyWaitEnd', {}, '2026-09-05T09:58:30.000Z')]);
    expect(ended.activity).toBe('unseen');
    expect(ended.turnEndedAt).toBe('2026-09-05T09:58:30.000Z');
    expect(ended.waitingFor).toBeNull();
  });

  it('вопрос человеку (blocked) ожидание не отменяет', () => {
    const result = activity([
      event('UserPromptSubmit'),
      hook('ParleyWaitStart', { waitTarget: 's-03' }),
      event('PermissionRequest'),
    ]);

    expect(result.activity).toBe('blocked');
  });
});

describe('activityOf: heldByBackground — working только из-за фоновых субагентов (Parley 0.2.0)', () => {
  const QUIET = '2026-09-05T09:58:00.000Z';
  const silent = (
    events: EventRecord[],
    log: ActivityLog | null = null,
  ): ReturnType<typeof activityOf> =>
    activityOf({ events, log, now: NOW, silenceThresholdMs: 30_000 });

  it('Stop при работающей фоновой задаче → true: ход родителя окончен, он стоит у приглашения', () => {
    const result = activity([
      event('UserPromptSubmit'),
      hook('Stop', { backgroundTasks: [task('a')] }),
    ]);

    expect(result.activity).toBe('working');
    expect(result.turnEndedAt).toBeNull();
    expect(result.heldByBackground).toBe(true);
  });

  it('конец хода по idle_prompt → true', () => {
    const result = activity([
      event('UserPromptSubmit'),
      hook('Notification', { notificationType: 'idle_prompt', backgroundTasks: [task('a')] }),
    ]);

    expect(result.activity).toBe('working');
    expect(result.heldByBackground).toBe(true);
  });

  it('тишина дольше порога при работающей фоновой задаче → true: родитель молчит', () => {
    const result = silent([
      event('UserPromptSubmit', null, QUIET),
      startOf('a', { backgroundTasks: [task('a')] }, QUIET),
    ]);

    expect(result.activity).toBe('working');
    expect(result.heldByBackground).toBe(true);
  });

  it('тишина лога родителя (записи были, но давно) при фоновой задаче → true', () => {
    const result = silent(
      [hook('Stop', { backgroundTasks: [task('a')] }, '2026-09-05T09:59:00.000Z')],
      { lastRecordAt: '2026-09-05T09:59:30.000Z', lastUserRecordAt: null },
    );

    expect(result.activity).toBe('working');
    expect(result.heldByBackground).toBe(true);
  });

  it('агент работает сам: ход не окончен, события свежие, а фоновые идут → false', () => {
    const result = activity([
      event('UserPromptSubmit'),
      startOf('a', { backgroundTasks: [task('a')] }),
    ]);

    expect(result.activity).toBe('working');
    expect(result.tasks.map((item) => item.id)).toEqual(['a']);
    expect(result.heldByBackground).toBe(false);
  });

  it('родитель пишет в транскрипт после Stop (разбирает результат) → false: он снова работает', () => {
    const result = activityOf({
      events: [hook('Stop', { backgroundTasks: [task('a')] }, '2026-09-05T10:00:01.000Z')],
      log: { lastRecordAt: '2026-09-05T10:00:05.000Z', lastUserRecordAt: null },
      now: NOW,
      silenceThresholdMs: 30_000,
    });

    expect(result.activity).toBe('working');
    expect(result.source).toBe('log');
    expect(result.heldByBackground).toBe(false);
  });

  it('ожидание wait_for → false: агент внутри вызова инструмента, ввода не примет', () => {
    const waiting = [
      event('UserPromptSubmit', null, QUIET),
      startOf('a', { backgroundTasks: [task('a')] }, QUIET),
      hook('ParleyWaitStart', { waitTarget: 's-03' }, QUIET),
    ];

    // И в тишине, когда ожидание держит её само, а фоновые рядом, и сразу после запроса.
    const quiet = silent(waiting);
    expect(quiet.activity).toBe('working');
    expect(quiet.waitingFor).toBe('s-03');
    expect(quiet.heldByBackground).toBe(false);
    expect(
      activity([...waiting.slice(0, 2), hook('ParleyWaitStart', { waitTarget: 's-03' })])
        .heldByBackground,
    ).toBe(false);
  });

  it('blocked → false: вопрос человеку', () => {
    const result = activity([
      event('UserPromptSubmit'),
      hook('PermissionRequest', { backgroundTasks: [task('a')] }),
    ]);

    expect(result.activity).toBe('blocked');
    expect(result.heldByBackground).toBe(false);
  });

  it('фоновых нет → false: ход окончен (unseen, idle), идёт, события пусты или журнала нет', () => {
    expect(activity([event('UserPromptSubmit'), event('Stop')]).heldByBackground).toBe(false);
    expect(activity([event('UserPromptSubmit'), event('Stop')], true).heldByBackground).toBe(false);
    expect(activity([event('UserPromptSubmit')]).heldByBackground).toBe(false);
    expect(activity([]).heldByBackground).toBe(false);
    expect(activityOf({ events: null, now: NOW }).heldByBackground).toBe(false);
  });

  it('фоновые только в снимке завершённых и командах (не субагенты) → false: держать нечему', () => {
    const result = activity([
      event('UserPromptSubmit'),
      hook('Stop', {
        backgroundTasks: [task('done', { status: 'completed' }), task('sh', { type: 'shell' })],
      }),
    ]);

    expect(result.activity).toBe('unseen');
    expect(result.heldByBackground).toBe(false);
  });

  it('снимок опустел → false: ход окончен по-настоящему', () => {
    const result = activity([
      event('UserPromptSubmit'),
      startOf('a'),
      hook('Stop', { backgroundTasks: [task('a')] }),
      stopOf('a', { backgroundTasks: [] }),
    ]);

    expect(result.activity).toBe('unseen');
    expect(result.heldByBackground).toBe(false);
  });

  it('новый запрос при тех же фоновых → false, а его Stop снова → true', () => {
    const turn = [event('UserPromptSubmit'), hook('Stop', { backgroundTasks: [task('a')] })];
    expect(activity(turn).heldByBackground).toBe(true);

    const next = [...turn, event('UserPromptSubmit')];
    expect(activity(next).activity).toBe('working');
    expect(activity(next).heldByBackground).toBe(false);

    expect(activity([...next, event('Stop')]).heldByBackground).toBe(true);
  });

  it('ход неизвестен (журнал начался со снимка без начала хода) → false: стоит ли агент у приглашения, не знаем', () => {
    const result = activity([stopOf('чужой', { backgroundTasks: [task('a')] })]);

    expect(result.activity).toBe('working');
    expect(result.heldByBackground).toBe(false);
  });

  it('SessionStart сбрасывает флаг вместе с задачами', () => {
    const result = activity([
      hook('Stop', { backgroundTasks: [task('a')] }),
      event('SessionStart'),
    ]);

    // Ход был окончен до перезапуска, SessionStart его не открывает.
    expect(result.activity).toBe('unseen');
    expect(result.heldByBackground).toBe(false);
  });
});

describe('activityOf: отставший снимок не воскрешает остановленного субагента (Parley 0.2.0)', () => {
  const stoppedLead = (...tail: EventRecord[]): EventRecord[] => [
    event('UserPromptSubmit'),
    hook('Stop', { backgroundTasks: [task('a')] }),
    stopOf('a', { backgroundTasks: [task('a')] }),
    ...tail,
  ];

  it('SubagentStop(a), а следующее событие снова числит a работающей: задача остановлена', () => {
    const result = activity(
      stoppedLead(
        hook('Notification', { notificationType: 'idle_prompt', backgroundTasks: [task('a')] }),
      ),
    );

    expect(result.activity).toBe('unseen');
    expect(result.tasks).toEqual([]);
    expect(result.subagents).toBe(0);
    expect(result.heldByBackground).toBe(false);
  });

  it('и сколько бы позже ни пришло снимков с остановленным id: он вычищается из каждого', () => {
    const result = activity(
      stoppedLead(
        hook('Notification', { backgroundTasks: [task('a')] }),
        hook('Notification', { backgroundTasks: [task('a'), task('b')] }),
      ),
    );

    // Остановленная `a` не вернулась, а `b`, о которой журнал знает только по снимку, жива.
    expect(result.activity).toBe('working');
    expect(result.tasks.map((item) => item.id)).toEqual(['b']);
    expect(result.heldByBackground).toBe(true);
  });

  it('новый SubagentStart того же id возвращает задачу: её снова ведёт снимок', () => {
    const result = activity(
      stoppedLead(startOf('a'), hook('Notification', { backgroundTasks: [task('a')] })),
    );

    expect(result.activity).toBe('working');
    expect(result.tasks.map((item) => item.id)).toEqual(['a']);
  });

  it('SessionStart забывает остановленных: снимок самого события с тем же id принимается', () => {
    const result = activity(stoppedLead(hook('SessionStart', { backgroundTasks: [task('a')] })));

    expect(result.tasks.map((item) => item.id)).toEqual(['a']);
  });

  it('фоновый субагент в снимке SessionStart: сессию держит он, а не сам SessionStart', () => {
    const turn = [event('UserPromptSubmit'), event('Stop')];
    const resumed = hook('SessionStart', { source: 'resume', backgroundTasks: [task('a')] });

    const afterTurn = activity([...turn, resumed]);
    expect(afterTurn.activity).toBe('working');
    expect(afterTurn.heldByBackground).toBe(true);
    expect(afterTurn.tasks.map((item) => item.id)).toEqual(['a']);

    // Хода до старта не было: о приглашении агента ничего не известно, удержания нет.
    const fresh = activity([resumed]);
    expect(fresh.activity).toBe('working');
    expect(fresh.heldByBackground).toBe(false);

    // Тот же снимок без работающих задач: сессия просто idle.
    expect(activity([hook('SessionStart', { source: 'startup', backgroundTasks: [] })]).activity).toBe('idle');
  });

  it('чужая остановка (id, которого не стартовали) тоже запоминается и вычищает его из снимков', () => {
    const result = activity([
      event('UserPromptSubmit'),
      stopOf('чужой', { backgroundTasks: [] }),
      hook('Stop', { backgroundTasks: [task('чужой'), task('a')] }),
    ]);

    expect(result.tasks.map((item) => item.id)).toEqual(['a']);
  });
});

describe('activityOf: предел удержания — backgroundHoldMs (Parley 0.2.0)', () => {
  const MINUTE = 60_000;
  /** Время через `minutes` минут после `AT`: так задаётся «сейчас», а события остаются на месте. */
  const nowAfter = (minutes: number): number => Date.parse(AT) + minutes * MINUTE;
  const read = (
    events: EventRecord[],
    nowMs: number,
    extra: Partial<Parameters<typeof activityOf>[0]> = {},
  ): ReturnType<typeof activityOf> =>
    activityOf({ events, now: nowMs, silenceThresholdMs: 30_000, ...extra });
  const parked = [event('UserPromptSubmit'), hook('Stop', { backgroundTasks: [task('a')] })];

  it('по умолчанию час: до него фоновый субагент держит сессию, после — зомби, ход окончен', () => {
    const before = read(parked, nowAfter(59));
    expect(before.activity).toBe('working');
    expect(before.heldByBackground).toBe(true);

    const after = read(parked, nowAfter(61));
    expect(after.activity).toBe('unseen');
    expect(after.heldByBackground).toBe(false);
    expect(after.tasks).toEqual([]);
    // Ход кончился на самом Stop: больше ничего не случалось.
    expect(after.turnEndedAt).toBe(AT);
    expect(read(parked, nowAfter(61), { seen: true }).activity).toBe('idle');
  });

  it('предел задаётся параметром: короче — и удержание снимается раньше', () => {
    expect(read(parked, nowAfter(1), { backgroundHoldMs: 10 * MINUTE }).activity).toBe('working');
    expect(read(parked, nowAfter(11), { backgroundHoldMs: 10 * MINUTE }).activity).toBe('unseen');
  });

  it('родитель ещё работал, но молчит дольше предела: ход окончен по тишине, зомби не держит', () => {
    const running = [event('UserPromptSubmit'), startOf('a', { backgroundTasks: [task('a')] })];

    const quiet = read(running, nowAfter(61));
    expect(quiet.activity).toBe('unseen');
    expect(quiet.turnEndedAt).toBe(AT);
    expect(quiet.tasks).toEqual([]);
  });

  it('тишина считается от последнего события или записи лога родителя — что свежее', () => {
    const logAt = (minutes: number): ActivityLog => ({
      lastRecordAt: new Date(nowAfter(minutes)).toISOString(),
      lastUserRecordAt: null,
    });

    // События час назад, а запись лога шесть минут назад: удержание не истекло, родитель тихо стоит.
    const logged = read(parked, nowAfter(61), { log: logAt(55) });
    expect(logged.activity).toBe('working');
    expect(logged.heldByBackground).toBe(true);

    // Запись лога тоже старше предела — зомби: ход окончен, и источник — лог.
    const stale = read(parked, nowAfter(62), { log: logAt(1) });
    expect(stale.activity).toBe('unseen');
    expect(stale.source).toBe('log');
    expect(stale.turnEndedAt).toBe(new Date(nowAfter(1)).toISOString());

    // Родитель писал в транскрипт полминуты назад: он работает сам, держать нечем и не нужно.
    const fresh = read(parked, nowAfter(61), { log: logAt(60.5) });
    expect(fresh.activity).toBe('working');
    expect(fresh.heldByBackground).toBe(false);
  });

  it('вопрос человеку (blocked) предел не снимает', () => {
    const result = read(
      [event('UserPromptSubmit'), hook('PermissionRequest', { backgroundTasks: [task('a')] })],
      nowAfter(300),
    );

    expect(result.activity).toBe('blocked');
  });

  it('ожидание wait_for старше предела (вызов умер, конца нет) тоже не держит', () => {
    const waiting = [event('UserPromptSubmit'), hook('ParleyWaitStart', { waitTarget: 's-03' })];

    const live = read(waiting, nowAfter(20));
    expect(live.activity).toBe('working');
    expect(live.waitingFor).toBe('s-03');

    const dead = read(waiting, nowAfter(61));
    expect(dead.activity).toBe('unseen');
    expect(dead.waitingFor).toBeNull();
  });

  it('времени событий нет (не разобрать) — предел не срабатывает', () => {
    const result = activityOf({
      events: [
        { ...event('UserPromptSubmit'), at: 'не время' },
        { ...hook('Stop', { backgroundTasks: [task('a')] }), at: 'не время' },
      ],
      now: nowAfter(600),
    });

    expect(result.activity).toBe('working');
    expect(result.heldByBackground).toBe(true);
  });
});

describe('activityOf: конец хода после снятия удержания (Parley 0.2.0)', () => {
  const STOP_AT = '2026-09-05T10:00:01.000Z';
  const RELEASE_AT = '2026-09-05T10:00:08.000Z';
  const lead = [
    event('UserPromptSubmit', null, '2026-09-05T09:59:50.000Z'),
    hook('Stop', { backgroundTasks: [task('a')] }, STOP_AT),
  ];

  it('последний фоновый закончился (SubagentStop, снимок пуст): turnEndedAt — время этого события', () => {
    const held = activity(lead);
    expect(held.activity).toBe('working');
    expect(held.turnEndedAt).toBeNull();

    const released = activity([...lead, stopOf('a', { backgroundTasks: [] }, RELEASE_AT)]);
    expect(released.activity).toBe('unseen');
    // Человек, смотревший сессию, пока лид ждал, теперь снова получит unseen: его просмотр старше.
    expect(released.turnEndedAt).toBe(RELEASE_AT);
    expect(released.turnEndedAt).not.toBe(STOP_AT);
  });

  it('любое событие с пустым снимком снимает удержание и ставит конец хода на своё время', () => {
    const released = activity([...lead, hook('Notification', { backgroundTasks: [] }, RELEASE_AT)]);

    expect(released.activity).toBe('unseen');
    expect(released.turnEndedAt).toBe(RELEASE_AT);
  });

  it('снимок без работающих субагентов (завершены, не субагенты) — тоже снятие удержания', () => {
    const released = activity([
      ...lead,
      hook('Notification', { backgroundTasks: [task('a', { status: 'completed' })] }, RELEASE_AT),
    ]);

    expect(released.turnEndedAt).toBe(RELEASE_AT);
  });

  it('пока остался хоть один фоновый, удержание держится и конец хода не наступил', () => {
    const result = activity([
      event('UserPromptSubmit'),
      hook('Stop', { backgroundTasks: [task('a'), task('b')] }, STOP_AT),
      stopOf('a', { backgroundTasks: [task('b')] }, RELEASE_AT),
    ]);

    expect(result.activity).toBe('working');
    expect(result.turnEndedAt).toBeNull();
  });

  it('без удержания время конца хода прежнее — время Stop', () => {
    const result = activity([
      event('UserPromptSubmit'),
      hook('Stop', { backgroundTasks: [] }, STOP_AT),
      hook('Notification', { backgroundTasks: [] }, RELEASE_AT),
    ]);

    expect(result.turnEndedAt).toBe(STOP_AT);
  });

  it('удержание снято, когда родитель уже работает сам: хода как не было — turnEndedAt остаётся null', () => {
    const result = activity([
      ...lead,
      event('UserPromptSubmit', null, '2026-09-05T10:00:06.000Z'),
      stopOf('a', { backgroundTasks: [] }, RELEASE_AT),
    ]);

    expect(result.activity).toBe('working');
    expect(result.turnEndedAt).toBeNull();
  });
});

describe('activityOf: несколько ожиданий wait_for, у каждого свой id (Parley 0.2.0)', () => {
  const QUIET = '2026-09-05T09:58:00.000Z';
  const start = (id: string | null, target: string, at = AT): EventRecord =>
    hook('ParleyWaitStart', { waitTarget: target, waitId: id }, at);
  const end = (id: string | null, at = AT): EventRecord =>
    hook('ParleyWaitEnd', { waitId: id }, at);
  const turn = [event('UserPromptSubmit')];

  it('параллельные вызовы: первый закончился, второй идёт — waitingFor остаётся за вторым', () => {
    const both = [...turn, start('w1', 's-02'), start('w2', 's-03')];
    // Последнее из активных ожиданий.
    expect(activity(both).waitingFor).toBe('s-03');

    expect(activity([...both, end('w1')]).waitingFor).toBe('s-03');
    // Закончился второй — снова виден первый, он ещё идёт.
    expect(activity([...both, end('w2')]).waitingFor).toBe('s-02');
    expect(activity([...both, end('w1'), end('w2')]).waitingFor).toBeNull();
  });

  it('End без id (прежняя строка) снимает все ожидания — для совместимости', () => {
    const result = activity([...turn, start('w1', 's-02'), start('w2', 's-03'), end(null)]);

    expect(result.waitingFor).toBeNull();
  });

  it('поздний End брошенного (Esc) вызова не снимает новое ожидание', () => {
    const result = activity([
      ...turn,
      start('w1', 's-02'),
      // Человек прервал ход и начал новый: ожидание прежнего хода снято, а вызов ещё дойдёт до своего End.
      event('UserPromptSubmit'),
      start('w2', 'inbox'),
      end('w1'),
    ]);

    expect(result.waitingFor).toBe('inbox');
  });

  it('Start без id (прежняя строка): End чужого id его не снимает, End без id — снимает', () => {
    const waiting = [...turn, start(null, 's-02')];

    expect(activity([...waiting, end('чужой')]).waitingFor).toBe('s-02');
    expect(activity([...waiting, end(null)]).waitingFor).toBeNull();
  });

  it('повторный Start с тем же id заменяет цель, а не копит ожидания', () => {
    const result = activity([...turn, start('w1', 's-02'), start('w1', 's-03')]);

    expect(result.waitingFor).toBe('s-03');
    expect(
      activity([...turn, start('w1', 's-02'), start('w1', 's-03'), end('w1')]).waitingFor,
    ).toBeNull();
  });

  it('Stop, UserPromptSubmit, SessionStart и конец хода по idle_prompt снимают все ожидания', () => {
    const waiting = [...turn, start('w1', 's-02'), start('w2', 's-03')];

    for (const closing of [
      event('Stop'),
      event('UserPromptSubmit'),
      event('SessionStart'),
      event('Notification', 'idle_prompt'),
    ]) {
      expect(activity([...waiting, closing]).waitingFor, closing.name).toBeNull();
    }
  });

  it('пока осталось хоть одно ожидание, тишина сессию не понижает; когда последнее кончилось — понижает', () => {
    const read = (events: EventRecord[]): ReturnType<typeof activityOf> =>
      activityOf({ events, now: NOW, silenceThresholdMs: 30_000 });
    const waiting = [
      event('UserPromptSubmit', null, QUIET),
      start('w1', 's-02', QUIET),
      start('w2', 's-03', QUIET),
    ];

    const oneLeft = read([...waiting, end('w1', QUIET)]);
    expect(oneLeft.activity).toBe('working');
    expect(oneLeft.waitingFor).toBe('s-03');
    expect(oneLeft.heldByBackground).toBe(false);

    const none = read([...waiting, end('w1', QUIET), end('w2', '2026-09-05T09:58:30.000Z')]);
    expect(none.activity).toBe('unseen');
    expect(none.waitingFor).toBeNull();
  });
});

describe('activityOf: TerminalWorking — кадр спиннера терминала Codex (Parley 0.2.0)', () => {
  const frame = (at = AT): EventRecord => event(TERMINAL_WORKING_EVENT, null, at);

  it('начинает ход, как UserPromptSubmit: working, turnEndedAt сброшен', () => {
    expect(activity([frame()]).activity).toBe('working');

    const afterStop = activity([event('UserPromptSubmit'), event('Stop'), frame()]);
    expect(afterStop.activity).toBe('working');
    expect(afterStop.turnEndedAt).toBeNull();
  });

  it('ожидания wait_for не снимает: кадр новее ParleyWaitStart, но это не новый ход', () => {
    const waiting = [
      event('UserPromptSubmit'),
      hook('ParleyWaitStart', { waitTarget: 's-02', waitId: 'w1' }),
    ];

    expect(activity([...waiting, frame(), frame()]).waitingFor).toBe('s-02');
    // Настоящее начало хода по-прежнему снимает.
    expect(activity([...waiting, event('UserPromptSubmit')]).waitingFor).toBeNull();
    // И конец хода.
    expect(activity([...waiting, frame(), event('Stop')]).waitingFor).toBeNull();
  });

  it('ожидание и кадры вместе: сессия working, и тишина её не понижает', () => {
    const quiet = '2026-09-05T09:58:00.000Z';
    const result = activityOf({
      events: [
        frame(quiet),
        hook('ParleyWaitStart', { waitTarget: 'inbox', waitId: 'w1' }, quiet),
        frame(quiet),
      ],
      now: NOW,
      silenceThresholdMs: 30_000,
    });

    expect(result.activity).toBe('working');
    expect(result.waitingFor).toBe('inbox');
  });
});

// ---------------------------------------------------------------------------------------------
// need: чего сессия ждёт от человека (Застрявшие сессии, 3.1–3.3, 3.5)
// ---------------------------------------------------------------------------------------------

/** Секунда `n` (1–9) той же минуты, что `AT` и `NOW`: события растут по времени, до `NOW` — не больше девяти секунд. */
const sec = (n: number): string => `2026-09-05T10:00:0${n}.000Z`;

const SESSION_LIMIT = "You've hit your session limit · resets 2:50pm (Europe/Moscow)";
/** 14:50 по Москве (UTC+3 круглый год) в день записи — 11:50 UTC. */
const SESSION_RESET = '2026-09-05T11:50:00.000Z';
const SIGNED_OUT = 'Not logged in · Please run /login';

const submit = (n: number): EventRecord => event('UserPromptSubmit', null, sec(n));
const permission = (
  n: number,
  toolName: string | null,
  toolDetail: string | null = null,
): EventRecord => hook('PermissionRequest', { toolName, toolDetail }, sec(n));
const notice = (n: number, type: string, message: string | null = null): EventRecord =>
  hook('Notification', { notificationType: type, message }, sec(n));
/** `StopFailure`: текст ошибки — `last_assistant_message`, подробности — `error_details`. */
const failure = (
  n: number,
  error: string | null,
  text: string | null,
  details: string | null = null,
): EventRecord =>
  hook('StopFailure', { error, lastAssistantMessage: text, errorDetails: details }, sec(n));

/** Ожидаемая потребность: поля, которых тест не называет, пусты. */
const wanted = (kind: NeedKind, n: number, patch: Partial<SessionNeed> = {}): SessionNeed => ({
  kind,
  since: sec(n),
  detail: null,
  resetsAt: null,
  window: null,
  account: null,
  ...patch,
});

/** Лог с ошибкой API на секунде `n`: она — последняя запись работы, человек писал раньше. */
const apiErrorLog = (
  n: number,
  error: string | null,
  text: string,
  patch: Partial<ActivityLog> = {},
): ActivityLog => ({
  lastRecordAt: sec(n),
  lastUserRecordAt: sec(1),
  lastApiError: { at: sec(n), error, text },
  ...patch,
});

/** Лог с ошибкой API в произвольный момент `at`: тоже последняя запись работы, человек писал на секунде 1. */
const apiErrorLogAt = (at: string, error: string | null, text: string): ActivityLog => ({
  lastRecordAt: at,
  lastUserRecordAt: sec(1),
  lastApiError: { at, error, text },
});

/** Одна строка таблицы: что подали свёртке и что она должна сказать про активность и `need`. */
interface NeedCase {
  name: string;
  events: EventRecord[] | null;
  log?: ActivityLog;
  seen?: boolean;
  /** «Сейчас» в мс; по умолчанию — `NOW`. */
  now?: number;
  activity: Activity;
  need: SessionNeed | null;
}

const fold = (row: NeedCase, seen = row.seen ?? false): ReturnType<typeof activityOf> =>
  activityOf({ events: row.events, log: row.log ?? null, seen, now: row.now ?? NOW });

const expectCase = (row: NeedCase): void => {
  const result = fold(row);
  expect(result.activity).toBe(row.activity);
  expect(result.need).toEqual(row.need);
};

/** Источники ожидания человека: одобрение, вопрос, старт (3.2). */
const SOURCE_CASES: NeedCase[] = [
  {
    name: 'PermissionRequest Bash → approval, detail — команда',
    events: [submit(1), permission(2, 'Bash', 'npm install')],
    activity: 'blocked',
    need: wanted('approval', 2, { detail: 'npm install' }),
  },
  {
    name: 'PermissionRequest без выжимки tool_input → approval, detail — имя инструмента',
    events: [submit(1), permission(2, 'WebFetch')],
    activity: 'blocked',
    need: wanted('approval', 2, { detail: 'WebFetch' }),
  },
  {
    name: 'PermissionRequest без tool_name → approval без detail',
    events: [submit(1), permission(2, null)],
    activity: 'blocked',
    need: wanted('approval', 2),
  },
  {
    name: 'permission_prompt → approval, detail — message',
    events: [submit(1), notice(2, 'permission_prompt', 'Claude needs your permission to use Bash')],
    activity: 'blocked',
    need: wanted('approval', 2, { detail: 'Claude needs your permission to use Bash' }),
  },
  {
    name: 'agent_needs_input → question, detail — message',
    events: [submit(1), notice(2, 'agent_needs_input', 'Which database?')],
    activity: 'blocked',
    need: wanted('question', 2, { detail: 'Which database?' }),
  },
  {
    name: 'elicitation_dialog → question, detail — message',
    events: [submit(1), notice(2, 'elicitation_dialog', 'Pick a region')],
    activity: 'blocked',
    need: wanted('question', 2, { detail: 'Pick a region' }),
  },
  {
    name: 'elicitation_url_dialog → question, detail — message',
    events: [submit(1), notice(2, 'elicitation_url_dialog', 'Open the link to sign in')],
    activity: 'blocked',
    need: wanted('question', 2, { detail: 'Open the link to sign in' }),
  },
  {
    name: 'Notification без message → question без detail',
    events: [submit(1), notice(2, 'agent_needs_input')],
    activity: 'blocked',
    need: wanted('question', 2),
  },
  {
    name: 'parley_startup → startup без detail, сессия blocked, хода не было',
    events: [notice(2, PARLEY_STARTUP_NOTIFICATION)],
    activity: 'blocked',
    need: wanted('startup', 2),
  },
  {
    name: 'parley_startup после закончившего ход → blocked, startup',
    events: [submit(1), event('Stop', null, sec(2)), notice(3, PARLEY_STARTUP_NOTIFICATION)],
    activity: 'blocked',
    need: wanted('startup', 3),
  },
  {
    name: 'длинный message обрезается до NEED_DETAIL_MAX знаков',
    events: [submit(1), notice(2, 'agent_needs_input', 'q'.repeat(300))],
    activity: 'blocked',
    need: wanted('question', 2, { detail: `${'q'.repeat(NEED_DETAIL_MAX - 1)}…` }),
  },
  {
    name: 'переводы строк в message сводятся к пробелам',
    events: [submit(1), notice(2, 'agent_needs_input', 'Which\ndatabase?')],
    activity: 'blocked',
    need: wanted('question', 2, { detail: 'Which database?' }),
  },
];

/** Ошибка API оборвала ход: лимит и слетевший вход (3.2). */
const LIMIT_CASES: NeedCase[] = [
  {
    name: 'StopFailure rate_limit с «resets» в тексте → limit, resetsAt и window из текста, ход окончен',
    events: [submit(1), failure(3, 'rate_limit', SESSION_LIMIT)],
    activity: 'unseen',
    need: wanted('limit', 3, { detail: SESSION_LIMIT, resetsAt: SESSION_RESET, window: 'session' }),
  },
  {
    name: 'тот же лимит у просмотренной сессии → idle, need тот же',
    events: [submit(1), failure(3, 'rate_limit', SESSION_LIMIT)],
    seen: true,
    activity: 'idle',
    need: wanted('limit', 3, { detail: SESSION_LIMIT, resetsAt: SESSION_RESET, window: 'session' }),
  },
  {
    name: 'недельный лимит с датой → resetsAt в этот день, window week',
    events: [
      submit(1),
      failure(
        3,
        'rate_limit',
        "You've hit your weekly limit · resets Sep 22 at 4pm (Europe/Moscow)",
      ),
    ],
    activity: 'unseen',
    need: wanted('limit', 3, {
      detail: "You've hit your weekly limit · resets Sep 22 at 4pm (Europe/Moscow)",
      resetsAt: '2026-09-22T13:00:00.000Z',
      window: 'week',
    }),
  },
  {
    name: 'лимит без времени в тексте → resetsAt и window null',
    events: [submit(1), failure(3, 'rate_limit', 'API Error: Rate limit reached')],
    activity: 'unseen',
    need: wanted('limit', 3, { detail: 'API Error: Rate limit reached' }),
  },
  {
    name: 'лимит GLM: время по Пекину, окно пять часов',
    events: [
      submit(1),
      failure(
        3,
        'rate_limit',
        '[1308][Usage limit reached for 5 hour. Your limit will reset at 2026-10-08 19:03:01]',
      ),
    ],
    activity: 'unseen',
    need: wanted('limit', 3, {
      detail:
        '[1308][Usage limit reached for 5 hour. Your limit will reset at 2026-10-08 19:03:01]',
      resetsAt: '2026-10-08T11:03:01.000Z',
      window: 'session',
    }),
  },
  {
    name: 'нет last_assistant_message → текст берётся из error_details',
    events: [
      submit(1),
      failure(3, 'rate_limit', null, '429 Too Many Requests · resets 7pm (Europe/Moscow)'),
    ],
    activity: 'unseen',
    need: wanted('limit', 3, {
      detail: '429 Too Many Requests · resets 7pm (Europe/Moscow)',
      resetsAt: '2026-09-05T16:00:00.000Z',
    }),
  },
  {
    name: 'last_assistant_message важнее error_details',
    events: [submit(1), failure(3, 'rate_limit', SESSION_LIMIT, '429 Too Many Requests')],
    activity: 'unseen',
    need: wanted('limit', 3, { detail: SESSION_LIMIT, resetsAt: SESSION_RESET, window: 'session' }),
  },
  {
    name: 'лимит без текста → limit без detail и resetsAt',
    events: [submit(1), failure(3, 'rate_limit', null)],
    activity: 'unseen',
    need: wanted('limit', 3),
  },
  {
    name: 'длинный текст: detail обрезан, а время сброса берётся из полного текста',
    events: [
      submit(1),
      failure(3, 'rate_limit', `${'x'.repeat(300)} · resets 2:50pm (Europe/Moscow)`),
    ],
    activity: 'unseen',
    need: wanted('limit', 3, {
      detail: `${'x'.repeat(NEED_DETAIL_MAX - 1)}…`,
      resetsAt: SESSION_RESET,
    }),
  },
  {
    name: 'authentication_failed → sign-in, account auth',
    events: [submit(1), failure(3, 'authentication_failed', SIGNED_OUT)],
    activity: 'unseen',
    need: wanted('sign-in', 3, { detail: SIGNED_OUT, account: 'auth' }),
  },
  {
    name: 'oauth_org_not_allowed → sign-in, account auth',
    events: [submit(1), failure(3, 'oauth_org_not_allowed', 'This organization is not allowed')],
    activity: 'unseen',
    need: wanted('sign-in', 3, { detail: 'This organization is not allowed', account: 'auth' }),
  },
  {
    name: 'billing_error → sign-in, account account',
    events: [submit(1), failure(3, 'billing_error', 'Your credit balance is too low')],
    activity: 'unseen',
    need: wanted('sign-in', 3, { detail: 'Your credit balance is too low', account: 'account' }),
  },
  {
    name: 'account_on_hold → sign-in, account account; время сброса у sign-in не берётся',
    events: [
      submit(1),
      failure(3, 'account_on_hold', 'Account on hold · resets 2:50pm (Europe/Moscow)'),
    ],
    activity: 'unseen',
    need: wanted('sign-in', 3, {
      detail: 'Account on hold · resets 2:50pm (Europe/Moscow)',
      account: 'account',
    }),
  },
  {
    name: 'server_error → ход окончен, need нет',
    events: [submit(1), failure(3, 'server_error', 'API Error: 500')],
    activity: 'unseen',
    need: null,
  },
  {
    name: 'StopFailure без поля error → ход окончен, need нет',
    events: [submit(1), failure(3, null, 'API Error')],
    activity: 'unseen',
    need: null,
  },
  {
    name: 'лимит, а сессию держит живой фоновый субагент → working, need нет',
    events: [
      submit(1),
      startOf('a', {}, sec(2)),
      hook(
        'StopFailure',
        { error: 'rate_limit', lastAssistantMessage: SESSION_LIMIT, backgroundTasks: [task('a')] },
        sec(3),
      ),
    ],
    activity: 'working',
    need: null,
  },
];

/** Запасной путь: ошибка API только в логе сессии (3.2). */
const LIMIT_IN_LOG: NeedCase = {
  name: 'лимит в логе, журнал пуст → limit, ход окончен на записи ошибки',
  events: [],
  log: apiErrorLog(5, 'rate_limit', SESSION_LIMIT),
  activity: 'unseen',
  need: wanted('limit', 5, { detail: SESSION_LIMIT, resetsAt: SESSION_RESET, window: 'session' }),
};

const FALLBACK_CASES: NeedCase[] = [
  LIMIT_IN_LOG,
  {
    name: 'лимит в логе, журнала событий нет вовсе → то же',
    events: null,
    log: apiErrorLog(5, 'rate_limit', SESSION_LIMIT),
    activity: 'unseen',
    need: wanted('limit', 5, { detail: SESSION_LIMIT, resetsAt: SESSION_RESET, window: 'session' }),
  },
  {
    name: 'лимит в логе, журнал старше ошибки → limit',
    events: [submit(1)],
    log: apiErrorLog(5, 'rate_limit', SESSION_LIMIT),
    activity: 'unseen',
    need: wanted('limit', 5, { detail: SESSION_LIMIT, resetsAt: SESSION_RESET, window: 'session' }),
  },
  {
    name: 'вход в логе: authentication_failed → sign-in, account auth',
    events: [submit(1)],
    log: apiErrorLog(5, 'authentication_failed', SIGNED_OUT),
    activity: 'unseen',
    need: wanted('sign-in', 5, { detail: SIGNED_OUT, account: 'auth' }),
  },
  {
    name: 'оплата в логе: billing_error → sign-in, account account',
    events: [submit(1)],
    log: apiErrorLog(5, 'billing_error', 'Your credit balance is too low'),
    activity: 'unseen',
    need: wanted('sign-in', 5, { detail: 'Your credit balance is too low', account: 'account' }),
  },
  {
    name: 'ошибка без лимита и входа (server_error) в логе → ход окончен, need нет',
    events: [submit(1)],
    log: apiErrorLog(5, 'server_error', 'API Error: 500'),
    activity: 'unseen',
    need: null,
  },
  {
    name: 'ошибка в логе без поля error → ход окончен, need нет',
    events: [submit(1)],
    log: apiErrorLog(5, null, 'API Error'),
    activity: 'unseen',
    need: null,
  },
  {
    name: 'в журнале событие новее ошибки → запасного пути нет, ход идёт',
    events: [submit(6)],
    log: apiErrorLog(5, 'rate_limit', SESSION_LIMIT),
    activity: 'working',
    need: null,
  },
  {
    name: 'событие журнала в тот же момент, что и ошибка → запасного пути нет',
    events: [submit(5)],
    log: apiErrorLog(5, 'rate_limit', SESSION_LIMIT),
    activity: 'working',
    need: null,
  },
  {
    name: 'ассистент писал после ошибки (продолжил сам) → запасного пути нет',
    events: [submit(1)],
    log: apiErrorLog(5, 'rate_limit', SESSION_LIMIT, { lastRecordAt: sec(7) }),
    activity: 'working',
    need: null,
  },
  {
    name: 'человек написал после ошибки → запасного пути нет',
    events: [submit(1)],
    log: apiErrorLog(5, 'rate_limit', SESSION_LIMIT, {
      lastRecordAt: sec(6),
      lastUserRecordAt: sec(6),
    }),
    activity: 'working',
    need: null,
  },
  {
    name: 'запись человека новее ошибки решает сама, даже когда lastRecordAt её не видит',
    events: [submit(1)],
    log: apiErrorLog(5, 'rate_limit', SESSION_LIMIT, {
      lastRecordAt: null,
      lastUserRecordAt: sec(6),
    }),
    activity: 'working',
    need: null,
  },
  {
    name: 'ход blocked по журналу → запасной путь молчит, остаётся approval',
    events: [submit(1), permission(2, 'Bash', 'ls')],
    log: apiErrorLog(5, 'rate_limit', SESSION_LIMIT),
    activity: 'blocked',
    need: wanted('approval', 2, { detail: 'ls' }),
  },
];

/** Лимит в логе на секунде 3: ожидаемое состояние, пока после записи не началась новая работа. */
const LIMIT_AT_3 = wanted('limit', 3, {
  detail: SESSION_LIMIT,
  resetsAt: SESSION_RESET,
  window: 'session',
});

/** События журнала после записи ошибки, которые работу заново не начинают: запасной путь действует (3.2). */
const PASSIVE_AFTER: Array<[name: string, event: EventRecord]> = [
  ['Stop', event('Stop', null, sec(6))],
  ['SessionEnd', event('SessionEnd', null, sec(6))],
  ['SubagentStop', hook('SubagentStop', { agentId: 'a' }, sec(6))],
  ['ParleyWaitStart', hook('ParleyWaitStart', { waitTarget: 's-02', waitId: 'w1' }, sec(6))],
  ['ParleyWaitEnd', hook('ParleyWaitEnd', { waitId: 'w1' }, sec(6))],
  ['idle_prompt', notice(6, 'idle_prompt')],
  ['auth_success', notice(6, 'auth_success')],
];

/** Ошибка на секунде 3, `Stop` сразу за ней, а через минуту — `idle_prompt` старого Claude Code без `StopFailure`. */
const STOP_THEN_IDLE: NeedCase = {
  name: 'ошибка в логе, затем Stop и через минуту idle_prompt → limit остаётся',
  events: [
    submit(1),
    event('Stop', null, sec(4)),
    hook('Notification', { notificationType: 'idle_prompt' }, '2026-09-05T10:01:05.000Z'),
  ],
  log: apiErrorLog(3, 'rate_limit', SESSION_LIMIT),
  now: Date.parse('2026-09-05T10:01:10.000Z'),
  activity: 'unseen',
  need: LIMIT_AT_3,
};

const PASSIVE_AFTER_CASES: NeedCase[] = [
  ...PASSIVE_AFTER.map(([name, next]): NeedCase => ({
    name: `ошибка в логе, затем ${name} → limit остаётся, ход окончен на записи ошибки`,
    events: [submit(1), next],
    log: apiErrorLog(3, 'rate_limit', SESSION_LIMIT),
    activity: 'unseen',
    need: LIMIT_AT_3,
  })),
  STOP_THEN_IDLE,
  {
    ...STOP_THEN_IDLE,
    name: 'то же у просмотренной сессии → idle, limit остаётся',
    seen: true,
    activity: 'idle',
  },
];

/** События журнала после записи ошибки, которые работу начинают заново: запасной путь молчит (3.2). */
const RESTARTING_AFTER_CASES: NeedCase[] = (
  [
    ['UserPromptSubmit', submit(6), 'working', null],
    ['SessionStart(resume)', hook('SessionStart', { source: 'resume' }, sec(6)), 'unseen', null],
    ['SessionStart(compact)', hook('SessionStart', { source: 'compact' }, sec(6)), 'working', null],
    ['SubagentStart', hook('SubagentStart', { agentId: 'a' }, sec(6)), 'working', null],
    ['кадр спиннера Codex', event(TERMINAL_WORKING_EVENT, null, sec(6)), 'working', null],
    ['quota_auto_resume_fired', notice(6, 'quota_auto_resume_fired'), 'working', null],
    ['elicitation_complete', notice(6, 'elicitation_complete'), 'working', null],
    [
      'PermissionRequest',
      permission(6, 'Bash', 'ls'),
      'blocked',
      wanted('approval', 6, { detail: 'ls' }),
    ],
    [
      'agent_needs_input',
      notice(6, 'agent_needs_input', 'Which?'),
      'blocked',
      wanted('question', 6, { detail: 'Which?' }),
    ],
    ['parley_startup', notice(6, PARLEY_STARTUP_NOTIFICATION), 'blocked', wanted('startup', 6)],
  ] as Array<[string, EventRecord, Activity, SessionNeed | null]>
).map(([name, next, activity, need]): NeedCase => ({
  name: `ошибка в логе, затем ${name} → запасного пути нет`,
  events: [submit(1), next],
  log: apiErrorLog(3, 'rate_limit', SESSION_LIMIT),
  activity,
  need,
}));

/** Журнал: ход и его `StopFailure` лимита на секунде 3 (`LIMIT_AT_3`). */
const JOURNAL_LIMIT = [submit(1), failure(3, 'rate_limit', SESSION_LIMIT)];

const BEFORE_FAILURE = '2026-09-05T10:00:02.600Z'; // запись лога на 0,4 с раньше события журнала
const AFTER_FAILURE = '2026-09-05T10:00:03.400Z'; // на 0,4 с позже
const LATER_FAILURE = '2026-09-05T10:00:07.000Z'; // на 4 с позже: журнал о втором ударе не знает

/** `StopFailure` в журнале главнее ошибки в логе: эпизод и конец хода — по событию журнала (3.2). */
const JOURNAL_FAILURE_CASES: NeedCase[] = [
  ...(
    [
      ['на 0,4 с раньше события', BEFORE_FAILURE],
      ['в тот же момент', sec(3)],
      ['на 0,4 с позже события', AFTER_FAILURE],
      ['на 4 с позже события', LATER_FAILURE],
    ] as Array<[string, string]>
  ).map(([when, at]): NeedCase => ({
    name: `StopFailure в журнале, запись ошибки в логе ${when} → эпизод по событию журнала`,
    events: JOURNAL_LIMIT,
    log: apiErrorLogAt(at, 'rate_limit', SESSION_LIMIT),
    activity: 'unseen',
    need: LIMIT_AT_3,
  })),
  {
    name: 'журнал: server_error, лог: rate_limit позже → решает журнал, need нет',
    events: [submit(1), failure(3, 'server_error', 'API Error: 500')],
    log: apiErrorLogAt(AFTER_FAILURE, 'rate_limit', SESSION_LIMIT),
    activity: 'unseen',
    need: null,
  },
  {
    name: 'журнал: rate_limit, лог: authentication_failed позже → решает журнал',
    events: JOURNAL_LIMIT,
    log: apiErrorLogAt(AFTER_FAILURE, 'authentication_failed', SIGNED_OUT),
    activity: 'unseen',
    need: LIMIT_AT_3,
  },
  {
    name: 'журнал: StopFailure, а в логе после ошибки писал ассистент → ход идёт, need снят',
    events: JOURNAL_LIMIT,
    log: apiErrorLog(3, 'rate_limit', SESSION_LIMIT, { lastRecordAt: sec(6) }),
    activity: 'working',
    need: null,
  },
  {
    name: 'StopFailure прошлого хода, а в новом ходу ошибка только в логе → запасной путь',
    events: [submit(1), failure(2, 'server_error', 'API Error: 500'), submit(4)],
    log: apiErrorLog(5, 'rate_limit', SESSION_LIMIT),
    activity: 'unseen',
    need: wanted('limit', 5, { detail: SESSION_LIMIT, resetsAt: SESSION_RESET, window: 'session' }),
  },
];

/** Заготовки для снятия: у каждой вида `need` своё начало на секунде 3. */
interface Base {
  label: string;
  events: EventRecord[];
  need: SessionNeed;
  /** Активность при этом `need`: стоящий ход — `blocked`, окончивший — `unseen`. */
  activity: Activity;
}

const LIMIT: Base = {
  label: 'limit',
  events: [submit(1), failure(3, 'rate_limit', SESSION_LIMIT)],
  need: wanted('limit', 3, { detail: SESSION_LIMIT, resetsAt: SESSION_RESET, window: 'session' }),
  activity: 'unseen',
};
const SIGN_IN: Base = {
  label: 'sign-in',
  events: [submit(1), failure(3, 'authentication_failed', SIGNED_OUT)],
  need: wanted('sign-in', 3, { detail: SIGNED_OUT, account: 'auth' }),
  activity: 'unseen',
};
const APPROVAL: Base = {
  label: 'approval',
  events: [submit(1), permission(3, 'Bash', 'npm install')],
  need: wanted('approval', 3, { detail: 'npm install' }),
  activity: 'blocked',
};
const QUESTION: Base = {
  label: 'question',
  events: [submit(1), notice(3, 'agent_needs_input', 'Which database?')],
  need: wanted('question', 3, { detail: 'Which database?' }),
  activity: 'blocked',
};
const ENDED_BASES = [LIMIT, SIGN_IN];
const BLOCKED_BASES = [APPROVAL, QUESTION];
const BASES = [...ENDED_BASES, ...BLOCKED_BASES];

type Next = [name: string, event: EventRecord];

/** Начало хода и ответ на форму снимают любой вид (3.3). */
const STARTS: Next[] = [
  ['UserPromptSubmit', submit(4)],
  ['кадр спиннера Codex', event(TERMINAL_WORKING_EVENT, null, sec(4))],
  ['quota_auto_resume_fired', notice(4, 'quota_auto_resume_fired')],
  ['elicitation_complete', notice(4, 'elicitation_complete')],
  ['elicitation_response', notice(4, 'elicitation_response')],
];

/** Запуск процесса: `startup`, `resume`, `clear` и SessionStart без поля. */
const LAUNCHES: Next[] = [
  ['SessionStart(startup)', hook('SessionStart', { source: 'startup' }, sec(4))],
  ['SessionStart(resume)', hook('SessionStart', { source: 'resume' }, sec(4))],
  ['SessionStart(clear)', hook('SessionStart', { source: 'clear' }, sec(4))],
  ['SessionStart без source', event('SessionStart', null, sec(4))],
];

/** `idle_prompt` и сжатие контекста: ни лимит, ни вход, ни вопрос человеку они не снимают. */
const QUIET: Next[] = [
  ['idle_prompt', notice(4, 'idle_prompt')],
  ['SessionStart(compact)', hook('SessionStart', { source: 'compact' }, sec(4))],
];

const STOP: Next = ['Stop', event('Stop', null, sec(4))];

const CLEARING_CASES: NeedCase[] = BASES.flatMap((base) => [
  ...STARTS.map(([name, next]): NeedCase => ({
    name: `${base.label}, затем ${name} → working, need снят`,
    events: [...base.events, next],
    activity: 'working',
    need: null,
  })),
  ...LAUNCHES.map(([name, next]): NeedCase => ({
    name: `${base.label}, затем ${name} → ход окончен, need снят`,
    events: [...base.events, next],
    activity: 'unseen',
    need: null,
  })),
]);

const KEEPING_CASES: NeedCase[] = [
  // Лимит и вход переживают то, чем ход и так кончился: Stop, idle_prompt и Ready Codex (он приходит как Stop).
  ...ENDED_BASES.flatMap((base) =>
    [STOP, ...QUIET].flatMap(([name, next]): NeedCase[] => [
      {
        name: `${base.label}, затем ${name} → need остаётся`,
        events: [...base.events, next],
        activity: 'unseen',
        need: base.need,
      },
      {
        name: `${base.label}, затем ${name}, сессия просмотрена → idle, need остаётся`,
        events: [...base.events, next],
        seen: true,
        activity: 'idle',
        need: base.need,
      },
    ]),
  ),
  // Вопрос человеку простой и сжатие не отменяют; `auth_success` — не про него.
  ...BLOCKED_BASES.flatMap((base) =>
    [...QUIET, ['auth_success', notice(4, 'auth_success')] as Next].map(
      ([name, next]): NeedCase => ({
        name: `${base.label}, затем ${name} → blocked, need остаётся`,
        events: [...base.events, next],
        activity: 'blocked',
        need: base.need,
      }),
    ),
  ),
  // Stop заканчивает ход, и ждать человека больше нечего.
  ...BLOCKED_BASES.map((base): NeedCase => ({
    name: `${base.label}, затем Stop → ход окончен, need снят`,
    events: [...base.events, STOP[1]],
    activity: 'unseen',
    need: null,
  })),
  // `auth_success` снимает только вход.
  {
    name: 'sign-in, затем auth_success → вход выполнен, need снят, ход по-прежнему окончен',
    events: [...SIGN_IN.events, notice(4, 'auth_success')],
    activity: 'unseen',
    need: null,
  },
  {
    name: 'limit, затем auth_success → limit остаётся',
    events: [...LIMIT.events, notice(4, 'auth_success')],
    activity: 'unseen',
    need: LIMIT.need,
  },
];

/** Запись человека в логе новее событий снимает любой вид, старая — нет (3.3). */
const LOG_CASES: NeedCase[] = BASES.flatMap((base): NeedCase[] => [
  {
    name: `${base.label}, затем запись человека в логе новее событий → working, need снят`,
    events: base.events,
    log: { lastRecordAt: sec(6), lastUserRecordAt: sec(6) },
    activity: 'working',
    need: null,
  },
  {
    name: `${base.label}, запись человека в логе старше событий → need остаётся`,
    events: base.events,
    log: { lastRecordAt: sec(2), lastUserRecordAt: sec(2) },
    activity: base.activity,
    need: base.need,
  },
]);

/** Новая ошибка или новый вопрос заменяет прежнее, если между ними ничего не сняло. */
const REPLACING_CASES: NeedCase[] = [
  {
    name: 'лимит, затем StopFailure входа → sign-in со своим since',
    events: [...LIMIT.events, failure(5, 'authentication_failed', SIGNED_OUT)],
    activity: 'unseen',
    need: wanted('sign-in', 5, { detail: SIGNED_OUT, account: 'auth' }),
  },
  {
    name: 'лимит, затем повторный StopFailure лимита → since и время сброса по последнему',
    events: [
      ...LIMIT.events,
      failure(
        5,
        'rate_limit',
        "You've hit your weekly limit · resets Sep 22 at 4pm (Europe/Moscow)",
      ),
    ],
    activity: 'unseen',
    need: wanted('limit', 5, {
      detail: "You've hit your weekly limit · resets Sep 22 at 4pm (Europe/Moscow)",
      resetsAt: '2026-09-22T13:00:00.000Z',
      window: 'week',
    }),
  },
  {
    name: 'лимит, затем StopFailure без need (server_error) → лимит снят: ход кончился другой ошибкой',
    events: [...LIMIT.events, failure(5, 'server_error', 'API Error: 500')],
    activity: 'unseen',
    need: null,
  },
  {
    name: 'лимит, затем Claude продолжил сам и просит одобрение → approval со своим since',
    events: [...LIMIT.events, permission(5, 'Bash', 'ls')],
    activity: 'blocked',
    need: wanted('approval', 5, { detail: 'ls' }),
  },
  {
    name: 'одобрение, затем StopFailure лимита → одобрение снято, limit',
    events: [...APPROVAL.events, failure(4, 'rate_limit', SESSION_LIMIT)],
    activity: 'unseen',
    need: wanted('limit', 4, { detail: SESSION_LIMIT, resetsAt: SESSION_RESET, window: 'session' }),
  },
];

/** Через 40 с после записи лога на секунде 6 — дольше порога тишины (30 с). */
const SILENT = Date.parse(sec(6)) + 40_000;

/** Пассивные события журнала на секунде 9, позже записи лога на секунде 6: они ход не начинают. */
const PASSIVE_AT_9: Next[] = [
  ['idle_prompt', notice(9, 'idle_prompt')],
  ['Stop', event('Stop', null, sec(9))],
  ['SubagentStop', hook('SubagentStop', { agentId: 'a' }, sec(9))],
  ['ParleyWaitEnd', hook('ParleyWaitEnd', { waitId: 'w1' }, sec(9))],
  ['SessionEnd', event('SessionEnd', null, sec(9))],
];

/** Снятое не возвращается: ни новым концом хода, ни тишиной, когда ход продолжил лог (3.3). */
const RESURFACING_CASES: NeedCase[] = [
  ...BASES.flatMap((base): NeedCase[] => [
    {
      name: `${base.label}, затем новый ход и его Stop → need не возвращается`,
      events: [...base.events, submit(4), event('Stop', null, sec(5))],
      activity: 'unseen',
      need: null,
    },
    {
      name: `${base.label}, затем запись человека в логе и тишина → ход окончен по тишине, need не возвращается`,
      events: base.events,
      log: { lastRecordAt: sec(6), lastUserRecordAt: sec(6) },
      now: SILENT,
      activity: 'unseen',
      need: null,
    },
  ]),
  ...ENDED_BASES.map((base): NeedCase => ({
    name: `${base.label}, затем запись ассистента новее событий (продолжил сам) и тишина → need не возвращается`,
    events: base.events,
    log: { lastRecordAt: sec(6), lastUserRecordAt: sec(1) },
    now: SILENT,
    activity: 'unseen',
    need: null,
  })),
  {
    name: 'limit, затем Claude продолжил сам (quota_auto_resume_fired) и закончил ход → need не возвращается',
    events: [...LIMIT.events, notice(4, 'quota_auto_resume_fired'), event('Stop', null, sec(5))],
    activity: 'unseen',
    need: null,
  },
  {
    name: 'sign-in, затем auth_success и Stop → need не возвращается',
    events: [...SIGN_IN.events, notice(4, 'auth_success'), event('Stop', null, sec(5))],
    activity: 'unseen',
    need: null,
  },
  // Запись лога новее начала эпизода снимает лимит и вход насовсем: пассивное событие журнала, дописанное после неё,
  // их не возвращает — снятие считается от начала эпизода, а не от последнего события любого вида.
  ...ENDED_BASES.flatMap((base) =>
    (
      [
        ['запись человека', { lastRecordAt: sec(6), lastUserRecordAt: sec(6) }],
        ['запись ассистента', { lastRecordAt: sec(6), lastUserRecordAt: sec(1) }],
      ] as Array<[string, ActivityLog]>
    ).flatMap(([who, log]) =>
      PASSIVE_AT_9.map(([name, next]): NeedCase => ({
        name: `${base.label}, ${who} в логе на секунде 6, затем ${name} на секунде 9 → need не возвращается`,
        events: [...base.events, next],
        log,
        activity: 'unseen',
        need: null,
      })),
    ),
  ),
];

/** «Конкретнее — сильнее» и границы эпизода (3.2, 3.5). */
const STRENGTH_CASES: NeedCase[] = [
  {
    name: 'approval, затем question → approval, since и detail первого',
    events: [
      submit(1),
      permission(2, 'Bash', 'npm install'),
      notice(3, 'agent_needs_input', 'Which database?'),
    ],
    activity: 'blocked',
    need: wanted('approval', 2, { detail: 'npm install' }),
  },
  {
    name: 'question, затем approval (permission_prompt) → approval, since первого, detail нового',
    events: [
      submit(1),
      notice(2, 'agent_needs_input', 'Which database?'),
      notice(3, 'permission_prompt', 'Claude needs your permission'),
    ],
    activity: 'blocked',
    need: wanted('approval', 2, { detail: 'Claude needs your permission' }),
  },
  {
    name: 'question, затем PermissionRequest → approval, since первого',
    events: [
      submit(1),
      notice(2, 'elicitation_dialog', 'Which database?'),
      permission(3, 'Bash', 'npm install'),
    ],
    activity: 'blocked',
    need: wanted('approval', 2, { detail: 'npm install' }),
  },
  {
    name: 'question, затем approval без detail → approval без detail, а не текст вопроса',
    events: [
      submit(1),
      notice(2, 'agent_needs_input', 'Which database?'),
      notice(3, 'permission_prompt'),
    ],
    activity: 'blocked',
    need: wanted('approval', 2),
  },
  {
    name: 'PermissionRequest и через 6 с его permission_prompt → один эпизод, detail из PermissionRequest',
    events: [
      submit(1),
      permission(2, 'Bash', 'npm install'),
      notice(8, 'permission_prompt', 'Claude needs your permission'),
    ],
    activity: 'blocked',
    need: wanted('approval', 2, { detail: 'npm install' }),
  },
  {
    name: 'повторный permission_prompt → тот же эпизод',
    events: [
      submit(1),
      notice(2, 'permission_prompt', 'first'),
      notice(3, 'permission_prompt', 'second'),
    ],
    activity: 'blocked',
    need: wanted('approval', 2, { detail: 'first' }),
  },
  {
    name: 'второй PermissionRequest за идущим одобрением — новое окно разрешения: since и detail новые',
    events: [submit(1), permission(2, 'Bash', 'npm install'), permission(5, 'Bash', 'npm test')],
    activity: 'blocked',
    need: wanted('approval', 5, { detail: 'npm test' }),
  },
  {
    name: 'startup, затем question → question, since первого',
    events: [
      notice(2, PARLEY_STARTUP_NOTIFICATION),
      notice(3, 'agent_needs_input', 'Which database?'),
    ],
    activity: 'blocked',
    need: wanted('question', 2, { detail: 'Which database?' }),
  },
  {
    name: 'question, затем startup → question остаётся',
    events: [
      notice(2, 'agent_needs_input', 'Which database?'),
      notice(3, PARLEY_STARTUP_NOTIFICATION),
    ],
    activity: 'blocked',
    need: wanted('question', 2, { detail: 'Which database?' }),
  },
  {
    name: 'ответ и новое одобрение → новый эпизод со своим since',
    events: [submit(1), permission(2, 'Bash', 'ls'), submit(3), permission(4, 'Bash', 'pwd')],
    activity: 'blocked',
    need: wanted('approval', 4, { detail: 'pwd' }),
  },
  {
    name: 'Stop и новое одобрение → новый эпизод со своим since',
    events: [
      submit(1),
      permission(2, 'Bash', 'ls'),
      event('Stop', null, sec(3)),
      permission(4, 'Bash', 'pwd'),
    ],
    activity: 'blocked',
    need: wanted('approval', 4, { detail: 'pwd' }),
  },
];

describe('activityOf: need — одобрение, вопрос, старт (3.2)', () => {
  it.each(SOURCE_CASES)('$name', expectCase);

  it('имя внутреннего уведомления хоста о старте — parley_startup', () => {
    expect(PARLEY_STARTUP_NOTIFICATION).toBe('parley_startup');
  });

  it('Notification с именем из прототипа объекта (constructor, toString) — неизвестное событие, а не вопрос', () => {
    for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const result = activity([submit(1), notice(2, type, 'text')]);
      expect(result.activity).toBe('working');
      expect(result.need).toBeNull();
    }
  });
});

describe('activityOf: need — ошибка API оборвала ход (3.2)', () => {
  it.each(LIMIT_CASES)('$name', expectCase);

  it('StopFailure заканчивает ход в момент события: turnEndedAt — его время, источник — журнал', () => {
    const result = activity([submit(1), failure(3, 'rate_limit', SESSION_LIMIT)]);
    expect(result.turnEndedAt).toBe(sec(3));
    expect(result.source).toBe('hooks');
    expect(result.lastEventAt).toBe(sec(3));
  });

  it('StopFailure без need тоже заканчивает ход', () => {
    const result = activity([submit(1), failure(3, 'server_error', 'API Error: 500')]);
    expect(result.activity).toBe('unseen');
    expect(result.turnEndedAt).toBe(sec(3));
  });

  it('текст Codex без пояса читается по часам машины: пояс свёртка не подставляет', () => {
    const text =
      "You've hit your usage limit. Visit settings to purchase more credits or try again at Oct 14th, 2026 7:27 PM.";
    const result = activity([submit(1), failure(3, 'rate_limit', text)]);
    // Ожидание строится конструктором `Date` по местным часам — тот же пояс, что у `Intl` по умолчанию.
    expect(result.need?.resetsAt).toBe(new Date(2026, 9, 14, 19, 27).toISOString());
    expect(result.need?.window).toBeNull();
  });
});

describe('activityOf: need — запасной путь по ошибке API в логе (3.2)', () => {
  it.each(FALLBACK_CASES)('$name', expectCase);
  it.each(PASSIVE_AFTER_CASES)('$name', expectCase);
  it.each(RESTARTING_AFTER_CASES)('$name', expectCase);
  it.each(JOURNAL_FAILURE_CASES)('$name', expectCase);

  it('после Stop и idle_prompt ход всё равно окончен на самой записи ошибки, а не на простое', () => {
    const result = fold(STOP_THEN_IDLE);
    expect(result.turnEndedAt).toBe(sec(3));
    expect(result.source).toBe('log');
    expect(result.lastEventAt).toBe('2026-09-05T10:01:05.000Z');
  });

  it('старый CLI: в журнале нет StopFailure — эпизод и конец хода по записи лога, ход окончен на ней', () => {
    const result = activityOf({
      events: [submit(1), event('Stop', null, sec(4))],
      log: apiErrorLogAt(AFTER_FAILURE, 'rate_limit', SESSION_LIMIT),
      now: NOW,
    });
    expect(result.need?.since).toBe(AFTER_FAILURE);
    expect(result.turnEndedAt).toBe(AFTER_FAILURE);
    expect(result.source).toBe('log');
  });

  it('StopFailure в журнале: запись ошибки в логе ничего не меняет — ни раньше события, ни позже, ни вовсе', () => {
    const journalOnly = activityOf({ events: JOURNAL_LIMIT, now: NOW });
    expect(journalOnly.need).toEqual(LIMIT_AT_3);
    expect(journalOnly.turnEndedAt).toBe(sec(3));
    expect(journalOnly.source).toBe('hooks');
    for (const at of [BEFORE_FAILURE, sec(3), AFTER_FAILURE, LATER_FAILURE]) {
      const log = apiErrorLogAt(at, 'rate_limit', SESSION_LIMIT);
      expect(activityOf({ events: JOURNAL_LIMIT, log, now: NOW })).toEqual(journalOnly);
    }
  });

  it('журнал и лог доходят в любом порядке: как только StopFailure в журнале, время эпизода — его', () => {
    for (const at of [BEFORE_FAILURE, AFTER_FAILURE]) {
      const log = apiErrorLogAt(at, 'rate_limit', SESSION_LIMIT);
      // Лог раньше журнала: события о конце хода ещё нет, и эпизод открывает запись ошибки.
      expect(activityOf({ events: [submit(1)], log, now: NOW }).need?.since).toBe(at);
      // Журнал дописан — эпизод по его событию, а результат тот же, что у журнала без лога.
      const both = activityOf({ events: JOURNAL_LIMIT, log, now: NOW });
      expect(both.need).toEqual(LIMIT_AT_3);
      expect(both).toEqual(activityOf({ events: JOURNAL_LIMIT, now: NOW }));
    }
  });

  it('ход окончен на самой записи, а не по тишине; источник — лог', () => {
    const result = fold(LIMIT_IN_LOG);
    expect(result.turnEndedAt).toBe(sec(5));
    expect(result.source).toBe('log');
    expect(result.lastEventAt).toBeNull();
    // Та же запись без отметки об ошибке API — обычный ответ ассистента: сессия работает до порога тишины.
    const plain = activityOf({
      events: [],
      log: { lastRecordAt: sec(5), lastUserRecordAt: sec(1) },
      now: NOW,
    });
    expect(plain.activity).toBe('working');
    expect(plain.need).toBeNull();
  });

  it('без журнала событий поднят флаг hooksMissing, а need выведен', () => {
    const result = activityOf({
      events: null,
      log: apiErrorLog(5, 'rate_limit', SESSION_LIMIT),
      now: NOW,
    });
    expect(result.hooksMissing).toBe(true);
    expect(result.need?.kind).toBe('limit');
  });

  it('время сброса считается от времени записи ошибки, а не от «сейчас»', () => {
    // Запись в 23:50 по Москве, «resets 1am (Europe/Moscow)» — ближайший час ночи по Москве, а не сегодняшний.
    const text = "You've hit your session limit · resets 1am (Europe/Moscow)";
    const at = '2026-09-05T20:50:00.000Z';
    const result = activityOf({
      events: [],
      log: {
        lastRecordAt: at,
        lastUserRecordAt: null,
        lastApiError: { at, error: 'rate_limit', text },
      },
      now: Date.parse(at) + 5_000,
    });
    expect(result.need?.since).toBe(at);
    expect(result.need?.resetsAt).toBe('2026-09-05T22:00:00.000Z');
  });

  it('первое чтение журнала даёт всем строкам одно время (mtime файла): ошибку лога запасной путь не восстановит', () => {
    // Ограничение принято (решение контролёра). При первом чтении журнала — а это случается после перезапуска хоста —
    // у всех строк одно `at`, mtime файла, и строка о начале хода выглядит новее ошибки в логе, поэтому свёртка не
    // отличает ход, закончившийся ошибкой, от обычного. Процессы агентов перезапуск хоста не переживают: сессии
    // становятся спящими, `need` у спящей `null` и так (3.1), а `stuck` в карте служба «застрял» снимает молча (6.3).
    const same = sec(9);
    const idle = hook('Notification', { notificationType: 'idle_prompt' }, same);
    const log = apiErrorLog(3, 'rate_limit', SESSION_LIMIT);

    const firstRead = activityOf({
      events: [event('UserPromptSubmit', null, same), idle],
      log,
      now: NOW,
    });
    expect(firstRead.activity).toBe('unseen');
    expect(firstRead.need).toBeNull();

    // Те же строки с настоящим временем (ход начался до ошибки): лимит выведен. Теряется он только от общего времени.
    const liveRead = activityOf({ events: [submit(1), idle], log, now: NOW });
    expect(liveRead.need).toEqual(LIMIT_AT_3);
  });
});

describe('activityOf: need — снятие (3.3)', () => {
  it.each(CLEARING_CASES)('$name', expectCase);
  it.each(KEEPING_CASES)('$name', expectCase);
  it.each(LOG_CASES)('$name', expectCase);
  it.each(REPLACING_CASES)('$name', expectCase);
  it.each(RESURFACING_CASES)('$name', expectCase);

  it('порядок строк — порядок файла: запись лога новее последней строки, но старше начала эпизода, лимит всё равно снимает', () => {
    // Строки идут не по времени: `Stop` на секунде 2 дописан после `StopFailure` на секунде 5. Запись лога на секунде 3
    // новее последней строки журнала — сессия работает, — и по тишине ход кончается без возвращённого лимита.
    const result = activityOf({
      events: [submit(1), failure(5, 'rate_limit', SESSION_LIMIT), event('Stop', null, sec(2))],
      log: { lastRecordAt: sec(3), lastUserRecordAt: sec(3) },
      now: Date.parse(sec(3)) + 40_000,
    });
    expect(result.activity).toBe('unseen');
    expect(result.need).toBeNull();
  });
});

describe('activityOf: need — конкретнее сильнее, эпизод (3.2, 3.5)', () => {
  it.each(STRENGTH_CASES)('$name', expectCase);
});

describe('activityOf: need — инвариант вида и хода (3.1)', () => {
  const BLOCKING_KINDS: NeedKind[] = ['approval', 'question', 'startup'];
  const ENDED_KINDS: NeedKind[] = ['limit', 'sign-in'];

  /**
   * Нарушение инварианта в состоянии: `blocked` всегда с видом из тройки, а `need` у остальных — только вида из
   * пары при оконченном ходе (`unseen`, `idle`). `null` — всё в порядке.
   */
  const violation = (result: ReturnType<typeof activityOf>): string | null => {
    const kind = result.need?.kind;
    if (result.activity === 'blocked') {
      return kind !== undefined && BLOCKING_KINDS.includes(kind)
        ? null
        : `blocked с need ${String(kind)}`;
    }
    if (kind === undefined) return null;
    const ended = result.activity === 'unseen' || result.activity === 'idle';
    return ended && ENDED_KINDS.includes(kind) ? null : `${result.activity} с need ${kind}`;
  };

  const TABLE = [
    ...SOURCE_CASES,
    ...LIMIT_CASES,
    ...FALLBACK_CASES,
    ...PASSIVE_AFTER_CASES,
    ...RESTARTING_AFTER_CASES,
    ...JOURNAL_FAILURE_CASES,
    ...CLEARING_CASES,
    ...KEEPING_CASES,
    ...LOG_CASES,
    ...REPLACING_CASES,
    ...RESURFACING_CASES,
    ...STRENGTH_CASES,
  ];

  it('для всех случаев таблиц: need !== null ⇒ (blocked и вид из тройки) или (unseen/idle и вид из пары)', () => {
    const bad = TABLE.flatMap((row) =>
      [false, true].map((seen) => ({ row, seen, why: violation(fold(row, seen)) })),
    )
      .filter(({ why }) => why !== null)
      .map(({ row, seen, why }) => `${row.name} (seen=${String(seen)}): ${String(why)}`);
    expect(TABLE.length).toBeGreaterThan(100);
    expect(bad).toEqual([]);
  });

  const ALPHABET: Array<[name: string, make: (n: number) => EventRecord]> = [
    ['UserPromptSubmit', submit],
    ['PermissionRequest', (n) => permission(n, 'Bash', 'ls')],
    ['permission_prompt', (n) => notice(n, 'permission_prompt', 'Allow?')],
    ['agent_needs_input', (n) => notice(n, 'agent_needs_input', 'Which?')],
    ['parley_startup', (n) => notice(n, PARLEY_STARTUP_NOTIFICATION)],
    ['elicitation_complete', (n) => notice(n, 'elicitation_complete')],
    ['quota_auto_resume_fired', (n) => notice(n, 'quota_auto_resume_fired')],
    ['auth_success', (n) => notice(n, 'auth_success')],
    ['idle_prompt', (n) => notice(n, 'idle_prompt')],
    ['Stop', (n) => event('Stop', null, sec(n))],
    ['SessionEnd', (n) => event('SessionEnd', null, sec(n))],
    ['SubagentStop', (n) => hook('SubagentStop', { agentId: 'a' }, sec(n))],
    ['StopFailure(rate_limit)', (n) => failure(n, 'rate_limit', SESSION_LIMIT)],
    ['StopFailure(authentication_failed)', (n) => failure(n, 'authentication_failed', SIGNED_OUT)],
    ['StopFailure(server_error)', (n) => failure(n, 'server_error', 'API Error: 500')],
    ['SessionStart(resume)', (n) => hook('SessionStart', { source: 'resume' }, sec(n))],
    ['SessionStart(compact)', (n) => hook('SessionStart', { source: 'compact' }, sec(n))],
    ['TerminalWorking', (n) => event(TERMINAL_WORKING_EVENT, null, sec(n))],
  ];

  /** Все последовательности из 1–`depth` событий алфавита, номера по алфавиту. */
  function* sequences(depth: number, prefix: number[] = []): Generator<number[]> {
    if (prefix.length > 0) yield prefix;
    if (prefix.length === depth) return;
    for (let index = 0; index < ALPHABET.length; index += 1)
      yield* sequences(depth, [...prefix, index]);
  }

  it('для всех последовательностей до трёх событий — с ошибкой API в логе и без, просмотренных и нет', () => {
    // Ошибка в логе новее всех событий (секунда 5) и посередине последовательности (секунда 2).
    const logs: Array<ActivityLog | null> = [
      null,
      apiErrorLog(5, 'rate_limit', SESSION_LIMIT),
      apiErrorLog(2, 'rate_limit', SESSION_LIMIT),
    ];
    const bad: string[] = [];
    let count = 0;
    for (const indexes of sequences(3)) {
      const names = indexes.map((index) => ALPHABET[index]?.[0] ?? '?').join(' → ');
      const events = indexes.map(
        (index, position) => ALPHABET[index]?.[1](position + 1) ?? submit(1),
      );
      for (const log of logs) {
        for (const seen of [false, true]) {
          count += 1;
          const why = violation(activityOf({ events, log, seen, now: NOW }));
          if (why !== null) {
            bad.push(
              `${names}${log === null ? '' : ' + ошибка в логе'}, seen=${String(seen)}: ${why}`,
            );
          }
        }
      }
    }
    expect(count).toBeGreaterThan(10_000);
    expect(bad).toEqual([]);
  });

  it('пассивное событие журнала не возвращает снятые лимит и вход: для всех последовательностей до двух событий', () => {
    // Снятое состояние не должно зависеть от того, что журнал дописали после записи лога: `Stop`, простой, остановка
    // субагента, конец ожидания, выход. (Одобрение и вопрос сюда не входят: у них прежнее правило «запись человека
    // новее последнего события», и оно сравнивается с последним событием любого вида.)
    const passive: Array<[string, EventRecord]> = [
      ['Stop', event('Stop', null, sec(9))],
      ['idle_prompt', notice(9, 'idle_prompt')],
      ['SubagentStop', hook('SubagentStop', { agentId: 'a' }, sec(9))],
      ['ParleyWaitStart', hook('ParleyWaitStart', { waitTarget: 's-02', waitId: 'w1' }, sec(9))],
      ['ParleyWaitEnd', hook('ParleyWaitEnd', { waitId: 'w1' }, sec(9))],
      ['SessionEnd', event('SessionEnd', null, sec(9))],
    ];
    const logs: Array<[string, ActivityLog | null]> = [
      ['без лога', null],
      ['запись человека на секунде 6', { lastRecordAt: sec(6), lastUserRecordAt: sec(6) }],
      ['запись ассистента на секунде 6', { lastRecordAt: sec(6), lastUserRecordAt: sec(1) }],
      ['ошибка API на секунде 5', apiErrorLog(5, 'rate_limit', SESSION_LIMIT)],
      ['ошибка API на секунде 2', apiErrorLog(2, 'rate_limit', SESSION_LIMIT)],
    ];
    const bad: string[] = [];
    let count = 0;
    for (const indexes of sequences(2)) {
      const names = indexes.map((index) => ALPHABET[index]?.[0] ?? '?').join(' → ');
      const events = indexes.map(
        (index, position) => ALPHABET[index]?.[1](position + 1) ?? submit(1),
      );
      for (const [logName, log] of logs) {
        if (activityOf({ events, log, now: NOW }).need !== null) continue;
        for (const [name, next] of passive) {
          count += 1;
          const kind = activityOf({ events: [...events, next], log, now: NOW }).need?.kind;
          if (kind === 'limit' || kind === 'sign-in') {
            bad.push(`${names} (${logName}) + ${name}: появился ${kind}`);
          }
        }
      }
    }
    expect(count).toBeGreaterThan(3_000);
    expect(bad).toEqual([]);
  });
});
