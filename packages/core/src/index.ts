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
  EFFORT_DESCRIPTION_MAX,
  EFFORT_TOKEN,
  MODEL_LABEL_MAX,
  PROVIDERS,
  agentEnv,
  codexModelsFile,
  commandBinary,
  commandInPath,
  effortsFor,
  probeCliVersion,
  providerCompatibilityError,
  providerReadiness,
  providerReadinessError,
  loadProviders,
  isClaudeCode,
  claudeConfigDirFor,
  modelChoiceError,
  printCommand,
  providersFile,
  providersWithHistory,
  resolveModelEffort,
  resumeCommand,
  selectableModels,
  startCommand,
  substituteArgs,
  supportsEffort,
  supportsModel,
} from './providers.js';
export { CLAUDE_EFFORTS, LEGACY_EFFORTS, effortLabel } from './provider-models.js';
export type { EffortOption, ModelOption } from './provider-models.js';
export type {
  EffortLevel,
  McpConfigKind,
  ModelEffortChoice,
  ModelEffortResolution,
  ProviderEntry,
  ProviderReadiness,
  ProviderReadinessOptions,
  ProviderFamily,
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
export {
  PAGE_DEFAULT_BYTES,
  PAGE_MAX_BYTES,
  PAGE_MAX_ITEMS,
  PAGE_MIN_BYTES,
  PageError,
  clampPageBytes,
  compactWorkMap,
  listPage,
  mapTopology,
  messagePage,
  pageBySeq,
  parseCursor,
  seqOf,
  textPage,
  viewBytes,
} from './work/context-pages.js';
export type { MapTopology, PageCursor, PageInfo, TextPage, WindowOptions } from './work/context-pages.js';
export type { NewMessage, NewSession, TransitionOptions } from './work/map.js';
export {
  addMember,
  addMemberByLead,
  addRoom,
  addRoomOriginMessage,
  addSystemMessage,
  deleteRoom,
  isDescendant,
  isMember,
  isRoomClosed,
  joinNotice,
  leaveOtherRooms,
  liveLead,
  nextRoomId,
  renameRoom,
  roomLead,
  RoomRuleError,
  setRoomLead,
} from './work/rooms.js';
export type { LeadChange, NewRoom } from './work/rooms.js';
export { leadRecipeBlock, recipeLeadBlock, recipeLeadsPending, reconcileRecipeLeads } from './work/recipe-lead.js';
export { BUILTIN_RECIPES } from './recipes/builtin.js';
export { listRecipeCatalog, expandRecipe, recipeCatalogView, snapshotRecipe } from './recipes/catalog.js';
export { parseProjectRecipe, projectRecipeId } from './recipes/parse.js';
export type {
  ExpandedRecipeAgent,
  ParsedRecipe,
  RecipeAgent,
  RecipeAgentView,
  RecipeCatalog,
  RecipeCatalogView,
  RecipeCode,
  RecipeDefinition,
  RecipeDiagnostic,
  RecipeEntry,
  RecipeEntryView,
  RecipeSnapshot,
} from './recipes/types.js';
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
  autoTitleOf,
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
  resetPointerLabel,
  startSession,
  UNTITLED_WORK,
} from './work/launch.js';
export type { LaunchOptions, LaunchPlan, NewSessionResult, StartedProcess } from './work/launch.js';
export { querySpawnLimits, validateSpawnBudget, SpawnBudgetError } from './work/session-layer.js';
export type { SpawnLimits } from './work/session-layer.js';
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
export {
  SecretFormatError,
  clearSecret,
  normalizeSecret,
  readSecret,
  secretHint,
  writeSecret,
} from './secrets.js';
export type { SecretId } from './secrets.js';
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
export { deliveryAction, isPointerText, pointerText } from './work/delivery.js';
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
export type {
  Capabilities,
  CapabilityAgent,
  CapabilityCommand,
  CapabilitySkill,
  CapabilitySource,
} from './capabilities/types.js';
export { claudeCommands } from './capabilities/claude-commands.js';
export { parseFrontmatter } from './capabilities/frontmatter.js';
export { resolveSkillCatalog } from './skills/catalog.js';
export type { SkillCatalog, SkillCatalogDiagnostic, SkillCatalogOptions } from './skills/catalog.js';
export { searchSkills } from './skills/search.js';
export type { SkillSearchMatch } from './skills/search.js';
export type { NativeSkill, SkillUnavailableReason } from './skills/types.js';
export { scanClaudeCapabilities } from './capabilities/scan.js';
export type { ScanOptions } from './capabilities/scan.js';
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
export { HUMAN, MESSAGE_KINDS, SYSTEM, PARLEY } from './work/types.js';
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

export { createParleyMd, ensureParleyMd } from './work/parley-md.js';

export { BUILTIN_ROLES, modelForTier } from './roles/builtin.js';
export { buildRoleCatalog, listRoleCatalog, resolveRoleChoice, RoleChoiceError } from './roles/catalog.js';
export type { RoleChoice, RequiredRolePermissions, ResolvedRoleChoice } from './roles/catalog.js';
export type { RoleCatalog, RoleDefinition, RoleDiagnostic } from './roles/types.js';
export { readCodexRoleContext, projectCodexRoleContext, readCodexNativeContext } from './roles/context.js';
export type { CodexRoleContext, CodexContextOptions, CodexNativeContext } from './roles/context.js';
export { sessionRole, roleId, roleFromId, sessionRoleCatalog, prepareSessionRole, assertRoleDelivery, roleSummaries } from './work/agents.js';
export type { SessionRoleCatalogOptions, RoleSummary, RoleList } from './work/agents.js';
export type { SessionRole } from './work/types.js';

// Shared project domain. Runtime workPaths continue to use their original local project path.
export { resolveMainCheckout, resolveSharedProjectContext } from './work/project-context.js';
export type { SharedProjectContext, ProjectContextOptions } from './work/project-context.js';
export { sharedProjectPaths, SharedStateError, inspectSharedIgnore, prepareSharedIgnore, withSharedProjectLock, readSharedFile, writeSharedFile } from './work/store.js';
export type { BacklogFileChoice, SharedProjectPaths, SharedDiagnostic, SharedWriteOptions, SharedStateErrorCode, SharedFileSnapshot } from './work/store.js';
export { parseBacklog, readBacklog, addBacklogItem, updateBacklogItem, removeBacklogItem, takeBacklogItem, completeBacklogItem } from './work/backlog.js';
export type { BacklogItem, BacklogDocument, BacklogInput, BacklogPatch, BacklogWriteResult, BacklogSuggestion, SuggestionKind } from './work/backlog.js';
export { listBacklogSuggestions, suggestBacklog, acceptBacklogSuggestion, dismissBacklogSuggestion } from './work/backlog-suggestions.js';
export type { BacklogSuggestionInput, BacklogSuggestionResult, SuggestionOptions } from './work/backlog-suggestions.js';
export { readProjectPreferences, setBacklogFile, setBacklogRule } from './work/project-preferences.js';
export type { BacklogRule, ProjectPreferences } from './work/project-preferences.js';

export { PLAN_ITEM_MAX, PLAN_TEXT_MAX, PlanConflictError, activeRoomPlan, planItemSatisfied, planItemsComplete, cancelRoomPlan, reconcileRoomPlans, setRoomMode, submitPlanItem, updatePlanItem, verifyPlanItem } from './work/plans.js';
export { capturePlanSnapshot, flushPlanSnapshots, PlanSnapshotError } from './work/plan-snapshots.js';
export type { PlanSnapshotFlushResult } from './work/plan-snapshots.js';
export { proposeCompletion } from './work/proposals.js';
export type { ProposalOptions } from './work/proposals.js';
export type { MapCompact } from './work/types.js';
export type { RoomMode, PlanMode, PlanStatus, PlanItemStatus, PlanDraft, PlanItemInput, PlanItem, PlanEvidence, RoomPlan, PlanExportIntent } from './work/types.js';

export { parseProjectMemory, readProjectMemory, addProjectMemory, updateProjectMemory, removeProjectMemory, undoProjectMemory } from './work/project-memory.js';
export type { MemoryKind, MemoryProvenance, MemoryItem, MemoryDocument, MemoryInput, MemoryPatch, MemoryWriteOptions, MemoryWriteResult, MemorySuggestion } from './work/project-memory.js';
export { rememberProjectMemory, listMemorySuggestions, listUndoableMemory, acceptMemorySuggestion, dismissMemorySuggestion } from './work/memory-suggestions.js';
export type { RememberInput, RememberOptions, MemorySuggestionResult, UndoableMemory } from './work/memory-suggestions.js';
export { formatMemoryFactBlock, MEMORY_MAX_BYTES, MEMORY_TRUNCATION_MARKER } from './work/session-layer.js';
export type { MemoryLayerWarning, SessionLayerWarning } from './work/session-layer.js';

export { capturePlanNotice, reservePlanEffects, flushPlanEffects, resumablePlanLetter, summarizePlanEffects } from './work/plan-effects.js';
export type { PlanEffect, PlanBacklogIntent } from './work/types.js';
export type { PlanEffectsSummary, PlanReservation } from './work/plan-effects.js';

export {
  DEFAULT_RESOURCE_LIMITS,
  REQUEST_BUDGET_EXTENSION,
  RESOURCE_COVERAGE,
  RESOURCE_LIMIT_BOUNDS,
  RESOURCE_LIMIT_KEYS,
  RESOURCE_WINDOW_MS,
  ResourceDeniedError,
  admitSpawn,
  assertMessageBudget,
  attemptKindFor,
  countRecipients,
  deniedForAgent,
  limitsFromConfig,
  reserveAttempt,
  resourceStatus,
  roomOfSession,
  settleAttempt,
  settleByEvidence,
  spawnDepthOf,
  teamStartFits,
} from './work/resource-policy.js';
export type {
  Meter,
  MessageRequest,
  ReserveRequest,
  ResourceDeniedCode,
  ResourceLimits,
  ResourceStatus,
  ScopeStatus,
  SpawnRequest,
} from './work/resource-policy.js';
export type { ResourceAttempt, ResourceKind, WorkResources } from './work/types.js';

export { captureDecisionJournal, flushDecisionJournal, validateDecisionJournalStorage, DecisionJournalError, readDecisionJournalFiles, classifyDecisionFile, DECISION_LIST_MAX_FILES } from './work/decision-journal.js';
export type { DecisionJournalIntent, DecisionJournalCode, DecisionJournalFlushResult, DecisionJournalFile, DecisionJournalListing, DecisionFileState } from './work/decision-journal.js';
export { renderRoomHistory, rebuildRoomHistory, shareRoomHistory, unshareRoomHistory, removeLocalRoomHistories, readRoomHistoryStatus, RoomHistoryError } from './work/room-history.js';
export type { RoomHistoryResult, RoomHistoryCode, RoomHistoryState, RoomHistoryStatus } from './work/room-history.js';
export { searchHistory, HistorySearchError, HISTORY_SCOPES } from './work/history-search.js';
export type { HistoryHit, HistoryScope, HistorySource, HistorySearchInput, HistorySearchResult } from './work/history-search.js';

export {
  createUsageLedger,
  freezeUsage,
  legacyUsage,
  selectUsage,
  sumUsage,
  usageKey,
  withDescendants,
  asCount,
  observedCount,
  EPOCH_TOLERANCE_MS,
} from './work/usage-ledger.js';
export type {
  DescendantUsage,
  FrozenUsage,
  KeyedUsage,
  SelectUsageInput,
  UsageAttribution,
  UsageCompleteness,
  UsageCounters,
  UsageObservation,
  UsageSource,
  UsageSummary,
  UsageTotal,
} from './work/usage-ledger.js';
