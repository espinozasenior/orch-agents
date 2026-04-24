/**
 * Domain event type definitions for the Orch-Agents event bus.
 *
 * These events flow between bounded contexts. During Phases 0-2 they are
 * dispatched via in-process EventEmitter. NATS JetStream upgrade at Phase 3+.
 *
 * See architecture doc Section 4.3 (Domain Events) and Section 8.3.
 */

import type {
  IntakeEvent,
  TriageResult,
  WorkflowPlan,
  PhaseResult,
  ReviewVerdict,
  SPARCPhase,
} from '../types';
import type {
  PlanId,
  WorkItemId,
  ExecId,
  AgentSessionId,
} from './branded-types';

// ---------------------------------------------------------------------------
// Base event envelope
// ---------------------------------------------------------------------------

export interface DomainEvent<T extends string = string, P = unknown> {
  readonly type: T;
  readonly id: string;
  readonly timestamp: string;
  readonly correlationId: string;
  readonly payload: P;
}

// ---------------------------------------------------------------------------
// Happy-path domain events (Section 4.3)
// ---------------------------------------------------------------------------

export type IntakeCompletedEvent = DomainEvent<
  'IntakeCompleted',
  { intakeEvent: IntakeEvent }
>;

export type WorkTriagedEvent = DomainEvent<
  'WorkTriaged',
  { intakeEvent: IntakeEvent; triageResult: TriageResult }
>;

export type PlanCreatedEvent = DomainEvent<
  'PlanCreated',
  { workflowPlan: WorkflowPlan; intakeEvent?: IntakeEvent }
>;

export type PhaseStartedEvent = DomainEvent<
  'PhaseStarted',
  { planId: PlanId; phaseType: SPARCPhase; agents: string[] }
>;

export type PhaseCompletedEvent = DomainEvent<
  'PhaseCompleted',
  { phaseResult: PhaseResult }
>;

export type ReviewCompletedEvent = DomainEvent<
  'ReviewCompleted',
  { reviewVerdict: ReviewVerdict }
>;

// ---------------------------------------------------------------------------
// Failure/recovery domain events (Section 8.3 -- Missing Domain Events)
// ---------------------------------------------------------------------------

export type WorkFailedEvent = DomainEvent<
  'WorkFailed',
  { workItemId: WorkItemId; failureReason: string; retryCount: number }
>;

export type WorkCancelledEvent = DomainEvent<
  'WorkCancelled',
  { workItemId: WorkItemId; cancellationReason: string }
>;

export type WorkPausedEvent = DomainEvent<
  'WorkPaused',
  { workItemId: WorkItemId; pauseReason: string; resumable: boolean }
>;

export type WorkCompletedEvent = DomainEvent<
  'WorkCompleted',
  { workItemId: WorkItemId; planId: PlanId; phaseCount: number; totalDuration: number; output?: string }
>;

// ---------------------------------------------------------------------------
// Agent execution events (Dorothy streaming layer)
// ---------------------------------------------------------------------------

export type AgentSpawnedEvent = DomainEvent<
  'AgentSpawned',
  { execId: ExecId; planId: PlanId; agentRole: string; agentType: string; phaseType: SPARCPhase }
>;

export type AgentChunkEvent = DomainEvent<
  'AgentChunk',
  { execId: ExecId; planId: PlanId; agentRole: string; chunk: string; timestamp: string }
>;

export type AgentCompletedEvent = DomainEvent<
  'AgentCompleted',
  { execId: ExecId; planId: PlanId; agentRole: string; duration: number; tokenUsage?: { input: number; output: number } }
>;

export type AgentFailedEvent = DomainEvent<
  'AgentFailed',
  { execId: ExecId; planId: PlanId; agentRole: string; error: string; duration: number }
>;

export type AgentCancelledEvent = DomainEvent<
  'AgentCancelled',
  { execId: ExecId; planId: PlanId; agentRole: string; duration: number }
>;

// ---------------------------------------------------------------------------
// Agent session events (Phase 7D)
// ---------------------------------------------------------------------------

export type AgentPromptedEvent = DomainEvent<
  'AgentPrompted',
  { agentSessionId: AgentSessionId; issueId: string; body: string }
>;

// ---------------------------------------------------------------------------
// Task backbone events (P6)
// ---------------------------------------------------------------------------

export type TaskOutputDeltaEvent = DomainEvent<
  'TaskOutputDelta',
  { taskId: string; delta: string; offset: number }
>;

export type TaskNotifiedEvent = DomainEvent<
  'TaskNotified',
  { taskId: string; status: string }
>;

// ---------------------------------------------------------------------------
// Child agent events (direct spawn mode)
// ---------------------------------------------------------------------------

export type ChildAgentRequestedEvent = DomainEvent<
  'ChildAgentRequested',
  { parentPlanId: string; childId: string; prompt: string; subagentType?: string }
>;

export type ChildAgentCompletedEvent = DomainEvent<
  'ChildAgentCompleted',
  { parentPlanId: string; childId: string; duration: number; output: string }
>;

export type ChildAgentFailedEvent = DomainEvent<
  'ChildAgentFailed',
  { parentPlanId: string; childId: string; duration: number; error: string }
>;

export type ChildAgentCancelledEvent = DomainEvent<
  'ChildAgentCancelled',
  { parentPlanId: string; childId: string; duration: number }
>;

// ---------------------------------------------------------------------------
// Workspace lifecycle events (Phase 3 — repo lifecycle scripts)
// ---------------------------------------------------------------------------

export type WorkspaceSetupStartedEvent = DomainEvent<
  'WorkspaceSetupStarted',
  { planId: string; worktreePath: string; source: 'workflow' | 'repo' | 'none' }
>;

export type WorkspaceSetupCompletedEvent = DomainEvent<
  'WorkspaceSetupCompleted',
  { planId: string; worktreePath: string; setupDurationMs: number; startDurationMs: number }
>;

export type WorkspaceSetupFailedEvent = DomainEvent<
  'WorkspaceSetupFailed',
  { planId: string; worktreePath: string; phase: 'setup' | 'start'; error: string; exitCode: number }
>;

// ---------------------------------------------------------------------------
// Automation scheduling events (Phase 2 — cron / webhook / auto-pause)
// ---------------------------------------------------------------------------

export type AutomationTriggeredEvent = DomainEvent<
  'AutomationTriggered',
  { automationId: string; repoName: string; trigger: 'cron' | 'webhook' | 'manual'; runId: string }
>;

export type AutomationCompletedEvent = DomainEvent<
  'AutomationCompleted',
  { automationId: string; runId: string; durationMs: number }
>;

export type AutomationFailedEvent = DomainEvent<
  'AutomationFailed',
  { automationId: string; runId: string; durationMs: number; error: string; consecutiveFailures: number }
>;

export type AutomationPausedEvent = DomainEvent<
  'AutomationPaused',
  { automationId: string; consecutiveFailures: number }
>;

export type AutomationResumedEvent = DomainEvent<
  'AutomationResumed',
  { automationId: string }
>;

// ---------------------------------------------------------------------------
// Union of all domain event types
// ---------------------------------------------------------------------------

export type AnyDomainEvent =
  | IntakeCompletedEvent
  | WorkTriagedEvent
  | PlanCreatedEvent
  | PhaseStartedEvent
  | PhaseCompletedEvent
  | ReviewCompletedEvent
  | WorkFailedEvent
  | WorkCancelledEvent
  | WorkPausedEvent
  | WorkCompletedEvent
  | AgentSpawnedEvent
  | AgentChunkEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | AgentCancelledEvent
  | AgentPromptedEvent
  | TaskOutputDeltaEvent
  | TaskNotifiedEvent
  | ChildAgentRequestedEvent
  | ChildAgentCompletedEvent
  | ChildAgentFailedEvent
  | ChildAgentCancelledEvent
  | WorkspaceSetupStartedEvent
  | WorkspaceSetupCompletedEvent
  | WorkspaceSetupFailedEvent
  | AutomationTriggeredEvent
  | AutomationCompletedEvent
  | AutomationFailedEvent
  | AutomationPausedEvent
  | AutomationResumedEvent;

// ---------------------------------------------------------------------------
// Event type string literals for use with the event bus
// ---------------------------------------------------------------------------

export type DomainEventType = AnyDomainEvent['type'];

/**
 * Map from event type string to its concrete DomainEvent type.
 * Used for type-safe event bus subscriptions.
 */
export interface DomainEventMap {
  IntakeCompleted: IntakeCompletedEvent;
  WorkTriaged: WorkTriagedEvent;
  PlanCreated: PlanCreatedEvent;
  PhaseStarted: PhaseStartedEvent;
  PhaseCompleted: PhaseCompletedEvent;
  ReviewCompleted: ReviewCompletedEvent;
  WorkFailed: WorkFailedEvent;
  WorkCancelled: WorkCancelledEvent;
  WorkPaused: WorkPausedEvent;
  WorkCompleted: WorkCompletedEvent;
  AgentSpawned: AgentSpawnedEvent;
  AgentChunk: AgentChunkEvent;
  AgentCompleted: AgentCompletedEvent;
  AgentFailed: AgentFailedEvent;
  AgentCancelled: AgentCancelledEvent;
  AgentPrompted: AgentPromptedEvent;
  TaskOutputDelta: TaskOutputDeltaEvent;
  TaskNotified: TaskNotifiedEvent;
  ChildAgentRequested: ChildAgentRequestedEvent;
  ChildAgentCompleted: ChildAgentCompletedEvent;
  ChildAgentFailed: ChildAgentFailedEvent;
  ChildAgentCancelled: ChildAgentCancelledEvent;
  WorkspaceSetupStarted: WorkspaceSetupStartedEvent;
  WorkspaceSetupCompleted: WorkspaceSetupCompletedEvent;
  WorkspaceSetupFailed: WorkspaceSetupFailedEvent;
  AutomationTriggered: AutomationTriggeredEvent;
  AutomationCompleted: AutomationCompletedEvent;
  AutomationFailed: AutomationFailedEvent;
  AutomationPaused: AutomationPausedEvent;
  AutomationResumed: AutomationResumedEvent;
}
