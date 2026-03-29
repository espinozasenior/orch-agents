/**
 * Core domain types for the Orch-Agents system.
 *
 * These interfaces define the contracts between bounded contexts,
 * sourced from the architecture document Section 8.3.
 */

// ---------------------------------------------------------------------------
// SPARC Phase
// ---------------------------------------------------------------------------

export type SPARCPhase =
  | 'specification'
  | 'pseudocode'
  | 'architecture'
  | 'refinement'
  | 'completion';

// ---------------------------------------------------------------------------
// Work Intent (14 known intents from Section 8.1 + custom extensibility)
// ---------------------------------------------------------------------------

export type WorkIntent =
  | 'validate-main'
  | 'validate-branch'
  | 'review-pr'
  | 're-review-pr'
  | 'post-merge'
  | 'triage-issue'
  | 'classify-issue'
  | 'assign-issue'
  | 'close-issue'
  | 'respond-comment'
  | 'process-review'
  | 'debug-ci'
  | 'deploy-release'
  | 'incident-response'
  | `custom:${string}`;

// ---------------------------------------------------------------------------
// Intake -> Triage
// ---------------------------------------------------------------------------

export interface IntakeEvent {
  id: string;
  timestamp: string;
  source: 'github' | 'linear' | 'client' | 'schedule' | 'system';
  sourceMetadata: Record<string, unknown>;
  intent: WorkIntent;
  entities: {
    repo?: string;
    branch?: string;
    prNumber?: number;
    issueNumber?: number;
    requirementId?: string;
    projectId?: string;
    files?: string[];
    labels?: string[];
    author?: string;
    severity?: 'low' | 'medium' | 'high' | 'critical';
  };
  rawText?: string;
}

// ---------------------------------------------------------------------------
// Triage (simplified — no SPARC phases or effort estimation)
// ---------------------------------------------------------------------------

export interface TriageResult {
  intakeEventId: string;
  priority: 'P0-immediate' | 'P1-high' | 'P2-standard' | 'P3-backlog';
  skipTriage: boolean;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface WorkflowPlan {
  id: string;
  workItemId: string;
  template: string;
  promptTemplate?: string;
  agentTeam: PlannedAgent[];
  maxAgents?: number;
  /** @deprecated Kept for backward compat with prompt-builder / fix-it-loop. */
  methodology?: string;
  /** @deprecated Kept for backward compat. */
  topology?: string;
  /** @deprecated Kept for backward compat. */
  swarmStrategy?: string;
  /** @deprecated Kept for backward compat. */
  consensus?: string;
  /** @deprecated Kept for backward compat. */
  phases?: PlannedPhase[];
  /** @deprecated Kept for backward compat. */
  estimatedDuration?: number;
  /** @deprecated Kept for backward compat. */
  estimatedCost?: number;
}

// ---------------------------------------------------------------------------
// Execution -> Review
// ---------------------------------------------------------------------------

export interface PhaseResult {
  phaseId: string;
  planId: string;
  phaseType: SPARCPhase;
  status: 'completed' | 'failed' | 'skipped';
  artifacts: Artifact[];
  metrics: {
    duration: number;
    agentUtilization: number;
    modelCost: number;
  };
}

// ---------------------------------------------------------------------------
// Review -> Execution/Deployment
// ---------------------------------------------------------------------------

export interface ReviewVerdict {
  phaseResultId: string;
  status: 'pass' | 'fail' | 'conditional';
  findings: Finding[];
  securityScore: number;
  testCoveragePercent: number;
  codeReviewApproval: boolean;
  feedback?: string;
}

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

export interface PlannedPhase {
  type: SPARCPhase;
  agents: string[];
  gate: string;
  skippable: boolean;
}

export interface PlannedAgent {
  role: string;
  type: string;
  tier: 1 | 2 | 3;
  required: boolean;
}

// ---------------------------------------------------------------------------
// Artifact and Finding
// ---------------------------------------------------------------------------

export interface Artifact {
  id: string;
  phaseId: string;
  type: string;
  url: string;
  metadata: Record<string, unknown>;
}

export interface Finding {
  id: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  category: string;
  message: string;
  location?: string;
}

// ---------------------------------------------------------------------------
// Artifact Execution Layer types
// ---------------------------------------------------------------------------

export type ArtifactKind = 'analysis' | 'code-patch' | 'new-file' | 'test' | 'pr-comment' | 'commit';

export interface CodeArtifactMetadata {
  path: string;
  diff?: string;
  commitSha?: string;
}

export interface WorktreeHandle {
  planId: string;
  path: string;
  branch: string;
  baseBranch: string;
  status: 'active' | 'committed' | 'pushed' | 'disposed';
}

export interface ApplyContext {
  commitMessage: string;
  expectedFiles?: string[];
  forbiddenPatterns?: RegExp[];
}

export interface ApplyResult {
  status: 'applied' | 'rejected' | 'rolled-back';
  commitSha?: string;
  changedFiles: string[];
  rejectionReason?: string;
}

export interface FixItAttempt {
  attempt: number;
  findings: Finding[];
  feedback: string;
  commitSha?: string;
}

/**
 * FixItResult is canonically defined in execution/fix-it-loop.ts (richer version with history).
 * Import from there instead of duplicating here.
 */

// ---------------------------------------------------------------------------
// Agent Execution Tracking (Dorothy streaming layer)
// ---------------------------------------------------------------------------

export type AgentExecStatus = 'spawned' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out';

export interface AgentExecState {
  execId: string;
  planId: string;
  agentRole: string;
  agentType: string;
  phaseType: SPARCPhase;
  status: AgentExecStatus;
  spawnedAt: string;
  lastActivity: string;
  completedAt: string | null;
  bytesReceived: number;
  chunksReceived: number;
  parsedSignals: {
    toolUseCount: number;
    thinkingDetected: boolean;
    jsonDetected: boolean;
  };
  tokenUsage?: TokenUsage;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export interface ContinuationState {
  resumable: boolean;
  sessionId?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

export interface DeploymentResult {
  workflowPlanId: string;
  status: 'success' | 'failed' | 'rolled-back';
  environment: string;
  healthChecks: {
    name: string;
    status: 'pass' | 'fail';
    latency: number;
  }[];
  rollbackTriggered: boolean;
}

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

export interface DecisionRecord {
  id: string;
  inputSignature: string;
  classification: {
    domain: string;
    complexity: string;
    scope: string;
    risk: string;
  };
  templateSelected: string;
  agentTeam: string[];
  outcome: 'success' | 'partial' | 'failure';
  duration: number;
  cost: number;
  timestamp: string;
}
