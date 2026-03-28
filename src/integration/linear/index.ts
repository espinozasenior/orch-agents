/**
 * Linear integration bounded context -- barrel export.
 *
 * Re-exports all public APIs for the Linear integration.
 */

// Types
export type {
  LinearWebhookPayload,
  LinearIssueData,
  LinearIssueSnapshot,
  LinearRoutingRule,
  LinearChange,
  WorkpadState,
  WorkpadAgent,
  WorkpadPhase,
  WorkpadFinding,
} from './types';

// Normalizer
export {
  normalizeLinearEvent,
  setWorkflowConfig,
  resetWorkflowConfig,
  getWorkflowConfig,
  setLinearBotUserId,
} from './linear-normalizer';

// Workflow parser
export {
  parseWorkflowMd,
  parseWorkflowMdString,
  WorkflowParseError,
} from './workflow-parser';
export type { WorkflowConfig } from './workflow-parser';

// Client
export {
  createLinearClient,
  LinearApiError,
  LinearRateLimitError,
} from './linear-client';
export type {
  LinearClient,
  LinearClientDeps,
  LinearIssueResponse,
  LinearCommentResponse,
} from './linear-client';

// Webhook handler
export { linearWebhookHandler } from './linear-webhook-handler';
export type { LinearWebhookHandlerDeps } from './linear-webhook-handler';

// State reconciler
export { snapshotIssue, detectChanges } from './linear-state-reconciler';

// Polling loop
export { createLinearPollingLoop } from './linear-polling-loop';
export type { LinearPollingLoop, LinearPollingLoopDeps } from './linear-polling-loop';

// Workpad reporter
export {
  createWorkpadReporter,
  buildWorkpadComment,
  postOrUpdateWorkpad,
} from './workpad-reporter';
export type { WorkpadReporter, WorkpadReporterDeps } from './workpad-reporter';

// Stall detector
export { createStallDetector, TIMEOUT_BY_EFFORT } from './stall-detector';
export type { StallDetector, StallDetectorDeps, EffortLevel } from './stall-detector';
