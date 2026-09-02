import type { TokenTotals } from '../counters.js';
import type { Provider } from '../session-index.js';

/** Статус работы. `archived` в списке не показывается (дизайн TUI, раздел 8). */
export type WorkStatus = 'active' | 'done' | 'archived';

/**
 * Статус сессии. Первые четыре ставит харнесс по PTY и логам, `done` и `failed`
 * приходят только из отчёта агента (спецификация, раздел 3).
 */
export type SessionStatus = 'pending' | 'active' | 'idle' | 'exited' | 'done' | 'failed';

/** Одна ступень жизненного цикла; код выхода есть только у перехода в `exited`. */
export interface HistoryEntry {
  status: SessionStatus;
  at: string;
  exitCode?: number;
}

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
  tokens: TokenTotals;
  toolCalls: Record<string, number>;
}

export interface WorkSession {
  id: string;
  provider: Provider;
  /** Роль сессии внутри работы: «план», «бэкенд», «ревью». */
  label: string;
  task: string;
  /** Сессия-родитель, если её породил агент; у ручной — null. */
  parent: string | null;
  /** Сессии, чьи резюме и артефакты попали в бриф. */
  contextFrom: string[];
  status: SessionStatus;
  history: HistoryEntry[];
  startedAt: string | null;
  endedAt: string | null;
  /** Id сессии у провайдера: для Claude — uuid jsonl-файла. */
  providerSessionId: string | null;
  metrics: SessionMetrics | null;
  summary: string | null;
  summarySource: SummarySource | null;
  artifacts: Artifact[];
}

/** Сообщение от сессии к сессии: доставляется по pull, живёт в карте. */
export interface Message {
  id: string;
  from: string;
  to: string;
  at: string;
  text: string;
  readAt: string | null;
}

export interface Work {
  id: string;
  title: string;
  goal: string;
  status: WorkStatus;
  createdAt: string;
  updatedAt: string;
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
