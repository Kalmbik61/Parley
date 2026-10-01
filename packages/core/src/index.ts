// Имена продукта (R1) — единственный источник, в том числе имён для агентов (сервер MCP, скилл, префикс ветки
// и корень worktree новых сессий).
export {
  BRANCH_PREFIX,
  DEFAULT_WORKTREE_ROOT,
  ENV_PREFIX,
  HOME_DIR,
  LEGACY_ENV_PREFIX,
  LEGACY_HOME_DIR,
  LEGACY_SKILL_NAME,
  LEGACY_STATE_DIR,
  MCP_SERVER_NAME,
  PRODUCT,
  SKILL_NAME,
  STATE_DIR,
  STATE_DIRS,
  bothEnv,
  envName,
  envRaw,
  envValue,
} from './names.js';
export type { Env } from './names.js';
export { forEachJsonlRecord, readJsonlRecords } from './jsonl.js';
export type { JsonlStats, RawRecord } from './jsonl.js';
export { adapterV1 } from './adapter-v1.js';
export type { TokenTotals } from './counters.js';
export type { SchemaAdapter, SessionRecord } from './adapter-v1.js';
export {
  claudeProjectRoots,
  defaultRoot,
  discoverSession,
  discoverSessions,
  sessionFileForPath,
} from './discover.js';
export type { DiscoveredSession, DiscoveredSubagent } from './discover.js';
export { indexSessionFile, projectSlug } from './session-index.js';
export type { IndexSessionOptions, Provider, SessionIndex, TitleSource } from './session-index.js';
export { indexSubsession, readSubagentMeta } from './subsession.js';
export type { SubagentMeta, Subsession } from './subsession.js';
export { buildIndex, buildSessionTree, loadSessionTree } from './session-tree.js';
export type { SessionTree } from './session-tree.js';
export { readSessionWorkflows, readWorkflowDescriptor } from './workflow.js';
export type { WorkflowInfo } from './workflow.js';
export { claudeSource, codexSource, watchSessions } from './watch.js';
export type { SessionChange, SessionWatcher, WatchOptions, WatchSource } from './watch.js';
export { gitBranch } from './git.js';
export { buildAllSessions } from './all-sessions.js';
export type { AllSessionsOptions } from './all-sessions.js';
export { defaultCodexRoot, discoverCodexSessions } from './codex/discover.js';
export type { DiscoveredCodexSession } from './codex/discover.js';
export { buildCodexIndex, indexCodexSession } from './codex/index-session.js';
export { readCodexLimits } from './codex/limits.js';
export { dropExpiredWindows, mergeLimits, readWorkLimits } from './limits.js';
export type { LimitWindow, ProviderLimits } from './limits.js';
export {
  PROVIDERS,
  agentEnv,
  commandBinary,
  commandInPath,
  loadProviders,
  modelChoiceError,
  printCommand,
  providersFile,
  providersWithHistory,
  resumeCommand,
  selectableModels,
  startCommand,
  substituteArgs,
  supportsEffort,
  supportsModel,
} from './providers.js';
export type { ModelOption } from './provider-models.js';
export type {
  EffortLevel,
  McpConfigKind,
  ProviderEntry,
  ProviderInfo,
  ProviderOverride,
  RunnerConfig,
  RunnerSubstitutions,
  SessionLink,
} from './providers.js';
export { modelBadge, modelName, providerBadge, providerMark } from './model-badge.js';
export { buildSchemaReport, observeRecord } from './schema-report.js';
export type { FieldReport, SchemaReport, SchemaReportResult, TypeReport } from './schema-report.js';
export {
  addMessage,
  addSession,
  bumpWorkId,
  canTransition,
  maxNumber,
  nextMessageId,
  nextSessionId,
  nextWorkId,
  parseMap,
  removeSession,
  setResult,
  transitionSession,
} from './work/map.js';
export { displayStatus } from './work/status-view.js';
export { isUnreadFor, markHumanRead, recipientsOf, unreadFor } from './work/letters.js';
export type { NewMessage, NewSession, TransitionOptions } from './work/map.js';
export {
  addMember,
  addMemberByLead,
  addRoom,
  addRoomOriginMessage,
  addSystemMessage,
  isDescendant,
  isMember,
  isRoomClosed,
  joinNotice,
  leaveOtherRooms,
  liveLead,
  nextRoomId,
  roomLead,
  RoomRuleError,
} from './work/rooms.js';
export type { NewRoom } from './work/rooms.js';
export {
  ACCEPTED_LETTER,
  ACCEPTED_LINE,
  PROPOSAL_TEXT_MAX,
  ProposalConflictError,
  resolveProposal,
  RETURNED_LETTER,
  setProposal,
} from './work/proposals.js';
export {
  commitWorktree,
  createWorktree,
  discardWorktree,
  DirtyWorktreeError,
  isGitRepo,
  baseBranchOf,
  checkoutGitDir,
  commitProject,
  gitStateReason,
  GitStateError,
  InvalidRevisionError,
  joinDiffFiles,
  mergeCheck,
  mergeWorktree,
  NothingToCommitError,
  parseCommits,
  parseMergeTree,
  parseNameStatusZ,
  parseNumstat,
  parsePorcelainPaths,
  plannedWorktree,
  projectChanges,
  worktreeDiff,
} from './work/worktree.js';
export type {
  BranchCommit,
  DiffFile,
  GitStateReason,
  MergeCheck,
  MergeResult,
  ProjectChanges,
  WorktreeDiff,
} from './work/worktree.js';
export {
  createWork,
  deleteSessionFiles,
  deleteWorkFiles,
  parleyHome,
  MapLockTimeoutError,
  pruneWorksIndex,
  readMap,
  readWorksIndex,
  renameWork,
  setWorkStatus,
  updateMap,
  WorkNotFoundError,
  workPaths,
  worksIndexPath,
} from './work/store.js';
export type { NewWork, UpdateMapOptions, WorkPaths, WriteOptions } from './work/store.js';
export { ensureStateDir, isDirectorySync, stateDir } from './work/state-dir.js';
export { isStaleHostLock, parseHostLock, readHostLock, socketIsAlive } from './host-lock.js';
export type { HostLock } from './host-lock.js';
export { MIGRATION_RECORD, migrateHome, migrateProjects } from './migrate.js';
export type {
  MigrateHomeOptions,
  MigrationEntry,
  MigrationResult,
  ProjectMigration,
  SkipReason,
} from './migrate.js';
export {
  hostLeaseActive,
  readHostLease,
  removeHostLease,
  writeHostLease,
} from './work/lease.js';
export type { HostLease } from './work/lease.js';
export { decisionsOf, participantLabel, sessionMention, sessionTag, threadOf } from './work/thread.js';
export type { Thread } from './work/thread.js';
export { buildBrief, writeBrief } from './work/brief.js';
export {
  applyAutoTitle,
  createChildSession,
  createNewSession,
  createPendingSession,
  deleteSession,
  finishExited,
  isNewLabel,
  isUntitledWork,
  linkSession,
  NEW_LABEL,
  planLaunch,
  planNew,
  planResume,
  readBrief,
  startSession,
  UNTITLED_WORK,
} from './work/launch.js';
export type { LaunchOptions, LaunchPlan, NewSessionResult, StartedProcess } from './work/launch.js';
export {
  BinaryNotFoundError,
  findBinary,
  findRunnerBinary,
  overrideValue,
  overrideVariable,
} from './work/find-binary.js';
export { GUIDE } from './work/guide.js';
export { SKILL_MD } from './work/skill.js';
export { installAgentSkill } from './work/skill-install.js';
export type {
  SkillInstallOptions,
  SkillInstallResult,
  SkillSkip,
  SkillSkipReason,
} from './work/skill-install.js';
export { systemGuidance } from './work/guidance.js';
export {
  SUMMARIZER,
  SUMMARY_TIMEOUT_MS,
  TRANSCRIPT_LIMIT,
  readTranscript,
  requestAutoSummary,
  summaryPrompt,
} from './work/summary.js';
export type { AutoSummaryOptions, TranscriptOptions } from './work/summary.js';
export { readWorks, watchWorks } from './work/works.js';
export type { WatchWorksOptions, WorkEntry, WorksWatcher } from './work/works.js';
export {
  LINK_TOLERANCE_MS,
  finishSession,
  linkProviderSession,
  readSessionMetrics,
  silenceMs,
} from './work/metrics.js';
export type {
  FinalStatus,
  FinishOptions,
  LinkOptions,
  LinkQuery,
  LiveSessionMetrics,
  MetricsRoots,
} from './work/metrics.js';
export {
  DEFAULT_CONFIG,
  ENV_NAMES,
  configPath,
  loadConfig,
  parseSetting,
  saveConfig,
} from './config.js';
export type { ParleyConfig, LoadedConfig } from './config.js';
export { DEFAULT_BACKGROUND_HOLD_MS, activityOf, hookedSince } from './work/activity.js';
export type {
  Activity,
  ActivityLog,
  ActivityOptions,
  ActivitySource,
  ActivityTask,
  SessionActivity,
} from './work/activity.js';
export {
  TERMINAL_WORKING_EVENT,
  bareEvent,
  eventRecordOf,
  openEvents,
  parseTasks,
  textOf,
  watchEvents,
} from './work/events.js';
export type {
  BackgroundTask,
  EventRecord,
  EventsLog,
  EventsWatcher,
  WatchEventsOptions,
} from './work/events.js';
export { deliveryAction, pointerText } from './work/delivery.js';
export type { DeliveryAction, DeliveryInput } from './work/delivery.js';
export {
  START_TOLERANCE_MS,
  checkSession,
  hasLiveProcess,
  isAlive,
  processStartedAt,
  reconcileMap,
} from './work/liveness.js';
export type { Liveness, LivenessOptions, ReconcileOptions } from './work/liveness.js';
export {
  FEED_HOOK_EVENTS,
  HOOK_COMMAND,
  HOOK_EVENTS,
  workSettings,
  workSettingsJson,
  writeWorkSettings,
} from './work/settings-file.js';
export type {
  HookCommand,
  HookEvent,
  HookHttp,
  HookMatcher,
  SettingsFile,
  WorkSettingsOptions,
} from './work/settings-file.js';
export { FEED_MIN_VERSION, feedSupported } from './work/feed-version.js';
export * from './feed/index.js';
export {
  MCP_SERVER_BIN,
  codexMcpOverride,
  mcpConfig,
  mcpConfigJson,
  mcpConfigValue,
  writeMcpConfig,
} from './work/mcp-config.js';
export type { McpConfigFile, McpConfigParams, McpStdioServer } from './work/mcp-config.js';
export {
  CHANNEL_MIN_VERSION,
  CHANNEL_VALUE,
  NO_CHANNEL_WARNING,
  channelSupported,
  parseVersion,
  probeChannelSupport,
} from './work/channel.js';
export type { ChannelProbe } from './work/channel.js';
export { contextFromEnv } from './mcp/context.js';
export type { McpContext } from './mcp/context.js';
export {
  DEFAULT_TIMEOUT_SEC,
  MAX_TIMEOUT_SEC,
  RATE_WINDOW_MS,
  createParleyServer,
} from './mcp/tools.js';
export { HUMAN, MESSAGE_KINDS, SYSTEM } from './work/types.js';
export type {
  Artifact,
  HistoryEntry,
  LaunchedBy,
  Message,
  MessageKind,
  Proposal,
  Room,
  SessionLifecycle,
  SessionMetrics,
  SessionResult,
  SessionStatus,
  SummarySource,
  Work,
  WorkIndexEntry,
  WorkMap,
  WorkProvider,
  WorkSession,
  WorkStatus,
  WorksIndex,
  WorktreeInfo,
} from './work/types.js';
