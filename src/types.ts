/**
 * Core domain types for the Orch-Agents system.
 *
 * These interfaces define the contracts between bounded contexts,
 * sourced from the architecture document Section 8.3.
 */

import type { ParsedGitHubEvent } from './webhook-gateway/event-parser';
import type {
  PlanId,
  WorkItemId,
  ExecId,
  LinearIssueId,
  AgentSessionId,
  PhaseId,
} from './kernel/branded-types';

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
// Intake -> Triage
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Source-specific metadata — discriminated union
// ---------------------------------------------------------------------------

/**
 * GitHub-source metadata, stamped by the GitHub normalizers.
 */
export interface GitHubSourceMetadata {
  readonly source: 'github';
  eventType: string;
  action?: string | null;
  deliveryId: string;
  repoFullName?: string;
  sender?: string;
  configSource?: 'workflow-md';
  /** Relative path to the resolved skill file, stamped by the normalizer. */
  skillPath?: string;
  /** Resolved WORKFLOW.md rule key, e.g. "pull_request.opened". */
  ruleKey?: string;
  /** Full ParsedGitHubEvent for downstream context-fetchers. */
  parsed?: ParsedGitHubEvent;
}

/**
 * Linear-source metadata, stamped by the Linear normalizers.
 */
export interface LinearSourceMetadata {
  readonly source: 'linear';
  linearIssueId: LinearIssueId;
  linearIdentifier?: string;
  linearTitle?: string;
  linearState?: string;
  linearTeamId?: string;
  linearTeamKey?: string;
  linearUrl?: string;
  agentSessionId?: AgentSessionId;
  attempt?: number;
  category?: string;
  /** Snapshot of Linear issue fields at intake time (free-form). */
  previousState?: Record<string, unknown>;
  /** Free-form intent string used by the Linear path for log/dispatch hints. */
  intent?: string;
}

/**
 * Staging / smoke-test run metadata.
 */
export interface StagingSourceMetadata {
  readonly source: 'staging';
  stagingRunId: string;
}

/**
 * System-originated or client-originated events with no source-specific metadata.
 */
export interface SystemSourceMetadata {
  readonly source: 'system' | 'client' | 'schedule';
}

/**
 * Automation-originated metadata, stamped by the scheduling bounded context.
 */
export interface AutomationSourceMetadata {
  readonly source: 'automation';
  automationId: string;
  trigger: 'cron' | 'webhook' | 'manual';
  /** Relative path to a skill file, if the automation config specifies one. */
  skillPath?: string;
}

/**
 * Discriminated union of all source metadata variants.
 *
 * Narrows on the `source` discriminant field — each variant only contains
 * the fields relevant to that source, making impossible states unrepresentable.
 */
export type IntakeSourceMetadata =
  | GitHubSourceMetadata
  | LinearSourceMetadata
  | StagingSourceMetadata
  | SystemSourceMetadata
  | AutomationSourceMetadata;

// ---------------------------------------------------------------------------
// Type guards for narrowing IntakeSourceMetadata
// ---------------------------------------------------------------------------

export function isGitHubMeta(meta: IntakeSourceMetadata): meta is GitHubSourceMetadata {
  return meta.source === 'github';
}

export function isLinearMeta(meta: IntakeSourceMetadata): meta is LinearSourceMetadata {
  return meta.source === 'linear';
}

export function isStagingMeta(meta: IntakeSourceMetadata): meta is StagingSourceMetadata {
  return meta.source === 'staging';
}

export function isAutomationMeta(meta: IntakeSourceMetadata): meta is AutomationSourceMetadata {
  return meta.source === 'automation';
}

export interface IntakeEvent {
  id: string;
  timestamp: string;
  source: 'github' | 'linear' | 'client' | 'schedule' | 'system' | 'automation';
  sourceMetadata: IntakeSourceMetadata;
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
  id: PlanId;
  workItemId: WorkItemId;
  promptTemplate?: string;
  agentTeam: PlannedAgent[];
  maxAgents?: number;
}

// ---------------------------------------------------------------------------
// Execution -> Review
// ---------------------------------------------------------------------------

export interface PhaseResult {
  phaseId: PhaseId;
  planId: PlanId;
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

export interface PlannedAgent {
  role: string;
  type: string;
  tier: 1 | 2 | 3;
  required: boolean;
  /** Explicit subagent type. When omitted and fork is eligible, FORK_AGENT is used. */
  subagentType?: string;
}

// ---------------------------------------------------------------------------
// Artifact and Finding
// ---------------------------------------------------------------------------

export interface Artifact {
  id: string;
  phaseId: PhaseId;
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
  /** Structured file path for inline review comments. */
  filePath?: string;
  /** Structured line number for inline review comments. */
  lineNumber?: number;
  /** Commit SHA for anchoring inline review comments. */
  commitSha?: string;
}

// ---------------------------------------------------------------------------
// Artifact Execution Layer types
// ---------------------------------------------------------------------------

export interface WorktreeHandle {
  planId: PlanId;
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

// ---------------------------------------------------------------------------
// Agent Execution Tracking (Dorothy streaming layer)
// ---------------------------------------------------------------------------

export type AgentExecStatus = 'spawned' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out';

export interface AgentExecState {
  execId: ExecId;
  planId: PlanId;
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
  workflowPlanId: PlanId;
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
  agentTeam: string[];
  outcome: 'success' | 'partial' | 'failure';
  duration: number;
  cost: number;
  timestamp: string;
}
