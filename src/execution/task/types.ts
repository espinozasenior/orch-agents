/**
 * Phase 9F -- Task Type Taxonomy: type definitions.
 *
 * Seven task types with type-prefixed IDs, lifecycle states,
 * and per-type metadata for scheduling, retries, and resources.
 */

// ---------------------------------------------------------------------------
// Task type enum
// ---------------------------------------------------------------------------

export enum TaskType {
  local_bash = 'local_bash',
  local_agent = 'local_agent',
  remote_agent = 'remote_agent',
  in_process_teammate = 'in_process_teammate',
  local_workflow = 'local_workflow',
  monitor_mcp = 'monitor_mcp',
  dream = 'dream',
}

// ---------------------------------------------------------------------------
// Task lifecycle status
// ---------------------------------------------------------------------------

export enum TaskStatus {
  pending = 'pending',
  running = 'running',
  completed = 'completed',
  failed = 'failed',
  cancelled = 'cancelled',
}

// ---------------------------------------------------------------------------
// Concurrency class -- determines parallelisation compatibility
// ---------------------------------------------------------------------------

export type ConcurrencyClass =
  | 'shell'
  | 'agent'
  | 'process'
  | 'workflow'
  | 'monitor'
  | 'dream';

// ---------------------------------------------------------------------------
// Resource requirements
// ---------------------------------------------------------------------------

export interface ResourceRequirements {
  memory?: 'low' | 'medium' | 'high';
  cpu?: 'low' | 'medium' | 'high';
}

// ---------------------------------------------------------------------------
// Per-type metadata
// ---------------------------------------------------------------------------

export interface TaskTypeMetadata {
  defaultTimeout: number;
  maxRetries: number;
  concurrencyClass: ConcurrencyClass;
  priority: number; // lower = higher priority
  resourceRequirements: ResourceRequirements;
}

// ---------------------------------------------------------------------------
// Metadata defaults (from spec pseudocode)
// ---------------------------------------------------------------------------

export const TASK_TYPE_METADATA: Record<TaskType, TaskTypeMetadata> = {
  [TaskType.local_bash]: {
    defaultTimeout: 120_000,
    maxRetries: 3,
    concurrencyClass: 'shell',
    priority: 2,
    resourceRequirements: { cpu: 'low' },
  },
  [TaskType.local_agent]: {
    defaultTimeout: 900_000,
    maxRetries: 1,
    concurrencyClass: 'agent',
    priority: 3,
    resourceRequirements: { memory: 'high', cpu: 'high' },
  },
  [TaskType.remote_agent]: {
    defaultTimeout: 900_000,
    maxRetries: 2,
    concurrencyClass: 'agent',
    priority: 3,
    resourceRequirements: { cpu: 'low' },
  },
  [TaskType.in_process_teammate]: {
    defaultTimeout: 300_000,
    maxRetries: 1,
    concurrencyClass: 'process',
    priority: 1,
    resourceRequirements: { memory: 'medium' },
  },
  [TaskType.local_workflow]: {
    defaultTimeout: 1_800_000,
    maxRetries: 0,
    concurrencyClass: 'workflow',
    priority: 2,
    resourceRequirements: { memory: 'medium' },
  },
  [TaskType.monitor_mcp]: {
    defaultTimeout: Infinity,
    maxRetries: Infinity,
    concurrencyClass: 'monitor',
    priority: 1,
    resourceRequirements: { cpu: 'low' },
  },
  [TaskType.dream]: {
    defaultTimeout: 600_000,
    maxRetries: 0,
    concurrencyClass: 'dream',
    priority: 10,
    resourceRequirements: { cpu: 'low', memory: 'low' },
  },
};

// ---------------------------------------------------------------------------
// Type prefix mapping
// ---------------------------------------------------------------------------

export const TASK_TYPE_PREFIX: Record<TaskType, string> = {
  [TaskType.local_bash]: 'lb',
  [TaskType.local_agent]: 'la',
  [TaskType.remote_agent]: 'ra',
  [TaskType.in_process_teammate]: 'ip',
  [TaskType.local_workflow]: 'lw',
  [TaskType.monitor_mcp]: 'mm',
  [TaskType.dream]: 'dr',
};

/** Inverse map: prefix string -> TaskType. */
export const PREFIX_TO_TASK_TYPE: Record<string, TaskType> = Object.fromEntries(
  Object.entries(TASK_TYPE_PREFIX).map(([type, prefix]) => [prefix, type as TaskType]),
) as Record<string, TaskType>;

// ---------------------------------------------------------------------------
// Task interface
// ---------------------------------------------------------------------------

export interface Task {
  readonly id: string;
  readonly type: TaskType;
  status: TaskStatus;
  metadata: TaskTypeMetadata;
  readonly createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: unknown;
  error?: Error;
}
