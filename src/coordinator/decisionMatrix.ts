/**
 * Continue-vs-Spawn decision matrix.
 *
 * Determines whether the coordinator should reuse an existing worker
 * (SendMessage / continue) or spawn a fresh one (AgentTool / spawn)
 * based on the worker's state and the next task's requirements.
 */

import type { WorkerState, TaskSpec, ContinueOrSpawn } from './types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decide whether to continue an existing worker or spawn a fresh one.
 *
 * Decision rules (evaluated in order):
 * 1. Verification tasks always spawn fresh (independent eyes).
 * 2. Failure correction always continues (error context is valuable).
 * 3. Low context overlap (<=0.7) spawns fresh (clean slate).
 * 4. High context overlap (>0.7) continues (reuse context).
 */
export function decideContinueOrSpawn(
  worker: WorkerState,
  nextTask: TaskSpec,
): ContinueOrSpawn {
  // Rule 1: Verification always gets fresh eyes
  if (nextTask.type === 'verification') {
    return 'spawn';
  }

  // Rule 2: Failure correction reuses the worker (error context is valuable)
  if (worker.lastStatus === 'failed' && nextTask.type === 'correction') {
    return 'continue';
  }

  // Rules 3 & 4: Context overlap determines the decision
  const overlap = computeOverlap(worker.filesExplored, nextTask.targetFiles);

  if (overlap > 0.7) {
    return 'continue';
  }

  return 'spawn';
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Compute the fraction of target files that the worker has already explored.
 * Returns a value between 0 and 1.
 */
function computeOverlap(explored: string[], target: string[]): number {
  if (target.length === 0) return 0;

  const exploredSet = new Set(explored);
  let count = 0;
  for (const file of target) {
    if (exploredSet.has(file)) {
      count++;
    }
  }

  return count / target.length;
}
