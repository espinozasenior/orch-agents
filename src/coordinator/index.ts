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
