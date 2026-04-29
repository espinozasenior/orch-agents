/**
 * Shared DTOs between @orch-agents/api and @orch-agents/web.
 *
 * Pure types — NO domain logic, no imports from the api package, no
 * imports from the web package. The api serializes these on the wire;
 * the web consumes them. If a type stops being a wire contract, it
 * doesn't belong here.
 */

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface RunPhaseDto {
  phaseId: string;
  phaseType: string;
  status: 'started' | 'completed' | 'failed' | 'skipped';
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  artifactCount: number;
}

export interface RunAgentActivityDto {
  execId: string;
  agentRole: string;
  status: 'spawned' | 'completed' | 'failed' | 'cancelled';
  spawnedAt: string;
  completedAt?: string;
  durationMs?: number;
  tokenUsage?: { input: number; output: number };
  error?: string;
}

export interface RunSummaryDto {
  correlationId: string;
  planId?: string;
  status: RunStatus;
  title: string;
  source: string;
  repo?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  failureReason?: string;
  phases: RunPhaseDto[];
  agents: RunAgentActivityDto[];
  eventCount: number;
}

export interface SecretMetaDto {
  key: string;
  scope: 'global' | 'repo';
  repo?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebTokenSummaryDto {
  id: string;
  label: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AutomationRunDto {
  runId: string;
  automationId: string;
  repoName: string;
  trigger: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  durationMs?: number;
  error?: string;
  output?: string;
}

/**
 * Discriminated union of every domain event the SSE stream emits.
 * Mirrors the api's `BufferedEvent.type` strings exactly.
 */
export type SseEventName =
  | 'IntakeCompleted'
  | 'PlanCreated'
  | 'PhaseStarted'
  | 'PhaseCompleted'
  | 'AgentSpawned'
  | 'AgentChunk'
  | 'AgentCompleted'
  | 'AgentFailed'
  | 'AgentCancelled'
  | 'WorkCompleted'
  | 'WorkFailed'
  | 'WorkCancelled'
  | 'AutomationTriggered'
  | 'AutomationCompleted'
  | 'AutomationFailed'
  | 'gap'
  | 'dropped';

export interface GapFrame {
  lastSeenId: number;
  currentMinId: number;
}

export interface DroppedFrame {
  droppedCount: number;
}
