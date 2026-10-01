/** Лента вида «Chat» (план 2026-10-01, Task 1): модель, редьюсер событий хуков, разбор журнала. */

export {
  FEED_AGENT_TEXT_LIMIT,
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
export { applyDecision, applyHookEvent, emptyFeedState, settleCards } from './reduce.js';
export { feedFromTranscript } from './from-transcript.js';
export type { FeedFromTranscriptOptions } from './from-transcript.js';
export { isHookNoise } from './noise.js';
