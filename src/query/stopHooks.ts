// ---------------------------------------------------------------------------
// P11 — Stop hooks bridge: WorkCancelled → AbortController (FR-P11-005/006)
// ---------------------------------------------------------------------------
//
// The query loop's existing `handleStopHooks` integration point already
// supports preventing continuation between turns (returns
// `{ preventContinuation: true }`). What was missing was a way for an
// EXTERNAL signal (the WorkCancelled domain event from a Linear webhook)
// to flip that switch AND propagate an AbortSignal to in-flight tool
// calls.
//
// This module provides:
//
//   1. createWorkCancelledStopRegistry(eventBus): subscribes to
//      WorkCancelled events on the project-wide EventBus and tracks
//      cancelled workItemIds in an in-memory set. Returns:
//        - handleStopHooks: a queryLoop-compatible callback that returns
//          { preventContinuation: true } once the workItemId is cancelled
//        - bindAbortController(workItemId, controller): wires an
//          AbortController to abort the moment WorkCancelled fires for
//          that workItemId. Returns an unbind function.
//        - dispose(): unsubscribes from the EventBus.
//
// The registry is intentionally workItemId-keyed (the WorkCancelledEvent
// payload only has workItemId, no taskId). The orchestrator passes its
// active workItemId at construction time. One registry per executor.
//
// Design note: this module imports the project EventBus types only as
// `type` imports — no runtime dependency. Tests construct a fake bus
// with the same shape.

import type { EventBus } from '../shared/event-bus.js';
import type { WorkCancelledEvent } from '../shared/event-types.js';
import type { QueryMessage } from './state.js';
import type { StopHookResult } from './queryLoop.js';
import type { QueryEventEmitter } from './events.js';

export interface WorkCancelledStopRegistry {
  /** Returns true if the given workItemId has been cancelled. */
  isCancelled(workItemId: string): boolean;
  /**
   * Build a queryLoop-compatible `handleStopHooks` callback that fires
   * `preventContinuation: true` once the bound workItemId is cancelled.
   */
  handleStopHooksFor(workItemId: string): (
    messages: QueryMessage[],
    assistantMessages: QueryMessage[],
  ) => Promise<StopHookResult>;
  /**
   * Bind an AbortController to the given workItemId. The controller is
   * aborted the moment WorkCancelled fires for it. Returns an unbind
   * function the caller MUST invoke on terminal exit (try/finally).
   */
  bindAbortController(workItemId: string, controller: AbortController): () => void;
  /** Tear down the EventBus subscription. Idempotent. */
  dispose(): void;
}

export interface CreateStopRegistryOptions {
  /** Optional observability emitter — fires StopHookFired on cancellation. */
  readonly emit?: QueryEventEmitter;
}

/**
 * Subscribe to WorkCancelled events on the EventBus and expose the
 * stop-hooks bridge. Call `dispose()` when the executor is torn down to
 * remove the subscription.
 */
export function createWorkCancelledStopRegistry(
  eventBus: Pick<EventBus, 'subscribe'>,
  options: CreateStopRegistryOptions = {},
): WorkCancelledStopRegistry {
  const cancelled = new Set<string>();
  const boundControllers = new Map<string, Set<AbortController>>();
  const emit = options.emit;

  const onCancelled = (event: WorkCancelledEvent): void => {
    const workItemId = event.payload.workItemId;
    if (!workItemId) return;
    cancelled.add(workItemId);
    const set = boundControllers.get(workItemId);
    if (set) {
      for (const controller of set) {
        if (!controller.signal.aborted) {
          controller.abort();
        }
      }
    }
  };

  const unsubscribe = eventBus.subscribe('WorkCancelled', onCancelled);
  let disposed = false;

  return {
    isCancelled(workItemId: string): boolean {
      return cancelled.has(workItemId);
    },
    handleStopHooksFor(workItemId: string) {
      return async (): Promise<StopHookResult> => {
        if (cancelled.has(workItemId)) {
          emit?.({
            type: 'StopHookFired',
            reason: 'WorkCancelled',
            // turnCount unknown at this layer; loop will overwrite if needed
            turnCount: 0,
            timestamp: Date.now(),
          });
          return { preventContinuation: true, blockingErrors: [] };
        }
        return { preventContinuation: false, blockingErrors: [] };
      };
    },
    bindAbortController(workItemId: string, controller: AbortController): () => void {
      // If already cancelled before bind, abort immediately.
      if (cancelled.has(workItemId)) {
        if (!controller.signal.aborted) controller.abort();
        return () => {};
      }
      let set = boundControllers.get(workItemId);
      if (!set) {
        set = new Set();
        boundControllers.set(workItemId, set);
      }
      set.add(controller);
      return () => {
        const s = boundControllers.get(workItemId);
        if (s) {
          s.delete(controller);
          if (s.size === 0) boundControllers.delete(workItemId);
        }
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      cancelled.clear();
      boundControllers.clear();
    },
  };
}
