// ---------------------------------------------------------------------------
// P11 — Query loop observability event types
// ---------------------------------------------------------------------------
//
// These are NOT DomainEvents. They are lightweight typed payloads emitted
// via an injected `emitEvent` callback. Callers can publish them to a
// DomainEventBus, write them to logs, or ignore them. The query loop
// itself never imports the project-wide EventBus — it only knows about
// the QueryEventEmitter callback shape.
//
// Design note (FR-P11-002 deviation): the spec asked for an explicit
// `QueryState` enum + EventBus-published `TransitionEvent` on every state
// change. We deviated to preserve P10's dependency on the existing
// `state.transition.reason` shape inside queryLoop.ts. Instead, we emit
// QueryTransitionEvent through this lightweight callback whenever the
// loop sets a new transition reason — same observability outcome with
// zero risk to P10.

import type { ContinueReason, TerminalReason } from './transitions.js';

/** Emitted whenever the loop transitions between iterations or terminates. */
export interface QueryTransitionEvent {
  readonly type: 'QueryTransition';
  readonly kind: 'continue' | 'terminal';
  readonly reason: ContinueReason | TerminalReason;
  readonly turnCount: number;
  readonly timestamp: number;
  readonly taskId?: string;
}

/** Emitted on every retry attempt against an overloaded API. */
export interface OverloadRetryEvent {
  readonly type: 'OverloadRetry';
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorMessage: string;
  readonly timestamp: number;
  readonly taskId?: string;
}

/** Emitted when the budget tracker says "continue" with a nudge. */
export interface BudgetContinuationEvent {
  readonly type: 'BudgetContinuation';
  readonly turnCount: number;
  readonly nudgeMessage: string;
  readonly timestamp: number;
  readonly taskId?: string;
}

/** Emitted when a stop hook short-circuits the loop (e.g. WorkCancelled). */
export interface StopHookFiredEvent {
  readonly type: 'StopHookFired';
  readonly reason: string;
  readonly turnCount: number;
  readonly timestamp: number;
  readonly taskId?: string;
}

export type QueryLoopEvent =
  | QueryTransitionEvent
  | OverloadRetryEvent
  | BudgetContinuationEvent
  | StopHookFiredEvent;

/** Callback shape consumed by queryLoop for observability emission. */
export type QueryEventEmitter = (event: QueryLoopEvent) => void;
