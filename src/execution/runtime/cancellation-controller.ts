/**
 * Cancellation Controller — manages graceful cancellation of agent processes.
 *
 * Sends SIGTERM first, then escalates to SIGKILL after a configurable grace
 * period. Supports cancellation of individual agents or all agents in a plan.
 */

import type { ChildProcess } from 'node:child_process';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface ActiveProcess {
  child: ChildProcess;
  planId: string;
  timer?: ReturnType<typeof setTimeout>;
}

export interface CancellationController {
  register(execId: string, child: ChildProcess, planId: string): void;
  cancel(execId: string, graceMs?: number): boolean;
  cancelPlan(planId: string, graceMs?: number): number;
  unregister(execId: string): void;
  getActiveCount(): number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createCancellationController(): CancellationController {
  const activeProcesses = new Map<string, ActiveProcess>();

  return {
    register(execId: string, child: ChildProcess, planId: string): void {
      activeProcesses.set(execId, { child, planId });
    },

    cancel(execId: string, graceMs = 5000): boolean {
      const entry = activeProcesses.get(execId);
      if (!entry) return false;

      // Send SIGTERM first
      entry.child.kill('SIGTERM');

      // Schedule SIGKILL escalation
      entry.timer = setTimeout(() => {
        try {
          entry.child.kill('SIGKILL');
        } catch {
          // Process may have already exited
        }
      }, graceMs);

      return true;
    },

    cancelPlan(planId: string, graceMs = 5000): number {
      let count = 0;
      for (const [execId, entry] of activeProcesses) {
        if (entry.planId === planId) {
          this.cancel(execId, graceMs);
          count++;
        }
      }
      return count;
    },

    unregister(execId: string): void {
      const entry = activeProcesses.get(execId);
      if (entry?.timer) {
        clearTimeout(entry.timer);
      }
      activeProcesses.delete(execId);
    },

    getActiveCount(): number {
      return activeProcesses.size;
    },
  };
}
