/**
 * Чек-лист приёмки TUI v2, пункты 1–10: таблица переходов 4.2 и страховка 4.3.
 * По одному `it` на строку таблицы — свёртка чистая, никакого диска здесь нет.
 */

import { describe, expect, it } from 'vitest';
import { activityOf, type ActivityLog } from './activity.js';
import type { EventRecord } from './events.js';

const AT = '2026-09-05T10:00:00.000Z';
const NOW = Date.parse('2026-09-05T10:00:10.000Z');

const event = (name: string, notificationType: string | null = null, at = AT): EventRecord => ({
  at,
  name,
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

  // Пункт 6.
  it('SubagentStart и SubagentStop считают живых субагентов, не уходя ниже нуля', () => {
    expect(activity([event('SubagentStart'), event('SubagentStart')]).subagents).toBe(2);
    expect(activity([event('SubagentStart'), event('SubagentStop')]).subagents).toBe(0);
    expect(activity([event('SubagentStop')]).subagents).toBe(0);
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
        event('SubagentStart', null, '2026-09-05T10:00:09.000Z'),
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
