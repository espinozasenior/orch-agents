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
  source: 'github' | 'client' | 'schedule' | 'system';
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
// Triage -> Planning
// ---------------------------------------------------------------------------

export interface TriageResult {
  intakeEventId: string;
  priority: 'P0-immediate' | 'P1-high' | 'P2-standard' | 'P3-backlog';
  complexity: { level: 'low' | 'medium' | 'high'; percentage: number };
  impact: 'isolated' | 'module' | 'cross-cutting' | 'system-wide';
  risk: 'low' | 'medium' | 'high' | 'critical';
  recommendedPhases: SPARCPhase[];
  requiresApproval: boolean;
  skipTriage: boolean;
  estimatedEffort: 'trivial' | 'small' | 'medium' | 'large' | 'epic';
}

// ---------------------------------------------------------------------------
// Planning -> Execution
// ---------------------------------------------------------------------------

export interface WorkflowPlan {
  id: string;
  workItemId: string;
  methodology: 'sparc-full' | 'sparc-partial' | 'tdd' | 'adhoc' | 'testing';
  template: string;
  topology:
    | 'mesh'
    | 'hierarchical'
    | 'hierarchical-mesh'
    | 'ring'
    | 'star'
    | 'adaptive';
  swarmStrategy: 'specialized' | 'balanced' | 'minimal';
  consensus: 'raft' | 'pbft' | 'none';
  maxAgents: number;
  phases: PlannedPhase[];
  agentTeam: PlannedAgent[];
  estimatedDuration: number;
  estimatedCost: number;
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
// Planning sub-types
// ---------------------------------------------------------------------------

export interface PlanningInput {
  intakeEventId: string;
  triageResult: TriageResult;
  classification: {
    domain: string;
    complexity: { level: string; percentage: number };
    scope: string;
    risk: string;
  };
  templateKey: string;
  agentTeam: PlannedAgent[];
  ambiguity?: { score: number; needsClarification: boolean };
}

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
