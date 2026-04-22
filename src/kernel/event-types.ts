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
  DeploymentResult,
  DecisionRecord,
  SPARCPhase,
  Artifact,
  Finding,
} from '../types';
import type {
  PlanId,
  WorkItemId,
  ExecId,
  AgentSessionId,
  PhaseId,
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

export type WebhookReceivedEvent = DomainEvent<
  'WebhookReceived',
  { rawPayload: Record<string, unknown>; eventType: string; deliveryId: string }
>;

export type RequirementSubmittedEvent = DomainEvent<
  'RequirementSubmitted',
  { requirementId: string; clientId: string; details: Record<string, unknown> }
>;

export type RequirementRefinedEvent = DomainEvent<
  'RequirementRefined',
  { requirementId: string; clarifications: Record<string, string>[] }
>;

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

export type DeploymentCompletedEvent = DomainEvent<
  'DeploymentCompleted',
  { deploymentResult: DeploymentResult }
>;

export type OutcomeRecordedEvent = DomainEvent<
  'OutcomeRecorded',
  { decisionRecord: DecisionRecord }
>;

export type WeightsUpdatedEvent = DomainEvent<
  'WeightsUpdated',
  { patternId: string; newWeight: number; previousWeight: number }
>;

export type ClientNotifiedEvent = DomainEvent<
  'ClientNotified',
  { clientId: string; notificationType: string; payload: Record<string, unknown> }
>;

// ---------------------------------------------------------------------------
// Failure/recovery domain events (Section 8.3 -- Missing Domain Events)
// ---------------------------------------------------------------------------

export type PhaseRetriedEvent = DomainEvent<
  'PhaseRetried',
  { phaseId: PhaseId; retryCount: number; feedback: string }
>;

export type WorkFailedEvent = DomainEvent<
  'WorkFailed',
  { workItemId: WorkItemId; failureReason: string; retryCount: number }
>;

export type WorkCancelledEvent = DomainEvent<
  'WorkCancelled',
  { workItemId: WorkItemId; cancellationReason: string }
>;

export type SwarmInitializedEvent = DomainEvent<
  'SwarmInitialized',
  { swarmId: string; topology: string; agentCount: number }
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
// Artifact Execution Layer events (Phase 5)
// ---------------------------------------------------------------------------

export type ArtifactsAppliedEvent = DomainEvent<
  'ArtifactsApplied',
  { planId: PlanId; commitSha: string; branch: string; changedFiles: string[] }
>;

export type ReviewRequestedEvent = DomainEvent<
  'ReviewRequested',
  { planId: PlanId; commitSha: string; branch: string; artifacts: Artifact[]; attempt: number }
>;

export type ReviewRejectedEvent = DomainEvent<
  'ReviewRejected',
  { planId: PlanId; findings: Finding[]; feedback: string; attempt: number }
>;

export type FixRequestedEvent = DomainEvent<
  'FixRequested',
  { planId: PlanId; feedback: string; findings: Finding[]; attempt: number }
>;

export type CommitCreatedEvent = DomainEvent<
  'CommitCreated',
  { planId: PlanId; sha: string; branch: string; files: string[]; message: string }
>;

export type RollbackTriggeredEvent = DomainEvent<
  'RollbackTriggered',
  { planId: PlanId; reason: string; worktreePath: string }
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
// Harness observability events (P0/P3 integration)
// ---------------------------------------------------------------------------

export type CompactionTriggeredEvent = DomainEvent<
  'CompactionTriggered',
  { tier: 'pipeline' | 'reactive'; tokensBefore: number; tokensAfter: number; execId: ExecId }
>;

export type CompactionCompletedEvent = DomainEvent<
  'CompactionCompleted',
  {
    cause: 'auto' | 'reactive';
    tokensBefore: number;
    tokensAfter: number;
    ratio: number;
    latencyMs: number;
    execId: ExecId;
  }
>;

export type ContextPressureWarningEvent = DomainEvent<
  'ContextPressureWarning',
  { currentTokens: number; threshold: number; percentLeft: number; recommended: 'snip' | 'compact' | 'block'; execId: ExecId }
>;

export type ContextPressureErrorEvent = DomainEvent<
  'ContextPressureError',
  { currentTokens: number; threshold: number; percentLeft: number; execId: ExecId }
>;

export type BudgetContinuationEvent = DomainEvent<
  'BudgetContinuation',
  { pct: number; tokens: number; continuationCount: number; execId: ExecId }
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
// Union of all domain event types
// ---------------------------------------------------------------------------

export type AnyDomainEvent =
  | WebhookReceivedEvent
  | RequirementSubmittedEvent
  | RequirementRefinedEvent
  | IntakeCompletedEvent
  | WorkTriagedEvent
  | PlanCreatedEvent
  | PhaseStartedEvent
  | PhaseCompletedEvent
  | ReviewCompletedEvent
  | DeploymentCompletedEvent
  | OutcomeRecordedEvent
  | WeightsUpdatedEvent
  | ClientNotifiedEvent
  | PhaseRetriedEvent
  | WorkFailedEvent
  | WorkCancelledEvent
  | SwarmInitializedEvent
  | WorkPausedEvent
  | WorkCompletedEvent
  | ArtifactsAppliedEvent
  | ReviewRequestedEvent
  | ReviewRejectedEvent
  | FixRequestedEvent
  | CommitCreatedEvent
  | RollbackTriggeredEvent
  | AgentSpawnedEvent
  | AgentChunkEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | AgentCancelledEvent
  | AgentPromptedEvent
  | CompactionTriggeredEvent
  | CompactionCompletedEvent
  | ContextPressureWarningEvent
  | ContextPressureErrorEvent
  | BudgetContinuationEvent
  | TaskOutputDeltaEvent
  | TaskNotifiedEvent
  | ChildAgentRequestedEvent
  | ChildAgentCompletedEvent
  | ChildAgentFailedEvent
  | ChildAgentCancelledEvent;

// ---------------------------------------------------------------------------
// Event type string literals for use with the event bus
// ---------------------------------------------------------------------------

export type DomainEventType = AnyDomainEvent['type'];

/**
 * Map from event type string to its concrete DomainEvent type.
 * Used for type-safe event bus subscriptions.
 */
export interface DomainEventMap {
  WebhookReceived: WebhookReceivedEvent;
  RequirementSubmitted: RequirementSubmittedEvent;
  RequirementRefined: RequirementRefinedEvent;
  IntakeCompleted: IntakeCompletedEvent;
  WorkTriaged: WorkTriagedEvent;
  PlanCreated: PlanCreatedEvent;
  PhaseStarted: PhaseStartedEvent;
  PhaseCompleted: PhaseCompletedEvent;
  ReviewCompleted: ReviewCompletedEvent;
  DeploymentCompleted: DeploymentCompletedEvent;
  OutcomeRecorded: OutcomeRecordedEvent;
  WeightsUpdated: WeightsUpdatedEvent;
  ClientNotified: ClientNotifiedEvent;
  PhaseRetried: PhaseRetriedEvent;
  WorkFailed: WorkFailedEvent;
  WorkCancelled: WorkCancelledEvent;
  SwarmInitialized: SwarmInitializedEvent;
  WorkPaused: WorkPausedEvent;
  WorkCompleted: WorkCompletedEvent;
  ArtifactsApplied: ArtifactsAppliedEvent;
  ReviewRequested: ReviewRequestedEvent;
  ReviewRejected: ReviewRejectedEvent;
  FixRequested: FixRequestedEvent;
  CommitCreated: CommitCreatedEvent;
  RollbackTriggered: RollbackTriggeredEvent;
  AgentSpawned: AgentSpawnedEvent;
  AgentChunk: AgentChunkEvent;
  AgentCompleted: AgentCompletedEvent;
  AgentFailed: AgentFailedEvent;
  AgentCancelled: AgentCancelledEvent;
  AgentPrompted: AgentPromptedEvent;
  CompactionTriggered: CompactionTriggeredEvent;
  CompactionCompleted: CompactionCompletedEvent;
  ContextPressureWarning: ContextPressureWarningEvent;
  ContextPressureError: ContextPressureErrorEvent;
  BudgetContinuation: BudgetContinuationEvent;
  TaskOutputDelta: TaskOutputDeltaEvent;
  TaskNotified: TaskNotifiedEvent;
  ChildAgentRequested: ChildAgentRequestedEvent;
  ChildAgentCompleted: ChildAgentCompletedEvent;
  ChildAgentFailed: ChildAgentFailedEvent;
  ChildAgentCancelled: ChildAgentCancelledEvent;
}
