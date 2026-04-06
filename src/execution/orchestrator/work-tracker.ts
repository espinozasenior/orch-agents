/**
 * Work Tracker.
 *
 * Maintains in-memory state for active work items as they progress
 * through SPARC phase execution. Tracks phase results, timing, and outcome.
 */

import type { AgentTracker, AgentExecState } from '../runtime/agent-tracker';
import type { Task } from '../task/types';

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
  failureReason: string | null;
}

export interface WorkTracker {
  start(planId: string, workItemId: string, task?: Task): void;
  complete(planId: string): void;
  fail(planId: string, reason: string): void;
  listActive(): WorkItemState[];
  /** Delegate to AgentTracker for per-agent drill-down (when available). */
  getAgentsByPlan(planId: string): AgentExecState[];
  /** Return the Task associated with a plan, if one was provided at start(). */
  getTask(planId: string): Task | undefined;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export interface WorkTrackerOpts {
  agentTracker?: AgentTracker;
}

export function createWorkTracker(opts: WorkTrackerOpts = {}): WorkTracker {
  const items = new Map<string, WorkItemState>();
  const tasksByPlan = new Map<string, Task>();
  const { agentTracker } = opts;

  return {
    start(planId: string, workItemId: string, task?: Task): void {
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
        failureReason: null,
      });
      if (task) {
        tasksByPlan.set(planId, task);
      }
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

    listActive(): WorkItemState[] {
      return [...items.values()].filter((s) => s.status === 'running');
    },

    getAgentsByPlan(planId: string): AgentExecState[] {
      if (!agentTracker) return [];
      return agentTracker.getAgentsByPlan(planId);
    },

    getTask(planId: string): Task | undefined {
      return tasksByPlan.get(planId);
    },
  };
}
