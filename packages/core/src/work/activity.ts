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

  // Страховка по логу. `blocked` она не снимает: вопрос пользователю виден
  // только хукам, а лог продолжает расти и без ответа на него.
  const lastRecordAt = log?.lastRecordAt ?? null;
  const recordAt = lastRecordAt === null ? Number.NaN : Date.parse(lastRecordAt);
  if (phase !== 'blocked' && !Number.isNaN(recordAt)) {
    const eventAt = lastEventAt === null ? Number.NaN : Date.parse(lastEventAt);
    const recordIsNewer = Number.isNaN(eventAt) || recordAt > eventAt;
    if (recordIsNewer) {
      phase = 'working';
      turnEndedAt = null;
      source = 'log';
    }
    // Тишину считаем от последнего события любой оси, а не только лога: свежий
    // хук значит, что агент жив, пока длинный инструмент или субагент ничего не
    // пишут в транскрипт, и понижать выведенный хуками `working` нельзя.
    const quietAt = recordIsNewer ? recordAt : eventAt;
    if (phase === 'working' && now - quietAt > silenceThresholdMs) {
      phase = 'ended';
      turnEndedAt = recordIsNewer ? lastRecordAt : lastEventAt;
      source = 'log';
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
