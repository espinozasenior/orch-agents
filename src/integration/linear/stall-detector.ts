/**
 * Timer-based stall detection for agent execution.
 *
 * Subscribes to AgentSpawned/Completed/Failed/Cancelled events.
 * Emits WorkPaused when an agent has no activity for a configurable
 * timeout (scaled by effort level).
 */

import type { EventBus } from '../../shared/event-bus';
import { createDomainEvent } from '../../shared/event-bus';
import type { Logger } from '../../shared/logger';
import { formatDuration } from '../../shared/format';
import { workItemId as wId } from '../../shared/branded-types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StallDetectorDeps {
  eventBus: EventBus;
  logger: Logger;
}

export type EffortLevel = 'trivial' | 'small' | 'medium' | 'large' | 'epic';

export interface StallDetector {
  /** Start tracking an agent for stalls. */
  startTracking(execId: string, planId: string, agentRole: string, effort: EffortLevel): void;
  /** Stop tracking a specific agent. */
  stopTracking(execId: string): void;
  /** Refresh the last activity timestamp for an agent. */
  refreshActivity(execId: string): void;
  /** Stop all tracking and clean up timers. */
  stopAll(): void;
  /** Wire up automatic event subscriptions. */
  subscribe(): void;
  /** Unsubscribe from all events. */
  unsubscribe(): void;
}

// ---------------------------------------------------------------------------
// Timeout thresholds by effort level (ms)
// ---------------------------------------------------------------------------

export const TIMEOUT_BY_EFFORT: Record<EffortLevel, number> = {
  trivial: 60_000,
  small: 300_000,
  medium: 600_000,
  large: 1_200_000,
  epic: 1_800_000,
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

interface TrackedAgent {
  timer: ReturnType<typeof setInterval>;
  threshold: number;
  lastActivity: number;
  planId: string;
  agentRole: string;
}

export function createStallDetector(deps: StallDetectorDeps): StallDetector {
  const { eventBus, logger } = deps;
  const timers = new Map<string, TrackedAgent>();
  const unsubscribers: Array<() => void> = [];

  function startTracking(
    execId: string,
    planId: string,
    agentRole: string,
    effort: EffortLevel,
  ): void {
    // Clean up existing tracker if any
    stopTracking(execId);

    const threshold = TIMEOUT_BY_EFFORT[effort] ?? TIMEOUT_BY_EFFORT.medium;
    const tracked: TrackedAgent = {
      timer: null as unknown as ReturnType<typeof setInterval>,
      threshold,
      lastActivity: Date.now(),
      planId,
      agentRole,
    };

    const checkInterval = Math.max(threshold / 4, 5000);

    tracked.timer = setInterval(() => {
      const elapsed = Date.now() - tracked.lastActivity;
      if (elapsed > threshold) {
        logger.warn('Agent stall detected', {
          execId,
          planId,
          agentRole,
          stalledForMs: elapsed,
          threshold,
        });

        eventBus.publish(
          createDomainEvent('WorkPaused', {
            workItemId: wId(planId),
            pauseReason: `Agent ${agentRole} stalled for ${formatDuration(elapsed)}`,
            resumable: true,
          }),
        );

        // Stop tracking after emitting stall event
        clearInterval(tracked.timer);
        timers.delete(execId);
      }
    }, checkInterval);

    if (tracked.timer.unref) {
      tracked.timer.unref();
    }

    timers.set(execId, tracked);
  }

  function stopTracking(execId: string): void {
    const entry = timers.get(execId);
    if (entry) {
      clearInterval(entry.timer);
      timers.delete(execId);
    }
  }

  function refreshActivity(execId: string): void {
    const entry = timers.get(execId);
    if (entry) {
      entry.lastActivity = Date.now();
    }
  }

  function stopAll(): void {
    for (const [, entry] of timers) {
      clearInterval(entry.timer);
    }
    timers.clear();
  }

  function subscribe(): void {
    unsubscribers.push(
      eventBus.subscribe('AgentCompleted', (event) => {
        stopTracking(event.payload.execId);
      }),
    );

    unsubscribers.push(
      eventBus.subscribe('AgentFailed', (event) => {
        stopTracking(event.payload.execId);
      }),
    );

    unsubscribers.push(
      eventBus.subscribe('AgentCancelled', (event) => {
        stopTracking(event.payload.execId);
      }),
    );
  }

  function unsubscribeAll(): void {
    for (const unsub of unsubscribers) {
      unsub();
    }
    unsubscribers.length = 0;
  }

  return {
    startTracking,
    stopTracking,
    refreshActivity,
    stopAll,
    subscribe,
    unsubscribe: unsubscribeAll,
  };
}
