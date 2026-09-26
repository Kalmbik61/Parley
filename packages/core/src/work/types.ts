import type { TokenTotals } from '../counters.js';

/** Статус работы. `archived` в списке не показывается (дизайн TUI, раздел 8). */
export type WorkStatus = 'active' | 'done' | 'archived';

/**
 * Прежний единый статус сессии (карта v1). В карте его больше нет: с v2 он
 * собирается из двух осей функцией `displayStatus` (`status-view.ts`) —
 * замороженный TUI и точки окна рисуют именно его.
 */
export type SessionStatus = 'pending' | 'active' | 'exited' | 'done' | 'failed';

/**
 * Ось процесса (спецификация 7.1): `sleeping` — процесса нет, но сессия на связи
 * и письмо её поднимает; `closed` — закрыта явно и писем не получает.
 */
export type SessionLifecycle = 'pending' | 'active' | 'sleeping' | 'closed';

/**
 * Ось итога: приходит только из `report` и процесс не меняет — после
 * `report(done)` сессия остаётся `active` (спецификация 7.1).
 */
export type SessionResult = 'done' | 'failed';

/**
 * Одна ступень жизни сессии: переход по оси процесса или поставленный итог.
 * Код выхода и сигнал есть только у ухода в `sleeping` по выходу процесса;
 * ДЕТАЛИ показывают их как «код 0» или «сигнал 9» (дизайн TUI, раздел 3).
 */
export interface HistoryEntry {
  event: SessionLifecycle | SessionResult;
  at: string;
  /** Код выхода; `null` — процесс завершился без нас и код неизвестен. */
  exitCode?: number | null;
  signal?: number;
}

/** Кто запустил сессию: панель харнесса, хост или напечатанная команда CLI. */
export type LaunchedBy = 'tui' | 'cli' | 'host';

/** Резюме написал сам агент через `report` или его дозаказали через `claude -p`. */
export type SummarySource = 'agent' | 'auto';

/** Путь артефакта — всегда относительно корня проекта (спецификация, раздел 8). */
export interface Artifact {
  kind: string;
  path: string;
}

/** Метрики сессии: фиксируются в карте при завершении, пока сессия жива — `null`. */
export interface SessionMetrics {
  durationMs: number;
  /** `null` — в логе нет ни одной записи с usage: «не знаем» и «ноль» — разные вещи. */
  tokens: TokenTotals | null;
  toolCalls: Record<string, number>;
}

/**
 * Id записи реестра провайдеров. Набор открыт: `~/.harnas/providers.json`
 * дополняет встроенный реестр своими CLI (спецификация, раздел 5).
 */
export type WorkProvider = string;

/**
 * Своя рабочая копия git для сессии (спецификация 8.1, 8.2): путь и ветка
 * планируются заранее (`plannedWorktree` в `work/worktree.ts`), а на диске
 * появляются только при запуске — до этого `createdAt` держит план живым, не
 * подтверждая, что каталог и ветка уже существуют.
 */
export interface WorktreeInfo {
  path: string;
  branch: string;
  /** Ветка или коммит, от которого worktree отведён; в него же идёт слияние. */
  base: string;
  /** `null` — worktree только запланирован, хост ещё не создал его на диске. */
  createdAt: string | null;
}

export interface WorkSession {
  id: string;
  provider: WorkProvider;
  /** Роль сессии внутри работы: «план», «бэкенд», «ревью». */
  label: string;
  /**
   * Что сессии сделать. Пустая строка — тихий старт: бриф уходит контекстом в
   * системный промпт, а задачу пользователь пишет первым сообщением сам (план
   * от 2026-09-06, раздел B). Такой сорт записи заводят только TUI (`prefix C`)
   * и CLI без `--task`; `spawn_session` пустую задачу по-прежнему отвергает.
   */
  task: string;
  /** Сессия-родитель, если её породил агент; у ручной — null. */
  parent: string | null;
  /** Сессии, чьи резюме и артефакты попали в бриф. */
  contextFrom: string[];
  lifecycle: SessionLifecycle;
  result: SessionResult | null;
  /** Когда поставлен последний итог; `null` — итога нет. */
  resultAt: string | null;
  /** Когда сессию закрыли явно; `null` — не закрыта. */
  closedAt: string | null;
  history: HistoryEntry[];
  startedAt: string | null;
  endedAt: string | null;
  /**
   * Pid процесса агента. `null` — процесс поднимал не харнесс (напечатанная
   * команда CLI), живость такой сессии видна только по молчанию лога.
   */
  pid: number | null;
  /** Время старта процесса из ОС: по нему ловится переиспользованный pid. */
  startedAtProcess: string | null;
  launchedBy: LaunchedBy | null;
  /** Id сессии у провайдера: для Claude — uuid jsonl-файла. */
  providerSessionId: string | null;
  metrics: SessionMetrics | null;
  summary: string | null;
  summarySource: SummarySource | null;
  artifacts: Artifact[];
  /**
   * Имя агента Claude Code, ролью которого запущена сессия (`claude --agent`);
   * `null` — обычная сессия. На диске может отсутствовать (карты до 2026-09-08):
   * `parseMap` подставляет `null` (спецификация 2026-09-08, 3.2).
   */
  agent: string | null;
  /**
   * Своя рабочая копия git; `null` — сессия работает прямо в каталоге проекта.
   * В картах на диске до этого куска поля нет вовсе: `parseMap` подставляет
   * `null` (кусок 4.1 плана worktree).
   */
  worktree: WorktreeInfo | null;
}

/**
 * Вид письма: `question` ждёт ответа, `decision` фиксирует договорённость,
 * `note` — всё остальное (спецификация 2026-09-08, 3.1). Вид нужен затем, что
 * отвечать стоит не на каждое письмо, а решения треда собираются сами.
 */
export type MessageKind = 'note' | 'question' | 'decision';
export const MESSAGE_KINDS: readonly MessageKind[] = ['note', 'question', 'decision'];

/** Отправитель письма из окна: человек не сессия и id `s-NN` у него нет. */
export const HUMAN = 'human';
/** Отправитель системного письма хоста («S05 не поднялась: …»). */
export const SYSTEM = 'system';

/** Комната — круг участников переписки (спецификация 6.1). */
export interface Room {
  /** `r-01`; счётчик `work.roomSeq`, id не переиспользуется. */
  id: string;
  title: string;
  /** Id сессии-создателя или `human`. */
  creator: string;
  /** Id сессий; человек — участник всегда и в список не пишется. */
  members: string[];
  createdAt: string;
}

/** Письмо: доставляется по pull, живёт в карте. */
export interface Message {
  id: string;
  /** Комната письма; `null` — прямое письмо, как до комнат. */
  roomId: string | null;
  /** Id сессии, `human` или `system`. */
  from: string;
  /** Адресаты; в комнате пустой список значит «всем участникам» (`recipientsOf`). */
  to: string[];
  at: string;
  text: string;
  /** На диске может отсутствовать (карты до 2026-09-08): `parseMap` подставляет `note`. */
  kind: MessageKind;
  /**
   * Отметки прочтения по адресатам: у рассылки комнаты каждый читает сам, и
   * одна отметка на письмо спрятала бы его от тех, кто ещё не прочёл.
   */
  readBy: Record<string, string>;
  /**
   * Отправитель или получатель удалён (план от 2026-09-06, раздел C). Само
   * письмо остаётся: переписку не переписывают задним числом, но отвечать на
   * него уже некому.
   */
  deleted?: boolean;
}

export interface Work {
  id: string;
  title: string;
  goal: string;
  status: WorkStatus;
  createdAt: string;
  updatedAt: string;
  /**
   * Сколько номеров сессий уже выдано: id удалённой не переиспользуется, иначе
   * `s-03` в чужом брифе указал бы на другую сессию. Поля нет в картах, писанных
   * до 2026-09-06, — тогда счётчик берётся максимумом по списку, миграции нет.
   */
  sessionSeq?: number;
  /**
   * Id удалённых сессий — только id, без данных: по нему `wait_for` отвечает
   * `state: deleted` вместо ошибки «сессии нет в карте».
   */
  deletedSessions?: string[];
  /** Сколько номеров комнат уже выдано: id комнаты, как и сессии, не переиспользуется. */
  roomSeq?: number;
}

/**
 * Карта работы — один файл `map.json`, пишет только харнесс. Версия 2 — с
 * комнатами и двумя осями сессии; карту v1 `parseMap` поднимает при чтении.
 */
export interface WorkMap {
  schemaVersion: 2;
  work: Work;
  sessions: WorkSession[];
  messages: Message[];
  rooms: Room[];
}

/** Запись глобального индекса работ `HARNAS_HOME/works-index.json`. */
export interface WorkIndexEntry {
  id: string;
  /** Абсолютный путь проекта, в котором лежит `.harnas/works/<id>/`. */
  projectPath: string;
  title: string;
  status: WorkStatus;
  updatedAt: string;
}

export interface WorksIndex {
  schemaVersion: 1;
  works: WorkIndexEntry[];
}
