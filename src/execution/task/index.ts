/**
 * Phase 9F -- Task Type Taxonomy: barrel exports.
 */

export {
  TaskType,
  TaskStatus,
  TASK_TYPE_METADATA,
  TASK_TYPE_PREFIX,
  PREFIX_TO_TASK_TYPE,
  type ConcurrencyClass,
  type ResourceRequirements,
  type TaskTypeMetadata,
  type Task,
} from './types';

export {
  createTaskId,
  parseTaskType,
  createTask,
} from './taskFactory';

export {
  transition,
  InvalidTransitionError,
  type TaskStateTransitionEvent,
  type TransitionListener,
} from './taskStateMachine';

export {
  createTaskRouter,
  type TaskRouter,
  type TaskExecutor,
} from './taskRouter';

export {
  createTaskRegistry,
  type TaskRegistry,
} from './taskRegistry';

export {
  createTaskOutputWriter,
  type TaskOutputWriter,
  type TaskOutputDelta,
} from './taskOutputWriter';

export {
  pollTasks,
  type PollTasksOpts,
  type PollTasksResult,
} from './taskPoller';
