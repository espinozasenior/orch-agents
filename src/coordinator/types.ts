/**
 * Core types for the Coordinator/Worker orchestration pattern (P2).
 *
 * Defines the state shapes for workers, task notifications,
 * coordinator state, and the continue-vs-spawn decision.
 */

/** Phase a worker is executing within the 4-phase workflow. */
export type WorkerPhase = 'research' | 'synthesis' | 'implementation' | 'verification';

/** Runtime status of a worker. */
export type WorkerStatus = 'running' | 'completed' | 'failed' | 'killed';

/** Decision: reuse an existing worker or spawn a fresh one. */
export type ContinueOrSpawn = 'continue' | 'spawn';

/** Tracked state of an individual worker agent. */
export interface WorkerState {
  id: string;
  phase: WorkerPhase;
  status: WorkerStatus;
  description: string;
  filesExplored: string[];
  lastStatus?: WorkerStatus;
  startTime: number;
}

/** XML task-notification payload sent by workers on completion/failure. */
export interface TaskNotification {
  taskId: string;
  status: 'completed' | 'failed' | 'killed';
  summary: string;
  result?: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
}

/** Aggregate coordinator state tracking all workers and findings. */
export interface CoordinatorState {
  workers: Map<string, WorkerState>;
  findings: Map<string, string>;
  currentPhase: WorkerPhase;
}

/** Specification for the next task to assign. */
export interface TaskSpec {
  type: 'research' | 'implementation' | 'verification' | 'correction';
  targetFiles: string[];
  description: string;
}

/** MCP client connection descriptor (minimal shape needed by prompt builder). */
export interface McpClient {
  name: string;
}

/** Task request created by intake adapters (webhook, API, direct). */
export interface CoordinatorTaskRequest {
  id: string;
  source: 'linear-webhook' | 'api' | 'direct';
  issueId?: string;
  issueData?: Record<string, unknown>;
  repoConfig?: { name: string; url: string; defaultBranch?: string };
  description: string;
  priority: number;
}

/** Action the coordinator session decides after processing a notification. */
export type CoordinatorAction =
  | { type: 'wait' }
  | { type: 'spawn'; phase: WorkerPhase; spec: TaskSpec }
  | { type: 'continue'; workerId: string; message: string }
  | { type: 'report'; summary: string };
