/**
 * Public library entry point.
 *
 * Re-exports the reusable subsystems of orch-agents for consumption by
 * downstream packages. This module has zero side effects — importing it
 * does NOT start the Fastify server.
 */

// Logger
export { createLogger } from '../shared/logger';
export type { Logger, LogContext } from '../shared/logger';
export type { LogLevel } from '../shared/config';

// Branded IDs
export {
  planId, workItemId, execId, linearIssueId,
  agentSessionId, phaseId, correlationId,
} from '../kernel/branded-types';
export type {
  PlanId, WorkItemId, ExecId, LinearIssueId,
  AgentSessionId, PhaseId, CorrelationId,
} from '../kernel/branded-types';

// Domain types (curated — intake/triage/deployment types omitted
// because they're app-internal and leak Linear/GitHub event shapes)
export type {
  SPARCPhase,
  Finding,
  Artifact,
  ReviewVerdict,
  PhaseResult,
  WorktreeHandle,
  ApplyContext,
  ApplyResult,
  AgentExecStatus,
  AgentExecState,
  TokenUsage,
  ContinuationState,
  PlannedAgent,
} from '../types';

// Errors
export {
  AppError, ValidationError, AuthenticationError, ConflictError,
  RateLimitError, TriageError, ExecutionError, ReviewError,
  shortErrorStack, redactSecrets, sanitizeForExternalDisplay,
} from '../kernel/errors';
