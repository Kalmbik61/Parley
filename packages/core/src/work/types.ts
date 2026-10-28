import type { AgentPlanState } from '../agent-plan.js';
import type { DecisionJournalIntent } from './decision-journal.js';
import type { TokenTotals } from '../counters.js';
import type { EffortLevel } from '../providers.js';
import type { RecipeSnapshot } from '../recipes/types.js';
import type { SessionNeed } from './stuck.js';
import type { FrozenUsage } from './usage-ledger.js';
import type { SessionLifecycle, SessionResult } from './session-state.js';

// Типы статуса сессии объявлены в `session-state.ts` вместе с функциями, которые их выводят.
export type { SessionStatus, SessionLifecycle, SessionResult } from './session-state.js';

/** Статус работы. `archived` в списке не показывается (дизайн TUI, раздел 8). */
export interface SessionRole { source: 'builtin' | 'claude' | 'codex'; name: string }

export type WorkStatus = 'active' | 'done' | 'archived';

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

/**
 * Кто запустил сессию: хост или напечатанная команда CLI. `tui` — панель ушедшего
 * TUI: новых таких записей нет, значение остаётся ради старых карт.
 */
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
  /**
   * Те же токены с происхождением: кэш как наблюдение, время записи, связывание и эпоха, при которых
   * снимок снят (P36). Нет поля — снимок до P36: известны только вход и выход (`legacyUsage`).
   */
  usage?: FrozenUsage;
  toolCalls: Record<string, number>;
}

/**
 * Id записи реестра провайдеров. Набор открыт: `providers.json` в доме (`~/.parley`, прежде `~/.harnas`)
 * дополняет встроенный реестр своими CLI (спецификация, раздел 5).
 */
export type WorkProvider = string;

export interface ArtifactsWorkspace {
  kind: 'artifacts';
  path: string;
}

export interface CloneWorkspace {
  kind: 'clone';
  path: string;
  branch: string;
  sha: string;
}

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

/** Приватное evidence запуска Codex: не входит в agent/public works/island projections. */
export interface CodexThreadBinding {
  launchRevision: string;
  pid: number;
  startedAtProcess: string;
  /** null — launch/fallback ещё не подтверждён root MCP вызовом. */
  threadId: string | null;
}

export interface WorkSession {
  id: string;
  /** Explicit personal steps, published by this session; separate from accepted room assignments. */
  agentPlan?: AgentPlanState;
  provider: WorkProvider;
  /** Роль сессии внутри работы: «план», «бэкенд», «ревью». */
  label: string;
  /**
   * Что сессии сделать. Пустая строка — тихий старт: бриф уходит контекстом в
   * системный промпт, а задачу пользователь пишет первым сообщением сам (план
   * от 2026-09-06, раздел B). Такой сорт записи заводят только окно (быстрая и
   * дочерняя сессия) и CLI без `--task`; `spawn_session` пустую задачу по-прежнему
   * отвергает.
   */
  task: string;
  /** Сессия-родитель, если её породил агент; у ручной — null. */
  parent: string | null;
  /**
   * Сессия, чей `create_session` завёл эту, — только чтобы сайдбар поставил её под создателем. Ничего не наследует:
   * ни почту, ни права, ни лимиты, ни бриф. Нет поля или `null` — сессию завели человек, окно, CLI или движок.
   */
  createdBy?: string | null;
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
  codexThreadBinding?: CodexThreadBinding;
  metrics: SessionMetrics | null;
  summary: string | null;
  summarySource: SummarySource | null;
  artifacts: Artifact[];
  /**
   * Имя агента Claude Code, ролью которого запущена сессия (`claude --agent`);
   * `null` — обычная сессия. На диске может отсутствовать (карты до 2026-09-08):
   * `parseMap` подставляет `null` (спецификация 2026-09-08, 3.2).
   */
  /** Legacy input only; normalized maps and new writes use role. */
  agent?: string | null;
  role?: SessionRole | null;
  /**
   * Своя рабочая копия git; `null` — сессия работает прямо в каталоге проекта.
   * В картах на диске до этого куска поля нет вовсе: `parseMap` подставляет
   * `null` (кусок 4.1 плана worktree).
   */
  worktree: WorktreeInfo | null;
  workspace?: CloneWorkspace | ArtifactsWorkspace | null;
  /**
   * Явный выбор модели и усилия из окна или `spawn_session`: с ним строятся и запуск, и `resume`
   * (`plan` в `launch.ts`), а выбор запуска его перекрывает. Нет поля — выбора нет: умолчание
   * текущей роли, без роли — умолчание CLI (без флага). `null` — явный «Default»: снимает умолчание
   * роли, флага нет. Вычисленные умолчания роли не записываются и пересчитываются при каждом новом
   * запуске. Усилие — id уровня из каталога модели: значение, не проходящее `EFFORT_TOKEN`,
   * `parseMap` читает как «нет выбора». На диске полей может не быть: `parseMap` их не подставляет.
   */
  model?: string | null;
  effort?: EffortLevel | null;
  /**
   * Облегчённый запуск (спека «меньше ходов и легче контекст», C2.2): решение принимается один раз при создании
   * сессии и одинаково применяется при `resume`. Нет поля = `false`: карты до этого куска читаются без миграции.
   */
  lean?: boolean;
  /**
   * Чего сессия ждёт от человека и не может продолжить без него (спека застрявших 5.1): одобрение, ответ, сброс
   * лимита, вход, экран при старте. Пишет только хост и только по порогу (3.5); снимает по концу эпизода.
   * Нет поля — то же, что `null`: миграции карты не нужно.
   */
  stuck?: SessionNeed | null;
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
/** Trusted accepted-plan assignments, reserved by the host/domain before wake. */
export const PARLEY = 'parley';
/** Актор движка в log и правилах плана (план автономной комнаты, §2). */
export const ENGINE = 'engine';

export type RoomMode = 'free' | 'checklist' | 'verified' | 'autonomous';
export type PlanMode = Exclude<RoomMode, 'free'>;
export type PlanStatus = 'proposed' | 'active' | 'completing' | 'completed' | 'cancelled';
export type PlanItemStatus = 'waiting' | 'ready' | 'in_progress' | 'done' | 'blocked' | 'verified' | 'returned';
export interface PlanEvidence { text: string; artifacts: string[] }
export interface PlanItemInput {
  id: number; title: string; owner: string; scope: string; after?: number[];
  criteria?: string[]; verifier?: string | null;
}
export interface PlanDraft {
  /** Required together for an amendment: the currently accepted identity/revision. */
  id?: string; rev?: number; mode: PlanMode; goal: string; items: PlanItemInput[]; backlog?: string[];
}
/** Вход предложения: git-факты и начальное состояние добавляет только хост. */
export interface AutonomousDraft {
  budget: AutonomousBudget['limits'];
  checks: { id: string; item: number; argv: string[]; cwd: string; env: Record<string, string>; inputs: string[]; timeoutMs: number }[];
  coverage: AutonomousPlan['coverage'];
}

/**
 * POST /agent/attempts: токен в Authorization: Bearer, актор и работа определяются хостом.
 * Хост повторно проверяет права, режим и rev; возвращает {ok:true,result} либо
 * {ok:false,error:{code,message}}. requestKey — sha256 канонического JSON
 * {roomId, planId: planId ?? null, rev: rev ?? null, text, draft: plan}, вычисленный ядром;
 * он идемпотентен для предложения этой сессии;
 * amendment сохраняет состояние исполнения до принятия человеком, без повторной инициализации.
 */
export type AttemptChannelRequest =
  | { action: 'propose-plan'; roomId: string; planId?: string; rev?: number; requestKey: string; text: string; plan: PlanDraft & { autonomous: AutonomousDraft } }
  | { action: 'submit'; attemptId: string; submissionKey?: string; manifest: Omit<HandoffManifestInput, 'sha'> }
  | { action: 'verify'; attemptId: string; sha: string; criterion: number; verdict: CheckResult['verdict']; note: string };
export interface PlanItem extends PlanItemInput {
  after: number[]; criteria: string[]; verifier: string | null; status: PlanItemStatus;
  evidence: PlanEvidence | null; note: string | null;
  /** Human-accepted Checklist completion retained on promotion; never a verification claim. */
  acceptedChecklistRevision?: number;
  log: { at: string; by: string; status: PlanItemStatus; note: string | null }[];
}
export interface RoomPlan {
  id: string; roomId: string; mode: PlanMode; status: PlanStatus; rev: number;
  goal: string; items: PlanItem[]; backlog: string[];
  acceptedAt: string | null; completedAt: string | null; cancelledAt: string | null;
  completionSummary: string | null;
  /** Только при mode === 'autonomous' (план автономной комнаты, §2). */
  autonomous?: AutonomousPlan;
}
/** Модель данных (план автономной комнаты, §2). */
export interface AutonomousPlan {               // RoomPlan.autonomous, только при mode === 'autonomous'
  budget: AutonomousBudget;
  checks: CheckSpec[];                           // заморожены при Go
  coverage: Record<number, Record<number, Array<string | 'verifier'>>>; // item → criterion index → требуемые checkId и/или вердикт проверяющего
  criteriaVersion: Record<number, number>;       // пункт → текущая версия критериев, ≥ 1; при Go движок пишет 1 для каждого пункта; растёт только через amendment (§2 п. 2)
  integration: Integration;
  attempts: PlanAttempt[];
  ops: AutonomousOp[];                           // журнал операций с внешним эффектом
  halted: { reason: 'budget' | 'no_progress' | 'stuck' | 'restart' | 'confinement' | 'human'; at: string; detail: string } | null;
  seq: { attempt: number; receipt: number; check: number; op: number };
}

/** Модель данных (план автономной комнаты, §2). */
export interface PlanAttempt {
  id: string;                                    // at-0001
  item: number; n: number;                       // пункт и номер попытки по пункту
  planRev: number; criteriaVersion: number;      // под какую ревизию и версию критериев сдана
  worker: string | null;                         // сессия исполнителя (null до записи sessionId)
  verifier: string | null;                       // сессия проверяющего качественных критериев
  branch: string; baseSha: string;               // ветка попытки и голова интеграции, от которой она ответвлена
  sha: string | null;                            // коммит захвата, созданный движком в engine.git; HEAD клона не читается и не доверяется
  tree: string | null;                           // дерево захвата; tree == tree(baseSha) → попытка без изменений
  submissionKey: string | null;                  // хэш манифеста без sha, задан исполнителем до действий сервера
  status: 'starting' | 'running' | 'submitted' | 'checking' | 'accepted' | 'queued' | 'integrated' | 'returned' | 'blocked' | 'aborted' | 'superseded';
  manifest: HandoffManifest | null; receipt: Receipt | null;
  checks: string[];                              // CheckResult.id
  failureSignature: string | null;               // см. п. 6
  startedAt: string; endedAt: string | null;
  log: { at: string; by: string; status: PlanAttempt['status']; note: string | null; op: string | null }[];
}

/** Модель данных (план автономной комнаты, §2). */
export type HandoffManifestInput = Omit<HandoffManifest, 'hash'> & { hash?: string };
export interface HandoffManifest {
  version: 1;
  sha: string | null;                            // null при сдаче; дописывает движок после захвата
  criteriaVersion: number;
  dependsOn: string[];                           // id принятых попыток зависимостей, из брифа
  coverage: 'covered' | 'partial' | 'failed' | 'unstarted';
  scope: string; facts: string[]; hypotheses: string[]; notFound: string[]; gaps: string[];
  text: string;                                  // до 4096 знаков
  artifacts: { path: string; sha256: string; storedAs: string }[]; // путь в дереве захвата, хэш, копия под .parley/…/attempts/<id>/
  hash: string;                                  // sha256 канонического JSON манифеста без поля hash
  submittedAt: string;
}

/** Модель данных (план автономной комнаты, §2). */
export interface Receipt {
  id: string; attemptId: string; manifestHash: string; sha: string; criteriaVersion: number;
  valid: boolean; reason: string | null; at: string;
}

/** Модель данных (план автономной комнаты, §2). */
export interface CheckSpec {
  id: string;                                    // ck-spec-01
  item: number;
  argv: string[];                                // без оболочки
  cwd: string;                                   // относительно checkout
  env: Record<string, string>;                   // полный allowlist переменных
  inputs: { path: string; blob: string }[];      // замороженные входы: файлы тестов, конфиги раннера, фикстуры, package.json и lock — blob на baseSha Go
  timeoutMs: number;
  frozenAt: string;
}

/** Модель данных (план автономной комнаты, §2). */
export interface CheckResult {
  id: string; specId: string; attemptId: string;
  sha: string; argvHash: string; envHash: string; inputsOk: boolean;
  verdict: 'pass' | 'fail' | 'error' | 'not_verified';
  by: string;                                    // ENGINE или сессия-проверяющий
  exitCode: number | null; summary: string; outputTail: string | null; // путь к файлу хвоста
  at: string; durationMs: number;
}

/** Модель данных (план автономной комнаты, §2). */
export interface Integration {
  branch: string; baseSha: string;
  verifiedHead: string;                          // последняя голова, на которой все проверки интегрированных пунктов прошли
  candidateHead: string | null;                  // голова после слияния, ещё не проверенная
  queue: string[];                               // attemptId в порядке приёма
  suspended: { reason: string; attemptId: string; at: string } | null;
}

/** Модель данных (план автономной комнаты, §2). */
export interface AutonomousBudget {
  limits: { attemptsPerItem: number; repairWaves: number; minutesPerAttempt: number; sessions: number; concurrent: number };
  spent: { attempts: number; repairWaves: number; sessions: number; verifiers: number; minutes: number; launches: number };
  reservations: { key: string; kind: 'session' | 'launch'; attemptId: string; at: string }[]; // снимаются по op done/failed
}

/** Модель данных (план автономной комнаты, §2). */
export interface AutonomousOp {
  key: string;                                   // op-0001; идемпотентный ключ эффекта
  kind: 'create-session' | 'launch' | 'close-session' | 'stop-session' | 'clone' | 'capture' | 'merge' | 'noop-integration' | 'merge-abort' | 'check' | 'copy-artifacts' | 'cleanup' | 'resume';
  attemptId: string | null;
  payload: Record<string, unknown>;              // что именно: sessionId, sha, branch, specId…
  state: 'intended' | 'done' | 'failed';
  at: string; settledAt: string | null; result: Record<string, unknown> | null;
}

/**
 * Local durable intent: exact captured Markdown, never rebuilt from a later live revision. Пока `pending`, у намерения
 * есть `content`: файл пишется вне транзакции карты и при отказе повторяется ровно с этого текста. У `written` текста
 * нет — он лежит в самом файле, а карта хранит его `sha256`, размер и заголовок (спека хранилища 6.2).
 */
export interface PlanExportIntent {
  file: string; planId: string; rev: number; event: 'accepted' | 'completed' | 'cancelled';
  status: 'pending' | 'written';
  content?: string;
  sha256?: string; bytes?: number; title?: string;
}

/**
 * Durable delivery record: occurrence is an item log offset or a captured source message ID. Текст письма нужен, пока
 * эффект `queued`: по нему письмо отправляется. Отправленный и отменённый эффект хранит вместо него `textSha256` —
 * сам текст остаётся в письме, и принадлежность письма эффекту сверяется по хэшу (спека хранилища 6.2).
 */
export interface PlanEffect {
  key: string; roomId: string; planId: string | null; rev: number;
  item: number | null; kind: 'ready' | 'verify' | 'returned' | 'blocked' | 'completing' | 'mode' | 'completion-returned';
  occurrence: string; target: string; createdAt: string;
  status: 'queued' | 'sent' | 'cancelled'; messageId: string | null;
  text?: string; textSha256?: string;
}
/** Captured completion, then separately prepared file version; never a map/Markdown atomic claim. */
export interface PlanBacklogIntent {
  key: string; planId: string; rev: number; backlogId: string; completedAt: string;
  status: 'pending' | 'written' | 'conflict';
  expectedVersion?: string; itemFingerprint?: string;
  code?: 'backlog-conflict' | 'backlog-unavailable';
}

/**
 * Решение ведущего, которое ждёт ответа человека (дизайн комнат, 3.1). Это изменяемый
 * слот комнаты, а не письмо: лента остаётся лентой фактов, и факты — `decision`, заметка
 * возврата, системные строки — дописываются, когда человек ответил.
 */
export interface Proposal {
  /** Absent in legacy Free proposals. */
  kind?: 'decision' | 'completion';
  plan?: RoomPlan;
  planId?: string;
  planRev?: number;
  /** `p-01`; счётчик `work.proposalSeq`, id не переиспользуется. */
  id: string;
  /** Ведущий, чей текст лежит в слоте. */
  from: string;
  /** 1..10000 знаков, токены упоминаний вида `@s02`. */
  text: string;
  /** 0, и +1 на каждую переделку, пока человек не ответил; id при этом тот же. */
  rev: number;
  at: string;
}

/** Запись журнала участия (спека расхода токенов, 4.1). */
export interface RoomMembership {
  /** Id сессии; человек в журнал не пишется. */
  session: string;
  /** Вход: создание комнаты для создателя и начальных участников, иначе момент `addMember`. */
  from: string;
  /** Уход (`leaveOtherRooms`); `null` — участник до сих пор в комнате. */
  to: string | null;
}

/** Комната — круг участников переписки (спецификация 6.1). */
export interface Room {
  mode?: RoomMode;
  /** `r-01`; счётчик `work.roomSeq`, id не переиспользуется. */
  id: string;
  title: string;
  /** Id сессии-создателя или `human`. */
  creator: string;
  /** Владелец; рабочее участие задаётся только members. */
  ownerId: string | null;
  /** Id сессий; человек — участник всегда и в список не пишется. */
  members: string[];
  createdAt: string;
  /**
   * Ведущий комнаты: тот, кто собирает позиции и приносит решение. `null` — ведущий не
   * назначен, им считается первый из `members` (`roomLead` в `rooms.ts`). Закрытого или удалённого
   * ведущего подменяет первый живой участник (`liveLead`): запись при этом не меняется. На диске
   * поля может не быть (карты до 2026-09-29): `parseMap` подставляет `null`.
   */
  lead: string | null;
  /** Решение, ждущее человека; `null` — ждать нечего. Так же подставляется `parseMap`ом. */
  proposal: Proposal | null;
  /**
   * Снимок рецепта на момент создания комнаты (спека рецептов, 6.2): правка файла рецепта комнату
   * не меняет. `null` — комната без рецепта; в картах до рецептов поля нет, `parseMap` подставляет `null`.
   */
  recipe?: RecipeSnapshot | null;
  /**
   * Ведущий, которому уже ушёл снимок плейбука письмом (спека рецептов, 6.4). Одна отметка на смену
   * ведущего: хост не шлёт письмо повторно после перезапуска. Хост ставит её при создании комнаты, если ведущий
   * ещё не запущен (плейбук придёт слоем). Нет поля — ведущему плейбук ещё не доставлен, письмо уйдёт.
   */
  recipeLeadNotified?: string;
  /**
   * ISO-время архивации комнаты; `null` — комната открыта. Архивную комнату человек убрал с глаз: лента читается, писать
   * в неё нельзя (`requireOpenRoom`), пока он не вернёт её (`reopenRoom`). Это не «закрытая» комната (`isRoomClosed`):
   * та вычисляется сама, по отсутствию живых участников. В картах до архива комнат поля нет: `parseMap` подставляет `null`;
   * необязательное, как `mode` и `recipe`, — комната из литерала без поля открыта (`isRoomArchived`).
   */
  archivedAt?: string | null;
  /**
   * Журнал участия (спека расхода токенов, 4.1): кто, когда вошёл и вышел. Нет поля — комната создана до журнала, её
   * история восстанавливается по ленте (`roomMembership`). Битый журнал `parseMap` убирает.
   */
  memberLog?: RoomMembership[];
}

/** Через кого человек отправил письмо (спека 2026-10-14, 7.4); нет поля — сам, в окне. */
export type MessageVia = 'assistant' | 'telegram';

/** Письмо: доставляется по pull, живёт в таблице `messages` (спека хранилища 6.2). */
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
   * Ответ на сообщение (Parley 0.3.0): id сообщения той же комнаты, над которым окно рисует цитату.
   * Нет поля — не ответ; так лежат и все письма карт до 0.3.0, подставлять `parseMap` нечего.
   */
  replyTo?: string;
  /** Письмо человека, переданное помощником (спека 2026-10-14, 7.4). У старых карт поля нет. */
  via?: MessageVia;
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
  /**
   * Полный размер текста в байтах, когда `text` сокращён: так письмо выглядит только в карте окна и на страницах
   * (`context-pages.ts`); на диске этого поля нет.
   */
  textBytes?: number;
}

/**
 * Что осталось за пределами компактной карты окна (`compactWorkMap`): письма за окном, точные счётчики
 * непрочитанного человеком и пути обрезанных полей. На диске поля нет — оно появляется только в снимке для окна.
 */
export interface MapCompact {
  version: 1;
  messages: {
    total: number;
    included: number;
    latestId: string | null;
    /**
     * По комнатам и по прямым письмам (`direct`): сколько всего и сколько из них в карте. `tailFrom` — номер самого
     * раннего письма хвоста, в котором в карте есть все письма комнаты подряд до последнего; всё, что старше, окно
     * берёт страницами (`context.messages` с курсором `before:tailFrom`). `null` — хвоста нет (самое новое письмо за бюджетом).
     */
    rooms: Record<string, { total: number; included: number; tailFrom: number | null }>;
  };
  /** Точное число непрочитанных человеком: прямых писем и по комнатам, независимо от окна. */
  unread: { letters: number; rooms: Record<string, number> };
  cut: Array<{ path: string; bytes: number }>;
  omitted: Record<string, number>;
}

/**
 * `MapCompact` версии 2: что окно с признаком `rooms-mail` получает вместо писем (`mailWorkMap`, спека rooms.mail 6.8).
 * Писем в карте нет совсем, а размер не зависит от длины переписки: на комнату — несколько чисел. Окно держит письма
 * само, из страниц `context.messages` и событий `rooms.mail`, а эти числа сверяет со своими (`top`, `total`).
 *
 * Два смысла «непрочитанного», не путать. `unread` — смысл СОБЫТИЯ `rooms.mail`, не версии 1: `letters` — ВСЕ непрочитанные
 * человеком письма работы (то же, что `unreadCount(HUMAN).total`), `rooms` — разбивка по комнатам, ключ `''` — прямые письма
 * (`unreadCount(HUMAN).byRoom`). У версии 1 `compact.unread.letters` — только прямые письма, комнаты в нём не считаются.
 * Комнаты без непрочитанного в `unread.rooms` нет, а в `rooms[id].unread` стоит `0`.
 */
export interface MapCompactMail {
  version: 2;
  /**
   * Каждая комната карты и прямые письма (ключ `''`; запись есть всегда, у пустого канала — нули и `null`):
   * `total` — сколько писем, `top` — наибольший номер `seq` (`0`, если писем нет), `lastAt` — момент самого нового письма,
   * `unread` — сколько из них человек не прочёл, `decision` — чем человек ответил на последнее решение комнаты
   * (`humanDecisionOutcome` по его письмам; у прямых писем всегда `null`).
   */
  rooms: Record<string, { total: number; top: number; lastAt: string | null; unread: number; decision: 'accepted' | 'returned' | null }>;
  unread: { letters: number; rooms: Record<string, number> };
  /**
   * Непрочитанные человеком письма, где могут называть `@human`: хвост непрочитанного (до `WINDOW_UNREAD_MAX`) через
   * `humanMentionCandidates`. Окно ЗАМЕНЯЕТ ими набор кандидатов работы; кандидатов события `rooms.mail` оно дописывает
   * в этот набор. Точное правило «@вы» применяет окно.
   */
  mentionCandidates: Message[];
  cut: Array<{ path: string; bytes: number }>;
  omitted: Record<string, number>;
}

/** Что израсходовано под бюджет работы (`resource-policy.ts`): запуск, возобновление, повтор запуска или новая сессия от агента. */
export type ResourceKind = 'spawn' | 'launch' | 'resume' | 'retry';

/**
 * Одна попытка в журнале ресурсов. `reserved` — слот взят до операции и ещё не подтверждён; `spent` — операция
 * случилась (процесс стартовал, запись создана); `released` — отменена своим владельцем до результата, слот вернулся.
 */
export interface ResourceAttempt {
  /** `a-0001`; счётчик `resources.seq`, id попытки не переиспользуется. */
  id: string;
  kind: ResourceKind;
  state: 'reserved' | 'spent' | 'released';
  at: string;
  settledAt?: string;
  /** Кто просил: id сессии (`spawn_session`), `human`, `wake` или `auto`. */
  actor: string;
  /** Сессия, под которую взят слот: новая (`spawn`) или поднимаемая. */
  session: string;
  /** Комната, чей бюджет тратится; `null` — только бюджет работы. */
  room: string | null;
  /** Поколение владельца резерва: чужой нерешённый резерв неоднозначен и сам по сроку не снимается. */
  owner: string;
}

/**
 * Журнал ресурсов работы: переживает перезапуск хоста, потому что лежит в карте и меняется под тем же замком, что и
 * сама операция. Это счётчики запусков и сессий, а не денег: жёсткого денежного потолка у провайдера нет.
 */
export interface WorkResources {
  seq: number;
  /** Сколько новых сессий агенты завели за всё время работы; удаление сессии счётчик не уменьшает. */
  spawned: number;
  spawnedByRoom: Record<string, number>;
  /** Только попытки в пределах окна и нерешённые: старые свёрнуты в счётчики. */
  attempts: ResourceAttempt[];
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
  /**
   * Сколько номеров решений уже выдано: слот `Room.proposal` после ответа человека пуст,
   * и по одному списку следующий `p-01` повторил бы id уже отвеченной карточки — «Accept»
   * по устаревшему окну принял бы чужое решение. Поле появилось 2026-09-29.
   */
  proposalSeq?: number;
  planSeq?: number;
  /**
   * Нижняя граница номеров писем: удалённая комната уносит из карты свои письма (`deleteRoom`), и по одному
   * списку следующий `m-NN` повторил бы id уже ушедшего — а по id письма окно ставит отметки прочтения и рисует
   * цитаты, будильник помнит указанные письма. Пишет только удаление комнаты; в картах до него поля нет.
   */
  messageSeq?: number;
}

/**
 * Хранимая карта работы: всё, кроме писем. Письма лежат в своих таблицах (`messages`, `message_reads`, `message_unread`,
 * спека хранилища 6.2) и читаются через API писем (`letter-store.ts`); карта с письмами — `WindowWorkMap`. Версия 2 — с
 * комнатами и двумя осями сессии; карту v1 `parseMap` поднимает при чтении.
 */
export interface WorkMap {
  schemaVersion: 2;
  work: Work;
  sessions: WorkSession[];
  rooms: Room[];
  plans?: RoomPlan[];
  planExports?: PlanExportIntent[];
  /** Exact accepted decision payloads; local durable retry state, not a prompt layer. */
  decisionExports?: DecisionJournalIntent[];
  planEffects?: PlanEffect[];
  planBacklogIntents?: PlanBacklogIntent[];
  /** Журнал ресурсов (`resource-policy.ts`); нет поля — карта до P37, бюджет начинается с нуля. */
  resources?: WorkResources;
}

/**
 * Карта с письмами: снимок для окна (`compactWorkMap`), страницы, разбор прежней `map.json`, полная карта из
 * `readStoredMap` и выгрузка `parley-core work map` (спека хранилища 6.2). Чистые предикаты писем (`isUnreadFor`,
 * `recipientsOf`, `unreadFor`, `isHumanUnread`) работают на ней — ими пользуются окно и сверка переезда.
 */
export type WindowWorkMap = WorkMap & {
  messages: Message[];
  /**
   * Только в снимке для окна: версия 1 (`compactWorkMap`) — письма хвостом и что осталось за ним; версия 2 (`mailWorkMap`) —
   * писем нет, вместо них числа (`MapCompactMail`). Какую версию получает окно, решает признак `rooms-mail`.
   */
  compact?: MapCompact | MapCompactMail;
};

/** Запись глобального индекса работ `works-index.json` дома (`parleyHome()`). */
export interface WorkIndexEntry {
  id: string;
  /** Абсолютный путь проекта, в котором лежит `.parley/works/<id>/` (или прежний `.harnas`). */
  projectPath: string;
  title: string;
  status: WorkStatus;
  updatedAt: string;
}

export interface WorksIndex {
  schemaVersion: 1;
  works: WorkIndexEntry[];
}
