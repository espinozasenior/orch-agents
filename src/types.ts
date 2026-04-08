/**
 * Core domain types for the Orch-Agents system.
 *
 * These interfaces define the contracts between bounded contexts,
 * sourced from the architecture document Section 8.3.
 */

import type { ParsedGitHubEvent } from './webhook-gateway/event-parser';

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

/**
 * P20: routing metadata stamped onto IntakeEvent.sourceMetadata. The
 * normalizer fills `skillPath` + `ruleKey` + `parsed`; the execution-engine
 * reads them on the IntakeCompleted handler.
 */
export interface IntakeSourceMetadata extends Record<string, unknown> {
  skillPath?: string;
  ruleKey?: string;
  parsed?: ParsedGitHubEvent;
}

export interface IntakeEvent {
  id: string;
  timestamp: string;
  source: 'github' | 'linear' | 'client' | 'schedule' | 'system';
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
  id: string;
  workItemId: string;
  template: string;
  promptTemplate?: string;
  agentTeam: PlannedAgent[];
  maxAgents?: number;
  /** @deprecated Kept for backward compat with prompt-builder / fix-it-loop. */
  methodology?: string;
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
