/**
 * Вторая ось состояния сессии — чем занят живой агент (дизайн TUI v2, раздел 4).
 * В карту не пишется: её выводят читатели по журналу хуков (4.2) и, как
 * страховка, по логу провайдера (4.3).
 *
 * Функция чистая: весь диск остаётся в `events.ts` и `metrics.ts`.
 */

import { DEFAULT_CONFIG } from '../config.js';
import type { EventRecord } from './events.js';

export type Activity = 'working' | 'blocked' | 'unseen' | 'idle';

/** Чем выведено состояние: журналом хуков, страховкой по логу или ничем. */
export type ActivitySource = 'hooks' | 'log' | 'none';

/** Что страховке известно про лог провайдера (`LiveSessionMetrics`). */
export interface ActivityLog {
  /** Время последней записи лога; `null` — записей нет. */
  lastRecordAt: string | null;
  /**
   * Время последней записи ПОЛЬЗОВАТЕЛЯ в логе; `null` — таких записей нет.
   * Только она снимает `blocked` со стороны страховки (раздел 4.3).
   */
  lastUserRecordAt: string | null;
}

export interface SessionActivity {
  activity: Activity;
  /** Живые субагенты: `SubagentStart` минус `SubagentStop`, не ниже нуля. */
  subagents: number;
  /** Когда закончился ход; `null` — агент работает или ход не начинался. */
  turnEndedAt: string | null;
  lastEventAt: string | null;
  source: ActivitySource;
  /** В журнале был `SessionEnd`: жизненный цикл меняет вызывающий, не мы. */
  exited: boolean;
  /** Каталога `events/` нет — работает одна страховка, нужно предупреждение. */
  hooksMissing: boolean;
}

/** `Notification`, после которых агент ждёт человека. */
const BLOCKING = new Set([
  'permission_prompt',
  'agent_needs_input',
  'elicitation_dialog',
  'elicitation_url_dialog',
]);

/** `Notification`, которыми ожидание закончилось и агент снова работает. */
const RESUMING = new Set(['elicitation_complete', 'elicitation_response']);

/** Ход: агент работает, ждёт человека или закончил. `null` — ничего не известно. */
type Phase = 'working' | 'blocked' | 'ended';

/** Время оси в миллисекундах; `NaN` — оси нет или её время не разобрать. */
const msOf = (value: string | null): number => (value === null ? Number.NaN : Date.parse(value));

/** Ось `a` свежее оси `b`; ось без времени не свежее ничего, но её и не обгоняют. */
const isNewer = (a: number, b: number): boolean => !Number.isNaN(a) && (Number.isNaN(b) || a > b);

export interface ActivityOptions {
  /** События журнала в порядке файла; `null` — журнала нет (`hooksMissing`). */
  events?: readonly EventRecord[] | null;
  log?: ActivityLog | null;
  /** Пользователь уже подключался к панели после конца хода. */
  seen?: boolean;
  now?: number;
  silenceThresholdMs?: number;
}

/**
 * Свёртка журнала и лога в состояние. Порядок переходов — порядок строк файла,
 * а не их timestamps: журнал пишет один процесс подряд, и его порядок точнее
 * часов. Неизвестные события пропускаются молча.
 */
export function activityOf({
  events = null,
  log = null,
  seen = false,
  now = Date.now(),
  silenceThresholdMs = DEFAULT_CONFIG.silenceThresholdMs,
}: ActivityOptions = {}): SessionActivity {
  let phase: Phase | null = null;
  let source: ActivitySource = 'none';
  let subagents = 0;
  let turnEndedAt: string | null = null;
  let lastEventAt: string | null = null;
  let exited = false;

  const start = (): void => {
    phase = 'working';
    turnEndedAt = null;
    source = 'hooks';
  };
  const end = (at: string): void => {
    phase = 'ended';
    turnEndedAt = at;
    source = 'hooks';
  };

  for (const event of events ?? []) {
    lastEventAt = event.at;
    switch (event.name) {
      case 'UserPromptSubmit':
      case 'SessionStart':
        start();
        break;
      case 'PermissionRequest':
        phase = 'blocked';
        source = 'hooks';
        break;
      case 'Notification': {
        const type = event.notificationType ?? '';
        if (BLOCKING.has(type)) {
          phase = 'blocked';
          source = 'hooks';
        } else if (RESUMING.has(type)) {
          start();
        } else if (type === 'idle_prompt' && phase !== 'blocked') {
          // Простой не отменяет вопроса пользователю: blocked снимает только
          // ответ на него или новый промпт.
          end(event.at);
        }
        break;
      }
      case 'Stop':
        end(event.at);
        break;
      case 'SubagentStart':
        subagents += 1;
        break;
      case 'SubagentStop':
        subagents = Math.max(0, subagents - 1);
        break;
      case 'SessionEnd':
        exited = true;
        break;
      default:
        // Прочие хуки состояние не меняют.
        break;
    }
  }

  // Страховка по логу (4.3). Из записей лога `blocked` снимает только запись
  // ПОЛЬЗОВАТЕЛЯ: пока агент ждёт ответа, с его стороны в транскрипт не пишется
  // ничего, а появившаяся запись значит, что разрешение выдано и ход продолжился
  // (хука «разрешение выдано» в наборе 4.2 нет).
  const lastRecordAt = log?.lastRecordAt ?? null;
  const recordAt = msOf(lastRecordAt);
  const eventAt = msOf(lastEventAt);
  const userAt = msOf(log?.lastUserRecordAt ?? null);

  if (phase === 'blocked' && isNewer(userAt, eventAt)) {
    phase = 'working';
    turnEndedAt = null;
    source = 'log';
  }

  if (phase !== 'blocked') {
    const recordIsNewer = isNewer(recordAt, eventAt);
    if (recordIsNewer) {
      phase = 'working';
      turnEndedAt = null;
      source = 'log';
    }
    // Тишину считаем от последнего события любой оси, а не только лога: свежий
    // хук значит, что агент жив, пока длинный инструмент или субагент ничего не
    // пишут в транскрипт, и понижать выведенный хуками `working` нельзя. Оси без
    // записей лога это тоже касается: агент, убитый без `SessionEnd`, иначе
    // остался бы `working` навсегда.
    const quietAt = recordIsNewer ? recordAt : eventAt;
    if (phase === 'working' && !Number.isNaN(quietAt) && now - quietAt > silenceThresholdMs) {
      phase = 'ended';
      turnEndedAt = recordIsNewer ? lastRecordAt : lastEventAt;
      // Источник — та ось, чьё время решило: лога может не быть вовсе.
      source = recordIsNewer ? 'log' : source;
    }
  }

  const ended: Activity = seen ? 'idle' : 'unseen';
  return {
    // Ничего не известно — состояние тусклое: после перезапуска харнесса все
    // закончившие ход сессии считаются просмотренными (раздел 4.1).
    activity: phase === null ? 'idle' : phase === 'ended' ? ended : phase,
    subagents,
    turnEndedAt,
    lastEventAt,
    source,
    exited,
    hooksMissing: events === null,
  };
}

/**
 * Были ли события хуков с момента `sinceMs` — старта процесса агента (fix-final-b, спека 8.6).
 * Ни одного — хост не знает, что у агента на экране: на вопросе доверия к папке Claude Code
 * хуков не шлёт, и активность такой сессии `idle`. Печать с Enter туда подтвердила бы диалог —
 * автоответ, запрещённый рамкой (15.1). Время события — mtime журнала, он не раньше самой
 * записи, а последнее событие — самое позднее: достаточно сравнить его.
 */
export function hookedSince(
  activity: Pick<SessionActivity, 'lastEventAt'> | null | undefined,
  sinceMs: number,
): boolean {
  const at = msOf(activity?.lastEventAt ?? null);
  return !Number.isNaN(at) && at >= sinceMs;
}
