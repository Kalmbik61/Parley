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
