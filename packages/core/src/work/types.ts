import type { TokenTotals } from '../counters.js';

/** Статус работы. `archived` в списке не показывается (дизайн TUI, раздел 8). */
export type WorkStatus = 'active' | 'done' | 'archived';

/**
 * Статус сессии. Первые три ставит харнесс по PTY, хукам и логам, `done` и
 * `failed` приходят только из отчёта агента (спецификация, раздел 3).
 *
 * `idle` удалён 2026-09-05 (ревью TUI v2): простой живого агента описывает не
 * карта, а `activity`; старые карты с `idle` читаются как `active`.
 */
export type SessionStatus = 'pending' | 'active' | 'exited' | 'done' | 'failed';

/**
 * Одна ступень жизненного цикла. Код выхода и сигнал есть только у перехода
 * в `exited`; ДЕТАЛИ показывают их как «код 0» или «сигнал 9» (дизайн TUI, раздел 3).
 */
export interface HistoryEntry {
  status: SessionStatus;
  at: string;
  /** Код выхода; `null` — процесс завершился без нас и код неизвестен. */
  exitCode?: number | null;
  signal?: number;
}

/** Кто запустил сессию: панель харнесса или напечатанная команда CLI. */
export type LaunchedBy = 'tui' | 'cli';

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
  status: SessionStatus;
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
}

/**
 * Вид письма: `question` ждёт ответа, `decision` фиксирует договорённость,
 * `note` — всё остальное (спецификация 2026-09-08, 3.1). Вид нужен затем, что
 * отвечать стоит не на каждое письмо, а решения треда собираются сами.
 */
export type MessageKind = 'note' | 'question' | 'decision';
export const MESSAGE_KINDS: readonly MessageKind[] = ['note', 'question', 'decision'];

/** Сообщение от сессии к сессии: доставляется по pull, живёт в карте. */
export interface Message {
  id: string;
  from: string;
  to: string;
  at: string;
  text: string;
  /** На диске может отсутствовать (карты до 2026-09-08): `parseMap` подставляет `note`. */
  kind: MessageKind;
  readAt: string | null;
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
}

/** Карта работы — один файл `map.json`, пишет только харнесс. */
export interface WorkMap {
  schemaVersion: 1;
  work: Work;
  sessions: WorkSession[];
  messages: Message[];
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
