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
  { planId: string; phaseType: SPARCPhase; agents: string[] }
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
  { phaseId: string; retryCount: number; feedback: string }
>;

export type WorkFailedEvent = DomainEvent<
  'WorkFailed',
  { workItemId: string; failureReason: string; retryCount: number }
>;

export type WorkCancelledEvent = DomainEvent<
  'WorkCancelled',
  { workItemId: string; cancellationReason: string }
>;

export type SwarmInitializedEvent = DomainEvent<
  'SwarmInitialized',
  { swarmId: string; topology: string; agentCount: number }
>;

export type WorkPausedEvent = DomainEvent<
  'WorkPaused',
  { workItemId: string; pauseReason: string; resumable: boolean }
>;

export type WorkCompletedEvent = DomainEvent<
  'WorkCompleted',
  { workItemId: string; planId: string; phaseCount: number; totalDuration: number }
>;

// ---------------------------------------------------------------------------
// Artifact Execution Layer events (Phase 5)
// ---------------------------------------------------------------------------

export type ArtifactsAppliedEvent = DomainEvent<
  'ArtifactsApplied',
  { planId: string; commitSha: string; branch: string; changedFiles: string[] }
>;

export type ReviewRequestedEvent = DomainEvent<
  'ReviewRequested',
  { planId: string; commitSha: string; branch: string; artifacts: Artifact[]; attempt: number }
>;

export type ReviewRejectedEvent = DomainEvent<
  'ReviewRejected',
  { planId: string; findings: Finding[]; feedback: string; attempt: number }
>;

export type FixRequestedEvent = DomainEvent<
  'FixRequested',
  { planId: string; feedback: string; findings: Finding[]; attempt: number }
>;

export type CommitCreatedEvent = DomainEvent<
  'CommitCreated',
  { planId: string; sha: string; branch: string; files: string[]; message: string }
>;

export type RollbackTriggeredEvent = DomainEvent<
  'RollbackTriggered',
  { planId: string; reason: string; worktreePath: string }
>;

// ---------------------------------------------------------------------------
// Agent execution events (Dorothy streaming layer)
// ---------------------------------------------------------------------------

export type AgentSpawnedEvent = DomainEvent<
  'AgentSpawned',
  { execId: string; planId: string; agentRole: string; agentType: string; phaseType: SPARCPhase }
>;

export type AgentChunkEvent = DomainEvent<
  'AgentChunk',
  { execId: string; planId: string; agentRole: string; chunk: string; timestamp: string }
>;

export type AgentCompletedEvent = DomainEvent<
  'AgentCompleted',
  { execId: string; planId: string; agentRole: string; duration: number; tokenUsage?: { input: number; output: number } }
>;

export type AgentFailedEvent = DomainEvent<
  'AgentFailed',
  { execId: string; planId: string; agentRole: string; error: string; duration: number }
>;

export type AgentCancelledEvent = DomainEvent<
  'AgentCancelled',
  { execId: string; planId: string; agentRole: string; duration: number }
>;

// ---------------------------------------------------------------------------
// Agent session events (Phase 7D)
// ---------------------------------------------------------------------------

export type AgentPromptedEvent = DomainEvent<
  'AgentPrompted',
  { agentSessionId: string; issueId: string; body: string }
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
  | AgentPromptedEvent;

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
}
