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
 * Чего сессия ждёт от человека — `need` (спека «Застрявшие сессии», 3.1–3.3, 3.5). Одобрение, вопрос и экран
 * старта останавливают ход: `blocked`. Лимит подписки и слетевший вход, наоборот, ход оканчивают: `StopFailure`
 * (а у сессий без этого хука — финальная ошибка API в логе провайдера) — конец хода, и `need` сидит поверх
 * `unseen`/`idle`, переживая `Stop`, `idle_prompt` и `Ready` Codex. Внутри эпизода более конкретный вид не
 * заменяется менее конкретным. Опубликованное `need` всегда согласовано с `activity` (`reportedNeed`).
 *
 * Удержание не вечно: если ни событий хуков, ни записей лога родителя нет дольше
 * `backgroundHoldMs` (час), фоновый субагент и ожидание считаются зомби — удержание снято, ход
 * окончен.
 *
 * Функция чистая: весь диск остаётся в `events.ts` и `metrics.ts`.
 */

import { DEFAULT_CONFIG } from '../config.js';
import {
  PARLEY_STARTUP_NOTIFICATION,
  TERMINAL_WORKING_EVENT,
  type BackgroundTask,
  type EventRecord,
} from './events.js';
import {
  classifyClaudeFailure,
  clampDetail,
  parseResetText,
  type NeedKind,
  type SessionNeed,
} from './stuck.js';

export type Activity = 'working' | 'blocked' | 'unseen' | 'idle';

/** Чем выведено состояние: журналом хуков, страховкой по логу или ничем. */
export type ActivitySource = 'hooks' | 'log' | 'none';

/** Что страховке известно про лог провайдера (`LiveSessionMetrics`). */
export interface ActivityLog {
  /**
   * Время последней записи лога; `null` — записей нет. Хост передаёт сюда время последней записи человека
   * или ассистента (`SessionIndex.lastWorkRecordAt`): служебный хвост, который Claude Code дописывает после
   * конца хода, работой не считается.
   */
  lastRecordAt: string | null;
  /**
   * Время последней записи ПОЛЬЗОВАТЕЛЯ в логе; `null` — таких записей нет.
   * Только она снимает `blocked` со стороны страховки (раздел 4.3).
   */
  lastUserRecordAt: string | null;
  /**
   * Самая поздняя запись ассистента с ошибкой API (`SessionIndex.lastApiError`, только лог Claude Code):
   * запасной путь для сессий, у которых `StopFailure` не доходит до журнала, — запущенных до этого хука и на
   * `claude` ниже порога ленты. Это сырьё, а не вывод: новее ли она остальных осей, решает свёртка. Нет поля и
   * `null` — такой записи нет.
   */
  lastApiError?: { at: string; error: string | null; text: string } | null;
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
  /** На что ждёт `wait_for`: цель последнего из идущих вызовов — id сессии или `inbox`; `null` — не ждёт. */
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
  /**
   * Чего сессия ждёт от человека; `null` — ничего (спека «Застрявшие сессии», 3.1). Не `null` только у `blocked`
   * (одобрение, вопрос, экран старта) и у сессии с оконченным ходом, `unseen` или `idle` (лимит, вход): значения
   * `activity` от этого не меняются. Lifecycle свёртка не видит — `null` у спящей и закрытой ставит хост.
   */
  need: SessionNeed | null;
}

/** Виды `need`, при которых ход стоит (`blocked`), по возрастанию конкретности: «конкретнее — сильнее» (3.2). */
const BLOCKING_KINDS: readonly NeedKind[] = ['startup', 'question', 'approval'];

/** Конкретность вида в эпизоде ожидания; −1 у видов, при которых ход не стоит (лимит, вход). */
const rankOf = (kind: NeedKind): number => BLOCKING_KINDS.indexOf(kind);

/** `Notification`, после которых агент ждёт человека, и какой вид `need` они дают. */
const BLOCKING = new Map<string, NeedKind>([
  ['permission_prompt', 'approval'],
  ['agent_needs_input', 'question'],
  ['elicitation_dialog', 'question'],
  ['elicitation_url_dialog', 'question'],
  [PARLEY_STARTUP_NOTIFICATION, 'startup'],
]);

/**
 * `Notification`, которыми ожидание закончилось и агент снова работает: ответ на форму, а также продолжение,
 * которое Claude Code начал сам после сброса лимита (`quota_auto_resume_fired`).
 */
const RESUMING = new Set([
  'elicitation_complete',
  'elicitation_response',
  'quota_auto_resume_fired',
]);

/**
 * События журнала, после которых работа заново не началась: конец хода, выход, остановка субагента и строки
 * `wait_for`, которые дописывает MCP-сервер, а не Claude Code. Запись об ошибке API в логе сравнивается с последним
 * событием, которое работу начинало (`restartsWork`): ошибка остаётся последним словом сессии, даже если после неё
 * Claude Code дописал `Stop` или `idle_prompt`, — иначе у сессий без `StopFailure` лимит пропадал бы через минуту простоя.
 */
const PASSIVE_EVENTS = new Set([
  'Stop',
  'StopFailure',
  'SessionEnd',
  'SubagentStop',
  'ParleyWaitStart',
  'ParleyWaitEnd',
]);

/** `Notification`, после которых работа заново не началась: простой у приглашения и выполненный вход. */
const PASSIVE_NOTIFICATIONS = new Set(['idle_prompt', 'auth_success']);

/** Событие начало или продолжило работу: всё, что не названо в `PASSIVE_EVENTS` и `PASSIVE_NOTIFICATIONS`. */
const restartsWork = (event: EventRecord): boolean =>
  event.name === 'Notification'
    ? !PASSIVE_NOTIFICATIONS.has(event.notificationType ?? '')
    : !PASSIVE_EVENTS.has(event.name);

/** `SessionStart.source`, с которых сессия начинается заново; пусто — прежняя версия без поля. */
const LAUNCH_SOURCES = new Set(['startup', 'resume', 'clear']);

const isLaunchSource = (source: string | null): boolean =>
  source === null || LAUNCH_SOURCES.has(source);

/** Ход: агент работает, ждёт человека или закончил. `null` — ничего не известно. */
type Phase = 'working' | 'blocked' | 'ended';

/** Время оси в миллисекундах; `NaN` — оси нет или её время не разобрать. */
const msOf = (value: string | null): number => (value === null ? Number.NaN : Date.parse(value));

/** Ось `a` свежее оси `b`; ось без времени не свежее ничего, но её и не обгоняют. */
const isNewer = (a: number, b: number): boolean => !Number.isNaN(a) && (Number.isNaN(b) || a > b);

/** Идущий вызов `wait_for`: его id (у строк прежних версий `null`) и цель. */
interface ActiveWait {
  id: string | null;
  target: string;
}

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
  // `as`: фазу меняют и замыкания `start` и `end`, которых анализ потока не видит, и без приведения он
  // считал бы её в цикле всё ещё `null`.
  let phase = null as Phase | null;
  let source: ActivitySource = 'none';
  let turnEndedAt: string | null = null;
  let lastEventAt: string | null = null;
  // Время последнего события, которое начало или продолжило работу (`restartsWork`).
  let lastRestartAt: string | null = null;
  // После последнего такого события в журнале есть `StopFailure`: о конце хода сказал сам Claude Code.
  let failedInJournal = false;
  let exited = false;
  const started = new Map<string, StartedAgent>();
  // Работающие субагенты из последнего снимка `background_tasks` — те, что живут и
  // после конца хода родителя. Событие без поля снимок не трогает, пустой список стирает.
  let background: BackgroundTask[] = [];
  // Остановленные субагенты: снимок следующего события может отстать и ещё числить их работающими,
  // а остановка уже была — таких в снимках не учитываем, пока субагент не стартует снова.
  const stopped = new Set<string>();
  // Идущие вызовы `wait_for` в порядке начала: параллельных бывает несколько, и конец снимает своё.
  let waits: ActiveWait[] = [];
  let heldByBackground = false;
  // Чего ждёт сессия: эпизод от появления потребности до её снятия. Как и `phase`, меняется замыканиями.
  let need = null as SessionNeed | null;

  const start = (): void => {
    phase = 'working';
    turnEndedAt = null;
    source = 'hooks';
    // Ход начался (промпт, кадр спиннера, ответ на форму, продолжение после лимита): ждать человека больше нечего.
    need = null;
  };
  const end = (at: string): void => {
    phase = 'ended';
    turnEndedAt = at;
    source = 'hooks';
    // Ход кончился: ожидание `wait_for` его не переживает, как и обычный субагент —
    // остаются фоновые из последнего снимка.
    waits = [];
    for (const id of started.keys()) {
      if (!background.some((task) => task.id === id)) started.delete(id);
    }
    // `need` конец хода не трогает: лимит и вход на нём как раз и ждут, а вопрос человеку после него не виден —
    // `reportedNeed` показывает такие виды только у стоящего хода.
  };
  // Ход встал: агент ждёт человека. Внутри идущего эпизода более конкретный вид не заменяется менее конкретным,
  // а менее конкретный повышается до более конкретного — с прежним `since`. `newDialog` — окно разрешения
  // (`PermissionRequest`): оно у каждого одобрения своё, и второе за идущим — уже другое, с новым `since`.
  const block = (kind: NeedKind, at: string, detail: string | null, newDialog = false): void => {
    const open = phase === 'blocked' ? need : null;
    phase = 'blocked';
    source = 'hooks';
    if (open === null || (newDialog && open.kind === 'approval')) {
      need = { kind, since: at, detail, resetsAt: null, window: null, account: null };
    } else if (rankOf(kind) > rankOf(open.kind)) {
      need = { ...open, kind, detail };
    }
  };
  // Ход оборван ошибкой API (`StopFailure`, а при запасном пути — запись лога): ход окончен, а лимит и слетевший
  // вход ждут человека. Время сброса берётся из полного текста: строка `detail` обрезана до `NEED_DETAIL_MAX` знаков
  // и могла потерять хвост с ним. Ошибка не из этих двух (`server_error`…) `need` не даёт и снимает прежний.
  const failed = (at: string, error: string | null, text: string | null): void => {
    end(at);
    const failure = classifyClaudeFailure(error);
    if (failure === null) {
      need = null;
      return;
    }
    const reset = failure.kind === 'limit' ? parseResetText(text ?? '', new Date(at)) : null;
    need = {
      kind: failure.kind,
      since: at,
      detail: clampDetail(text),
      resetsAt: reset?.resetsAt ?? null,
      window: reset?.window ?? null,
      account: failure.account,
    };
  };

  for (const event of events ?? []) {
    lastEventAt = event.at;
    if (restartsWork(event)) {
      lastRestartAt = event.at;
      failedInJournal = false;
    } else if (event.name === 'StopFailure') {
      failedInJournal = true;
    }
    const heldBefore = background.length > 0;
    // Сессия началась заново (запуск, `--resume`, `/clear`, сжатие): прежнее забыто,
    // но снимок самого события уже про новое состояние и остаётся.
    if (event.name === 'SessionStart') {
      started.clear();
      background = [];
      stopped.clear();
      waits = [];
    }
    if (event.backgroundTasks !== null) {
      background = event.backgroundTasks.filter(
        (task) => isRunningSubagent(task) && !stopped.has(task.id),
      );
    }
    switch (event.name) {
      case 'UserPromptSubmit':
        waits = [];
        start();
        break;
      case 'SessionStart':
        // Новый процесс стоит у приглашения: хода, пока человек (или бриф) не прислал промпт, нет, и
        // `Stop` после перезапуска не придёт — `working` от самого старта крутился бы до `idle_prompt`.
        // Ход начинает только `UserPromptSubmit`. Если прежний процесс умер посреди хода без `Stop`,
        // этот ход окончен; иначе фаза остаётся как была — перезапуск (смена модели, Resume) нового
        // `unseen` не создаёт. Запуском считаются только `startup`, `resume`, `clear` и отсутствие поля;
        // автосжатие (`compact`) идёт внутри хода, а незнакомое (будущее) значение — тоже: фазу не трогают.
        // Проба живого Claude Code 2.1.289 (2026-10-06): первый хук — признак готовности поля ввода,
        // SessionStart срабатывает через ~0,2-0,35 с после запуска и набранный в этот миг текст не теряется;
        // удерживать `working` до `idle_prompt` ради готовности ввода не нужно.
        if (isLaunchSource(event.source)) {
          // Запущен новый процесс: то, чего ждал прежний (вопрос, лимит, вход), позади.
          need = null;
          if (phase === 'working' || phase === 'blocked') end(event.at);
        }
        break;
      case TERMINAL_WORKING_EVENT:
        // Кадр спиннера Codex: ход идёт, но это не его начало — ожидание `wait_for` остаётся.
        start();
        break;
      case 'PermissionRequest':
        block('approval', event.at, clampDetail(event.toolDetail ?? event.toolName), true);
        break;
      case 'Notification': {
        const type = event.notificationType ?? '';
        const kind = BLOCKING.get(type);
        if (kind !== undefined) {
          block(kind, event.at, clampDetail(event.message));
        } else if (RESUMING.has(type)) {
          start();
        } else if (type === 'auth_success') {
          // Вход выполнен: слетевший вход снят, лимит от входа не проходит. Ход при этом не начинается.
          if (need?.kind === 'sign-in') need = null;
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
      case 'StopFailure':
        // Claude Code шлёт его вместо `Stop`, когда ход оборвала ошибка API; у Codex такое событие хост выводит
        // из `task_complete` с ошибкой. Текст ошибки — то, что видит человек; без него — подробности.
        failed(event.at, event.error, event.lastAssistantMessage ?? event.errorDetails);
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
        if (event.waitTarget !== null) {
          // Повторный Start с тем же id заменяет цель; строки без id — каждая своё ожидание.
          waits = [
            ...waits.filter((wait) => event.waitId === null || wait.id !== event.waitId),
            { id: event.waitId, target: event.waitTarget },
          ];
        }
        break;
      case 'ParleyWaitEnd':
        // End без id (прежняя версия) снимает все ожидания, с id — только своё: поздний End
        // брошенного вызова не должен снимать новое.
        waits = event.waitId === null ? [] : waits.filter((wait) => wait.id !== event.waitId);
        break;
      case 'SessionEnd':
        exited = true;
        break;
      default:
        // Прочие хуки состояние не меняют.
        break;
    }
    // Ход родителя кончился давно, но его держали фоновые; это событие их отпустило — ход окончен
    // теперь. Иначе тот, кто смотрел сессию, пока лид ждал, считался бы видевшим и конец хода.
    // Само `SessionStart` обнуляет задачи не потому, что их отпустили, — это перезапуск, нового конца нет.
    if (
      heldBefore &&
      background.length === 0 &&
      phase === 'ended' &&
      event.name !== 'SessionStart'
    ) {
      turnEndedAt = event.at;
    }
  }

  // Страховка по логу (4.3). Из записей лога `blocked` снимает только запись
  // ПОЛЬЗОВАТЕЛЯ: пока агент ждёт ответа, с его стороны в транскрипт не пишется
  // ничего, а появившаяся запись значит, что разрешение выдано и ход продолжился
  // (хука «разрешение выдано» в наборе 4.2 нет).
  const lastRecordAt = log?.lastRecordAt ?? null;
  const recordAt = msOf(lastRecordAt);
  const eventAt = msOf(lastEventAt);
  const restartAt = msOf(lastRestartAt);
  const userAt = msOf(log?.lastUserRecordAt ?? null);

  if (phase === 'blocked' && isNewer(userAt, eventAt)) {
    phase = 'working';
    turnEndedAt = null;
    source = 'log';
  }

  // Ошибка API в логе (3.2). Запись ошибки — последняя запись работы, новее человека и последнего события журнала,
  // начавшего работу (`Stop` и `idle_prompt` после неё её не отменяют), а ход не стоит на вопросе: ход кончился на ней.
  // Сама запись — «ответ ассистента новее событий», который иначе вернул бы сессию в `working`, поэтому здесь она
  // возобновлением работы не считается. Был ответ после неё (Claude продолжил сам) или сообщение человека — ошибка
  // позади.
  const apiError = log?.lastApiError ?? null;
  const apiErrorAt = msOf(apiError?.at ?? null);
  const errorEndsTurn =
    apiError !== null &&
    phase !== 'blocked' &&
    isNewer(apiErrorAt, restartAt) &&
    isNewer(apiErrorAt, userAt) &&
    !(recordAt > apiErrorAt);
  // Запасной путь: у сессии, чей `StopFailure` не доходит до журнала (старый Claude Code, хуки ленты выключены), о
  // конце хода знает один лог — это то же, что `StopFailure` в момент записи. Если же в журнале после начала хода
  // есть свой `StopFailure`, журнал главнее: `need`, `since` и конец хода остаются по его событию, что бы ни
  // показывал лог и когда бы индекс лога его ни дочитал, — иначе время эпизода менялось бы от порядка прихода.
  if (errorEndsTurn && !failedInJournal) {
    failed(apiError.at, apiError.error, apiError.text);
    source = 'log';
  }

  if (phase !== 'blocked') {
    const recordIsNewer = isNewer(recordAt, eventAt);
    if (recordIsNewer && !errorEndsTurn) {
      phase = 'working';
      turnEndedAt = null;
      source = 'log';
      // Запись новее событий — сессия снова работает, и то, чего она ждала, позади (запись человека — прямо
      // названное снятие, 3.3); иначе по тишине ход окончился бы с прежним лимитом.
      need = null;
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
      waits = [];
    }
    if (phase === 'working' && !Number.isNaN(quietAt) && now - quietAt > silenceThresholdMs) {
      // Фоновый субагент и ожидание `wait_for` молчат в журнале и в логе родителя, пока
      // работают, — тишина по ним ничего не значит.
      if (waits.length > 0) {
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
    heldByBackground = phase === 'ended' && waits.length === 0;
    phase = 'working';
    turnEndedAt = null;
    source = 'hooks';
  }

  // Ход окончен — работать нечему: обычный субагент его не пережил бы, а фоновые уже подняли
  // бы сессию в `working`. Случай тишины, когда `started` ещё хранит убитого помощника, —
  // тоже сюда: в списке его нет.
  const tasks = phase === 'ended' ? [] : tasksOf(started, background);

  const ended: Activity = seen ? 'idle' : 'unseen';
  // Ничего не известно — состояние тусклое: после перезапуска харнесса все
  // закончившие ход сессии считаются просмотренными (раздел 4.1).
  const reported: Activity = phase === null ? 'idle' : phase === 'ended' ? ended : phase;
  return {
    activity: reported,
    subagents: tasks.length,
    tasks,
    // Последнее из идущих ожиданий.
    waitingFor: phase === 'ended' ? null : (waits.at(-1)?.target ?? null),
    heldByBackground,
    turnEndedAt,
    lastEventAt,
    source,
    exited,
    hooksMissing: events === null,
    need: reportedNeed(need, reported),
  };
}

/**
 * `need` в паре с опубликованной активностью (3.1): `blocked` — только вид, при котором ход стоит (одобрение,
 * вопрос, старт); ход окончен (`unseen`, `idle`) — только вид, на котором он оборвался (лимит, вход). Всё прочее —
 * `null`: работающая сессия ничего не ждёт, а несогласованный вид — остаток эпизода, который снял лог, тишина или
 * фоновые субагенты, поднявшие сессию в `working`.
 */
function reportedNeed(need: SessionNeed | null, activity: Activity): SessionNeed | null {
  if (need === null || activity === 'working') return null;
  const stopsTurn = rankOf(need.kind) >= 0;
  return stopsTurn === (activity === 'blocked') ? need : null;
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
