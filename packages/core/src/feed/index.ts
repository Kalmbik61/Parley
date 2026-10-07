/** Лента вида «Chat» (план 2026-10-01, Task 1): модель, редьюсер событий хуков, разбор журнала. */

export {
  FEED_AGENT_CHILDREN,
  FEED_AGENT_TEXT_LIMIT,
  FEED_CHILD_INPUT_LIMIT,
  FEED_CHILD_RESULT_LIMIT,
  FEED_INPUT_LIMIT,
  FEED_PATCH_LINES,
  FEED_RESULT_LIMIT,
  FEED_TEXT_LIMIT,
} from './types.js';
export type {
  FeedAgent,
  FeedAgentStatus,
  FeedCard,
  FeedCardState,
  FeedDecision,
  FeedError,
  FeedItem,
  FeedNotice,
  FeedNoticeData,
  FeedPatchHunk,
  FeedPermissionCard,
  FeedPlanCard,
  FeedPrompt,
  FeedQuestion,
  FeedQuestionCard,
  FeedQuestionOption,
  FeedState,
  FeedStream,
  FeedText,
  FeedTool,
  FeedToolResponse,
  FeedToolStatus,
  FeedTurn,
  FeedUpdate,
} from './types.js';
export {
  applyDecision,
  applyHookEvent,
  closeFeedTurn,
  emptyFeedState,
  settleCards,
} from './reduce.js';
export { feedFromTranscript, interruptedAt, retryFromTranscript } from './from-transcript.js';
export type { FeedFromTranscriptOptions } from './from-transcript.js';
export { isHookNoise } from './noise.js';
export { turnActive } from './turn.js';
export { applyCodexRecords, CODEX_HISTORY_IN_TERMINAL, CODEX_HISTORY_MESSAGE, commandText, emptyCodexCursor, feedFromCodexRollout } from './codex/apply-codex.js';
export type { CodexCursor } from './codex/apply-codex.js';
export { parseRolloutLine, rolloutRecordOf } from './codex/rollout-record.js';
export type { RolloutRecord } from './codex/rollout-record.js';
export { codexAgentMeta, emptyCodexAgentMeta, withCodexAgentMeta } from './codex/codex-agents.js';
export type { CodexAgentMeta } from './codex/codex-agents.js';
