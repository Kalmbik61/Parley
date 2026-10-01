/**
 * Чек-лист приёмки TUI v2, пункты 1–10: таблица переходов 4.2 и страховка 4.3.
 * По одному `it` на строку таблицы — свёртка чистая, никакого диска здесь нет.
 * Субагенты по id, снимок фоновых задач и ожидание `wait_for` — в конце файла (Parley 0.2.0).
 */

import { describe, expect, it } from 'vitest';
import { activityOf, hookedSince, type ActivityLog } from './activity.js';
import { bareEvent, type BackgroundTask, type EventRecord } from './events.js';

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

  it('SessionStart с любым startup_type → working', () => {
    expect(activity([event('SessionStart')]).activity).toBe('working');
    expect(activity([event('SessionStart')]).source).toBe('hooks');
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
    expect(reset.activity).toBe('working');
    expect(reset.tasks).toEqual([]);
    expect(reset.subagents).toBe(0);
    expect(reset.waitingFor).toBeNull();

    const withOwn = activity([...before, hook('SessionStart', { backgroundTasks: [task('b')] })]);
    expect(withOwn.tasks.map((item) => item.id)).toEqual(['b']);
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

    expect(result.activity).toBe('working');
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
