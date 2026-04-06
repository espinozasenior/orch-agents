// ---------------------------------------------------------------------------
// P1 — Query Loop Public API
// ---------------------------------------------------------------------------

export type { TerminalReason, ContinueReason, Terminal, Continue } from './transitions.js';
export type { QueryMessage, ToolUseBlockRef, QueryLoopState } from './state.js';
export { createInitialState } from './state.js';
export type { ModelEvent, ModelTextEvent, ModelToolUseEvent, ModelErrorEvent, QueryDeps } from './deps.js';
export { createTestDeps } from './deps.js';
export {
  queryLoop,
  DEFAULT_MAX_TURNS,
  MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
  OUTPUT_RECOVERY_MESSAGE,
} from './queryLoop.js';
export type {
  QueryParams,
  QueryResult,
  QueryEvent,
  StreamRequestStartEvent,
  AssistantMessageEvent,
  ToolResultEvent,
  ErrorMessageEvent,
  InterruptionEvent,
  CompactionResult,
  StopHookResult,
  BudgetDecision,
  ToolExecutionResult,
} from './queryLoop.js';
export {
  createQueryLoopParams,
  queryMessageToCompact,
  compactMessageToQuery,
} from './queryLoopFactory.js';
export type {
  QueryLoopFactoryDeps,
  QueryLoopCallbacks,
} from './queryLoopFactory.js';

// P11 — observability events, overload retry, and stop hook bridge
export type {
  QueryTransitionEvent,
  OverloadRetryEvent,
  BudgetContinuationEvent,
  StopHookFiredEvent,
  QueryLoopEvent,
  QueryEventEmitter,
} from './events.js';
export {
  callWithOverloadRetry,
  abortableSleep,
  isOverloadedError,
  OverloadExhaustedError,
  OverloadAbortedError,
  DEFAULT_OVERLOAD_MAX_RETRIES,
  DEFAULT_OVERLOAD_BASE_DELAY_MS,
  DEFAULT_OVERLOAD_MAX_DELAY_MS,
  DEFAULT_OVERLOAD_JITTER_RATIO,
} from './overloadRetry.js';
export type { OverloadRetryOptions } from './overloadRetry.js';
export {
  createWorkCancelledStopRegistry,
} from './stopHooks.js';
export type {
  WorkCancelledStopRegistry,
  CreateStopRegistryOptions,
} from './stopHooks.js';
