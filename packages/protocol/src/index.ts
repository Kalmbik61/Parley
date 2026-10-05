export { PROTOCOL_VERSION } from './version.js';
export { HOST_ERROR_REASONS, refKey } from './types.js';
export type {
  ErrorCode,
  FeedCardState,
  FeedDecision,
  FeedItem,
  HostErrorReason,
  HostNotice,
  LimitWindow,
  LiveMetrics,
  LiveTask,
  MailWait,
  ModelOption,
  Capabilities,
  CapabilityAgent,
  CapabilityCommand,
  CapabilitySkill,
  CapabilitySource,
  NoticeKind,
  ProtocolError,
  ProviderLimits,
  SendReason,
  SendResult,
  SessionRef,
  WorksSnapshot,
} from './types.js';
export { METHODS, NOTIFICATIONS, permissionModeChoice, sessionRef } from './methods.js';
export {
  FEED_AGENT_CHILDREN,
  FEED_AGENT_TEXT_LIMIT,
  FEED_DECISION_ANSWERS,
  FEED_DECISION_ANSWER_LIMIT,
  FEED_DECISION_MESSAGE_LIMIT,
  FEED_INPUT_LIMIT,
  FEED_MIN_VERSION,
  FEED_PATCH_LINES,
  FEED_RESULT_LIMIT,
  FEED_SCHEMA_VERSION,
  FEED_TEXT_LIMIT,
  feedCardState,
  feedDecision,
  feedItem,
} from './feed.js';
export type {
  MethodName,
  NotificationName,
  Params,
  PermissionModeChoice,
  Result,
  Results,
} from './methods.js';
export type { EventData, EventName, Events } from './events.js';
export {
  LineDecoder,
  LineTooLongError,
  MAX_LINE_BYTES,
  encodeLine,
  parseIncoming,
} from './framing.js';
export type {
  EventMessage,
  Incoming,
  NotificationMessage,
  RequestMessage,
  ResponseMessage,
} from './framing.js';

export { capabilityProvider, capabilityScope, capabilityDiagnostic, capabilityPresence, capabilityRow, capabilityColumn, capabilitySnapshot } from './capability-snapshot.js';
export type { CapabilityProvider, CapabilityScope, CapabilityDiagnostic, CapabilityPresence, CapabilityRow, CapabilityColumn, CapabilitySnapshot } from './capability-snapshot.js';

export type { RoleList, RoleSummary, SessionRole } from '@parley/core';

export { capabilityMcpInput, capabilityMcpWriteScope, capabilityMcpAdd, capabilityMcpTarget, capabilityActionResult } from './capability-actions.js';
export type { CapabilityMcpInput, CapabilityMcpAdd, CapabilityMcpTarget, CapabilityActionResult } from './capability-actions.js';
export { capabilityActionReason, capabilityActionAvailability, capabilityMcpActions, capabilityMcpAddAvailability } from './capability-snapshot.js';
export type { CapabilityActionReason, CapabilityActionAvailability, CapabilityMcpActions, CapabilityMcpAddAvailability } from './capability-snapshot.js';

export { COMPACT_WORKS_FEATURE, LEGACY_SNAPSHOT_MAX_BYTES, contextPageMethodSchemas } from './context-pages.js';
export type { ContextPageMethodName, ContextPageMethodParams, ContextPageMethodResults } from './context-pages.js';

export { BACKLOG_SNAPSHOT_MAX_BYTES, backlogAuthor, backlogChanged, backlogDiagnostic, backlogErrorCode, backlogItem, backlogMethodSchemas, backlogPrepareTakeResult, backlogRule, backlogSnapshot, backlogSuggestion } from './backlog.js';
export type { BacklogAuthor, BacklogChanged, BacklogDiagnostic, BacklogErrorCode, BacklogMethodName, BacklogMethodParams, BacklogMethodResults, BacklogRule, BacklogSnapshot } from './backlog.js';

export { capabilityPluginActions } from './capability-snapshot.js';
export type { CapabilityPluginActions } from './capability-snapshot.js';
export { CAPABILITY_PLUGIN_RESPONSE_BYTES, capabilityPluginCatalogRequest, capabilityPluginDetailsRequest, capabilityPluginInstallRequest, capabilityPluginTargetRequest,
  capabilityPluginUninstallRequest, capabilityPluginMarketplaceRequest, capabilityPluginComposition, capabilityPluginSummary,
  capabilityPluginCatalogResponse, capabilityPluginDetailsResponse, capabilityPluginResult, capabilityPluginMethodSchemas } from './capability-plugin-actions.js';
export type { CapabilityPluginCatalogRequest, CapabilityPluginDetailsRequest, CapabilityPluginInstallRequest, CapabilityPluginTargetRequest,
  CapabilityPluginUninstallRequest, CapabilityPluginMarketplaceRequest, CapabilityPluginSummary, CapabilityPluginResult,
  CapabilityPluginCatalogResponse, CapabilityPluginDetailsResponse, CapabilityPluginMethodResults } from './capability-plugin-actions.js';

export { planMethodSchemas, planDraft, planEvidence, planActionResult, planEffectsSummary, roomMode } from './plan-actions.js';
export type { PlanMethodName, PlanMethodParams, PlanMethodResults, PlanActionResult } from './plan-actions.js';

export { capabilitySkillActions } from './capability-snapshot.js';
export { capabilitySkillTarget, capabilitySkillResult, capabilitySkillMethodSchemas } from './capability-skill-actions.js';
export type { CapabilitySkillTarget, CapabilitySkillResult, CapabilitySkillMethodResults } from './capability-skill-actions.js';

export { DECISIONS_LIST_MAX_LIMIT, DECISIONS_LIST_DEFAULT_LIMIT, DECISION_FILE_NAME, decisionState, decisionRef, decisionListErrorCode,
  decisionsListResult, historyState, historyDiagnostic, roomHistoryStatus, historyErrorCode, journalMethodSchemas } from './journal.js';
export type { DecisionRef, DecisionsListResult, RoomHistoryStatusView, JournalMethodName, JournalMethodParams, JournalMethodResults } from './journal.js';

export { MEMORY_SNAPSHOT_MAX_BYTES, memoryKind, memoryDiagnostic, memoryItemView, memorySuggestionView, memoryUndoView, memorySnapshot, memoryMethodSchemas } from './memory.js';
export type { MemoryItemView, MemorySuggestionView, MemoryUndoView, MemorySnapshot, MemoryMethodName, MemoryMethodParams, MemoryMethodResults } from './memory.js';

export { SHARED_FILE_PATH, HISTORY_SEARCH_MAX_LIMIT, HISTORY_SEARCH_DEFAULT_LIMIT, historySource, historyScope, historyHit, historySearchResult, historyMethodSchemas } from './history.js';
export type { HistoryHitView, HistorySearchView, HistoryMethodName, HistoryMethodParams, HistoryMethodResults } from './history.js';
