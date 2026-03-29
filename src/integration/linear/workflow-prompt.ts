import type { PlannedAgent, WorkflowPlan, IntakeEvent } from '../../types';
import { sanitize } from '../../shared/input-sanitizer';

const SUPPORTED_PLACEHOLDERS = new Set([
  'agent.role',
  'agent.type',
  'attempt.number',
  'issue.branch',
  'issue.description',
  'issue.identifier',
  'issue.labels',
  'issue.priority',
  'issue.project',
  'issue.repo',
  'issue.state',
  'issue.team',
  'issue.title',
  'plan.template',
  'plan.workItemId',
  'repository.branch',
  'repository.name',
  'tracker.team',
]);

export interface WorkflowPromptContext {
  readonly attempt: Record<string, string>;
  readonly issue: Record<string, string>;
  readonly agent: Record<string, string>;
  readonly plan: Record<string, string>;
  readonly repository: Record<string, string>;
  readonly tracker: Record<string, string>;
}

export function validateWorkflowPromptTemplate(template: string): string[] {
  const placeholders = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)) {
    placeholders.add(match[1]);
  }

  return Array.from(placeholders).filter((placeholder) => !SUPPORTED_PLACEHOLDERS.has(placeholder));
}

export function renderWorkflowPromptTemplate(
  template: string,
  intakeEvent: IntakeEvent,
  agent: PlannedAgent,
  plan: WorkflowPlan,
): string {
  if (!template.trim()) {
    return '';
  }

  const context = buildWorkflowPromptContext(intakeEvent, agent, plan);

  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, placeholder) => {
    if (!SUPPORTED_PLACEHOLDERS.has(placeholder)) {
      throw new Error(`Unsupported WORKFLOW.md placeholder "${placeholder}"`);
    }
    return lookupPlaceholder(context, placeholder);
  });
}

function buildWorkflowPromptContext(
  intakeEvent: IntakeEvent,
  agent: PlannedAgent,
  plan: WorkflowPlan,
): WorkflowPromptContext {
  const sourceMetadata = intakeEvent.sourceMetadata;
  const issueIdentifier = getString(sourceMetadata.linearIdentifier)
    ?? intakeEvent.entities.requirementId
    ?? plan.workItemId;
  const issueTitle = getString(sourceMetadata.linearTitle) ?? '';
  const issueDescription = intakeEvent.rawText ? sanitize(intakeEvent.rawText) : '';
  const issueLabels = intakeEvent.entities.labels?.join(', ') ?? '';
  const issuePriority = normalizeIssuePriority(intakeEvent.entities.severity);
  const issueProject = intakeEvent.entities.projectId ?? '';
  const issueState = getString(sourceMetadata.linearState) ?? '';
  const issueTeam = getString(sourceMetadata.linearTeamKey)
    ?? getString(sourceMetadata.linearTeamId)
    ?? '';
  const issueRepo = intakeEvent.entities.repo ?? '';
  const issueBranch = intakeEvent.entities.branch ?? '';
  const attemptNumber = normalizeAttemptNumber(sourceMetadata.attempt);

  return {
    attempt: {
      number: attemptNumber,
    },
    issue: {
      identifier: issueIdentifier,
      title: issueTitle,
      description: issueDescription,
      labels: issueLabels,
      priority: issuePriority,
      project: issueProject,
      state: issueState,
      team: issueTeam,
      repo: issueRepo,
      branch: issueBranch,
    },
    agent: {
      role: agent.role,
      type: agent.type,
    },
    plan: {
      workItemId: plan.workItemId,
      template: plan.template,
    },
    repository: {
      name: issueRepo,
      branch: issueBranch,
    },
    tracker: {
      team: issueTeam,
    },
  };
}

function lookupPlaceholder(context: WorkflowPromptContext, placeholder: string): string {
  const [scope, key] = placeholder.split('.', 2);
  if (!scope || !key) {
    return '';
  }

  const record = context[scope as keyof WorkflowPromptContext];
  if (!record) {
    return '';
  }

  return record[key] ?? '';
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeIssuePriority(severity: IntakeEvent['entities']['severity']): string {
  switch (severity) {
    case 'critical':
      return '0';
    case 'high':
      return '1';
    case 'medium':
      return '2';
    case 'low':
      return '3';
    default:
      return '';
  }
}

function normalizeAttemptNumber(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'string') {
    return value;
  }
  return '';
}
