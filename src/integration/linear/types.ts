/**
 * Linear-specific type definitions for the Linear integration bounded context.
 *
 * These types model Linear API payloads, internal state snapshots,
 * routing rules, and change detection results.
 */

// ---------------------------------------------------------------------------
// Linear Webhook Payload (subset of Linear webhook schema)
// ---------------------------------------------------------------------------

export interface LinearWebhookPayload {
  /** Event action: 'create' | 'update' | 'remove' */
  action: string;
  /** Actor who triggered the event */
  actor?: { id: string; name?: string; type?: string };
  /** ISO-8601 timestamp of webhook creation */
  createdAt: string;
  /** Resource type: 'Issue', 'Comment', 'Project', etc. */
  type: string;
  /** The resource data */
  data: LinearIssueData;
  /** Previous values of changed fields (only on 'update') */
  updatedFrom?: Record<string, unknown>;
  /** URL for the webhook source */
  url?: string;
  /** Organization ID */
  organizationId?: string;
  /** Webhook timestamp for dedup */
  webhookTimestamp?: number;
  /** Webhook ID */
  webhookId?: string;
}

export interface LinearIssueData {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url?: string;
  priority: number;
  /** Issue state */
  state?: { id: string; name: string; type?: string };
  /** Labels on the issue */
  labels?: Array<{ id: string; name: string }>;
  /** Assignee */
  assignee?: { id: string; name?: string };
  /** Creator */
  creator?: { id: string; name?: string };
  /** Team */
  team?: { id: string; key: string; name?: string };
  /** Project */
  project?: { id: string; name?: string };
  /** Updated timestamp */
  updatedAt?: string;
  /** Attachments (may contain GitHub links) */
  attachments?: Array<{ sourceType?: string; url?: string }>;
}

// ---------------------------------------------------------------------------
// Issue Snapshot (for polling state reconciliation)
// ---------------------------------------------------------------------------

export interface LinearIssueSnapshot {
  id: string;
  state: string;
  stateId: string;
  /** Linear state type (backlog|unstarted|started|completed|canceled). */
  stateType: string | undefined;
  labels: string[];
  labelIds: string[];
  assigneeId: string | null;
  priority: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Routing Rule (DEPRECATED -- replaced by WorkflowConfig from WORKFLOW.md)
// Kept as a type alias for backward compatibility during migration.
// ---------------------------------------------------------------------------

/** @deprecated Use WorkflowConfig from workflow-parser.ts instead. */
export interface LinearRoutingRule {
  trigger: 'state' | 'label' | 'assigned' | 'priority_urgent';
  value: string | null;
  intent: string;
  template: string;
  phases: string[];
  priority: 'P0-immediate' | 'P1-high' | 'P2-standard' | 'P3-backlog';
  skipTriage: boolean;
}

// ---------------------------------------------------------------------------
// Change Detection (for polling reconciler)
// ---------------------------------------------------------------------------

export interface LinearChange {
  field: 'state' | 'labels' | 'assignee' | 'priority';
  from: unknown;
  to: unknown;
  updatedFrom: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Workpad State (for building progress comments)
// ---------------------------------------------------------------------------

export interface WorkpadState {
  planId: string;
  linearIssueId: string;
  currentPhase: string;
  status: string;
  startedAt: string;
  elapsedMs: number;
  agents: WorkpadAgent[];
  phases: WorkpadPhase[];
  findings: WorkpadFinding[];
}

export interface WorkpadAgent {
  role: string;
  type: string;
  status: string;
  durationMs: number;
}

export interface WorkpadPhase {
  type: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  summary?: string;
}

export interface WorkpadFinding {
  severity: string;
  message: string;
}
