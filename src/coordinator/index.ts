/**
 * Coordinator module — public API.
 *
 * Re-exports types and functions for the coordinator/worker
 * orchestration pattern (P2).
 */

export type {
  WorkerPhase,
  WorkerStatus,
  ContinueOrSpawn,
  WorkerState,
  TaskNotification,
  CoordinatorState,
  TaskSpec,
  McpClient,
  CoordinatorTaskRequest,
  CoordinatorAction,
} from './types';

export {
  getCoordinatorSystemPrompt,
  getCoordinatorUserContext,
} from './coordinatorPrompt';

export {
  parseTaskNotification,
  isTaskNotification,
} from './notificationParser';

export { decideContinueOrSpawn } from './decisionMatrix';

/**
 * Check whether the current process is running in coordinator mode.
 *
 * P9: Coordinator mode is the default execution model.
 * Opt out by setting CLAUDE_CODE_COORDINATOR_MODE=0.
 */
export function isCoordinatorMode(): boolean {
  return process.env.CLAUDE_CODE_COORDINATOR_MODE !== '0';
}
