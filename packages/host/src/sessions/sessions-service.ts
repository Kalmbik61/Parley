/**
 * Создание, запуск, остановка и удаление сессий — план, кусок 1.7.
 *
 * `launch()` — общая точка входа что для интерактивного запуска
 * (`sessions.create`/`sessions.resume`), что для подъёма письмом: план
 * команды строит core (`planLaunch`/`planResume`/`planNew`), а хост только
 * находит бинарь, собирает окружение и заводит PTY. Канал звонка здесь всегда
 * выключен (`{ channel: false }`) — хост про него ничего не знает (спека 4.2).
 *
 * Две оси (кусок 3.4): «Остановить» усыпляет (`sleeping` — письмо поднимет),
 * «Закрыть» закрывает насовсем (`closed`). Закрытую не поднимает ни письмо, ни
 * ручной `resume`, а живой PTY закрытой в карте сессии хост гасит сам.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  addSystemMessage,
  appendAgentBinding,
  applyAgentSwitch,
  currentSegmentUsage,
  attemptKindFor,
  collectHandover,
  freezeUsage,
  isRoomArchived,
  launchClassOf,
  liveLead,
  mergeQueued,
  PARLEY,
  parleyNote,
  providerLabel,
  switchBlockers,
  unreadLetters,
  type AgentBinding,
  type LaunchClass,
  type LetterTx,
  type LimitAlternative,
  type MachineTicket,
  type ProviderLimits,
  type QueueReason,
  type WorkMap,
  limitsFromConfig,
  prepareSessionRole,
  roleId,
  type SessionRole,
  type WorkSession,
  type RoleCatalog,
  baseBranchOf,
  createNewSession,
  createPendingSession,
  createWorktree,
  checkProjectConnectivity,
  ensureParleyMd,
  deleteSession,
  DirtyWorktreeError,
  discardWorktree,
  effortsFor,
  finishExited,
  findRunnerBinary,
  GitStateError,
  InvalidRevisionError,
  CODEX_AUTO_MIN_VERSION,
  codexFeedSupported,
  codexHooksWanted,
  feedSupported,
  isGitRepo,
  isTrusted,
  loadConfig,
  loadProviders,
  isClaudeCode,
  isAccountRecord,
  isManagedEntry,
  managedRecord,
  ownsHookToken,
  MapLockTimeoutError,
  providerReadiness,
  providerReadinessError,
  prepareCustomProviderDir,
  readCustomProviders,
  mirrorProjectTrust,
  syncApiKeyApproval,
  userClaudeConfigDir,
  userClaudeJsonPath,
  readSecret,
  noteCreation,
  openEvents,
  planLaunch,
  planNew,
  planResume,
  plannedWorktree,
  processStartedAt,
  querySpawnLimits,
  validateSpawnBudget,
  SpawnBudgetError,
  readMap,
  recentCreations,
  reserveAttempt,
  roomOfSession,
  ResourceDeniedError,
  sessionMention,
  sessionTag,
  settleAttempt,
  startSession,
  swarmOfSession,
  SYSTEM,
  ENGINE,
  transitionSession,
  trustKey,
  updateMap,
  workPaths,
  writeBrief,
  writeLetters,
  type CodexWriteApprovals,
  type EffortLevel,
  type ParleyConfig,
  type LaunchPlan,
  type SpawnLimits,
  type ProviderEntry,
  type UsageSummary,
} from '@parley/core';
import { HOST_ERROR_REASONS, refKey } from '@parley/protocol';
import type { Result, SessionRef } from '@parley/protocol';
import type { ActivityService, SessionLive } from '../activity/activity-service.js';
import type { ConsentsService } from '../consents/consents-service.js';
import type { HostContext } from '../context.js';
import { HostError } from '../errors.js';
import { serialized } from '../methods/custom-providers.js';
import type { HookServer } from '../hooks/hook-server.js';
import type { ProviderVersions } from '../providers/versions.js';
import type { PtyHandle, PtyManager } from '../pty/pty-manager.js';
import type { WorksService, WorksView } from '../works/works-service.js';
import { gitFailure } from '../worktrees/worktrees-service.js';
import { createStepTimer } from '../timing.js';
import { admitSwarmSession, swarmBudgetRefusal, swarmMemberRefusal } from '../swarms/spawn.js';
import type { SwarmSpawn } from '../swarms/spawn.js';
import { createSkillInstaller } from './agent-skills.js';
import { findInterrupted } from './interrupted.js';
import { resolveModelChoice } from './model-choice.js';
import { LOOPBACK_KEY_PLACEHOLDER, providerLaunchEnv } from './provider-env.js';
import { copyTranscript, discardCopy, hasConversation, isClaudeAccount, removeForkCopy, type CarriedTranscript } from './transcript-carry.js';

export interface CreateSessionInput {
  projectPath: string;
  workId: string | null;
  provider: string;
  label: string;
  task: string;
  parent: string | null;
  /** Authenticated caller requesting an ordinary workspace peer. */
  requestedBy?: string;
  /** Только для движка: create_session канала агента этот флаг не передаёт. */
  deferLaunch?: boolean;
  /**
   * Сессия создаётся участником роя (спека роя v1, 4): королева нового роя или трутень/проверяющий в рой королевы-
   * вызывающего. Только путь роя (`/agent/swarms`, `swarms.create`) ставит поле, `/agent/sessions` его не принимает.
   * Для `create` `task` — задача роя (`objective`), для `add` — срез; хост дописывает свой шаблон (`swarms/briefs.ts`).
   */
  swarm?: SwarmSpawn;
  role?: SessionRole | null;
  agent?: string;
  /** Своя рабочая копия git — план пишется сразу, каталог заводит `launch()` (спека 8.1). */
  worktree?: boolean;
  workspace?: WorkSession['workspace'];
  /**
   * Модель и усилие из диалога запуска (дизайн комнат, 3.2; спека нормалайзера, 5.3). Пару проверяет
   * `resolveModelChoice`: вне каталога провайдера — `bad_request`, пустое значение — «по умолчанию», без флага.
   * Разрешённый выбор ложится в запись сессии (`WorkSession.model`, `.effort`): его берут и повторный запуск,
   * и resume.
   */
  model?: string | null;
  effort?: string | null;
  /**
   * Облегчённый запуск (спека «меньше ходов и легче контекст», C2.2): явный выбор окна. Ложится в запись сессии на
   * всех путях ниже; `resume` и подъём письмом берут его оттуда. Без поля запись не меняется.
   * При создании участников комнаты окно передаёт значение настройки `leanAgents`; королева роя всегда облегчённая (b-013).
   */
  lean?: boolean;
}

export type LaunchMode = 'launch' | 'resume' | 'new';

/**
 * Исход `launch()`: `held` — запуск Codex остановлен до согласия человека на папку проекта (спека 2026-10-21, 4.2);
 * `queued` — запуск ждёт свободного слота машины (спека ёмкости 2026-10-30, 4.2): процесса и worktree нет, запись очереди
 * лежит в карте сессии, продолжит её сервис ёмкости.
 */
export type LaunchOutcome = 'started' | 'held' | 'queued';

/**
 * Созданная сессия; `held` — её запуск ждёт согласия на папку, `queued` — слота машины (причина очереди); запись
 * `pending` уже в карте.
 */
export type CreatedSession = SessionRef & { held?: 'folder-trust'; queued?: QueueReason };

/**
 * Попыток записать старт процесса в карту, пока база работ занята: подъём всей работы после перезапуска хоста
 * держал запись дольше 3 с (2026-10-09), а процесс к этому моменту уже идёт.
 */
const START_WRITE_ATTEMPTS = 3;

/** Сколько ждать файла форка, чтобы убрать копию транскрипта в папке цели, и как часто смотреть. */
const FORK_WAIT_MS = 10 * 60_000;
const FORK_POLL_MS = 1000;

/** Сколько исходов замен агента помнит хост для повторов того же `requestId`. */
const SWITCH_RESULTS_KEPT = 100;

/** Короткая причина замены в строке ленты: «(Claude Code 2: usage limit)». */
const SWITCH_REASON: Record<AgentBinding['reason'], string> = {
  limit: 'usage limit',
  'sign-in': 'signed out',
  'provider-missing': 'removed from Parley',
  manual: 'replaced',
  model: 'model changed',
};

/** Строка ленты каждой комнаты сессии (спека замены агента, 5.7, 6.5) — для человека. */
export function switchLine(sessionId: string, target: string, model: string | null, previous: string, reason: AgentBinding['reason']): string {
  return `${sessionMention(sessionId)} continues on ${target}${model === null ? '' : ` · ${model}`} (${previous}: ${SWITCH_REASON[reason]})`;
}

/** Почему прежний агент сменён — для писем и первого хода форка. */
function switchWhy(previous: string, reason: AgentBinding['reason']): string {
  return reason === 'limit'
    ? `${previous} hit its usage limit`
    : reason === 'sign-in'
      ? `${previous} was signed out`
      : reason === 'provider-missing'
        ? `${previous} was removed from Parley`
        : `${previous} was replaced`;
}

/** Первый ход форка (спека 5.4.1): разговор тот же, аккаунт другой — что проверить, прежде чем продолжать. */
export function transcriptNote(sessionId: string, target: string, previous: string, reason: AgentBinding['reason']): string {
  return `You continue this conversation as ${sessionMention(sessionId)} on ${target} after ${switchWhy(previous, reason)}. Same id, rooms, children, worktree and mail. Time has passed: check get_map and your inbox before redoing anything.`;
}

/** Письмо `parley` ведущему и ждущим ответа (спека 6.5): кто сменился и что с ждавшими письмами. */
export function switchLetter(sessionId: string, target: string, model: string | null, previous: string, reason: AgentBinding['reason']): string {
  const why = switchWhy(previous, reason);
  const mention = sessionMention(sessionId);
  return `${mention} continues on ${target}${model === null ? '' : ` (${model})`} after ${why}. Its rooms, children and mail stay with it; messages that waited are being delivered.`;
}

/** Что `launch()` передаёт плану запуска сверх самой сессии. */
export interface LaunchChoice {
  /**
   * Кто просит запуск — для журнала бюджета (`resource-policy.ts`): `human` — окно, `auto` — автозапуск
   * созданного агентом, `wake` — будильник. Нет значения — человек. Возобновление будильником подчиняется ещё и
   * личному потолку `resumeRate`.
   */
  by?: string;
  /**
   * Класс запуска для очереди машины; нет — `launchClassOf(by)`. Будильник ставит `human`, если будит письмо человека:
   * `by` у него всё равно `wake`.
   */
  launchClass?: LaunchClass;
  /** Указатель первым ходом `resume`, если провайдер его принимает. */
  prompt?: string;
  /** Пакет передачи при замене агента: первым сообщением `launch` после брифа. */
  handover?: string;
  /** Продолжение разговора форком: `resume` поднимает разговор с этим id как `--fork-session` (спека 5.4.1). */
  forkFrom?: string;
  model?: string | null;
  effort?: EffortLevel | null;
}

export interface SessionsService {
  /** Проверка после удаления worktree, включая сессии без живого процесса. */
  checkWorktreeGit(ref: SessionRef): Promise<void>;
  create(input: CreateSessionInput): Promise<CreatedSession>;
  /**
   * `prompt` — указатель первым ходом `resume`; `model` и `effort` перекрывают выбор из карты. `held` — запуск Codex
   * остановлен до согласия на папку (карточка заведена, бюджет не занят, ничего не создано); `queued` — машине тесно:
   * запуск встал в очередь (резерв работы снят, процесса и worktree нет, запись в карте); `started` — и при раннем
   * выходе (запуск уже идёт, процесс жив).
   */
  launch(ref: SessionRef, mode: LaunchMode, options?: LaunchChoice): Promise<LaunchOutcome>;
  stop(ref: SessionRef): Promise<void>;
  /** Насовсем: `closed` в карте и остановка PTY, если он жив. */
  close(ref: SessionRef): Promise<void>;
  /** `force` — грязный worktree отбрасывается вместе с сессией; без него — `conflict` (спека 8.3). */
  delete(ref: SessionRef, force?: boolean): Promise<void>;
  live(ref: SessionRef): boolean;
  stopAll(): Promise<void>;
  /** Собирает прерванных посреди хода — на старте хоста, после сверки живости. */
  collectInterrupted(): Promise<void>;
  /** Прерванные, которые всё ещё спят: их ещё не подняли и не закрыли. */
  interrupted(): SessionRef[];
  /** Поднимает прерванных без промпта — только с согласия человека (спека 10). */
  resumeInterrupted(refs: readonly SessionRef[]): Promise<void>;
  /**
   * Выбор модели и effort в записи сессии (спека нормалайзера, 5.5): `null` — явный «Default» (снимает и умолчание
   * роли), `undefined` оставляет как было. Процесс не трогает.
   */
  setChoice(ref: SessionRef, choice: { model?: string | null; effort?: string | null }): Promise<void>;
  /** Замок смены модели и effort этой сессии: через него идут `sessions.setEffort` и `sessions.setModel`. */
  exclusive: SwitchLock;
  /**
   * Смена модели (спека нормалайзера, 5.8): живую сессию у приглашения перезапускает через resume с новым
   * `--model`, остальным только пишет карту. `effort` в ответе — что осталось в карте: `null` — сброшен (у новой
   * модели такого уровня нет) или его не было. Та же модель — ни записи, ни перезапуска.
   */
  setModel(ref: SessionRef, model: string): Promise<{ model: string; effort: string | null; restarted: boolean }>;
  /** Куда можно перевести сессию и что останется при ней (спека замены агента, 5.2, 6.10). */
  switchOptions(ref: SessionRef): Promise<Result<'sessions.switchOptions'>>;
  /**
   * Замена агента на месте (спека замены агента, 5.3): id, комнаты, дети, почта и worktree остаются, меняется
   * провайдер процесса. Повтор того же `requestId` — тот же ответ (6.13).
   */
  switchAgent(ref: SessionRef, request: SwitchRequest): Promise<Result<'sessions.switchAgent'>>;
  /**
   * На старте хоста: `switching` в карте пережил прежний хост (замены живут только в его памяти) — снимается. Сессия
   * спит; если прежний агент уже заменён, следующий запуск поднимет нового с пакетом передачи. Заодно убирает копии
   * транскрипта в папке цели, оставшиеся после форка (спека 5.4.1).
   */
  clearStaleSwitches(): Promise<void>;
}

/** Параметры `sessions.switchAgent` без `ref`; `by` — кто просил (`human` или id сессии, чей запрос одобрен). */
export interface SwitchRequest {
  requestId: string;
  provider: string;
  model?: string | null;
  effort?: string | null;
  carry?: 'handover' | 'transcript';
  force?: boolean;
  by?: string;
}

/**
 * Связи замены агента со службами, которые заводятся после сессий (спека замены агента, 5.3, 6.3–6.5, 6.10). Без них
 * замена идёт без снятия эпизода «застрял», без сброса будильника и без подсказки цели.
 */
export interface SessionsTakeoverOptions {
  /** Эпизод лимита или входа закрывается молча — без «is back» (6.4). */
  stuck?: { endBySwitch(ref: SessionRef): Promise<void> };
  /** Будильник создаётся позже сервиса сессий: ссылка читается при замене. */
  wake?: () => { switched(ref: SessionRef): void } | undefined;
  /** Вошедшие аккаунты того же CLI — как в письме о лимите (`limitAlternatives`). */
  alternatives?: (provider: string) => Promise<readonly LimitAlternative[]>;
  /** Лимиты аккаунта; `null` — хост их не знает. */
  limits?: (provider: string) => ProviderLimits | null;
  /** Пакет передачи (`collectHandover` из core); подмена — для тестов. */
  handover?: typeof collectHandover;
}

/**
 * Лента вида «Chat» (план 2026-10-01, Task 2): приёмник HTTP-хуков и версии CLI для порога. Оба
 * необязательны — без них сессии запускаются как до ленты: файл настроек без HTTP-хуков, токена нет.
 */
export interface SessionsFeedOptions {
  hooks?: Pick<HookServer, 'url' | 'register' | 'unregister'>;
  providerVersions?: ProviderVersions;
  /**
   * Вошёл ли аккаунт подписки с этим id (служба входа, спека подписок 5.4): `true` — вошёл, `false` и `null` (не знаем) —
   * нет. Ответ может быть обещанием: пока кэш входа пуст (старт хоста, первая проверка идёт), хост отдаёт её исход, и
   * вошедший аккаунт не отказывает из-за «не знаем» (спека подписок 10). Не передан — аккаунты считаются невошедшими и
   * запуск отказывает текстом о входе (`readyProvider`). Спрашивается только у аккаунтов.
   */
  signedIn?: (id: string) => boolean | null | Promise<boolean | null>;
  /** Injectable native limit query; production queries the runtime before spawn. */
  spawnLimits?: () => Promise<SpawnLimits | null>;
  /** Current snapshot injection for isolated tests, never a persisted default. */
  roleCatalog?: (cwd: string) => Promise<RoleCatalog>;
  /**
   * Команда хуков Codex — путь запускателя `PARLEY_HOME/bin/parley-codex-hook` (спека 2026-10-07, 5.6). Зовётся только
   * в режиме `parley` настройки `codexWriteApprovals` и при адресе приёмника; нет — хуки Codex не включаются.
   */
  codexHookCommand?: () => Promise<string | undefined>;
  /**
   * Согласия человека на папку (спека 2026-10-21, 4.2): запуск Codex в проекте без записи в `trust.json` останавливается
   * и заводит карточку. Без сервиса (изолированные тесты) такой запуск не удерживается.
   */
  consents?: Pick<ConsentsService, 'request'>;
  /**
   * Канал агента к браузеру окна (спека браузера 2026-10-07, 3.7): адрес эндпоинта (`null` — не слушает) и токены на
   * запуск. Всем провайдерам, в отличие от хуков ленты; без него сессии запускаются без инструмента `browser_open`.
   */
  agent?: { url(): string | null; register(ref: SessionRef): string; unregister(ref: SessionRef): void };
  /** Замена агента сессии (спека 2026-10-30): службы застревания, будильника и лимитов. */
  takeover?: SessionsTakeoverOptions;
  /**
   * Потолок машины (спека ёмкости 2026-10-30, 4.2): `CapacityService` хоста. Тип структурный, как у `hooks` и `consents`:
   * сервис ёмкости сам зовёт `launch` сессий, и сессии его не импортируют. `admit` зовётся после бюджета работы и до
   * worktree; нет сервиса — допуска нет (изолированные тесты).
   */
  capacity?: {
    admit(request: { ref: SessionRef; launchClass: LaunchClass }): Promise<MachineTicket>;
    settle(ref: SessionRef): void;
    pump(): void;
  };
}


/**
 * Агент у своего приглашения (спека нормалайзера, 5.7–5.8): ход окончен — `idle` или ещё не просмотренный
 * `unseen`, как у доставки писем (`delivery.ts` в core). `working` и `blocked` — занят; сведений нет — тоже занят:
 * печатать и перезапускать вслепую хост не станет.
 */
export function atPrompt(live: SessionLive | undefined): boolean {
  const state = live?.activity.activity;
  return state === 'idle' || state === 'unseen';
}

/** Отказ «агент занят»: `conflict` с причиной `busy` — окно по ней выбирает свой текст. */
export function busyError(message: string): HostError {
  return new HostError('conflict', message, { reason: HOST_ERROR_REASONS.busy });
}

/** Замок смены модели и effort: вторая смена той же сессии, пока идёт первая, — `busy`. */
export type SwitchLock = (<T>(ref: SessionRef, run: () => Promise<T>) => Promise<T>) & {
  /** Идёт ли сейчас смена этой сессии: `pty.send` в это время не печатает — клавиши смены идут в открытый ползунок. */
  held(ref: SessionRef): boolean;
};

/**
 * Одна смена модели или effort на сессию за раз (спека нормалайзера, 5.7–5.8): двойной клик или `setEffort` во время
 * `setModel` получают `busy` до первой клавиши — клавиши двух смен не смешиваются, перезапуск один. Ключ ставится
 * синхронно, до первого `await`, и снимается и после сбоя.
 */
export function createSwitchLock(): SwitchLock {
  const running = new Set<string>();
  const lock = async <T>(ref: SessionRef, run: () => Promise<T>): Promise<T> => {
    const key = refKey(ref);
    if (running.has(key)) throw busyError('Another model or effort change of this session is in progress');
    running.add(key);
    try {
      return await run();
    } finally {
      running.delete(key);
    }
  };
  return Object.assign(lock, { held: (ref: SessionRef): boolean => running.has(refKey(ref)) });
}

/**
 * Режим одобрений пишущих ролей Codex для запуска (спека 2026-10-21, 5.2). `auto` требует Codex не ниже
 * `CODEX_AUTO_MIN_VERSION`: на старом (и на версии, которую не удалось узнать) незнакомый ключ `approvals_reviewer`
 * сорвал бы старт сессии, поэтому запуск идёт как `terminal`. Прочие режимы от версии не зависят. Сравнение версий —
 * то же, что у `codexFeedSupported`.
 */
export function effectiveCodexWriteApprovals(
  config: Pick<ParleyConfig, 'codexWriteApprovals'>,
  version: string | null,
): CodexWriteApprovals {
  if (config.codexWriteApprovals !== 'auto') return config.codexWriteApprovals;
  return version !== null && feedSupported(version, CODEX_AUTO_MIN_VERSION) ? 'auto' : 'terminal';
}

export function createSessionsService(
  host: HostContext,
  works: WorksService,
  pty: PtyManager,
  activity: ActivityService,
  feed: SessionsFeedOptions = {},
): SessionsService {
  const { hooks, providerVersions, capacity } = feed;
  const spawnLimits = feed.spawnLimits ?? querySpawnLimits;
  const warned = new Set<string>();
  const creationWarnings = new Set<string>();
  const gitWriteGrants = new Map<string, boolean>();

  function needsGitCheck(session: WorkSession | undefined, issuedGrant: boolean | undefined): boolean {
    // После перезапуска хоста прежний grant неизвестен: текущая роль его не отменяет.
    return issuedGrant ?? Boolean(session?.provider === 'codex' && !session.workspace && session.worktree?.createdAt);
  }

  async function checkGit(ref: SessionRef): Promise<void> {
    try {
      await checkProjectConnectivity(ref.projectPath);
    } catch (error) {
      host.log.warn('Git connectivity check failed', { ref, error: String(error) });
      host.broadcast('host.notice', {
        kind: 'git-connectivity-failed', ref,
        text: 'Git repository connectivity check failed; inspect the host log before continuing.',
        at: new Date().toISOString(),
      });
    }
  }

  async function checkWorktreeGit(ref: SessionRef): Promise<void> {
    const map = await readMap(ref.projectPath, ref.workId);
    if (needsGitCheck(map.sessions.find(session => session.id === ref.sessionId), gitWriteGrants.get(refKey(ref)))) await checkGit(ref);
  }

  function deliverWarnings(ref: SessionRef, plan: LaunchPlan): void {
    const diagnostics = plan.diagnostics ?? [];
    for (const message of plan.warnings) {
      if (!diagnostics.some((warning) => warning.message === message)) {
        host.log.warn('session launch warning', { ref, message });
      }
    }
    for (const warning of diagnostics) {
      host.log.warn('session layer warning', { ref, code: warning.code, message: warning.message });
      const key = warning.code === 'provider-override-gap'
        ? warning.code : warning.code === 'role-missing' ? `${refKey(ref)}\0${warning.code}` : `${ref.projectPath}\0${warning.code}`;
      if (warned.has(key)) continue;
      warned.add(key);
      host.broadcast('host.notice', { kind: warning.code, ref, text: warning.message, at: new Date().toISOString() });
    }
  }

  // Одна смена модели или effort на сессию за раз — общий замок `sessions.setEffort` и `sessions.setModel`.
  const exclusive = createSwitchLock();

  // Между чтением карты и `pty.start` есть await-и (план команды, поиск
  // бинаря) — за это время может подоспеть второй вызов на ту же сессию:
  // ручной `sessions.resume` одновременно с подъёмом той же сессии письмом.
  const launching = new Set<string>();

  // Идущие замены агента (спека замены агента, 5.3, 6.13): по сессии — id запроса и его исход. Живут только в памяти
  // этого хоста: `switching` в карте без записи здесь после перезапуска — оборванная замена (`clearStaleSwitches`).
  const switches = new Map<string, { id: string; result: Promise<Result<'sessions.switchAgent'>> }>();
  // Исходы законченных замен по `requestId`: повтор того же запроса — тот же ответ.
  const switched = new Map<string, Result<'sessions.switchAgent'>>();
  // Пакет передачи до первого старта нового агента: Codex, удержанный до согласия на папку, стартует позже.
  const pendingHandovers = new Map<string, string>();

  // Запись карты по выходу процесса идёт асинхронно и без ожидания в самом
  // обработчике `exit` (его сигнатура синхронная) — но `stop()`/`delete()`
  // обязаны вернуться только после того, как карта уже носит `sleeping`, иначе
  // вызывающая сторона (тест, `sessions.delete`) увидит гонку с ещё не
  // дописанным файлом. Промис по каждой сессии живёт здесь до своего
  // завершения, `stop()` его дожидается следом за самим выходом процесса.
  const finalizing = new Map<string, Promise<void>>();

  // Запись `active` после старта процесса идёт позже самого `pty.start`: между
  // ними — await-ы (время старта процесса из ОС, запись карты). Процесс, который
  // вышел сразу (провалившийся `--resume`), иначе успел бы записать `sleeping`
  // раньше, чем `startSession` — `active`, и карта осталась бы с живой сессией
  // без процесса. Выход дожидается записи старта.
  const starting = new Map<string, Promise<void>>();

  // Скилл `parley` в проект и в worktree сессии перед каждым запуском (`agent-skills.ts`).
  const installSkill = createSkillInstaller(host);

  // Поколение этого хоста: им подписаны резервы бюджета. Резерв прошлого поколения без свидетельств неоднозначен —
  // он считается занятым и сам по сроку не снимается (`resource-policy.ts`); новая попытка той же сессии его подхватывает.
  const generation = `host-${randomUUID()}`;

  /**
   * Бюджет исчерпан — безопасный исход: процесс и worktree не создаются, модель не запускается. Автозапуску
   * созданного агентом отказ виден: уведомление человеку и системное письмо родителю (иначе тот ждал бы ребёнка).
   * Окну отказ возвращается ошибкой со значением `data.code = 'resource-budget'`, будильнику — тоже: письма ждут.
   */
  async function refuseLaunch(
    ref: SessionRef,
    parentId: string | null,
    by: string,
    error: ResourceDeniedError,
  ): Promise<never> {
    host.log.warn('launch refused by the resource budget', { ref, by, code: error.code, scope: error.scope });
    if (by === 'auto') {
      const text = `${sessionTag(ref.sessionId)} was not started: ${error.message}`;
      host.broadcast('host.notice', { kind: 'launch-failed', ref, text, at: new Date().toISOString() });
      if (parentId !== null) {
        try {
          // Только письмо: без разбора карты (спека хранилища 6.2).
          writeLetters(ref.projectPath, ref.workId, (letters, current) => {
            if (current.sessions.some((candidate) => candidate.id === parentId)) {
              letters.add({ roomId: null, from: SYSTEM, to: [parentId], text, kind: 'note' });
            }
          });
        } catch (mapError) {
          host.log.error('письмо об отказе запуска не записалось', { ref, error: String(mapError) });
        }
      }
    }
    throw new HostError('conflict', error.message, {
      code: 'resource-budget',
      reason: error.code,
      scope: error.scope,
      limit: error.limit,
      used: error.used,
    });
  }

  /** Резерв слота до запуска: проверка и запись одним действием под замком карты. */
  async function reserveLaunch(
    ref: SessionRef,
    parentId: string | null,
    mode: LaunchMode,
    by: string,
  ): Promise<string> {
    const { config } = await loadConfig();
    let attemptId = '';
    try {
      await updateMap(
        ref.projectPath,
        ref.workId,
        (map) => {
          attemptId = reserveAttempt(map, {
            kind: attemptKindFor(map, ref.sessionId, mode),
            actor: by,
            session: ref.sessionId,
            owner: generation,
            limits: limitsFromConfig(config),
            ...(by === 'wake' ? { sessionResumeRate: config.resumeRate } : {}),
          }).id;
        },
        { touch: false },
      );
    } catch (error) {
      if (error instanceof ResourceDeniedError) return refuseLaunch(ref, parentId, by, error);
      throw error;
    }
    return attemptId;
  }

  /** Исход резерва: `spent` — процесс стартовал, `released` — запуска не было. Трогает только резерв этого поколения. */
  async function settleLaunch(ref: SessionRef, attemptId: string, outcome: 'spent' | 'released'): Promise<void> {
    await updateMap(
      ref.projectPath,
      ref.workId,
      (map) => {
        settleAttempt(map, attemptId, generation, outcome);
      },
      { touch: false },
    ).catch((error: unknown) => {
      host.log.error('исход резерва бюджета не записался', { ref, attemptId, outcome, error: String(error) });
    });
  }

  // Закрываемые сейчас: между остановкой PTY и записью `closed` сессия успевает
  // побыть `sleeping`, и письмо в этот миг подняло бы её обратно.
  const closing = new Set<string>();

  // Прерванные посреди хода на старте хоста (спека 10) — до согласия человека.
  let interruptedRefs: SessionRef[] = [];

  // Процесс вышел — сессия засыпает (спецификация 7.1): письмо её поднимет.
  // Итог `done`/`failed` — другая ось, выход процесса его не трогает.
  pty.on('exit', (ref, exit) => {
    const key = refKey(ref);
    const issuedGitGrant = gitWriteGrants.get(key);
    // Токен приёмника живёт, пока жив процесс: `SessionEnd` приходит до выхода, позже хуков нет.
    hooks?.unregister(ref);
    feed.agent?.unregister(ref);
    const done = (starting.get(key) ?? Promise.resolve())
      .then(async () => {
        try {
          await finishExited(ref.projectPath, ref.workId, ref.sessionId, {
            exitCode: exit.exitCode,
            signal: exit.signal ?? undefined,
          });
        } finally {
          if (issuedGitGrant === true) await checkGit(ref);
          else if (issuedGitGrant === undefined) {
            const map = await readMap(ref.projectPath, ref.workId);
            if (needsGitCheck(map.sessions.find(session => session.id === ref.sessionId), undefined)) await checkGit(ref);
          }
        }
      })
      .catch((error: unknown) => {
        host.log.error('переход сессии в sleeping не записался', { ref, error: String(error) });
      })
      .finally(() => {
        finalizing.delete(key);
      });
    finalizing.set(key, done);
  });

  /**
   * Адрес приёмника хуков для запуска — `claude` не ниже `FEED_MIN_VERSION` и `codex` не ниже
   * `CODEX_FEED_MIN_VERSION`, у Codex ещё и в режиме `parley` настройки `codexWriteApprovals` (хукам нужно доверие
   * человека, спека 2026-10-07, решение 9; `codexHooksWanted`). Версия — проба старта хоста по команде провайдера
   * (короткая, ждём её); нет версии, старый CLI и прочие провайдеры — без хуков, окно покажет терминал.
   */
  async function feedHookUrl(provider: string): Promise<string | undefined> {
    const codex = provider === 'codex';
    if ((!isClaudeCode(provider) && !codex) || hooks === undefined || providerVersions === undefined) return undefined;
    const url = hooks.url();
    if (url === null) return undefined;
    if (codex && !codexHooksWanted((await loadConfig()).config)) return undefined;
    await providerVersions.ready;
    const entry = (await loadProviders())[provider];
    if (entry === undefined) return undefined;
    const version = providerVersions.get(entry.runner.command);
    if (version === null) return undefined;
    return (codex ? codexFeedSupported(version) : feedSupported(version)) ? url : undefined;
  }

  /** Версия CLI провайдера из пробы старта хоста (ждём её, как `feedHookUrl`); проб нет или версия не узнана — `null`. */
  async function providerVersionOf(provider: string): Promise<string | null> {
    if (providerVersions === undefined) return null;
    await providerVersions.ready;
    const entry = (await loadProviders())[provider];
    return entry === undefined ? null : providerVersions.get(entry.runner.command);
  }

  // Уведомление о старом Codex — раз на процесс хоста, а не на каждый запуск.
  let autoUnsupportedNoticed = false;

  /**
   * Режим одобрений запуска Codex (спека 2026-10-21, 5.2): настройка и проба версии. `auto` на старом Codex —
   * `terminal`, и об этом одно уведомление `codex-auto-unsupported` на процесс хоста.
   */
  async function codexApprovalsFor(ref: SessionRef, provider: string): Promise<CodexWriteApprovals> {
    const { config } = await loadConfig();
    const version = await providerVersionOf(provider);
    const mode = effectiveCodexWriteApprovals(config, version);
    if (config.codexWriteApprovals === 'auto' && mode === 'terminal' && !autoUnsupportedNoticed) {
      autoUnsupportedNoticed = true;
      host.log.warn('codex: режим auto не поддержан этой версией, запуск как terminal', { version, min: CODEX_AUTO_MIN_VERSION });
      if (version !== null) {
        host.broadcast('host.notice', {
          kind: 'codex-auto-unsupported',
          ref,
          text: `Codex ${version} is older than ${CODEX_AUTO_MIN_VERSION}: Auto-review is unavailable, approvals are asked in the terminal. Update Codex to use it.`,
          at: new Date().toISOString(),
        });
      }
    }
    return mode;
  }

  async function readyProvider(provider: string, recorded = false): Promise<ProviderEntry> {
    const entry = (await loadProviders())[provider];
    // Записанная сессия удалённого провайдера — не ошибка ввода: она цела и ждёт, пока человек продолжит её на другом
    // провайдере. `conflict`: состояние сессии не даёт запуск, а не запрос сломан.
    if (entry === undefined && recorded) {
      throw new HostError('conflict', `${provider} is not in Parley: continue the session on another provider`);
    }
    if (entry === undefined) throw new HostError('bad_request', `unknown provider ${provider}; see get_map {field: "providers"}`);
    const readiness = await providerReadiness(entry, {
      ...(providerVersions === undefined ? {} : { probeVersion: (command) => providerVersions.fresh(command) }),
      signedIn: entry.account === undefined ? null : ((await feed.signedIn?.(entry.id)) ?? null),
    });
    const refusal = providerReadinessError(entry, readiness);
    if (refusal !== null) throw new HostError('bad_request', refusal);
    return entry;
  }

  /**
   * PTY жив, а карта говорит `sleeping`: запись старта когда-то не удалась. Окно по карте показывает Resume, а запуск
   * на живом процессе нового не начинает — без починки кнопка молчала бы. Дописываем `active` с приметами того же процесса.
   */
  async function repairLive(ref: SessionRef, handle: PtyHandle): Promise<void> {
    const key = refKey(ref);
    launching.add(key);
    const repaired = (async () => {
      const session = (await readMap(ref.projectPath, ref.workId)).sessions.find(
        (candidate) => candidate.id === ref.sessionId,
      );
      if (session?.lifecycle !== 'sleeping') return;
      host.log.warn('карта отставала от живого процесса — сессия снова active', { ref, pid: handle.pid });
      await startSession(ref.projectPath, ref.workId, ref.sessionId, null, {
        pid: handle.pid,
        startedAtProcess: await processStartedAt(handle.pid),
        launchedBy: 'host',
      });
    })();
    // Как у запуска: выход процесса посреди починки пишет `sleeping` только после неё — иначе `active` с мёртвым pid.
    starting.set(key, repaired.catch(() => {}));
    try {
      await repaired;
    } finally {
      starting.delete(key);
      launching.delete(key);
    }
  }

  async function launch(
    ref: SessionRef,
    mode: LaunchMode,
    options: LaunchChoice = {},
  ): Promise<LaunchOutcome> {
    const key = refKey(ref);
    if (launching.has(key) || closing.has(key)) return 'started';
    const live = pty.get(ref);
    if (live !== undefined) {
      await repairLive(ref, live);
      return 'started';
    }
    launching.add(key);
    try {
      return await launchHeld(ref, mode, options);
    } finally {
      launching.delete(key);
    }
  }

  /**
   * Тело запуска под ключом `launching`, который держит вызывающий: `launch` — на один запуск, `switchAgent` — на всю
   * замену агента (спека замены агента, 6.3). `notify: false` — об отказе скажет сам вызывающий.
   */
  async function launchHeld(
    ref: SessionRef,
    requested: LaunchMode,
    choice: LaunchChoice = {},
    notify = true,
  ): Promise<LaunchOutcome> {
    const key = refKey(ref);
    let mode = requested;
    let options = choice;
    // Замена, чей запуск это: отказ запуска её снимает (5.3 шаг 9).
    let switchingId: string | undefined;
    const timer = createStepTimer();
    let failed = true;
    let held = false;
    // Запуск встал в очередь машины: в журнале шагов это не отказ.
    let queued = false;
    let loggedProvider: string | undefined;
    // Резерв слота бюджета держится до исхода: процесс стартовал — `spent`, любой отказ до старта — `released`.
    let attemptId: string | null = null;
    // Слот машины, взятый у сервиса ёмкости (`start` и `overflow`): держится до старта процесса или отказа запуска.
    let machineReserved = false;
    // Запуск прошёл сверх потолка машины: текст уведомления человеку готов, уходит после старта.
    let overLimit: string | null = null;
    let processStarted = false;
    let agentChannel: { url: string; token: string } | undefined;
    try {
      const map = await timer.step('readMap', () => readMap(ref.projectPath, ref.workId));
      const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
      if (session === undefined) {
        throw new Error(`session ${ref.sessionId} is not in the map of workspace ${ref.workId}`);
      }
      loggedProvider = session.provider;
      // Закрытая не поднимается ничем (спека 7.1): процесс без пути в `active`
      // жил бы без записи в карте.
      if (session.lifecycle === 'closed') {
        throw new Error(`session ${ref.sessionId} is closed`);
      }
      // Архив освобождает процессы агентов: до Reopen сессии работы не поднимает ни письмо, ни человек.
      if (map.work.status === 'archived') {
        throw new HostError('conflict', `workspace ${ref.workId} is archived: reopen it to resume its sessions`);
      }
      // Первый запуск нового агента после замены (спека замены агента, 5.3): новый разговор с пакетом передачи — и у
      // самой замены, и у Resume после отказа, и после согласия на папку Codex.
      if (options.handover === undefined && options.forkFrom === undefined && mode !== 'new') {
        if (awaitingAgent(session)) {
          mode = 'launch';
          options = { ...options, handover: pendingHandovers.get(key) ?? (await recollectHandover(ref, session)) };
        } else if (await forkWithoutFile(session)) {
          // Форк стартовал и вышел, не записав разговор (5.4.1): тот же форк заново, а не голый бриф под его id.
          const retry = await reforkOf(ref, session);
          if (retry === null) {
            mode = 'launch';
            options = { ...options, handover: await recollectHandover(ref, session) };
          } else {
            mode = 'resume';
            options = { ...options, forkFrom: retry.from, prompt: [retry.note, options.prompt ?? ''].filter((part) => part !== '').join('\n\n') };
          }
        }
      }
      switchingId = session.switching?.id;

      // Before planned worktree creation, settings, skills and hook registration; repeated every launch.
      // Первым: отказ готовности провайдера не оставляет следа в карте, в том числе резерва бюджета.
      const entry = await timer.step('provider', () => readyProvider(session.provider, true));

      // Согласие человека на папку (спека 2026-10-21, 4.2) — до бюджета, worktree, скилла и PARLEY.md: удержанный запуск
      // ничего не оставляет. Только Codex: у Claude, GLM и своих провайдеров экрана доверия Parley не заменяет.
      // Нет согласия — карточка и `held`; есть — ключи доверия считаются ниже, уже после создания worktree.
      let trusted = false;
      if (session.provider === 'codex') {
        trusted = await timer.step('trust', () => isTrusted(ref.projectPath));
        if (!trusted && feed.consents !== undefined) {
          const by = options.by ?? 'human';
          // Кто просил: подъём и ручной resume — `resume`, человек — `launch`, агент (`create_session`, автозапуск) —
          // `agent`; сессия просившего — родитель записи или тот, чей id пришёл как `by` (`create_session` ставит его).
          const requester = session.parent ?? (map.sessions.some((candidate) => candidate.id === by) ? by : undefined);
          feed.consents.request(
            {
              projectPath: ref.projectPath,
              folder: await trustKey(ref.projectPath),
              requestedBy: {
                source: mode === 'resume' ? 'resume' : by === 'human' ? 'launch' : 'agent',
                ...(requester === undefined ? {} : { sessionId: requester }),
                workId: ref.workId,
                label: session.label,
              },
            },
            // `new` — быстрая сессия без промпта; после согласия она поднимается обычным запуском.
            { ref, mode: mode === 'resume' ? 'resume' : 'launch', by },
          );
          held = true;
          failed = false;
          return 'held';
        }
      }

      // Допуск — до worktree, скилла и процесса: исчерпанный бюджет не создаёт ничего.
      attemptId = await timer.step('reserve', () => reserveLaunch(ref, session.parent, mode, options.by ?? 'human'));

      // Потолок машины (спека ёмкости, 4.2) — после бюджета работы и тоже до worktree: очередь не оставляет ни каталога,
      // ни скилла, ни процесса. Нет сервиса ёмкости — нет и допуска.
      if (capacity !== undefined) {
        const launchClass = options.launchClass ?? launchClassOf(options.by);
        const ticket = await timer.step('machine', () => capacity.admit({ ref, launchClass }));
        // Движок в очередь не встаёт: допуск отвечает ему `start`.
        if (ticket.kind === 'queue' && launchClass !== 'engine') {
          // Резерв работы снимается раньше записи очереди и насоса: насос может тут же продвинуть эту запись, а после его
          // вызова `launch` ничего не ждёт и сразу отпускает ключ `launching` — иначе запуск насоса упёрся бы в него.
          await settleLaunch(ref, attemptId, 'released');
          attemptId = null;
          await timer.step('queue', () => updateMap(
            ref.projectPath,
            ref.workId,
            (current) => {
              const target = current.sessions.find((candidate) => candidate.id === ref.sessionId);
              // Сессию успели закрыть или поднять другим путём: ждать слота нечему, а запись очереди так и осталась бы.
              if (target === undefined || target.lifecycle === 'closed' || target.lifecycle === 'active') return;
              target.queued = mergeQueued(target.queued, {
                class: launchClass,
                mode: requested,
                by: options.by ?? 'human',
                at: new Date().toISOString(),
                reason: ticket.reason,
                live: ticket.live,
                limit: ticket.limit,
              });
            },
            // Служебная запись, не событие работы: карточка работы не всплывает в сайдбаре.
            { touch: false },
          ));
          host.log.info('запуск ждёт в очереди машины', {
            ref, class: launchClass, reason: ticket.reason, live: ticket.live, limit: ticket.limit,
          });
          queued = true;
          failed = false;
          capacity.pump();
          return 'queued';
        }
        machineReserved = true;
        if (ticket.kind === 'overflow') {
          overLimit = ticket.reason === 'machine-limit'
            ? `${sessionTag(ref.sessionId)} started over the machine limit (${ticket.live + 1}/${ticket.limit})`
            : `${sessionTag(ref.sessionId)} started while memory is critical`;
        }
      }

      // Worktree запланирован (`plannedWorktree` в `create()` или в старой карте
      // в core), но каталога на диске ещё нет — заводим его перед первым же
      // запуском, в том числе перед `resume` прерванной сессии (спека 8.1–8.3).
      if (session.worktree !== null && session.worktree.createdAt === null) {
        const worktree = session.worktree;
        try {
          await timer.step('worktree', () => createWorktree(ref.projectPath, worktree));
        } catch (error) {
          const text = `worktree for ${sessionTag(ref.sessionId)} was not created: ${(error as Error).message}`;
          host.broadcast('host.notice', {
            kind: 'launch-failed',
            ref,
            text,
            at: new Date().toISOString(),
          });
          const parentId = session.parent;
          if (parentId !== null) {
            try {
              writeLetters(ref.projectPath, ref.workId, (letters, current) => {
                if (current.sessions.some((candidate) => candidate.id === parentId)) {
                  letters.add({ roomId: null, from: SYSTEM, to: [parentId], text, kind: 'note' });
                }
              });
            } catch (mapError) {
              host.log.error('письмо о несозданном worktree не записалось', {
                ref,
                error: String(mapError),
              });
            }
          }
          throw error;
        }
        const createdAt = new Date().toISOString();
        worktree.createdAt = createdAt;
        await timer.step('worktree', () => updateMap(ref.projectPath, ref.workId, (current) => {
          const target = current.sessions.find((candidate) => candidate.id === ref.sessionId);
          if (target?.worktree !== null && target?.worktree !== undefined) {
            target.worktree.createdAt = createdAt;
          }
        }));
      }

      // Скилл ставится после worktree: его корень к этому моменту уже на диске. Сбой установки запуск не
      // останавливает — `installSkill` его не бросает.
      await timer.step('skill', () => installSkill(ref, session.worktree?.path ?? null));
      try {
        const result = await timer.step('parleyMd', () => ensureParleyMd(ref.projectPath));
        if (result.receiptError && !creationWarnings.has(ref.projectPath)) {
          creationWarnings.add(ref.projectPath);
          host.log.warn('PARLEY.md accounting could not be completed; automatic recreation is suppressed', { projectPath: ref.projectPath });
        }
        if (result.created) host.broadcast('host.notice', {
          kind: 'parley-md-created', ref,
          text: 'Parley added PARLEY.md — team rules for your agents', at: new Date().toISOString(),
        });
      } catch {
        if (!creationWarnings.has(ref.projectPath)) {
          creationWarnings.add(ref.projectPath);
          host.log.warn('Parley could not create PARLEY.md; this session still starts', { projectPath: ref.projectPath });
        }
      }

      const { hookUrl, codexHookCommand } = await timer.step('hooks', async () => {
        const url = await feedHookUrl(session.provider);
        const codexCommand = url !== undefined && session.provider === 'codex' ? await feed.codexHookCommand?.() : undefined;
        return { hookUrl: url, codexHookCommand: codexCommand };
      });
      const roleCatalog = feed.roleCatalog
        ? await timer.step('roles', () => feed.roleCatalog!(session.workspace?.path ?? session.worktree?.path ?? ref.projectPath))
        : undefined;
      // Канал агента к браузеру (спека браузера 3.7): свой токен на каждый запуск, у всех провайдеров. Адрес и токен
      // уходят только в конфиг MCP-сервера, в окружение процесса — нет.
      const agentUrl = feed.agent?.url() ?? null;
      if (agentUrl !== null && feed.agent !== undefined) agentChannel = { url: agentUrl, token: feed.agent.register(ref) };
      const planFn = mode === 'resume' ? planResume : mode === 'new' ? planNew : planLaunch;
      // Политика одобрений и ключи доверия — только Codex. Ключи — realpath: cwd сессии (worktree) к этому месту уже
      // создан на диске, а до создания `/tmp` и `/private/tmp` дали бы разные ключи, и Codex показал бы экран доверия.
      // Поля `trust` и `codexWriteApprovals` появляются в `LaunchOptions` core вместе с подстановками `{trust}` и
      // `{approvals}` (задача 5): спред их не проверяет.
      const trust = trusted
        ? {
            project: await trustKey(ref.projectPath),
            cwd: await trustKey(session.workspace?.path ?? session.worktree?.path ?? ref.projectPath),
          }
        : undefined;
      const codexApprovals = session.provider === 'codex'
        ? await timer.step('approvals', () => codexApprovalsFor(ref, session.provider))
        : undefined;
      const plan = await timer.step('plan', () => planFn(ref.projectPath, ref.workId, session, {
        channel: false,
        ...(trust === undefined ? {} : { trust }),
        ...(codexApprovals === undefined ? {} : { codexWriteApprovals: codexApprovals }),
        ...(roleCatalog === undefined ? {} : { roleCatalog }),
        ...(hookUrl === undefined ? {} : { hookUrl }),
        ...(codexHookCommand === undefined ? {} : { codexHookCommand }),
        ...(agentChannel === undefined ? {} : { agent: agentChannel }),
        ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
        ...(options.handover === undefined ? {} : { handover: options.handover }),
        ...(options.forkFrom === undefined ? {} : { forkFrom: options.forkFrom }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.effort === undefined ? {} : { effort: options.effort }),
      }));
      deliverWarnings(ref, plan);

      let command: string;
      try {
        command = await timer.step('binary', () => findRunnerBinary(plan.command, process.env));
      } catch (error) {
        host.broadcast('host.notice', {
          kind: 'launch-failed',
          ref,
          text: `session ${ref.sessionId} failed to launch: ${(error as Error).message}`,
          at: new Date().toISOString(),
        });
        throw error;
      }

      // Окружение самого хоста — окружение login-shell от окна (спека 3.2);
      // `agentEnv` чистит унаследованные метки родительской сессии Claude Code
      // (П0), `plan.env` поверх добавляет свои `PARLEY_*` и `HARNAS_*`.
      // Read again after async preparation: key removal/rotation applies to this exact process.
      const runnerSecret = entry.runner.secret;
      const secret = runnerSecret === undefined ? null : await timer.step('secret', () => readSecret(runnerSecret));
      if (entry.runner.secret !== undefined && secret === null && entry.runner.keyOptional !== true) {
        // Ключ могли удалить после проверки готовности: тот же текст отказа, что у `readyProvider`.
        throw new HostError('bad_request', providerReadinessError(entry, { needs: 'key', error: null, version: null })
          ?? 'provider key is missing');
      }
      // Папка своего провайдера и аккаунта подписки готовится перед каждым запуском, и resume тоже (спека своих
      // провайдеров 6.2, К17–К18; спека подписок 5.3): посев, ссылки, доверие к cwd сессии и, только у провайдера с
      // адресом, подтверждение ключа. Сбой — отказ запуска, не падение хоста.
      const record = managedRecord(entry);
      if (record !== undefined) {
        try {
          // Шаги своих провайдеров идут по одному: два запуска одного провайдера не пишут его файл состояния
          // вперемешку, а удаление провайдера не даёт запуску пересоздать только что убранную папку.
          await timer.step('custom-dir', () => serialized(async () => {
            if (!(await readCustomProviders()).some((candidate) => candidate.id === record.id)) {
              throw new Error('the provider was deleted');
            }
            await prepareCustomProviderDir(record, {
              claudeConfigDir: userClaudeConfigDir(),
              warn: (text) => host.log.warn(text, { provider: record.id }),
            });
            await mirrorProjectTrust(record.id, plan.cwd, { userClaudeJson: userClaudeJsonPath() });
            // У аккаунта ключа нет, одобрять нечего. Иначе одобряется то, что реально уйдёт в `ANTHROPIC_API_KEY`:
            // и плейсхолдер loopback без ключа (К17).
            if (!isAccountRecord(record)) {
              const apiKey = secret ?? (entry.runner.keyOptional === true ? LOOPBACK_KEY_PLACEHOLDER : null);
              await syncApiKeyApproval(record.id, entry.runner.auth === 'api-key' ? apiKey : null);
            }
          }));
        } catch (error) {
          host.log.warn('custom provider folder could not be prepared', { ref, provider: record.id, error: String(error) });
          host.broadcast('host.notice', {
            kind: 'launch-failed', ref,
            text: `session ${ref.sessionId} failed to launch: ${entry.label} folder could not be prepared`,
            at: new Date().toISOString(),
          });
          throw new HostError('bad_request', `${entry.label} folder could not be prepared (${(error as Error).message})`);
        }
      }
      // История своего провайдера и аккаунта пишется в `<папка>/projects` (создана `prepareCustomProviderDir`): индекс
      // логов встаёт на неё наблюдателем до старта процесса (спека 5.6). Сбой наблюдателя запуск не отказывает.
      if (isManagedEntry(entry) && entry.runner.configDir !== undefined) {
        try {
          activity.watchClaudeRoot(path.join(entry.runner.configDir, 'projects'));
        } catch (error) {
          host.log.warn('custom provider history root could not be watched', { ref, provider: entry.id, error: String(error) });
        }
      }
      const env = providerLaunchEnv(entry, process.env, plan.env, secret);
      if (session.workspace && plan.env.TMPDIR !== undefined) env.TMPDIR = plan.env.TMPDIR;
      // Свой токен приёмника на каждый запуск (решение А): с ним HTTP-хуки из файла настроек находят
      // сессию. Только при `hookUrl` — без него в файле настроек HTTP-хуков нет, и токен не нужен.
      if (hookUrl !== undefined && hooks !== undefined) {
        // Тот же признак, что у `launch.ts` в файле настроек: имя переменной в файле и в окружении не разойдутся (К13).
        const name = ownsHookToken(entry) ? 'PARLEY_HOOK_CAPABILITY' : 'PARLEY_HOOK_TOKEN';
        // Мост хука Codex (`codex-hook-bin`) читает адрес и токен из окружения процесса — у Claude они в файле настроек.
        if (session.provider === 'codex') env['PARLEY_HOOK_URL'] = hookUrl;
        env[name] = hooks.register(
          ref,
          plan.providerSessionId ?? session.providerSessionId,
          session.provider,
        );
      }
      // `provider` — процессу не нужен, а хосту нужен: у codex состояние берётся из потока его терминала,
      // и ввод идёт своим порядком (спека комнат, 3.6).
      let handle: PtyHandle;
      const previousGitGrant = gitWriteGrants.get(key);
      try {
        // The hook token and inherited host environment are now final. No PTY starts on guard failure.
        handle = await timer.step('spawn', async () => {
          validateSpawnBudget(command, plan.args, env, await spawnLimits());
          gitWriteGrants.set(key, Boolean(session.provider === 'codex' && !session.workspace && session.worktree &&
            plan.args.some(arg => arg.startsWith('sandbox_workspace_write.writable_roots='))));
          const spawned = pty.start(ref, {
            command,
            args: plan.args,
            cwd: plan.cwd,
            env,
            provider: session.provider,
          });
          processStarted = true;
          // Слот теперь держит сам процесс: резерв машины снимается сразу, пока его никто не посчитал дважды.
          if (machineReserved) {
            machineReserved = false;
            capacity?.settle(ref);
          }
          return spawned;
        });
      } catch (error) {
        if (previousGitGrant === undefined) gitWriteGrants.delete(key);
        else gitWriteGrants.set(key, previousGitGrant);
        if (hookUrl !== undefined) hooks?.unregister(ref);
        const safe = (error as NodeJS.ErrnoException).code === 'E2BIG'
          ? new SpawnBudgetError('spawn-budget-too-large') : error;
        if (safe instanceof SpawnBudgetError) {
          host.log.warn('session spawn budget rejected', { ref, code: safe.code, ...safe.details });
          throw new HostError('bad_request', safe.message, { code: safe.code, ...safe.details });
        }
        throw safe;
      }
      const started = (async () => {
        try {
          const stamp = {
            pid: handle.pid,
            startedAtProcess: await processStartedAt(handle.pid),
            launchedBy: 'host' as const,
          };
          for (let attempt = 1; ; attempt += 1) {
            try {
              await startSession(ref.projectPath, ref.workId, ref.sessionId, plan.providerSessionId, stamp,
                plan.env['PARLEY_NATIVE_CONTEXT_REVISION']);
              break;
            } catch (error) {
              // Базу держат другие писатели карты — это пройдёт; прочий сбой повтором не лечится.
              if (!(error instanceof MapLockTimeoutError) || attempt >= START_WRITE_ATTEMPTS) throw error;
              host.log.warn('запись старта сессии ждёт базу работ — повтор', { ref, attempt });
            }
          }
        } finally {
          // Процесс уже идёт: слот потрачен, даже если запись старта в карту не удалась.
          if (attemptId !== null) await settleLaunch(ref, attemptId, 'spent');
        }
      })();
      // Выходу нужен только момент, а не результат: ошибку старта получит вызывающий.
      starting.set(key, started.catch(() => {}));
      try {
        await timer.step('startWrite', () => started);
        failed = false;
      } catch (error) {
        // Процесс идёт, а карта о нём не знает: окно по карте показывало бы спящую рядом с живым процессом.
        // Останавливаем — сессия снова без процесса, как и записано в карте, и Resume поднимет её заново.
        // `starting` снимается до остановки: запись выхода ждёт его и иначе не дождалась бы.
        starting.delete(key);
        await stop(ref).catch((stopError: unknown) => {
          host.log.error('процесс с незаписанным стартом не остановился', { ref, error: String(stopError) });
        });
        throw error;
      } finally {
        starting.delete(key);
      }
      // Сверх потолка машины (спека ёмкости, 4.2): человеку — что запуск прошёл мимо очереди.
      if (overLimit !== null) {
        host.broadcast('host.notice', { kind: 'machine-over-limit', ref, text: overLimit, at: new Date().toISOString() });
      }
      // Форк записывает разговор с первым ходом: копия транскрипта в папке цели уберётся, как только он появится.
      if (options.forkFrom !== undefined) {
        watchFork(ref, session.previousAgents?.at(-1)?.provider ?? session.provider, session.provider, options.forkFrom);
      }
      // Новый агент поднят: замена окончена — `switching` снят, письма ждавшим (спека замены агента, 5.3 шаг 8).
      if (session.switching !== null && session.switching !== undefined) await finishSwitch(ref);
      return 'started';
    } catch (error) {
      if (notify && error instanceof HostError) host.broadcast('host.notice', {
        kind: 'launch-failed', ref,
        text: `session ${ref.sessionId} failed to launch: ${error.message}`,
        at: new Date().toISOString(),
      });
      // Запуск нового агента вне оркестратора (после согласия на папку Codex) отказал: замена окончена, сессия спит с
      // новым провайдером (5.3 шаг 9). Оркестратор снимает `switching` сам.
      if (switchingId !== undefined && !switches.has(key)) await dropSwitch(ref, switchingId);
      throw error;
    } finally {
      // Процесс не стартовал — токен канала никому не нужен.
      if (agentChannel !== undefined && !processStarted) feed.agent?.unregister(ref);
      // Отмена освобождает только свой ожидающий слот: резервы других сессий и прошлых поколений остаются.
      if (attemptId !== null && !processStarted) await settleLaunch(ref, attemptId, 'released');
      // Слот машины, не дошедший до процесса, возвращается сервису ёмкости — после резерва работы: насос, которого этот
      // вызов разбудит, не должен встретить в бюджете работы ещё не снятый резерв.
      if (machineReserved) capacity?.settle(ref);
      host.log.info('запуск сессии: время шагов', {
        ref,
        mode,
        by: options.by ?? 'human',
        ...(loggedProvider === undefined ? {} : { provider: loggedProvider }),
        ...timer.result(),
        ...(held ? { held: true } : {}),
        ...(queued ? { queued: true } : {}),
        ...(failed ? { failed: true } : {}),
      });
    }
  }

  /**
   * Сессию, заведённую `sessions.create`, тут же откроют в терминале — в
   * отличие от той, что поднята письмом, отмечаем её увиденной сразу,
   * чтобы до первого `pty.attach` она не мигала непрочитанной. Запуск Codex, удержанный до согласия на папку,
   * отдаёт `held`: запись `pending` в карте уже есть, процесс стартует сам после решения человека. Запуск, вставший в
   * очередь машины, отдаёт `queued` с причиной очереди: записано то же самое, процесс стартует, когда освободится слот.
   */
  async function createInteractive(
    ref: SessionRef,
    mode: LaunchMode,
    choice: LaunchChoice,
  ): Promise<CreatedSession> {
    const outcome = await launch(ref, mode, choice);
    activity.markSeen(ref);
    if (outcome === 'held') return { ...ref, held: 'folder-trust' };
    if (outcome === 'queued') {
      // Причина — в записи очереди; записи нет (сессию успели поднять или закрыть) — потолок машины.
      const session = (await readMap(ref.projectPath, ref.workId)).sessions.find((candidate) => candidate.id === ref.sessionId);
      return { ...ref, queued: session?.queued?.reason ?? 'machine-limit' };
    }
    return ref;
  }

  /**
   * Быстрые сессии core заводит с именем по умолчанию (`addSession`
   * ставит `defaultSessionName` вместо `NEW_LABEL`) и провайдером claude. Ярлык и
   * провайдер из диалога окна должны остаться — иначе выбор человека молча терялся бы.
   * Пустой ярлык оставляет имя по умолчанию: автозаголовок Claude Code его не меняет
   * (спека архива комнат, раздел 14). Модель, усилие и `lean` ложатся в запись только при явном выборе.
   */
  async function applyChoice(
    ref: SessionRef,
    label: string,
    provider: string,
    role: SessionRole | null,
    choice: LaunchChoice,
    lean: boolean | undefined,
  ): Promise<void> {
    const trimmed = label.trim();
    await updateMap(ref.projectPath, ref.workId, (map) => {
      const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
      if (session === undefined) return;
      if (trimmed !== '') session.label = trimmed;
      session.provider = provider;
      session.role = role;
      if (choice.model !== undefined) session.model = choice.model;
      if (choice.effort !== undefined) session.effort = choice.effort;
      if (lean !== undefined) session.lean = lean;
    });
  }

  /**
   * План worktree пишется в карту сразу; каталог на диске заводит `launch()` перед первым запуском.
   *
   * `brief: true` — бриф сессии уже записан без плана (его пишет создание
   * записи): переписываем его по карте с планом, иначе агент не узнает из
   * брифа свою ветку и базу (fix-guide, п. 3). Быстрой сессии `new` бриф не
   * пишется вовсе — ей и заводить его незачем.
   */
  async function attachWorktreePlan(ref: SessionRef, brief: boolean): Promise<void> {
    const base = await baseBranchOf(ref.projectPath);
    const { config } = await loadConfig();
    const updated = await updateMap(ref.projectPath, ref.workId, (map) => {
      const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
      if (session === undefined) return;
      session.worktree = plannedWorktree(
        ref.projectPath,
        ref.workId,
        ref.sessionId,
        base,
        config.worktreeRoot,
      );
    });
    // Запись успели удалить — плана нет, и бриф собирать не по чему.
    const planned = updated.sessions.some((candidate) => candidate.id === ref.sessionId);
    if (brief && planned) await writeBrief(ref.projectPath, updated, ref.sessionId);
  }

  async function create(input: CreateSessionInput): Promise<CreatedSession> {
    const timer = createStepTimer();
    const logged: { sessionId?: string } = {};
    let failed = true;
    try {
      const ref = await createTimed(input, timer, logged);
      failed = false;
      return ref;
    } finally {
      host.log.info('создание сессии: время шагов', {
        projectPath: input.projectPath,
        workId: input.workId,
        ...(logged.sessionId === undefined ? {} : { sessionId: logged.sessionId }),
        provider: input.provider,
        ...timer.result(),
        ...(failed ? { failed: true } : {}),
      });
    }
  }

  async function createTimed(
    input: CreateSessionInput,
    timer: ReturnType<typeof createStepTimer>,
    logged: { sessionId?: string },
  ): Promise<CreatedSession> {
    const { projectPath, workId, provider, label, task, parent, worktree, lean } = input;
    if (input.workspace !== undefined && (input.requestedBy !== ENGINE || worktree === true || !input.workspace || !['clone', 'artifacts'].includes(input.workspace.kind) || !path.isAbsolute(input.workspace.path) || input.workspace.kind === 'clone' && (!input.workspace.branch || !input.workspace.sha))) throw new HostError('bad_request', 'Only the engine may assign an autonomous workspace.');
    if (input.deferLaunch && input.requestedBy !== ENGINE) throw new HostError('bad_request', 'Only the engine may defer a session launch.');
    if (input.requestedBy !== undefined && (workId === null || !task.trim())) throw new HostError('bad_request', 'Agent-created sessions require a workspace and task.');
    if (input.swarm !== undefined && (input.requestedBy === ENGINE || workId === null || !task.trim() || input.swarm.kind === 'add' && input.requestedBy === undefined)) throw new HostError('bad_request', 'Swarm sessions require a workspace, a task and a human or agent caller.');
    const agentConfig = input.requestedBy === undefined && input.swarm === undefined ? undefined : (await loadConfig()).config;
    if (parent !== null) throw new HostError('bad_request', 'Child sessions are no longer supported. Create a root session and add it to a room.');
    // Secret-dependent GLM must refuse before every create branch. Other providers keep their
    // existing create/launch failure behavior; all launches still use the shared preflight below.
    // Аккаунт подписки отказывает так же рано: своя папка вместо ключа (спека подписок 5.5), и без входа
    // сессия не должна оставить в карте `pending`, которую нечем запустить.
    const early = (await timer.step('providers', () => loadProviders()))[provider]?.runner;
    if (early?.secret !== undefined || early?.configDir !== undefined) {
      await timer.step('providers', () => readyProvider(provider));
    }
    // Модель и усилие — раньше всего: пара не из каталога провайдера отвергается до первой записи в карте (иначе
    // осталась бы `pending`-сессия, которую нечем запустить), а пустое значение — «по умолчанию». Разрешённый выбор
    // пишется в запись сессии на всех путях ниже: повторный запуск и resume берут его оттуда (спека нормалайзера, 5.5).
    // Пустая строка — отсутствие выбора; только явный null очищает default роли до default CLI.
    if (input.agent !== undefined && input.role !== undefined) throw new HostError('bad_request', 'agent-and-role-conflict');
    const role = input.role ?? (input.agent === undefined ? null : { source: 'claude' as const, name: input.agent });
    const registry = await timer.step('providers', () => loadProviders());
    const entry = registry[provider];
    if (!entry) throw new HostError('bad_request', `unknown provider ${provider}; see get_map {field: "providers"}`);
    await timer.step('role', async () => {
      await prepareSessionRole(projectPath, entry, { roleId: roleId(role), provider, mode: 'create' }, feed.roleCatalog ? await feed.roleCatalog(projectPath) : undefined);
    });
    const resolved = await timer.step('model', () => resolveModelChoice(provider, input.model ?? undefined, input.effort ?? undefined));
    // `exactOptionalPropertyTypes`: явный `undefined` ключом в `LaunchChoice` не проходит.
    const choice: LaunchChoice = {
      ...(input.requestedBy === undefined ? {} : { by: input.requestedBy }),
      ...(input.model === null ? { model: null } : resolved.model === undefined ? {} : { model: resolved.model }),
      ...(input.effort === null ? { effort: null } : resolved.effort === undefined ? {} : { effort: resolved.effort }),
    };

    // Проверка до создания сессии — иначе в карте осталась бы pending-сессия, которую нечем завести.
    if (worktree === true && !(await timer.step('git', () => isGitRepo(projectPath)))) {
      throw new HostError('bad_request', 'the project has no git — a worktree cannot be created');
    }

    if (workId === null) {
      const created = await timer.step('record', () => createNewSession(projectPath, null));
      const ref = { projectPath, workId: created.workId, sessionId: created.session.id };
      logged.sessionId = ref.sessionId;
      await timer.step('choice', () => applyChoice(ref, label, provider, role, choice, lean));
      if (worktree === true) await timer.step('worktreePlan', () => attachWorktreePlan(ref, false));
      return timer.step('launch', () => createInteractive(ref, 'new', choice));
    }

    if (task === '') {
      const created = await timer.step('record', () => createNewSession(projectPath, workId));
      const ref = { projectPath, workId, sessionId: created.session.id };
      logged.sessionId = ref.sessionId;
      await timer.step('choice', () => applyChoice(ref, label, provider, role, choice, lean));
      if (worktree === true) await timer.step('worktreePlan', () => attachWorktreePlan(ref, false));
      return timer.step('launch', () => createInteractive(ref, 'new', choice));
    }

    // Codex в проекте без согласия человека: запись `pending` создаётся, а резерв бюджета не берётся — его возьмёт
    // `launch()` после решения (спека 2026-10-21, 4.2). `launch()` проверит согласие сам, здесь — только чтобы не занять слот.
    const awaitsConsent = await timer.step('trust', async () =>
      provider === 'codex' && feed.consents !== undefined && !(await isTrusted(projectPath)));
    let admitted: { ref: SessionRef; attemptId: string } | undefined;
    try {
      const sessionId = await timer.step('record', () => createPendingSession(projectPath, workId, {
        provider,
        label,
        task,
        parent,
        // Только для сайдбара: сессия встаёт под той, что её завела; движок — не сессия.
        ...(input.requestedBy === undefined || input.requestedBy === ENGINE || input.swarm !== undefined ? {} : { createdBy: input.requestedBy }),
        contextFrom: [],
        ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
        role,
        ...choice,
        ...(lean === undefined ? {} : { lean }),
      }, agentConfig === undefined ? undefined : (map, sessionId) => {
        const limits = limitsFromConfig(agentConfig);
        if (input.swarm !== undefined) {
          // Ветка роя (спека роя, 5): рой жив → пороги роёв → общий запуск, как у обычной сессии. `spawned` и `spawnedByRoom`
          // она не читает и не увеличивает. Человек (`swarms.create`, `requestedBy` нет) вызывающего не имеет, пороги агентов
          // не тратит и резерв не берёт: его запуск резервирует `launch()`.
          const caller = input.requestedBy === undefined ? undefined : map.sessions.find(s => s.id === input.requestedBy);
          if (input.requestedBy !== undefined && (!caller || caller.lifecycle === 'closed')) throw new HostError('bad_request', 'The caller session is no longer available.');
          if (map.work.status === 'archived') throw new HostError('bad_request', 'The workspace is archived.');
          admitSwarmSession(map, map.sessions.find(s => s.id === sessionId)!, { spawn: input.swarm, caller, limits, label, task });
          if (input.requestedBy !== undefined && !awaitsConsent) {
            const attempt = reserveAttempt(map, { kind: 'launch', actor: input.requestedBy, session: sessionId, owner: generation, limits });
            admitted = { ref: { projectPath, workId, sessionId }, attemptId: attempt.id };
          }
          return;
        }
        const caller = map.sessions.find(s => s.id === input.requestedBy);
        if (input.requestedBy !== ENGINE && (!caller || caller.lifecycle === 'closed')) throw new HostError('bad_request', 'The caller session is no longer available.');
        if (map.work.status === 'archived') throw new HostError('bad_request', 'The workspace is archived.');
        // Участник роя сессий не создаёт (спека роя, 4): проверка на хосте по карте, текст роли её не заменяет.
        if (input.requestedBy !== ENGINE && swarmOfSession(map, caller!.id) !== null) throw swarmMemberRefusal(caller!.id, 'create sessions');
        const room = input.requestedBy === ENGINE
          ? map.plans?.find(plan => plan.mode === 'autonomous' && plan.autonomous?.ops.some(op => op.kind === 'create-session' && label === `${plan.id}/${op.attemptId}/${op.payload.role}/${op.key}`))?.roomId ?? null
          : roomOfSession(map, caller!.id);
        // Пороги считают создания за последние сутки (журнал `recent`); пожизненные `spawned` и `spawnedByRoom` — только история.
        const now = Date.now();
        const used = recentCreations(map, 'session', now);
        const roomUsed = room === null ? 0 : recentCreations(map, 'session', now, room);
        if (used >= limits.workNewSessions) throw new ResourceDeniedError('new-sessions', 'work', used, limits.workNewSessions);
        if (room !== null && roomUsed >= limits.roomNewSessions) throw new ResourceDeniedError('new-sessions', 'room', roomUsed, limits.roomNewSessions);
        if (!awaitsConsent && !input.deferLaunch) {
          const attempt = reserveAttempt(map, { kind: 'launch', actor: input.requestedBy!, session: sessionId, owner: generation, limits });
          admitted = { ref: { projectPath, workId, sessionId }, attemptId: attempt.id };
        } else {
          // Резерв слота возьмёт `launch()` после решения человека; счётчики созданных сессий растут уже сейчас.
          map.resources ??= { seq: 0, spawned: 0, spawnedByRoom: {}, attempts: [] };
        }
        map.resources!.spawned += 1;
        if (room !== null) map.resources!.spawnedByRoom[room] = (map.resources!.spawnedByRoom[room] ?? 0) + 1;
        noteCreation(map, 'session', room, now);
      }));
      logged.sessionId = sessionId;
      const ref = { projectPath, workId, sessionId };
      if (worktree === true) await timer.step('worktreePlan', () => attachWorktreePlan(ref, true));
      if (input.deferLaunch) return ref;
      const created = await timer.step('launch', () => createInteractive(ref, 'launch', choice));
      // Согласие пропало между проверкой и запуском (отозвано) или запуск встал в очередь машины: резерв, взятый при
      // создании, возвращается. `launchHeld` на очереди уже снял тот же резерв (`reserveAttempt` подхватывает ожидающий
      // резерв этой сессии), так что строка — для ясности; повторное снятие безвредно.
      const reserved = admitted as { ref: SessionRef; attemptId: string } | undefined;
      if ((created.held !== undefined || created.queued !== undefined) && reserved !== undefined) {
        await settleLaunch(reserved.ref, reserved.attemptId, 'released');
      }
      return created;
    } catch (error) {
      if (input.swarm !== undefined && error instanceof ResourceDeniedError) throw swarmBudgetRefusal(error);
      if (admitted !== undefined) {
        await settleLaunch(admitted.ref, admitted.attemptId, 'released');
        throw new HostError(
          error instanceof HostError ? error.code : 'internal',
          `Session ${admitted.ref.sessionId} could not be started: ${error instanceof Error ? error.message : String(error)}. Check get_map before retrying create_session.`,
          { ...(error instanceof HostError ? error.data : {}), ref: admitted.ref },
        );
      }
      throw error;
    }
  }

  async function stop(ref: SessionRef): Promise<void> {
    if (pty.get(ref) !== undefined) await pty.stop(ref);
    // Само событие `exit` уже прошло (см. выше) — если запись карты ещё
    // пишется, дожидаемся её, чтобы вызывающая сторона не читала гонку.
    await finalizing.get(refKey(ref));
  }

  async function setChoice(
    ref: SessionRef,
    choice: { model?: string | null; effort?: string | null },
    closed?: AgentBinding,
  ): Promise<void> {
    await updateMap(ref.projectPath, ref.workId, (map) => {
      const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
      if (session === undefined) {
        throw new HostError('not_found', `session ${ref.sessionId} is not in the map of workspace ${ref.workId}`);
      }
      // `null` — явный «Default» из меню чата: пишется как `null`, а не удаляет поле, иначе после смены
      // вернулось бы умолчание роли.
      if (choice.model !== undefined) session.model = choice.model;
      if (choice.effort !== undefined) session.effort = choice.effort;
      // Смена модели закрывает отрезок расхода (5.9): тот же разговор, новая модель.
      if (closed !== undefined) session.previousAgents = appendAgentBinding(session.previousAgents, closed);
    });
  }

  /**
   * Модель проверяет resolver; сохранённый effort остаётся, если он есть у новой модели, иначе сбрасывается в
   * «по умолчанию». Та же модель, что в карте, — ничего не пишется и не перезапускается. Сессия без процесса (спит,
   * закрыта, ждёт запуска) — только запись в карту: следующий запуск или resume возьмёт новую модель. Живая — только
   * у приглашения и без фоновых задач: запись в карту, остановка и resume с флагами из карты. Resume не поднялся —
   * ошибка уходит окну, а карта уже с новой моделью: кнопка Resume повторит запуск. Всё — под замком `exclusive`.
   */
  async function setModel(
    ref: SessionRef,
    model: string,
  ): Promise<{ model: string; effort: string | null; restarted: boolean }> {
    return exclusive(ref, async () => {
      const session = (await readMap(ref.projectPath, ref.workId)).sessions.find(
        (candidate) => candidate.id === ref.sessionId,
      );
      if (session === undefined) {
        throw new HostError('not_found', `session ${ref.sessionId} is not in the map of workspace ${ref.workId}`);
      }
      const entry = (await loadProviders())[session.provider];
      if (entry === undefined || !isClaudeCode(entry)) {
        throw new HostError('bad_request', 'the model of a session can be changed only for Claude Code sessions');
      }
      const next = (await resolveModelChoice(session.provider, model)).model;
      // Шаблон запуска без `{model}` (свои `args` в providers.json): модель до CLI не доедет — менять нечего.
      if (next === undefined) throw new HostError('bad_request', `provider ${entry.id} does not accept a model`);
      // Та же модель — ни записи, ни перезапуска: меню отмечает её и так.
      if (next === session.model) return { model: next, effort: session.effort ?? null, restarted: false };
      // Нет выбора effort — его нет и после смены (умолчание роли не вытесняется); выбор, которого у новой модели
      // нет, становится явным «Default» (`null`).
      const effort =
        session.effort === undefined
          ? undefined
          : session.effort !== null && (effortsFor(entry, next)?.some((level) => level.id === session.effort) ?? false)
            ? session.effort
            : null;
      // Сессия сейчас поднимается: процесса ещё нет, но он уже прочитал старую модель из карты — запись «для неживой»
      // и следующий запуск молча остались бы с ней.
      if (launching.has(refKey(ref))) throw busyError('The session is starting; try again in a moment');
      const live = pty.get(ref) !== undefined;
      if (live) {
        const state = activity.get(ref);
        if (!atPrompt(state)) throw busyError('Wait until the agent is idle');
        if (state?.activity.tasks.some((task) => task.background) === true) {
          throw busyError('Wait until background tasks finish');
        }
        // Остановка и resume потеряли бы неотправленный текст; `hasDraft` включает и указатель будильника.
        if (pty.get(ref)?.hasDraft() === true) {
          throw busyError('The input field has unsent text; send or clear it first');
        }
      }
      // Разговор уже был — прежняя модель закрывает отрезок расхода (5.9); без разговора считать нечего.
      let closed: AgentBinding | undefined;
      if (session.providerSessionId !== null) {
        const endedAt = new Date().toISOString();
        const usage = await segmentUsage(session, endedAt);
        closed = {
          provider: session.provider,
          model: session.model ?? null,
          effort: session.effort ?? null,
          providerSessionId: session.providerSessionId,
          startedAt: session.previousAgents?.at(-1)?.endedAt ?? session.startedAt,
          endedAt,
          reason: 'model',
          requestedBy: 'human',
          carried: 'transcript',
          ...(usage === undefined ? {} : { usage }),
          costUsd: await segmentCost(session, endedAt),
        };
      }
      await setChoice(ref, { model: next, ...(effort === undefined ? {} : { effort }) }, closed);
      if (!live) return { model: next, effort: effort ?? null, restarted: false };
      await stop(ref);
      await launch(ref, 'resume');
      return { model: next, effort: effort ?? null, restarted: true };
    });
  }

  /** Имя провайдера для людей и агентов; удалённый из реестра — своим id. */
  const labelOf = (registry: Record<string, ProviderEntry>, id: string): string =>
    providerLabel(registry[id] ?? { id, label: id });

  /** Новый агент ещё не стартовал после замены: прежний агент записан, разговора у нового пока нет. */
  const awaitingAgent = (session: WorkSession): boolean =>
    (session.previousAgents?.length ?? 0) > 0 && session.providerSessionId === null;

  /** Агент продолжал разговор форком, а файла форка в папке его аккаунта нет: форк вышел до первой записи. */
  async function forkWithoutFile(session: WorkSession): Promise<boolean> {
    const last = session.previousAgents?.at(-1);
    if (last?.carried !== 'transcript' || last.providerSessionId === null || session.providerSessionId === null) return false;
    if (session.providerSessionId === last.providerSessionId) return false;
    try {
      return !(await hasConversation(session.provider, session.providerSessionId));
    } catch {
      return false;
    }
  }

  /**
   * Повтор форка от разговора прежнего агента: копия в папке цели обновляется из источника. Не вышло — `null`, и
   * привязка помечается пакетом передачи: новый агент стартует с ним, а следующий запуск форк уже не повторяет.
   */
  async function reforkOf(ref: SessionRef, session: WorkSession): Promise<{ from: string; note: string } | null> {
    const last = session.previousAgents?.at(-1);
    if (last === undefined || last.providerSessionId === null) return null;
    try {
      const carried = await copyTranscript(last.provider, session.provider, last.providerSessionId);
      const registry = await loadProviders();
      return { from: carried.from, note: transcriptNote(session.id, labelOf(registry, session.provider), labelOf(registry, last.provider), last.reason) };
    } catch (error) {
      host.log.warn('форк не повторить — новый агент стартует с пакетом передачи', { ref, error: String(error) });
      await updateMap(ref.projectPath, ref.workId, (map) => {
        const record = map.sessions.find((candidate) => candidate.id === ref.sessionId)?.previousAgents?.at(-1);
        if (record !== undefined) record.carried = 'handover';
      }).catch(() => {});
      return null;
    }
  }

  /** Пакет передачи по карте (`collectHandover`); подмена — `takeover.handover`. */
  const handoverOf = (
    ref: SessionRef,
    previous: Parameters<typeof collectHandover>[3],
    target: Parameters<typeof collectHandover>[4],
    conversation?: string | null,
  ): ReturnType<typeof collectHandover> =>
    (feed.takeover?.handover ?? collectHandover)(ref.projectPath, ref.workId, ref.sessionId, previous, target, conversation);

  /**
   * Пакет для запуска нового агента, когда собранного в памяти нет (хост перезапущен, Resume после отказа): по
   * последней привязке. В карте разговор прежнего агента уже сброшен — хвост берётся по id из привязки; сбой — запуск
   * без пакета.
   */
  async function recollectHandover(ref: SessionRef, session: WorkSession): Promise<string> {
    const last = session.previousAgents?.at(-1);
    if (last === undefined) return '';
    try {
      const registry = await loadProviders();
      const { text } = await handoverOf(
        ref,
        {
          provider: last.provider,
          providerLabel: labelOf(registry, last.provider),
          model: last.model,
          reason: last.reason === 'model' ? 'manual' : last.reason,
          endedAt: last.endedAt,
          resetsAt: null,
        },
        { providerLabel: labelOf(registry, session.provider), model: session.model ?? null },
        last.providerSessionId,
      );
      return text;
    } catch (error) {
      host.log.warn('пакет передачи не собрался — новый агент стартует по брифу', { ref, error: String(error) });
      return '';
    }
  }

  /** Комнаты сессии, куда пишутся строка и письма о замене: где она участник, кроме архивных (спека 6.5). */
  const roomsOfSession = (map: WorkMap, sessionId: string) =>
    map.rooms.filter((room) => room.members.includes(sessionId) && !isRoomArchived(room));

  /**
   * Письма `parley` о замене (спека 6.5): живым ведущим комнат сессии и отправителям непрочитанных писем к ней — тем
   * же, кому ушло письмо о лимите. Детям — ничего: их родитель тот же. В общей комнате письмо идёт в неё, иначе прямое.
   */
  function notifyWaiting(map: WorkMap, letters: LetterTx, session: WorkSession, text: string, at: string): void {
    const rooms = roomsOfSession(map, session.id);
    const to = new Map<string, string | null>();
    for (const room of rooms) {
      const lead = liveLead(map, room);
      if (lead !== null && !to.has(lead)) to.set(lead, room.id);
    }
    for (const message of letters.unreadFor(session.id)) {
      if (to.has(message.from)) continue;
      const shared = message.roomId !== null && rooms.some((room) => room.id === message.roomId) ? message.roomId : null;
      to.set(message.from, shared);
    }
    to.delete(session.id);
    for (const [id, roomId] of to) {
      if (!map.sessions.some((candidate) => candidate.id === id && candidate.lifecycle !== 'closed')) continue;
      if (roomId !== null) parleyNote(map, letters, roomId, id, text, at);
      else letters.add({ roomId: null, from: PARLEY, to: [id], text, kind: 'note', at });
    }
  }

  /** Замена окончена (новый агент поднят): `switching` снят, письма ждавшим, будильник забывает прежний подъём. */
  async function finishSwitch(ref: SessionRef): Promise<void> {
    pendingHandovers.delete(refKey(ref));
    try {
      const registry = await loadProviders();
      await updateMap(ref.projectPath, ref.workId, (map, letters) => {
        const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
        if (session?.switching === null || session?.switching === undefined) return;
        session.switching = null;
        const last = session.previousAgents?.at(-1);
        if (last === undefined) return;
        const text = switchLetter(session.id, labelOf(registry, session.provider), session.model ?? null, labelOf(registry, last.provider), last.reason);
        notifyWaiting(map, letters, session, text, new Date().toISOString());
      });
    } catch (error) {
      host.log.error('конец замены агента не записался', { ref, error: String(error) });
    }
    feed.takeover?.wake?.()?.switched(ref);
  }

  /**
   * Снять `switching` без писем: замена не дошла до старта нового агента. Будильник забывает подъём прежнего агента
   * (указанные письма, удержания): иначе письма, указанные за время замены, больше не указывались бы.
   */
  async function dropSwitch(ref: SessionRef, requestId: string): Promise<void> {
    await updateMap(ref.projectPath, ref.workId, (map) => {
      const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
      if (session?.switching?.id === requestId) session.switching = null;
    }).catch((error: unknown) => {
      host.log.error('switching не снялся после отказа замены', { ref, error: String(error) });
    });
    feed.takeover?.wake?.()?.switched(ref);
  }

  /**
   * Снимок расхода закрываемого отрезка (спека 5.9): записи лога в окне `[начало отрезка, замена)`. Начало — конец
   * прежней привязки или первый старт сессии. Нет индекса лога — снимок, который выход процесса записал в карту,
   * если он того же разговора и отрезок первый (тогда он и есть весь разговор).
   */
  async function segmentUsage(session: WorkSession, endedAt: string): Promise<AgentBinding['usage']> {
    const binding = session.providerSessionId;
    if (binding === null) return undefined;
    const from = session.previousAgents?.at(-1)?.endedAt ?? session.startedAt;
    let usage: UsageSummary | null = null;
    try {
      const resolver = typeof activity.usageResolver === 'function' ? activity.usageResolver() : undefined;
      if (resolver !== undefined) {
        usage =
          (session.previousAgents?.length ?? 0) > 0 && from !== null
            ? await currentSegmentUsage(session, resolver, [{ from, to: endedAt }])
            : from === null
              ? resolver.whole(session)
              : await resolver.slice(session, [{ from, to: endedAt }]);
      }
    } catch (error) {
      host.log.warn('расход отрезка не посчитался', { sessionId: session.id, error: String(error) });
    }
    const frozen = session.metrics?.usage;
    if (usage === null && frozen?.binding === binding && (session.previousAgents?.length ?? 0) === 0) usage = frozen;
    return usage === null ? undefined : freezeUsage(usage, { binding, epoch: session.startedAtProcess, closed: true });
  }

  /** Стоимость закрываемого отрезка по `cost-state` лога (5.9); `null` — лог её не сообщает. */
  async function segmentCost(session: WorkSession, endedAt: string): Promise<number | null> {
    const from = session.previousAgents?.at(-1)?.endedAt ?? session.startedAt;
    if (session.providerSessionId === null || from === null) return null;
    try {
      const resolver = typeof activity.usageResolver === 'function' ? activity.usageResolver() : undefined;
      return (await resolver?.cost?.(session, { from, to: endedAt })) ?? null;
    } catch (error) {
      host.log.warn('стоимость отрезка не посчиталась', { sessionId: session.id, error: String(error) });
      return null;
    }
  }

  /** Почему прежний агент сменён: из застревания, отсутствия в реестре или по просьбе. */
  function switchReason(session: WorkSession, registry: Record<string, ProviderEntry>): Exclude<AgentBinding['reason'], 'model'> {
    if (registry[session.provider] === undefined) return 'provider-missing';
    if (session.stuck?.kind === 'limit') return 'limit';
    if (session.stuck?.kind === 'sign-in') return 'sign-in';
    return 'manual';
  }

  async function switchAgent(ref: SessionRef, request: SwitchRequest): Promise<Result<'sessions.switchAgent'>> {
    const key = refKey(ref);
    const running = switches.get(key);
    if (running !== undefined) {
      // Двойной клик, два окна, остров и Telegram (6.13): тот же запрос ждёт тот же исход, другой — `busy`.
      if (running.id === request.requestId) return running.result;
      throw busyError('The session is already continuing on another provider');
    }
    const done = switched.get(request.requestId);
    if (done !== undefined) return done;
    const result = exclusive(ref, () => runSwitch(ref, request));
    switches.set(key, { id: request.requestId, result });
    try {
      const outcome = await result;
      switched.set(request.requestId, outcome);
      // Память ответов — на повторы одного запроса, а не журнал: старые уходят.
      if (switched.size > SWITCH_RESULTS_KEPT) switched.delete(switched.keys().next().value as string);
      return outcome;
    } finally {
      switches.delete(key);
    }
  }

  /** Шаги 1–9 спеки 5.3 под замком `exclusive` и ключом `launching` на весь срок (6.3). */
  async function runSwitch(ref: SessionRef, request: SwitchRequest): Promise<Result<'sessions.switchAgent'>> {
    const key = refKey(ref);
    const carry = request.carry ?? 'handover';
    const map = await readMap(ref.projectPath, ref.workId);
    const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
    if (session === undefined) {
      throw new HostError('not_found', `session ${ref.sessionId} is not in the map of workspace ${ref.workId}`);
    }
    // Тот же запрос уже удержан согласием на папку Codex: ответ тот же, повторной замены нет.
    if (session.switching?.id === request.requestId) return { outcome: 'held', carried: carry };
    if (session.switching !== null && session.switching !== undefined) {
      throw busyError('The session is already continuing on another provider');
    }
    const choice = await resolveModelChoice(request.provider, request.model ?? undefined, request.effort ?? undefined);
    const target = {
      provider: request.provider,
      ...(request.model === undefined ? {} : { model: request.model === null ? null : (choice.model ?? null) }),
      ...(request.effort === undefined ? {} : { effort: request.effort === null ? null : ((choice.effort as EffortLevel | undefined) ?? null) }),
    };
    const blockers = switchBlockers(map, ref.sessionId, target);
    if (blockers.length > 0) throw new HostError('conflict', blockers.join('; '));
    // Готовность цели — до любых изменений: отказ не трогает прежнего агента.
    const entry = await readyProvider(request.provider);
    const registry = await loadProviders();
    // Продолжение разговора — только между аккаунтами Anthropic (5.4): иначе отказ, тоже до любых изменений.
    if (carry === 'transcript' && !(isClaudeAccount(session.provider, registry[session.provider]) && isClaudeAccount(entry.id, entry))) {
      throw new HostError('bad_request', 'The conversation can be continued only between Claude accounts: use the handover summary');
    }
    // Свежая запись перед проверками занятости: за пробу версии CLI лимит мог сброситься, и будильник вернул агента
    // к работе — по старому снимку его погасили бы посреди хода без `force`.
    const current = (await readMap(ref.projectPath, ref.workId)).sessions.find((candidate) => candidate.id === ref.sessionId);
    if (current === undefined) throw new HostError('not_found', `session ${ref.sessionId} is gone`);
    // От этой проверки до `launching.add` — ни одного `await`: иначе подъём письмом успел бы занять ключ, а `finally`
    // замены снял бы чужой.
    if (current.switching !== null && current.switching !== undefined) {
      throw busyError('The session is already continuing on another provider');
    }
    if (launching.has(key) || closing.has(key)) throw busyError('The session is starting; try again in a moment');
    // Причина — по снимку до остановки: выход процесса и `endBySwitch` снимают `stuck`.
    const reason = switchReason(current, registry);

    // Живой агент: только у приглашения, без фоновых задач и черновика — как у `setModel`. Застрявший в лимите или
    // на входе ход не продолжит и так. Процесс не от хоста гасить нечем — только с `force`.
    const live = pty.get(ref);
    const stuck = current.stuck?.kind === 'limit' || current.stuck?.kind === 'sign-in';
    if (live !== undefined && request.force !== true && !stuck) {
      const state = activity.get(ref);
      if (!atPrompt(state)) throw busyError('Wait until the agent is idle or stop it first');
      if (state?.activity.tasks.some((task) => task.background) === true) {
        throw busyError('Wait until background tasks finish');
      }
      if (live.hasDraft()) throw busyError('The input field has unsent text; send or clear it first');
    }
    if (live === undefined && current.lifecycle === 'active' && request.force !== true) {
      throw busyError('The agent runs outside Parley: stop it first or continue with force');
    }

    const since = new Date().toISOString();
    launching.add(key);
    let applied = false;
    try {
      await updateMap(ref.projectPath, ref.workId, (current) => {
        const record = current.sessions.find((candidate) => candidate.id === ref.sessionId);
        if (record !== undefined) record.switching = { id: request.requestId, to: request.provider, since };
      });
      if (live !== undefined) await stop(ref);
      if (pty.get(ref) !== undefined) throw new HostError('internal', 'the previous agent did not stop');
      await feed.takeover?.stuck?.endBySwitch(ref);

      // Карта после выхода процесса: итоговые метрики и разговор прежнего агента — для пакета и снимка расхода.
      const stopped = (await readMap(ref.projectPath, ref.workId)).sessions.find((candidate) => candidate.id === ref.sessionId);
      if (stopped === undefined) throw new HostError('not_found', `session ${ref.sessionId} is gone`);
      const endedAt = new Date().toISOString();
      const previousLabel = labelOf(registry, stopped.provider);
      const targetLabel = providerLabel(entry);
      // Пакет — после остановки (транскрипт и рабочая копия в конечном виде) и до `applyAgentSwitch` (он сбрасывает
      // разговор, и хвоста не было бы). Сбой пакета замену не останавливает: бриф уйдёт всё равно.
      let handover = '';
      try {
        handover = (
          await handoverOf(
            ref,
            {
              provider: stopped.provider,
              providerLabel: previousLabel,
              model: stopped.model ?? null,
              reason,
              endedAt,
              resetsAt: stopped.stuck?.resetsAt ?? current.stuck?.resetsAt ?? null,
            },
            { providerLabel: targetLabel, model: target.model ?? null },
          )
        ).text;
      } catch (error) {
        host.log.warn('пакет передачи не собрался — новый агент стартует по брифу', { ref, error: String(error) });
      }
      // Перенос разговора (5.4.1): копия транскрипта в папку цели — до замены в карте, пока id прежнего разговора на
      // месте. Сбой или транскрипта нет — откат к пакету передачи, сессия не теряется.
      let transcript: CarriedTranscript | null = null;
      if (carry === 'transcript' && stopped.providerSessionId !== null) {
        try {
          transcript = await copyTranscript(stopped.provider, request.provider, stopped.providerSessionId);
        } catch (error) {
          host.log.warn('транскрипт не скопировался — замена с пакетом передачи', { ref, error: String(error) });
        }
      }
      const usage = await segmentUsage(stopped, endedAt);
      const binding: AgentBinding = {
        provider: stopped.provider,
        model: stopped.model ?? null,
        effort: stopped.effort ?? null,
        providerSessionId: stopped.providerSessionId,
        startedAt: stopped.previousAgents?.at(-1)?.endedAt ?? stopped.startedAt,
        endedAt,
        reason,
        requestedBy: request.by ?? 'human',
        carried: transcript === null ? 'handover' : 'transcript',
        ...(usage === undefined ? {} : { usage }),
        costUsd: await segmentCost(stopped, endedAt),
      };
      await updateMap(ref.projectPath, ref.workId, (current, letters) => {
        const fresh = current.sessions.find((candidate) => candidate.id === ref.sessionId);
        if (fresh?.switching?.id !== request.requestId) throw new HostError('conflict', 'the switch was cancelled');
        current.sessions = applyAgentSwitch(current, ref.sessionId, target, binding, randomUUID()).sessions;
        const line = switchLine(ref.sessionId, targetLabel, target.model ?? null, previousLabel, reason);
        for (const room of roomsOfSession(current, ref.sessionId)) addSystemMessage(current, letters, room.id, line, endedAt);
      });
      applied = true;
      pendingHandovers.set(key, handover);

      const by = request.by ?? 'human';
      // Форка не будет: копия в папке цели убирается, привязка помечается пакетом передачи (5.4.1).
      const dropFork = async (copied: CarriedTranscript): Promise<void> => {
        await discardCopy(copied).catch((cleanup: unknown) => {
          host.log.warn('копия транскрипта не убралась', { ref, error: String(cleanup) });
        });
        await updateMap(ref.projectPath, ref.workId, (current) => {
          const last = current.sessions.find((candidate) => candidate.id === ref.sessionId)?.previousAgents?.at(-1);
          if (last !== undefined) last.carried = 'handover';
        });
      };
      let outcome: LaunchOutcome;
      try {
        if (transcript === null) outcome = await launchHeld(ref, 'launch', { by, handover }, false);
        else {
          try {
            const prompt = transcriptNote(ref.sessionId, targetLabel, previousLabel, reason);
            outcome = await launchHeld(ref, 'resume', { by, forkFrom: transcript.from, prompt }, false);
          } catch (error) {
            // Форк не поднялся: копия убрана, новый агент стартует с пакетом передачи (5.4.1), и ответ это называет.
            host.log.warn('форк разговора не поднялся — запуск с пакетом передачи', { ref, error: String(error) });
            await dropFork(transcript);
            transcript = null;
            outcome = await launchHeld(ref, 'launch', { by, handover }, false);
          }
          // Запуск с форком встал в очередь машины: процесса и форка нет, а запись очереди помнит только вид запуска и `by`,
          // без `forkFrom`. Продолжение поднимет нового агента пакетом передачи (`awaitingAgent`), поэтому копия не нужна,
          // а записи и ответ должны говорить то же.
          if (outcome === 'queued' && transcript !== null) {
            await dropFork(transcript);
            transcript = null;
          }
        }
      } catch (error) {
        // Шаг 9: карта уже с новым провайдером, сессия спит; Resume повторит запуск, обратная замена — тот же метод.
        await dropSwitch(ref, request.requestId);
        host.broadcast('host.notice', {
          kind: 'launch-failed',
          ref,
          text: `${sessionMention(ref.sessionId)} did not start on ${targetLabel}: ${(error as Error).message}. Resume to retry, or continue it on ${previousLabel} again.`,
          at: new Date().toISOString(),
        });
        throw error;
      }
      // `held`: запуск Codex ждёт согласия на папку; `queued`: машине тесно, запуск ждёт слота в очереди. И там и там
      // `switching` остаётся до старта нового агента, снимет его сам запуск (`finishSwitch`).
      return { outcome, carried: transcript === null ? 'handover' : 'transcript' };
    } catch (error) {
      if (!applied) {
        pendingHandovers.delete(key);
        await dropSwitch(ref, request.requestId);
      }
      throw error;
    } finally {
      launching.delete(key);
    }
  }

  /**
   * Копия транскрипта в папке цели удаляется, как только рядом появился файл форка (5.4.1, п. 1): Claude Code пишет
   * его с первым ходом. Ждём в фоне до `FORK_WAIT_MS`; не дождались или хост перезапущен — копию уберёт
   * `clearStaleSwitches` на следующем старте.
   */
  function watchFork(ref: SessionRef, previous: string, target: string, from: string): void {
    const deadline = Date.now() + FORK_WAIT_MS;
    const check = async (): Promise<void> => {
      const fork = (await readMap(ref.projectPath, ref.workId)).sessions.find((candidate) => candidate.id === ref.sessionId)
        ?.providerSessionId;
      if (fork === null || fork === undefined || fork === from) return;
      if (await removeForkCopy(previous, target, from, fork)) return;
      if (Date.now() < deadline) setTimeout(() => void check().catch(() => {}), FORK_POLL_MS).unref?.();
    };
    setTimeout(() => void check().catch((error: unknown) => {
      host.log.warn('копия транскрипта после форка не убралась', { ref, error: String(error) });
    }), FORK_POLL_MS).unref?.();
  }

  /** Запас лимита аккаунта: 100 минус наибольшая занятость окон; лимитов нет — ниже любого известного. */
  const headroom = (limits: ProviderLimits | null): number =>
    limits === null ? -1 : 100 - Math.max(limits.fiveHour?.usedPercent ?? 0, limits.week?.usedPercent ?? 0);

  async function switchOptions(ref: SessionRef): Promise<Result<'sessions.switchOptions'>> {
    const map = await readMap(ref.projectPath, ref.workId);
    const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
    if (session === undefined) {
      throw new HostError('not_found', `session ${ref.sessionId} is not in the map of workspace ${ref.workId}`);
    }
    const registry = await loadProviders();
    const currentEntry = registry[session.provider];
    const reason = currentEntry === undefined
      ? 'provider-missing'
      : session.stuck?.kind === 'limit' || session.stuck?.kind === 'sign-in'
        ? session.stuck.kind
        : null;

    const readiness = async (entry: ProviderEntry): Promise<{ needs: string | null }> => {
      try {
        const state = await providerReadiness(entry, {
          ...(providerVersions === undefined ? {} : { probeVersion: (command) => providerVersions.fresh(command) }),
          signedIn: entry.account === undefined ? null : ((await feed.signedIn?.(entry.id)) ?? null),
        });
        return { needs: state.needs ?? (state.error === null ? null : 'error') };
      } catch {
        return { needs: 'error' };
      }
    };
    const limitsOf = (id: string): ProviderLimits | null => feed.takeover?.limits?.(id) ?? null;

    const targets: Result<'sessions.switchOptions'>['targets'] = [];
    for (const entry of Object.values(registry)) {
      if (entry.id === session.provider) continue;
      const { needs } = await readiness(entry);
      targets.push({
        id: entry.id,
        label: providerLabel(entry),
        family: entry.family ?? null,
        available: needs === null,
        needs,
        limits: limitsOf(entry.id),
        transcript: isClaudeAccount(session.provider, currentEntry) && isClaudeAccount(entry.id, entry),
      });
    }

    // Подсказка (6.10): вошедший аккаунт того же семейства с наибольшим запасом, иначе готовый другого семейства.
    let alternatives: readonly LimitAlternative[] = [];
    if (currentEntry !== undefined && feed.takeover?.alternatives !== undefined) {
      try {
        alternatives = await feed.takeover.alternatives(session.provider);
      } catch (error) {
        host.log.warn('альтернативы для замены агента не собрались', { ref, error: String(error) });
      }
    }
    const ready = new Set(targets.filter((target) => target.available).map((target) => target.id));
    const same = alternatives.filter((alternative) => ready.has(alternative.id));
    const best = [...same].sort((a, b) => headroom(b.limits) - headroom(a.limits))[0];
    const family = currentEntry?.family;
    const other = targets.find((target) => target.available && (family === undefined || target.family !== family));
    const suggested = best?.id ?? other?.id ?? null;

    const rooms = map.rooms.filter((room) => room.members.includes(session.id));
    let unread = 0;
    try {
      unread = unreadLetters(ref.projectPath, ref.workId, session.id).length;
    } catch (error) {
      host.log.warn('непрочитанное для замены агента не прочиталось', { ref, error: String(error) });
    }
    return {
      current: { provider: session.provider, available: reason === null && currentEntry !== undefined, reason },
      targets,
      suggested,
      keeps: {
        rooms: rooms.length,
        leads: rooms.filter((room) => liveLead(map, room) === session.id).map((room) => room.id),
        owns: map.rooms.filter((room) => room.ownerId === session.id).map((room) => room.id),
        // Дети — и записанные родителем, и заведённые этой сессией через `create_session` (`createdBy`).
        children: map.sessions.filter(
          (child) => child.id !== session.id && (child.parent === session.id || child.createdBy === session.id) && child.lifecycle !== 'closed',
        ).length,
        unread,
        worktree: session.worktree?.branch ?? null,
      },
      // Цель ещё не выбрана: проверки по самой сессии, без «та же цель».
      blockers: switchBlockers(map, session.id, { provider: '' }),
    };
  }

  /**
   * `switching` в карте пережил прежний хост: замена в его памяти оборвалась. Снимается у всех: сессия спит. Прежний
   * агент уже заменён — следующий запуск (Resume, письмо, согласие на папку Codex) поднимет нового с пакетом.
   */
  async function clearStaleSwitches(): Promise<void> {
    let registry: Record<string, ProviderEntry> = {};
    try {
      registry = await loadProviders();
    } catch (error) {
      host.log.warn('реестр провайдеров не прочитался для оборванных замен', { error: String(error) });
    }
    for (const entry of works.snapshot().entries) {
      for (const session of entry.map.sessions) {
        // Копия транскрипта, которую прежний хост не успел убрать после форка (5.4.1): форк уже есть — копия лишняя.
        const last = session.previousAgents?.at(-1);
        if (last?.carried === 'transcript' && last.providerSessionId !== null && session.providerSessionId !== null &&
          session.providerSessionId !== last.providerSessionId) {
          await removeForkCopy(last.provider, session.provider, last.providerSessionId, session.providerSessionId).catch((error: unknown) => {
            host.log.warn('копия транскрипта после форка не убралась', { sessionId: session.id, error: String(error) });
          });
        }
        if (session.switching === null || session.switching === undefined) continue;
        const ref: SessionRef = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id };
        if (switches.has(refKey(ref))) continue;
        const stale = session.switching.id;
        await dropSwitch(ref, stale);
        host.log.warn('замена агента оборвалась вместе с прежним хостом — switching снят', { ref, to: session.switching.to });
        if (awaitingAgent(session)) {
          host.broadcast('host.notice', {
            kind: 'launch-failed',
            ref,
            text: `${sessionMention(session.id)} did not finish continuing on ${labelOf(registry, session.provider)}: Resume starts it.`,
            at: new Date().toISOString(),
          });
        }
      }
    }
  }

  async function close(ref: SessionRef): Promise<void> {
    const key = refKey(ref);
    closing.add(key);
    try {
      // Сначала остановка, потом `closed`: выход процесса дописывает в карту код
      // выхода и итоговые метрики, а закрытую сессию `finishExited` не трогает.
      await stop(ref);
      await updateMap(ref.projectPath, ref.workId, (map) => {
        const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
        if (session === undefined) {
          throw new Error(`session ${ref.sessionId} is not in the map of workspace ${ref.workId}`);
        }
        if (session.lifecycle !== 'closed') transitionSession(map, ref.sessionId, 'closed');
      });
    } finally {
      closing.delete(key);
    }
  }

  async function del(ref: SessionRef, force = false): Promise<void> {
    await stop(ref);
    // Worktree — рабочая копия на диске, а не только запись в карте: грязную
    // без явного согласия теряют молча (спека 8.3), поэтому проверка раньше
    // самого удаления записи.
    const map = await readMap(ref.projectPath, ref.workId).catch(() => null);
    const session = map?.sessions.find((candidate) => candidate.id === ref.sessionId);
    const worktree = session?.worktree;
    const check = needsGitCheck(session, gitWriteGrants.get(refKey(ref)));
    if (worktree !== null && worktree !== undefined && worktree.createdAt !== null) {
      try {
        await discardWorktree(ref.projectPath, worktree, { force });
      } catch (error) {
        if (error instanceof DirtyWorktreeError) throw new HostError('conflict', error.message);
        // Ветка из карты — не ревизия, `.git` worktree подменён: тот же bad_request, что у
        // worktrees.merge/discard.
        if (error instanceof InvalidRevisionError || error instanceof GitStateError) throw gitFailure(error);
        throw error;
      }
    }
    await deleteSession(ref.projectPath, ref.workId, ref.sessionId);
    if (check) await checkGit(ref);
    gitWriteGrants.delete(refKey(ref));
  }

  /**
   * Сессию закрыл `close_session` агента прямо в карте, а её PTY ещё жив: хост
   * гасит процесс сам — закрытая сессия жить не должна. Так же и всякая живая
   * сессия архивной работы: архив освобождает процессы агентов, сессии засыпают.
   */
  function stopRetired(snapshot: WorksView): void {
    for (const entry of snapshot.entries) {
      const archived = entry.map.work.status === 'archived';
      for (const session of entry.map.sessions) {
        if (!archived && session.lifecycle !== 'closed') continue;
        const ref: SessionRef = {
          projectPath: entry.projectPath,
          workId: entry.map.work.id,
          sessionId: session.id,
        };
        const key = refKey(ref);
        if (pty.get(ref) === undefined || closing.has(key)) continue;
        closing.add(key);
        stop(ref)
          .catch((error: unknown) => {
            host.log.error('остановка закрытой сессии не удалась', { ref, error: String(error) });
          })
          .finally(() => closing.delete(key));
      }
    }
  }

  works.onChange((snapshot) => {
    stopRetired(snapshot);
  });

  /** Та же сессия всё ещё спит — её не подняли и не закрыли с момента сбора. */
  function stillSleeping(ref: SessionRef): boolean {
    const session = works
      .entry(ref.projectPath, ref.workId)
      ?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
    return session?.lifecycle === 'sleeping';
  }

  return {
    checkWorktreeGit,
    create,
    launch,
    stop,
    close,
    delete: del,
    setChoice,
    exclusive,
    setModel,
    switchOptions,
    switchAgent,
    clearStaleSwitches,
    live: (ref) => pty.get(ref) !== undefined,
    async stopAll() {
      await Promise.all(
        pty.list().map((handle) =>
          stop(handle.ref).catch((error: unknown) => {
            host.log.error('остановка сессии на выключении хоста не удалась', {
              ref: handle.ref,
              error: String(error),
            });
          }),
        ),
      );
    },
    async collectInterrupted() {
      interruptedRefs = await findInterrupted(works.snapshot().entries, (ref) =>
        openEvents(workPaths(ref.projectPath, ref.workId).events)
          .read(ref.sessionId)
          .catch(() => null),
      );
    },
    interrupted: () => interruptedRefs.filter(stillSleeping),
    async resumeInterrupted(refs) {
      for (const ref of refs) {
        // Поднимаем только тех, кто всё ещё спит: закрытую (спека 7.1) и уже
        // поднятую — нет. Карта — свежим чтением: снимок работ мог отстать.
        const map = await readMap(ref.projectPath, ref.workId).catch(() => null);
        const session = map?.sessions.find((candidate) => candidate.id === ref.sessionId);
        if (session?.lifecycle !== 'sleeping') continue;
        await launch(ref, 'resume').catch((error: unknown) => {
          host.log.error('подъём прерванной сессии не удался', { ref, error: String(error) });
        });
      }
      const asked = new Set(refs.map(refKey));
      interruptedRefs = interruptedRefs.filter((ref) => !asked.has(refKey(ref)));
    },
  };
}
