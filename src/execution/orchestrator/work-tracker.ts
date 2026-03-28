/**
 * Work Tracker.
 *
 * Maintains in-memory state for active work items as they progress
 * through SPARC phase execution. Tracks phase results, timing, and outcome.
 */

import type { PhaseResult } from '../../types';
import type { AgentTracker, AgentExecState } from '../runtime/agent-tracker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkItemState {
  planId: string;
  workItemId: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt: string | null;
  totalDuration: number;
  phaseResults: PhaseResult[];
  failureReason: string | null;
}

export interface WorkTracker {
  start(planId: string, workItemId: string): void;
  recordPhaseResult(planId: string, result: PhaseResult): void;
  complete(planId: string): void;
  fail(planId: string, reason: string): void;
  getState(planId: string): WorkItemState | undefined;
  listActive(): WorkItemState[];
  cleanup(maxAgeMs: number): void;
  /** Delegate to AgentTracker for per-agent drill-down (when available). */
  getAgentsByPlan(planId: string): AgentExecState[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export interface WorkTrackerOpts {
  agentTracker?: AgentTracker;
}

export function createWorkTracker(opts: WorkTrackerOpts = {}): WorkTracker {
  const items = new Map<string, WorkItemState>();
  const { agentTracker } = opts;

  return {
    start(planId: string, workItemId: string): void {
      if (items.has(planId)) {
        throw new Error(`Plan ${planId} is already tracked`);
      }
      items.set(planId, {
        planId,
        workItemId,
        status: 'running',
        startedAt: new Date().toISOString(),
        completedAt: null,
        totalDuration: 0,
        phaseResults: [],
        failureReason: null,
      });
    },

    recordPhaseResult(planId: string, result: PhaseResult): void {
      const state = items.get(planId);
      if (!state) {
        throw new Error(`Cannot record phase result: plan ${planId} not tracked`);
      }
      state.phaseResults.push(result);
    },

    complete(planId: string): void {
      const state = items.get(planId);
      if (!state) {
        throw new Error(`Cannot complete: plan ${planId} not tracked`);
      }
      state.status = 'completed';
      state.completedAt = new Date().toISOString();
      state.totalDuration = new Date(state.completedAt).getTime() - new Date(state.startedAt).getTime();
    },

    fail(planId: string, reason: string): void {
      const state = items.get(planId);
      if (!state) {
        throw new Error(`Cannot fail: plan ${planId} not tracked`);
      }
      state.status = 'failed';
      state.completedAt = new Date().toISOString();
      state.totalDuration = new Date(state.completedAt).getTime() - new Date(state.startedAt).getTime();
      state.failureReason = reason;
    },

    getState(planId: string): WorkItemState | undefined {
      return items.get(planId);
    },

    listActive(): WorkItemState[] {
      return [...items.values()].filter((s) => s.status === 'running');
    },

    cleanup(maxAgeMs: number): void {
      const now = Date.now();
      for (const [planId, state] of items) {
        if (state.status !== 'running' && state.completedAt) {
          const completedAt = new Date(state.completedAt).getTime();
          if (now - completedAt >= maxAgeMs) {
            items.delete(planId);
          }
        }
      }
    },

    getAgentsByPlan(planId: string): AgentExecState[] {
      if (!agentTracker) return [];
      return agentTracker.getAgentsByPlan(planId);
    },
  };
}
