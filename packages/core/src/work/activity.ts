/**
 * Вторая ось состояния сессии — чем занят живой агент (дизайн TUI v2, раздел 4).
 * В карту не пишется: её выводят читатели по журналу хуков (4.2) и, как
 * страховка, по логу провайдера (4.3).
 *
 * Субагенты считаются по id: `SubagentStart` заводит, `SubagentStop` снимает, а чужая
 * остановка — служебные помощники Claude Code шлют их десятками без старта — не снимает
 * ничего. Обычный субагент ход родителя не переживает. Фоновые живут дольше: Claude Code
 * кладёт снимок `background_tasks` в каждый хук, и пока в последнем снимке есть
 * работающий субагент, сессия `working`, даже когда ход родителя окончен, а правило
 * тишины её не понижает. Родитель при этом стоит у своего приглашения и ввод принимает:
 * `heldByBackground` отличает такую сессию от работающей сама — будильнику это важно.
 * Ожидание `wait_for` приходит своими строками журнала (`ParleyWaitStart`, `ParleyWaitEnd`,
 * их дописывает MCP-сервер сессии): пока оно идёт, сессия занята — агент внутри вызова
 * инструмента, — а тишина её тоже не понижает.
 *
 * Удержание не вечно: если ни событий хуков, ни записей лога родителя нет дольше
 * `backgroundHoldMs` (час), фоновый субагент и ожидание считаются зомби — удержание снято, ход
 * окончен.
 *
 * Функция чистая: весь диск остаётся в `events.ts` и `metrics.ts`.
 */

import { DEFAULT_CONFIG } from '../config.js';
import type { BackgroundTask, EventRecord } from './events.js';

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

/** Живой субагент сессии: что о нём известно журналу. */
export interface ActivityTask {
  id: string;
  /** `general-purpose`…; `null` — ни снимок, ни `SubagentStart` типа не назвали. */
  agentType: string | null;
  /** Короткое описание из снимка; `null` — снимок его не знает, хост ищет в `meta.json`. */
  description: string | null;
  /** Фоновый: есть в последнем снимке `background_tasks` и живёт после конца хода родителя. */
  background: boolean;
  /**
   * `transcript_path` родителя из `SubagentStart`: рядом с ним лежит
   * `<без .jsonl>/subagents/agent-<id>.meta.json`. `null` — старта не видели.
   */
  transcriptPath: string | null;
}

export interface SessionActivity {
  activity: Activity;
  /** Живые субагенты — `tasks.length`. */
  subagents: number;
  /** Живые субагенты: по id, обычные и фоновые; пуст, когда ход окончен и фоновых нет. */
  tasks: ActivityTask[];
  /** На что сейчас ждёт `wait_for`: id сессии или `inbox`; `null` — не ждёт. */
  waitingFor: string | null;
  /**
   * `working` выставлено ТОЛЬКО удержанием фоновых субагентов: ход родителя окончен (`Stop`,
   * `idle_prompt` или тишина), а в снимке есть работающие. Родитель стоит у своего приглашения и
   * ввод принимает. `false` — агент работает сам, ждёт в `wait_for`, `blocked`, ход не окончен
   * или о конце хода ничего не известно, либо сессия вовсе не `working`.
   */
  heldByBackground: boolean;
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

/** Субагент, о старте которого сказал `SubagentStart`. */
interface StartedAgent {
  agentType: string | null;
  transcriptPath: string | null;
}

/**
 * Работающий субагент снимка. Другие виды задач (фоновая команда, сервер разработки)
 * сессию не держат: иначе `npm run dev` в фоне оставил бы её `working` навсегда.
 */
const isRunningSubagent = (task: BackgroundTask): boolean =>
  task.type === 'subagent' && task.status === 'running';

/**
 * Живые субагенты: стартовавшие (в порядке старта) и работающие из снимка, о чьём старте
 * журнал не знает. Описание и тип берутся из снимка, если они там есть.
 */
function tasksOf(
  started: ReadonlyMap<string, StartedAgent>,
  background: readonly BackgroundTask[],
): ActivityTask[] {
  const tasks: ActivityTask[] = [];
  for (const [id, agent] of started) {
    const listed = background.find((task) => task.id === id);
    tasks.push({
      id,
      agentType: listed?.agentType ?? agent.agentType,
      description: listed?.description ?? null,
      background: listed !== undefined,
      transcriptPath: agent.transcriptPath,
    });
  }
  for (const listed of background) {
    if (started.has(listed.id)) continue;
    tasks.push({
      id: listed.id,
      agentType: listed.agentType,
      description: listed.description,
      background: true,
      transcriptPath: null,
    });
  }
  return tasks;
}

/**
 * Предел удержания по умолчанию — час. Дольше фоновый субагент или `wait_for` (их предел — полчаса)
 * молчать не могут: от зомби — убитого без `SubagentStop` субагента, умершего MCP-сервера — иначе
 * сессия оставалась бы `working` навсегда, а тишина при удержании не действует.
 */
export const DEFAULT_BACKGROUND_HOLD_MS = 60 * 60 * 1000;

export interface ActivityOptions {
  /** События журнала в порядке файла; `null` — журнала нет (`hooksMissing`). */
  events?: readonly EventRecord[] | null;
  log?: ActivityLog | null;
  /** Пользователь уже подключался к панели после конца хода. */
  seen?: boolean;
  now?: number;
  silenceThresholdMs?: number;
  /** Сколько фоновый субагент или ожидание держат сессию без единого события и записи лога. */
  backgroundHoldMs?: number;
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
  backgroundHoldMs = DEFAULT_BACKGROUND_HOLD_MS,
}: ActivityOptions = {}): SessionActivity {
  let phase: Phase | null = null;
  let source: ActivitySource = 'none';
  let turnEndedAt: string | null = null;
  let lastEventAt: string | null = null;
  let exited = false;
  const started = new Map<string, StartedAgent>();
  // Работающие субагенты из последнего снимка `background_tasks` — те, что живут и
  // после конца хода родителя. Событие без поля снимок не трогает, пустой список стирает.
  let background: BackgroundTask[] = [];
  // Остановленные субагенты: снимок следующего события может отстать и ещё числить их работающими,
  // а остановка уже была — таких в снимках не учитываем, пока субагент не стартует снова.
  const stopped = new Set<string>();
  let waitingFor: string | null = null;
  let heldByBackground = false;

  const start = (): void => {
    phase = 'working';
    turnEndedAt = null;
    source = 'hooks';
  };
  const end = (at: string): void => {
    phase = 'ended';
    turnEndedAt = at;
    source = 'hooks';
    // Ход кончился: ожидание `wait_for` его не переживает, как и обычный субагент —
    // остаются фоновые из последнего снимка.
    waitingFor = null;
    for (const id of started.keys()) {
      if (!background.some((task) => task.id === id)) started.delete(id);
    }
  };

  for (const event of events ?? []) {
    lastEventAt = event.at;
    // Сессия началась заново (запуск, `--resume`, `/clear`, сжатие): прежнее забыто,
    // но снимок самого события уже про новое состояние и остаётся.
    if (event.name === 'SessionStart') {
      started.clear();
      background = [];
      stopped.clear();
      waitingFor = null;
    }
    if (event.backgroundTasks !== null) {
      background = event.backgroundTasks.filter(
        (task) => isRunningSubagent(task) && !stopped.has(task.id),
      );
    }
    switch (event.name) {
      case 'UserPromptSubmit':
        waitingFor = null;
        start();
        break;
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
        // Без id старт не сопоставить с остановкой — события пропускаются.
        if (event.agentId !== null) {
          stopped.delete(event.agentId);
          started.set(event.agentId, {
            agentType: event.agentType,
            transcriptPath: event.transcriptPath,
          });
        }
        break;
      case 'SubagentStop': {
        // Чужой id ничего не снимает из живых: служебных остановок без старта бывает десятки.
        const id = event.agentId;
        if (id !== null) {
          stopped.add(id);
          started.delete(id);
          // Снимок самого события мог отстать от остановки и ещё числить задачу работающей.
          background = background.filter((task) => task.id !== id);
        }
        break;
      }
      case 'ParleyWaitStart':
        if (event.waitTarget !== null) waitingFor = event.waitTarget;
        break;
      case 'ParleyWaitEnd':
        waitingFor = null;
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
    // Фоновый субагент и ожидание не вечны: молчит и журнал, и лог дольше предела — это зомби.
    if (!Number.isNaN(quietAt) && now - quietAt > backgroundHoldMs) {
      background = [];
      waitingFor = null;
    }
    if (phase === 'working' && !Number.isNaN(quietAt) && now - quietAt > silenceThresholdMs) {
      // Фоновый субагент и ожидание `wait_for` молчат в журнале и в логе родителя, пока
      // работают, — тишина по ним ничего не значит.
      if (waitingFor !== null) {
        // Агент внутри вызова `wait_for`: ход идёт, ввода он не примет.
      } else if (background.length > 0) {
        // Ход родителя по тишине окончен, а фоновый субагент ещё работает: сессию держит он.
        heldByBackground = true;
      } else {
        phase = 'ended';
        turnEndedAt = recordIsNewer ? lastRecordAt : lastEventAt;
        // Источник — та ось, чьё время решило: лога может не быть вовсе.
        source = recordIsNewer ? 'log' : source;
      }
    }
  }

  // Ход родителя окончен (Stop, idle_prompt), а фоновый субагент ещё работает и принесёт
  // результат: сессия занята. `blocked` не трогаем — вопрос человеку важнее. Если о конце хода
  // ничего не известно (`phase === null`), сессия тоже занята, но у приглашения ли агент — нет.
  if (background.length > 0 && phase !== 'blocked' && phase !== 'working') {
    heldByBackground = phase === 'ended' && waitingFor === null;
    phase = 'working';
    turnEndedAt = null;
    source = 'hooks';
  }

  // Ход окончен — работать нечему: обычный субагент его не пережил бы, а фоновые уже подняли
  // бы сессию в `working`. Случай тишины, когда `started` ещё хранит убитого помощника, —
  // тоже сюда: в списке его нет.
  const tasks = phase === 'ended' ? [] : tasksOf(started, background);

  const ended: Activity = seen ? 'idle' : 'unseen';
  return {
    // Ничего не известно — состояние тусклое: после перезапуска харнесса все
    // закончившие ход сессии считаются просмотренными (раздел 4.1).
    activity: phase === null ? 'idle' : phase === 'ended' ? ended : phase,
    subagents: tasks.length,
    tasks,
    waitingFor: phase === 'ended' ? null : waitingFor,
    heldByBackground,
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
